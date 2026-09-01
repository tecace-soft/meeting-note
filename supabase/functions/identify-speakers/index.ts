import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';

// Suggests, for each anonymous diarization label ("Speaker A/B/C") in a transcript,
// which known person it most likely is — using text/context only (name mentions,
// topic/profile overlap, and a self prior). Suggestion-only: never relabels on its own.
// Mirrors generate-profile's auth gate, CORS, and Gemini call chain.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ms-access-token',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Verify the app JWT minted by supabase-token (HS256). Mirrors generate-profile's gate. */
async function verifyAppJwt(token: string, secret: string): Promise<{ userId: string | null; error?: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) return { userId: null, error: 'Invalid JWT format.' };
  const [encodedHeader, encodedPayload, signature] = parts;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  if (!timingSafeEqual(base64Url(new Uint8Array(expectedSignature)), signature)) {
    return { userId: null, error: 'Invalid JWT signature.' };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload))) as Record<string, unknown>;
  } catch {
    return { userId: null, error: 'Invalid JWT payload.' };
  }
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (exp && exp < Math.floor(Date.now() / 1000)) {
    return { userId: null, error: 'JWT is expired.' };
  }
  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  return sub ? { userId: sub } : { userId: null, error: 'JWT did not include a user id.' };
}

/** Fallback: validate a Microsoft Graph access token by calling /me. Mirrors generate-profile. */
async function getMicrosoftUserId(accessToken: string): Promise<{ userId: string | null; error?: string }> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return {
      userId: null,
      error: `Microsoft Graph /me rejected the token (${response.status}). ${detail.slice(0, 300)}`,
    };
  }
  const data = (await response.json()) as { id?: unknown };
  return {
    userId: typeof data.id === 'string' && data.id.trim() ? data.id.trim() : null,
    error: 'Microsoft Graph /me did not return a user id.',
  };
}

interface RosterEntry {
  speakerId: string;
  name: string;
  summary: string;
}

interface RequestBody {
  transcriptText: string;
  labels: string[];
  roster: RosterEntry[];
  selfName?: string | null;
  noteId?: string | null; // optional: the note being suggested, excluded from the signature corpus
}

// Bounds to keep the prompt (and cost) sane on long meetings / large speaker directories.
const MAX_TRANSCRIPT_CHARS = 24000;
const MAX_ROSTER_ENTRIES = 40;
const MAX_LABELS = 30;
const MAX_SUMMARY_CHARS = 700;
const SIG_MAX_NOTES = 60; // recent labeled notes scanned to build per-speaker signatures

/** Override with `GEMINI_MODEL` secret. If a model 404s, set e.g. `gemini-2.5-flash-lite` or `gemini-2.5-flash`. */
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';
// gemini-2.0-* were RETIRED (verified 404 2026-08-18) — a failover chain ending on a dead
// model surfaced a confusing "no longer available" 404. LITE-ONLY for cost (no
// gemini-2.5-flash — too expensive); both models here are live lite-tier.
const DEFAULT_GEMINI_FALLBACK_MODELS = ['gemini-3.1-flash-lite'];
const RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);

interface GeminiGenerateContentResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: number };
}

function extractGeminiOutputText(data: GeminiGenerateContentResponse): string {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts?.length) return '';
  return parts.map((p) => p.text ?? '').join('');
}

async function callGeminiGenerateContent(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ rawText: string; error?: string; status?: number }> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        // thinkingBudget:0 keeps this in line with its server twin (memory.ts identifySpeakers
        // via callJsonModel) + update-user-memory: on 2.5 models, thinking tokens can consume
        // the output budget and truncate the JSON. Faster + more reliable, no behavior change.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  const responseBody = await res.text();
  let data: GeminiGenerateContentResponse;
  try {
    data = JSON.parse(responseBody) as GeminiGenerateContentResponse;
  } catch {
    return {
      rawText: '',
      error: `Gemini API error (${res.status}): ${responseBody.slice(0, 500)}`,
      status: res.status || 502,
    };
  }
  if (!res.ok) {
    const msg = data.error?.message ?? responseBody.slice(0, 500);
    return { rawText: '', error: `Gemini API error (${res.status}): ${msg}`, status: res.status };
  }
  if (data.error?.message) {
    return { rawText: '', error: `Gemini API error: ${data.error.message}`, status: res.status };
  }
  if (data.promptFeedback?.blockReason) {
    return { rawText: '', error: `Gemini blocked the prompt: ${data.promptFeedback.blockReason}`, status: 400 };
  }
  const rawText = extractGeminiOutputText(data).trim();
  if (!rawText) {
    const fr = data.candidates?.[0]?.finishReason;
    const reason = fr ? ` (finishReason: ${fr})` : '';
    return {
      rawText: '',
      error: `Gemini returned empty output.${reason} Check model name (GEMINI_MODEL) and API key.`,
      status: 502,
    };
  }
  return { rawText };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFallbackModels(primaryModel: string): string[] {
  const configured = Deno.env.get('GEMINI_FALLBACK_MODELS')
    ?.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const fallbackModels = configured?.length ? configured : DEFAULT_GEMINI_FALLBACK_MODELS;
  return [primaryModel, ...fallbackModels].filter((model, index, models) => model && models.indexOf(model) === index);
}

async function callGeminiWithRetryAndFallback(
  apiKey: string,
  primaryModel: string,
  systemPrompt: string,
  userPrompt: string
): Promise<{ rawText: string; error?: string; status?: number; model?: string }> {
  const models = parseFallbackModels(primaryModel);
  let lastResult: { rawText: string; error?: string; status?: number } | null = null;

  for (const model of models) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await callGeminiGenerateContent(apiKey, model, systemPrompt, userPrompt);
      if (!result.error) return { ...result, model };

      lastResult = result;
      const retryable = typeof result.status === 'number' && RETRYABLE_GEMINI_STATUSES.has(result.status);
      if (!retryable) break;
      if (attempt < maxAttempts) {
        await sleep(700 * attempt + Math.floor(Math.random() * 300));
      }
    }
  }

  return {
    rawText: '',
    error: lastResult?.error ?? 'Speaker identification failed after retries and fallback models.',
    status: lastResult?.status ?? 502,
  };
}

// NOTE: keep this prompt in sync with workflow-server/src/memory.ts (the ingest + eval copy).
// Both are text-only speaker identification; they must behave the same.
const IDENTIFY_SYSTEM_PROMPT = `You identify who each anonymous speaker in a meeting transcript most likely is.
You are given: (1) a transcript whose speakers are anonymous labels like "Speaker A", "Speaker B"; (2) a roster of the user's KNOWN speakers — the people this user REGULARLY meets with — each with a short profile summary, most-established first; (3) the display name of the logged-in user ("self"), who is usually present in their own meetings.

For EACH distinct anonymous label, decide the single most likely identity using text signals + these priors, roughly in this order of reliability:
- Direct address / vocatives ("Thanks, Hansoo", "Andrew, what do you think?") and self-introductions ("this is Jin") — strongest.
- INTERACTION ROLE — match each speaker's conversational STANCE to the ROLE described in the roster profile. This is usually MORE reliable than topic overlap, because in a small team everyone discusses the same topics. Signals: who ASKS for progress / SETS direction / REQUESTS features / evaluates ("어때요?", "~해달라는 거예요", "our goal is…") vs who REPORTS what they did / ACCEPTS tasks / defers ("어제 ~ 완성했습니다", "제가 ~ 할게요", "알겠습니다"). A boss/lead asks & directs; a developer reports & accepts. Map the asker to the roster's lead/boss profile and the reporter to the roster's developer profile.
- The SELF prior: the self is usually present. Decide which ROLE the self plays from the roster (is the self the lead or the developer?) and use the interaction-role signal to place the self on the matching label.
- The ROSTER / attendance prior: the roster IS this user's usual set of collaborators. In a SMALL meeting (few labels), the participants are almost always the self plus one or a few roster members — so exactly one label is the self and the others most likely map to roster members. Prefer a confident roster assignment there instead of "unknown".
- Topic / project overlap — WEAKEST signal; use only to break ties, never to override interaction role.

Rules:
- If the label best matches a roster entry, return its exact speakerId and name.
- SELF CONSISTENCY (critical): if the person you assign to a label IS the logged-in user (self), you MUST set isSelf=true; and if isSelf=true the name MUST be the self's name. Never name the self person with isSelf=false, and never set isSelf=true for anyone who is not the self.
- At most ONE label is the self. If two labels look like the self, keep isSelf=true only for the single best one.
- If the transcript clearly NAMES a person who is NOT in the roster, return speakerId=null and that name (a new-name suggestion).
- Only return unknown (speakerId=null, name=null) when there is genuinely no supporting signal AND no small-meeting roster mapping. Do NOT invent an identity from nothing — but in a small meeting whose participants clearly correspond to self + roster members, a confident assignment is EXPECTED, not "unknown".
- CONFIDENCE (0.0-1.0), calibrated to MAPPING certainty, not just to recognizing the group:
  - >=0.8 only when a SPECIFIC label has a clear distinguishing signal (direct address, an unambiguous interaction-role match, a name mention).
  - <=0.5 when you can identify the participant SET but the role/text signals do not clearly say WHICH label is which (e.g. two same-domain speakers, weak or conflicting stance signals). Give your best-guess mapping at low confidence so it is offered as a suggestion, NOT auto-applied. A confident WRONG mapping is worse than a tentative one.
- Never invent a speakerId that is not in the roster.
- NEVER output an anonymous label itself as the name. If you cannot identify a label's speaker, return speakerId=null AND name=null (unknown) — do NOT echo "Speaker A"/"Speaker B"/"Speaker C" back as the name.
- Names are real PEOPLE only. NEVER use the meeting/app/product/company/tool name, a project name, or any non-person noun (e.g. "meeting note", "the app") as a person's name; if that is all you have, return unknown.
- rationale: one short sentence citing the evidence (a quote, the matched interaction role, or the self/roster prior).

Return ONLY JSON of the exact shape:
{"suggestions":[{"label":"Speaker A","speakerId":"<roster id or null>","name":"<name or null>","confidence":0.0,"isSelf":false,"rationale":"..."}]}
Include exactly one object per distinct label given, in the same order.`;

// Collapse roster entries that refer to the same person (same name after stripping a
// parenthetical script variant, e.g. "Andrew Yoo" vs "Andrew Yoo (유영준)"), keeping the
// RICHEST profile and ordering richest-first as a light "regular collaborator" prior. Sending
// duplicates made the model pick a different speakerId per meeting and flip isSelf. Shapes the
// request ONLY — no DB mutation. Keep in sync with workflow-server/src/memory.ts.
function dedupeRosterByName(roster: RosterEntry[]): RosterEntry[] {
  const byName = new Map<string, RosterEntry>();
  for (const entry of roster) {
    const key = entry.name.replace(/\s*[(（【[].*$/, '').trim().toLowerCase();
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing || (entry.summary?.length ?? 0) > (existing.summary?.length ?? 0)) {
      byName.set(key, entry);
    }
  }
  return [...byName.values()].sort((a, b) => (b.summary?.length ?? 0) - (a.summary?.length ?? 0));
}

function buildIdentifyUserPrompt(body: RequestBody): string {
  const transcript = body.transcriptText.slice(0, MAX_TRANSCRIPT_CHARS);
  const labels = body.labels.slice(0, MAX_LABELS);
  const roster = dedupeRosterByName(body.roster).slice(0, MAX_ROSTER_ENTRIES);

  const rosterText = roster.length
    ? roster
        .map((entry, index) => {
          const summary = (entry.summary || '').slice(0, MAX_SUMMARY_CHARS).trim() || '(no profile yet)';
          return `${index + 1}. speakerId="${entry.speakerId}" name="${entry.name}"\n${summary}`;
        })
        .join('\n\n')
    : '(the user has no saved speakers yet)';

  const selfLine = body.selfName?.trim()
    ? `Logged-in user (self), usually present: "${body.selfName.trim()}"`
    : 'Logged-in user (self): unknown';

  return `${selfLine}

Anonymous labels to identify (return one suggestion per label, in this order):
${labels.map((l) => `- ${l}`).join('\n')}

Known speaker roster:
${rosterText}

Transcript (speakers are anonymous):
${transcript}`;
}

interface Suggestion {
  label: string;
  speakerId: string | null;
  name: string | null;
  confidence: number;
  isSelf: boolean;
  rationale: string;
}

function clamp01(n: unknown): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// Product/app names that recur in these transcripts and must never be treated as a person.
// Compared after stripping non-alphanumerics + lowercasing ("Meeting Note" -> "meetingnote").
// Keep in sync with workflow-server/src/memory.ts.
const NON_PERSON_NAME_TOKENS = new Set(['meetingnote', 'meetingnotes']);

/** A model-returned NAME that is not a real person: an echoed anonymous label ("Speaker C"),
 *  a generic placeholder ("Unknown"/"Transcript"), one of the labels we asked about, or the
 *  product/app name. These are the "Speaker C -> Speaker C" / "Speaker F -> meeting note"
 *  garbage suggestions; coerce them to unknown so the UI shows "Unknown" with no Apply. */
function isNonPersonName(name: string, requestedLabels: string[]): boolean {
  const t = name.trim();
  if (!t) return true;
  if (/^(speaker|transcript|unknown)\b/i.test(t) || /^speaker\s*#?\s*\d+$/i.test(t)) return true;
  const lc = t.toLowerCase();
  if (requestedLabels.some((l) => l.trim().toLowerCase() === lc)) return true;
  if (NON_PERSON_NAME_TOKENS.has(lc.replace(/[^a-z0-9]/g, ''))) return true;
  return false;
}

/** Parse + validate the model output. Drops any speakerId not in the roster (never trust an invented id). */
function parseSuggestions(rawText: string, validSpeakerIds: Set<string>, requestedLabels: string[]): Suggestion[] {
  const stripped = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return [];
  }
  const arr = (parsed as { suggestions?: unknown }).suggestions;
  if (!Array.isArray(arr)) return [];

  const allowed = new Set(requestedLabels);
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!label || !allowed.has(label) || seen.has(label)) continue;
    seen.add(label);

    let speakerId = typeof o.speakerId === 'string' && o.speakerId.trim() ? o.speakerId.trim() : null;
    if (speakerId && !validSpeakerIds.has(speakerId)) speakerId = null; // never trust an invented id
    let name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null;
    // Coerce a non-person name to UNKNOWN — an echoed label ("Speaker C") or the product name
    // ("meeting note"). Do this REGARDLESS of speakerId: past bad "Apply"s created roster rows
    // literally named "Speaker X"/"meeting note", so such a name can arrive WITH a valid roster id
    // and would otherwise slip through. Drop both fields so nothing bogus is offered to Apply.
    if (name && isNonPersonName(name, requestedLabels)) { name = null; speakerId = null; }

    out.push({
      label,
      speakerId,
      name,
      confidence: clamp01(o.confidence),
      isSelf: o.isSelf === true,
      rationale: typeof o.rationale === 'string' ? o.rationale.slice(0, 300) : '',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DETERMINISTIC EVIDENCE-ANCHOR LAYER — keep behaviorally in sync with
// workflow-server/src/speakerAnchors.ts (that module has the full doc + unit tests, and the
// backtest's "anchors ON" arm measures exactly this). The model confidently picks the wrong
// same-team member; this reshapes each suggestion against high-precision textual anchors from the
// same transcript, with NO extra Gemini call: VETO a non-self pick a negative anchor contradicts,
// BOOST/OVERRIDE one a self-introduction confirms, and CAP any non-self pick with no concrete
// anchor to <=0.6 so "confident and wrong" is impossible. The self path is never touched.
// ---------------------------------------------------------------------------
const CAP_NO_ANCHOR = 0.6;
const CAP_VETOED = 0.35;
const CONFIRM = 0.9;

type Anchor = { kind: 'self-intro' | 'address'; label: string; name: string };

const hasHangul = (s: string): boolean => /[가-힣]/.test(s);
const hangulCore = (s: string): string => (s.toLowerCase().match(/[가-힣]+/g) ?? []).join('');
const stripParen = (s: string): string => s.toLowerCase().replace(/\s*[(（【\[].*$/, '').trim();
const latinParts = (s: string): string[] =>
  stripParen(s).replace(/[()（）【】\[\]·,]/g, ' ').split(/\s+/).filter((p) => p.length >= 2 && /[a-z]/.test(p));

function matchToken(token: string, knownNames: string[]): string | null {
  const t = token.trim().toLowerCase();
  if (t.length < 2) return null;
  for (const full of knownNames) {
    if (hasHangul(t)) {
      const core = hangulCore(full);
      if (core && (core.includes(t) || t.includes(core))) return full;
    } else if (latinParts(full).includes(t)) {
      return full;
    }
  }
  return null;
}

function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (stripParen(a) && stripParen(a) === stripParen(b)) return true;
  const ha = hangulCore(a), hb = hangulCore(b);
  if (ha && hb && (ha.includes(hb) || hb.includes(ha))) return true;
  const pa = latinParts(a), pb = latinParts(b);
  if (pa.length && pb.length) {
    if (pa.length === 1 && pa[0] === pb[0]) return true;
    if (pb.length === 1 && pb[0] === pa[0]) return true;
  }
  return false;
}

function parseTurns(transcript: string, labels: string[]): Array<{ label: string; text: string }> {
  const known = new Set(labels.map((l) => l.trim()));
  const turns: Array<{ label: string; text: string }> = [];
  let current: { label: string; text: string } | null = null;
  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const m = /^\s*([^:]{1,40}?):\s?(.*)$/.exec(line);
    if (m && known.has(m[1].trim())) {
      if (current) turns.push(current);
      current = { label: m[1].trim(), text: m[2] };
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  if (current) turns.push(current);
  return turns;
}

const SELF_INTRO_PATTERNS: RegExp[] = [
  /(?:제가|저는|나는|난|전)\s*([가-힣]{2,4}|[A-Za-z][A-Za-z]+)\s*(?:입니다|이에요|예요|이라고|라고|이라고요|라고요)/g,
  /(?:^|[\s"“'])(?:i['’`]m|i am|this is|my name is|name['’`]s)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/gi,
];
const ADDRESS_PATTERNS: RegExp[] = [
  /([가-힣]{2,4})\s*(?:님|씨)(?![가-힣])/g,
  /\b(?:thanks|thank you),?\s+([A-Z][a-zA-Z]+)\b/gi,
  /\b([A-Z][a-zA-Z]+),\s+(?:can|could|would|will|what|how|do|are|please)\b/g,
  /\bover to you,?\s+([A-Z][a-zA-Z]+)/gi,
];

function collectNames(patterns: RegExp[], text: string, knownNames: string[]): string[] {
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const resolved = matchToken((m[1] ?? '').trim(), knownNames);
      if (resolved && !out.includes(resolved)) out.push(resolved);
    }
  }
  return out;
}

function extractAnchors(turns: Array<{ label: string; text: string }>, knownNames: string[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const turn of turns) {
    for (const name of collectNames(SELF_INTRO_PATTERNS, turn.text, knownNames)) anchors.push({ kind: 'self-intro', label: turn.label, name });
    for (const name of collectNames(ADDRESS_PATTERNS, turn.text, knownNames)) anchors.push({ kind: 'address', label: turn.label, name });
  }
  return anchors;
}

function rosterIdFor(name: string, roster: Array<{ speakerId: string; name: string }>): string | null {
  const hit = roster.find((r) => sameName(r.name, name));
  return hit ? hit.speakerId : null;
}

function applyAnchors(suggestions: Suggestion[], anchors: Anchor[], roster: Array<{ speakerId: string; name: string }>, selfName: string | null): Suggestion[] {
  const positive = new Map<string, Set<string>>();
  const negative = new Map<string, Set<string>>();
  for (const a of anchors) {
    const bucket = a.kind === 'self-intro' ? positive : negative;
    const set = bucket.get(a.label) ?? new Set<string>();
    set.add(a.name);
    bucket.set(a.label, set);
  }
  return suggestions.map((s) => {
    const posSet = positive.get(s.label);
    const posName = posSet && posSet.size === 1 ? [...posSet][0] : null;
    const posIsSelf = posName != null && sameName(posName, selfName);
    if (posName && !posIsSelf) {
      if (s.name && sameName(s.name, posName)) return { ...s, confidence: Math.max(s.confidence, CONFIRM) };
      return { label: s.label, name: posName, speakerId: rosterIdFor(posName, roster), confidence: CONFIRM, isSelf: false, rationale: `self-introduction anchor: "${posName}"` };
    }
    if (posName && posIsSelf && s.isSelf) return { ...s, confidence: Math.max(s.confidence, CONFIRM) };
    const negSet = negative.get(s.label);
    if (!s.isSelf && s.name && negSet && [...negSet].some((n) => sameName(s.name, n))) {
      return { label: s.label, name: null, speakerId: null, confidence: Math.min(s.confidence, CAP_VETOED), isSelf: false, rationale: `contradicted by address anchor` };
    }
    if (!s.isSelf && s.name) return { ...s, confidence: Math.min(s.confidence, CAP_NO_ANCHOR) };
    return s;
  });
}

function gateSuggestionsWithAnchors(suggestions: Suggestion[], transcript: string, labels: string[], roster: Array<{ speakerId: string; name: string }>, selfName: string | null): Suggestion[] {
  const knownNames = [...roster.map((r) => r.name), ...(selfName ? [selfName] : [])].filter(Boolean);
  if (knownNames.length === 0) return suggestions;
  const anchors = extractAnchors(parseTurns(transcript, labels), knownNames);
  return applyAnchors(suggestions, anchors, roster, selfName);
}

// ---------------------------------------------------------------------------
// SIGNATURE IDENTIFIER — keep behaviorally in sync with workflow-server/src/speakerSignature.ts
// (that module has the doc + unit tests; the backtest SIG arm measures exactly this). Each roster
// member gets a TF-IDF text signature from their PAST labeled utterances; an anonymous label is
// matched to the nearest signature. Signature-primary, LLM fallback. Thresholds tuned on the
// backtest (t10/m08). Reuses sameName/stripParen/latinParts/hangul* from the anchor block above.
// ---------------------------------------------------------------------------
// Operating point re-tuned after H9 (see speakerSignature.ts DEFAULTS): t08/m02.
const SIG_TSCORE = 0.08, SIG_TMARGIN = 0.02, SIG_MIN_TOKENS = 8;
interface SigCorpus { key: string; display: string; docs: Array<{ noteId: string; tokens: string[] }> }
interface SigUtterance { noteId: string; name: string; text: string }

// H9: drop non-discriminative filler (Korean fillers/backchannels + English stopwords) so a word
// everyone says can't add cosine noise. Keep in sync with speakerSignature.ts STOPWORDS.
const SIG_STOPWORDS = new Set<string>([
  '그래서', '그러니까', '그러면', '그런데', '근데', '그리고', '그거', '그게', '이제', '이거', '저기',
  '약간', '그냥', '진짜', '너무', '조금', '이렇게', '그렇게', '어떻게', '뭐지', '뭐야', '뭔가',
  '아니', '아니요', '아니에요', '맞아요', '그렇죠', '그쵸', '그럼', '네네', '알겠습니다', '있어요',
  '없어요', '해야', '하는', '하고', '해서', '해가지고', '있는', '있고', '거예요', '거죠', '건데',
  '같아요', '같은', '같이', '우리', '저희', '제가', '지금', '오늘', '내일', '어제', '한번', '일단',
  'the', 'and', 'that', 'this', 'with', 'for', 'you', 'yeah', 'okay', 'right', 'like', 'just',
  'have', 'are', 'was', 'but', 'not', 'they', 'them', 'there', 'here', 'what', 'about', 'kind',
  'gonna', 'wanna', 'really', 'actually', 'basically', 'something', 'because',
]);
// H4: role/interaction-stance tokens (who ASKS/DIRECTS vs REPORTS/DEFERS) — a signal content words
// miss, and it helps thin-history speakers. Keep in sync with speakerSignature.ts roleTokens.
const SIG_R_DIRECT = /어때요|어떻게 생각|해주세요|해달라|하면 좋겠|합시다|해야 (?:돼|되|할)|정리해|확인해|검토|보내주|주세요/;
const SIG_R_REPORT = /했습니다|완료|끝냈|진행했|해봤|확인했|만들었|적용했|배포했|테스트해/;
const SIG_R_ASK = /\?|나요|까요|인가요|건가요|맞나요|무엇|언제|어디|누가|왜/;
const SIG_R_DEFER = /알겠습니다|알겠어요|네네|그렇게 하겠|그러겠|맞아요|동의/;
const SIG_ROLE_WEIGHT = 6;
function sigRoleTokens(text: string): string[] {
  const out: string[] = [];
  const push = (tok: string) => { for (let i = 0; i < SIG_ROLE_WEIGHT; i += 1) out.push(tok); };
  if (SIG_R_DIRECT.test(text)) push('r:direct');
  if (SIG_R_REPORT.test(text)) push('r:report');
  if (SIG_R_ASK.test(text)) push('r:ask');
  if (SIG_R_DEFER.test(text)) push('r:defer');
  return out;
}
const sigTokenize = (s: string): string[] => [
  ...(s.toLowerCase().match(/[가-힣]{2,}|[a-z]{2,}/g) ?? []).filter((t) => !SIG_STOPWORDS.has(t)),
  ...sigRoleTokens(s),
];
const sigCanon = (s: string): string => s.replace(/\s*[(（【\[].*$/, '').trim().toLowerCase().replace(/\s+/g, ' ');

function sigBuildCorpora(utterances: SigUtterance[]): Map<string, SigCorpus> {
  const corpora = new Map<string, SigCorpus>();
  for (const u of utterances) {
    const display = (u.name ?? '').trim();
    const key = sigCanon(display);
    if (!key) continue;
    const tokens = sigTokenize(u.text ?? '');
    if (tokens.length === 0) continue;
    const person = corpora.get(key) ?? { key, display, docs: [] };
    person.docs.push({ noteId: u.noteId, tokens });
    corpora.set(key, person);
  }
  return corpora;
}
function sigIdf(corpora: Map<string, SigCorpus>): Map<string, number> {
  const df = new Map<string, number>();
  for (const person of corpora.values()) {
    const seen = new Set<string>();
    for (const d of person.docs) for (const t of d.tokens) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const P = corpora.size;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log((P + 1) / (d + 1)) + 1);
  return idf;
}
const sigTf = (tokens: string[]): Map<string, number> => {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const [t, c] of tf) tf.set(t, 1 + Math.log(c)); // H9: sublinear TF
  return tf;
};
function sigSignature(corpora: Map<string, SigCorpus>, key: string, excludeNoteId: string | null): Map<string, number> {
  const toks: string[] = [];
  for (const d of corpora.get(key)?.docs ?? []) if (d.noteId !== excludeNoteId) toks.push(...d.tokens);
  return sigTf(toks);
}
function sigCosine(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [t, fa] of a) { const w = fa * (idf.get(t) ?? 0); na += w * w; const fb = b.get(t); if (fb) dot += w * (fb * (idf.get(t) ?? 0)); }
  for (const [t, fb] of b) { const w = fb * (idf.get(t) ?? 0); nb += w * w; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
const sigSat = (x: number, k: number): number => (x > 0 ? x / (x + k) : 0);
function sigConfidence(top1: number, top2: number): number {
  const margin = Math.max(0, top1 - top2);
  const v = 0.72 + 0.16 * sigSat(margin, 0.08) + 0.08 * sigSat(top1, 0.25);
  return Math.min(1, Math.max(0, v));
}
// Canonical person key for cross-speaker uniqueness (strip parenthetical script variant, lowercase,
// collapse spaces) — mirrors canonName in speakerSignature.ts. Used to keep one person per meeting.
const sigCanonName = (s: string): string => s.replace(/\s*[(（【\[].*$/, '').trim().toLowerCase().replace(/\s+/g, ' ');

interface SigDecision { label: string; name: string; speakerId: string | null; confidence: number; isSelf: boolean }
// Decide per label: a WARM + STRONG match is promoted; else the label is a fallback for the LLM.
function sigDecide(
  labels: Array<{ label: string; text: string }>, corpora: Map<string, SigCorpus>, idf: Map<string, number>,
  excludeNoteId: string | null, roster: RosterEntry[], selfName: string | null,
): { promoted: Map<string, SigDecision>; fallback: string[] } {
  const promoted = new Map<string, SigDecision>();
  const fallback: string[] = [];
  for (const { label, text } of labels) {
    const labelVec = sigTf(sigTokenize(text));
    if (labelVec.size === 0) { fallback.push(label); continue; }
    let top1 = { key: '', display: '', score: -1, warm: false };
    let top2Score = 0;
    for (const person of corpora.values()) {
      const otherTokens = person.docs.filter((d) => d.noteId !== excludeNoteId).reduce((n, d) => n + d.tokens.length, 0);
      const score = otherTokens ? sigCosine(labelVec, sigSignature(corpora, person.key, excludeNoteId), idf) : 0;
      if (score > top1.score) { top2Score = top1.score < 0 ? 0 : top1.score; top1 = { key: person.key, display: person.display, score, warm: otherTokens >= SIG_MIN_TOKENS }; }
      else if (score > top2Score) { top2Score = score; }
    }
    const margin = Math.max(0, top1.score - top2Score);
    if (!top1.warm || top1.score < SIG_TSCORE || margin < SIG_TMARGIN) { fallback.push(label); continue; }
    const rosterHit = roster.find((r) => sameName(r.name, top1.display));
    promoted.set(label, {
      label, name: top1.display, speakerId: rosterHit ? rosterHit.speakerId : null,
      confidence: sigConfidence(top1.score, top2Score), isSelf: sameName(top1.display, selfName),
    });
  }
  // Each person at most once (generalizes self-only): a dominant signature must not win multiple
  // speakers ("3 speakers all = one colleague"). Keep the highest-confidence label per person; the
  // rest fall to the LLM, which resolves them independently. Self is one person, so this subsumes
  // the old "never two selves" rule.
  const winnerLabelByPerson = new Map<string, string>();
  for (const s of [...promoted.values()].sort((a, b) => b.confidence - a.confidence)) {
    const personId = s.speakerId ?? sigCanonName(s.name);
    if (!winnerLabelByPerson.has(personId)) winnerLabelByPerson.set(personId, s.label);
  }
  const winnerLabels = new Set(winnerLabelByPerson.values());
  for (const s of [...promoted.values()]) if (!winnerLabels.has(s.label)) { promoted.delete(s.label); fallback.push(s.label); }
  return { promoted, fallback };
}


serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // Auth gate: require an authenticated user (app JWT, or Microsoft Graph token fallback).
  // Without this, anyone holding the anon key could burn the org's Gemini quota. Mirrors generate-profile.
  const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET') ?? Deno.env.get('JWT_SECRET') ?? '';
  const authHeader = req.headers.get('authorization')?.trim() ?? '';
  const appToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  const microsoftToken = req.headers.get('x-ms-access-token')?.trim() ?? '';
  let authResult = appToken && jwtSecret
    ? await verifyAppJwt(appToken, jwtSecret)
    : { userId: null as string | null, error: 'Missing app bearer token.' };
  if (!authResult.userId && microsoftToken) {
    authResult = await getMicrosoftUserId(microsoftToken);
  }
  if (!authResult.userId && !appToken && !microsoftToken) {
    authResult = { userId: null, error: 'Missing bearer token.' };
  }
  if (!authResult.userId) {
    return jsonResponse({ error: authResult.error ?? 'Unauthorized' }, 401);
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400);
  }

  const transcriptText = typeof body.transcriptText === 'string' ? body.transcriptText.trim() : '';
  const labels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string' && l.trim().length > 0).map((l) => l.trim())
    : [];
  // speakerId arrives as a NUMBER when the DB PK is an integer (PostgREST returns JSON numbers),
  // so coerce rather than require a string — the old `typeof === 'string'` check silently dropped
  // EVERY roster entry, leaving the model with no roster (it could only answer "unknown").
  const roster = Array.isArray(body.roster)
    ? body.roster
        .map((r) => {
          const o = (r ?? {}) as Record<string, unknown>;
          const id = o.speakerId;
          const speakerId = typeof id === 'string' ? id.trim() : typeof id === 'number' ? String(id) : '';
          const name = typeof o.name === 'string' ? o.name.trim() : '';
          return { speakerId, name, summary: typeof o.summary === 'string' ? o.summary : '' };
        })
        .filter((r) => r.speakerId && r.name)
    : [];

  if (!transcriptText || labels.length === 0) {
    return jsonResponse({ error: 'transcriptText and at least one label are required.' }, 400);
  }

  const apiKey = Deno.env.get('GEMINI_API_KEY') ?? Deno.env.get('GOOGLE_API_KEY') ?? '';
  const model = (Deno.env.get('GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL).trim();
  if (!apiKey) {
    return jsonResponse({ error: 'No Gemini API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) as a Supabase secret.' }, 500);
  }

  const validSpeakerIds = new Set(roster.map((r) => r.speakerId));
  const requestedLabels = labels.slice(0, MAX_LABELS);
  const selfName = typeof body.selfName === 'string' ? body.selfName : null;
  const noteId = typeof body.noteId === 'string' && body.noteId.trim() ? body.noteId.trim() : null;

  // 1. Build per-speaker signatures from the user's PAST labeled notes (best-effort; any failure
  //    just leaves the corpus empty → pure LLM behavior, never a failed suggestion).
  let corpora = new Map<string, SigCorpus>();
  let idf = new Map<string, number>();
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? Deno.env.get('MEETING_NOTE_SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('MEETING_NOTE_SERVICE_ROLE_KEY') ?? '';
  if (supabaseUrl && serviceRoleKey) {
    try {
      const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data } = await db.from('note').select('id, diarization')
        .eq('user_id', authResult.userId).order('created_at', { ascending: false }).limit(SIG_MAX_NOTES);
      const utt: SigUtterance[] = [];
      for (const n of (data ?? []) as Array<{ id: string; diarization: unknown }>) {
        if (noteId && n.id === noteId) continue; // leave-one-out
        const segs = Array.isArray(n.diarization) ? n.diarization : [];
        for (const s of segs as Array<{ speaker?: unknown; text?: unknown }>) {
          const name = typeof s.speaker === 'string' ? s.speaker.trim() : '';
          const text = typeof s.text === 'string' ? s.text : '';
          // Never let a non-person label ("Speaker X") or the product name ("meeting note") — left
          // in old diarization by a past bad rename — become a signature candidate.
          if (name && !isNonPersonName(name, []) && text) utt.push({ noteId: n.id, name, text });
        }
      }
      corpora = sigBuildCorpora(utt);
      idf = sigIdf(corpora);
    } catch (_err) { corpora = new Map(); idf = new Map(); }
  }

  // 2. Signature decision on the current transcript's anonymous labels.
  const textByLabel = new Map<string, string>();
  for (const turn of parseTurns(transcriptText, requestedLabels)) {
    textByLabel.set(turn.label, `${textByLabel.get(turn.label) ?? ''} ${turn.text}`.trim());
  }
  const labelsWithText = requestedLabels.map((l) => ({ label: l, text: textByLabel.get(l) ?? '' }));
  const dec = corpora.size
    ? sigDecide(labelsWithText, corpora, idf, noteId, roster, selfName)
    : { promoted: new Map<string, SigDecision>(), fallback: requestedLabels };

  // 3. LLM identify ONLY for labels the signature did not resolve (cold-start / weak signal).
  let anchoredByLabel = new Map<string, Suggestion>();
  if (dec.fallback.length > 0) {
    const userPrompt = buildIdentifyUserPrompt({ transcriptText, labels, roster, selfName: body.selfName });
    const result = await callGeminiWithRetryAndFallback(apiKey, model, IDENTIFY_SYSTEM_PROMPT, userPrompt);
    if (result.error) {
      // The LLM failed: still return whatever the signatures resolved rather than error out.
      if (dec.promoted.size === 0) return jsonResponse({ error: result.error }, result.status ?? 502);
    } else {
      const raw = parseSuggestions(result.rawText, validSpeakerIds, requestedLabels);
      // Anchor the LLM suggestions (confident-garbage guard); signature picks are evidence, kept as-is.
      const anchored = gateSuggestionsWithAnchors(raw, transcriptText, requestedLabels, roster, selfName);
      anchoredByLabel = new Map(anchored.map((s) => [s.label, s]));
    }
  }

  // 4. Merge: a promoted signature pick wins; otherwise the anchored LLM suggestion for that label.
  const merged: Suggestion[] = requestedLabels.map((label) => {
    const s = dec.promoted.get(label);
    if (s) return { label, name: s.name, speakerId: s.speakerId, confidence: s.confidence, isSelf: s.isSelf, rationale: 'signature' };
    return anchoredByLabel.get(label) ?? { label, name: null, speakerId: null, confidence: 0, isSelf: false, rationale: '' };
  });
  // Enforce "each person at most once" across the merged list: the signature and LLM stages could
  // each land on the same person, or the LLM could name two speakers the same. Keep the highest-
  // confidence instance per person and abstain the rest (preserves the isSelf ⟺ self-name
  // invariant, since self is one person). Kills the "same person for multiple speakers" output.
  const winnerByPerson = new Map<string, Suggestion>();
  for (const s of [...merged].filter((s) => s.name).sort((a, b) => b.confidence - a.confidence)) {
    const personId = s.speakerId ?? sigCanonName(s.name as string);
    if (!winnerByPerson.has(personId)) winnerByPerson.set(personId, s);
  }
  const keptPersons = new Set(winnerByPerson.values());
  for (const s of merged) {
    if (s.name && !keptPersons.has(s)) {
      s.isSelf = false; s.name = null; s.speakerId = null;
      s.confidence = Math.min(s.confidence, 0.3); s.rationale = 'demoted duplicate person';
    }
  }
  return jsonResponse({ suggestions: merged });
});
