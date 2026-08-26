import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

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

/** Verify the app JWT minted by supabase-token (HS256). Mirrors note-audio-url's gate. */
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

/** Fallback: validate a Microsoft Graph access token by calling /me. Mirrors note-audio-url. */
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

interface RequestBody {
  speakerName: string;
  speakerId?: string;
  transcriptText: string;
  existingProfile?: string | null;
}

/** Override with `GEMINI_MODEL` secret. If a model 404s, set e.g. `gemini-3.1-flash-lite`. */
// PRIMARY is gemini-3.1-flash-lite. The heavy-speaker timeout was NOT a model/runtime hang — it
// was the nested responseSchema making the model run away to MAX_TOKENS (measured 2026-08-26; see
// callGeminiGenerateContent). Schema-less, 3.1-flash-lite returns compact valid JSON in ~3.4s.
// 2.5-flash-lite stays as the fallback. LITE-ONLY for cost (no gemini-2.5-flash). gemini-2.0-*
// are RETIRED (404) — do not add them back.
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';
// Include 3.1-flash-lite in the fallback list too, so that even if a GEMINI_MODEL secret pins
// the primary to the hang-prone 2.5-flash-lite, the chain still reaches the reliable 3.1 after
// the timeout-advance (parseFallbackModels dedupes, so listing it twice is harmless).
const DEFAULT_GEMINI_FALLBACK_MODELS = ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
const RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);

// Supabase kills a request idle for 150s (observed IDLE_TIMEOUT on a heavy speaker). Bound our
// own time well under that: abort any single Gemini call, and stop starting new attempts once
// the total budget is spent, so we ALWAYS return a clean error instead of the platform killing us.
// Keep the per-call timeout tight: a healthy (schema-less) call is ~3-4s, so 30s is generous and
// abandons any stuck call fast enough to still reach the working fallback within the total budget.
const GEMINI_CALL_TIMEOUT_MS = 30_000;
const TOTAL_TIME_BUDGET_MS = 120_000;

// Structural correctness is enforced in APP code, NOT via a Gemini responseSchema. History:
// a responseSchema (O-2) was added to prevent truncation-into-invalid-JSON wipes, but MEASURED
// 2026-08-26 it BACKFIRED — constrained decoding to the nested schema made 3.1-flash-lite run
// away to ~165k chars / MAX_TOKENS (~50s, never closing the JSON), the real cause of the
// `exceeded 30000ms` timeout. Schema dropped (see callGeminiGenerateContent). The wipe risk it
// was meant to cover is already handled without it: parseOntologyStrict (O-1) returns null on
// bad JSON so we retry/fail instead of writing an empty ontology, and clampStr/clampStrArray/
// mapObjectArray enforce these caps on the parsed output. NOTE (still true): Gemini ignores
// `maxLength` on strings, so string trimming MUST live in app code (clampStr), not the prompt.
const MAX_ARRAY_ITEMS = 4;
const MAX_STR_LEN = 120;
// Generous DEFENSIVE backstop, not a real trim: the timeout is driven by OUTPUT generation
// (bounded now by the item cap + base-prompt brevity + per-call/total timeouts), NOT by input
// size — prefill of even a 2h meeting is a few seconds. So keep the whole transcript for real
// meetings (a 38-min meeting is ~35-45k chars; ~90 min fits here) and only clip a pathological
// input. Raising this does NOT reintroduce the 150s timeout. ~37k tokens is trivial for lite.
const MAX_TRANSCRIPT_CHARS = 150000;
// On a MAX_TOKENS truncation the retry raises the output ceiling AND forces much shorter
// output (maxLength is unenforced, so the prompt is the only way to shrink string fields).
const MAX_TOKENS_RETRY_BUDGET = 32768;
const BREVITY_ESCALATION =
  'IMPORTANT: your previous response was too long and was cut off before the JSON closed. ' +
  'Produce a MUCH SHORTER ontology this time: at most 3 items in each array, and every string ' +
  'field at most 60 characters (a short phrase, never a sentence or paragraph). Keep only the ' +
  'highest-confidence, most important facts and drop the rest. Returning COMPLETE, valid JSON is ' +
  'more important than being comprehensive.';
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
  userPrompt: string,
  maxOutputTokens?: number,
  timeoutMs: number = GEMINI_CALL_TIMEOUT_MS
): Promise<{ rawText: string; error?: string; status?: number; finishReason?: string; timedOut?: boolean }> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  // Abort a call that hangs so the retry loop stays inside the total time budget. Gemini is
  // non-streaming here, so `fetch` resolves only after generation finishes — the slow part.
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  let res: Response;
  try {
    res = await fetch(url, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        // NO responseSchema. MEASURED 2026-08-26 (probe-generate-profile.ts, real heavy speaker
        // vs live Gemini): constrained decoding to the nested ONTOLOGY_SCHEMA makes
        // gemini-3.1-flash-lite RUN AWAY — it fills the structure to the item/string caps and
        // keeps going to ~165k chars / finishReason MAX_TOKENS, taking ~50s (past the 30s abort)
        // and NEVER closing the JSON. Dropping the schema (same as the identify/diarize twin, which
        // never hangs) makes the model obey the prompt's brevity rules → compact valid JSON in
        // ~3.4s. Structural correctness is enforced in APP code instead: parseOntologyStrict (O-1)
        // returns null on bad JSON (retry/fail, never an empty wipe) and clampStr/clampStrArray/
        // mapObjectArray enforce MAX_STR_LEN + MAX_ARRAY_ITEMS. thinkingBudget:0 stays.
        maxOutputTokens: maxOutputTokens ?? 24576,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  } catch (err) {
    clearTimeout(abortTimer);
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return {
      rawText: '',
      error: timedOut
        ? `Gemini call exceeded ${timeoutMs}ms and was aborted.`
        : `Gemini request failed: ${err instanceof Error ? err.message : String(err)}`,
      status: 504,
      timedOut, // a hung model: the caller advances to the fallback instead of retrying it
    };
  }
  clearTimeout(abortTimer);

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
    return {
      rawText: '',
      error: `Gemini blocked the prompt: ${data.promptFeedback.blockReason}`,
      status: 400,
    };
  }
  const finishReason = data.candidates?.[0]?.finishReason;
  const rawText = extractGeminiOutputText(data).trim();
  if (!rawText) {
    const reason = finishReason ? ` (finishReason: ${finishReason})` : '';
    return {
      rawText: '',
      error: `Gemini returned empty output.${reason} Check model name (GEMINI_MODEL) and API key.`,
      status: 502,
    };
  }
  return { rawText, finishReason };
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
  userPrompt: string,
  speakerName: string,
  speakerId: string
): Promise<{ ontology?: SpeakerOntology; error?: string; status?: number; model?: string }> {
  const models = parseFallbackModels(primaryModel);
  let lastError = 'Gemini profile generation failed after retries and fallback models.';
  let lastStatus = 502;
  const start = Date.now();

  outer:
  for (const model of models) {
    const maxAttempts = 3;
    // Escalation state (reset per model): a MAX_TOKENS truncation means the output overran
    // the budget, so the NEXT attempt both raises the ceiling and reinforces brevity in the
    // prompt (maxLength is unenforced, so the prompt is the only lever to shrink strings).
    let attemptUserPrompt = userPrompt;
    let attemptBudget: number | undefined = undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Stop before we blow the total budget (else Supabase kills us at 150s with IDLE_TIMEOUT).
      const remaining = TOTAL_TIME_BUDGET_MS - (Date.now() - start);
      if (remaining <= 5_000) {
        lastError = `Sync Profile timed out after ${Math.round((Date.now() - start) / 1000)}s (heavy speaker/transcript). Try again.`;
        lastStatus = 504;
        break outer;
      }
      const result = await callGeminiGenerateContent(apiKey, model, systemPrompt, attemptUserPrompt, attemptBudget, Math.min(GEMINI_CALL_TIMEOUT_MS, remaining));
      if (!result.error) {
        // O-1/O-2: an HTTP-200 body that is truncated/garbage (unparseable ontology) is
        // retryable — NOT a silent empty success that would wipe the saved profile.
        const parsed = parseOntologyStrict(result.rawText, speakerName, speakerId);
        if (parsed) return { ontology: parsed, model };
        lastError = `Ontology output was not valid JSON (model ${model}, len ${result.rawText.length}, finishReason ${result.finishReason ?? 'n/a'}).`;
        lastStatus = 502;
        // A MAX_TOKENS truncation repeats identically unless we change the request: give the
        // retry more room AND push the model to write shorter fields / fewer items.
        if (result.finishReason === 'MAX_TOKENS') {
          attemptBudget = MAX_TOKENS_RETRY_BUDGET;
          attemptUserPrompt = `${userPrompt}\n\n${BREVITY_ESCALATION}`;
        }
        if (attempt < maxAttempts) { await sleep(700 * attempt + Math.floor(Math.random() * 300)); continue; }
        break; // exhausted this model → next model
      }

      lastError = result.error;
      lastStatus = result.status ?? 502;
      // A TIMEOUT means this model is hung (e.g. 2.5-flash-lite on the nested schema): retrying
      // the SAME model just burns 3× the timeout and never reaches the working fallback. Advance
      // to the next model immediately.
      if (result.timedOut) break;
      const retryable = typeof result.status === 'number' && RETRYABLE_GEMINI_STATUSES.has(result.status);
      if (!retryable) break;
      if (attempt < maxAttempts) {
        await sleep(700 * attempt + Math.floor(Math.random() * 300));
      }
    }
  }

  return { error: lastError, status: lastStatus };
}

interface SpeakerOntology {
  schema_version: string;
  speaker_id: string;
  display_name: string;
  aliases: string[];
  identity_confidence: number;
  professional_context: {
    company: string;
    role: string;
    domains: string[];
    confidence: number;
  };
  active_projects: {
    name: string;
    role_in_project: string;
    status: string;
    importance: string;
    confidence: number;
  }[];
  relationships: {
    person_or_group: string;
    relationship_type: string;
    context: string;
    related_projects: string[];
    confidence: number;
  }[];
  responsibilities: {
    description: string;
    scope: string;
    related_projects: string[];
    status: string;
    confidence: number;
  }[];
  open_threads: {
    topic: string;
    status: string;
    priority: string;
    summary: string;
    related_projects: string[];
    confidence: number;
  }[];
  last_updated_at: string;
}

function clampConfidence01(n: unknown): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// Gemini enforces responseSchema `maxItems` but NOT `maxLength` (verified 2026-08-18: it
// returned an 813-char string for a maxLength:120 field). So bound string length and array
// size in APPLICATION code, applied on BOTH the parsed OUTPUT and the existing ontology fed
// back into the update prompt. Trimming the existing profile keeps every Sync Profile input
// compact, which is what stops a heavy speaker's ontology from growing until the update
// output overflows maxOutputTokens and truncates mid-JSON.
function clampStr(v: unknown): string {
  return (typeof v === 'string' ? v : '').slice(0, MAX_STR_LEN);
}
function clampStrArray(v: unknown): string[] {
  return (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    .map((s) => s.slice(0, MAX_STR_LEN))
    .slice(0, MAX_ARRAY_ITEMS);
}

function mapProfessionalContext(pc: Record<string, unknown>): SpeakerOntology['professional_context'] {
  return {
    company: clampStr(pc.company),
    role: clampStr(pc.role),
    domains: clampStrArray(pc.domains),
    confidence: clampConfidence01(pc.confidence),
  };
}

function mapActiveProject(o: Record<string, unknown>): SpeakerOntology['active_projects'][number] {
  return {
    name: clampStr(o.name),
    role_in_project: clampStr(o.role_in_project),
    status: clampStr(o.status),
    importance: clampStr(o.importance),
    confidence: clampConfidence01(o.confidence),
  };
}

function mapRelationship(o: Record<string, unknown>): SpeakerOntology['relationships'][number] {
  return {
    person_or_group: clampStr(o.person_or_group),
    relationship_type: clampStr(o.relationship_type),
    context: clampStr(o.context),
    related_projects: clampStrArray(o.related_projects),
    confidence: clampConfidence01(o.confidence),
  };
}

function mapResponsibility(o: Record<string, unknown>): SpeakerOntology['responsibilities'][number] {
  return {
    description: clampStr(o.description),
    scope: clampStr(o.scope),
    related_projects: clampStrArray(o.related_projects),
    status: clampStr(o.status),
    confidence: clampConfidence01(o.confidence),
  };
}

function mapOpenThread(o: Record<string, unknown>): SpeakerOntology['open_threads'][number] {
  return {
    topic: clampStr(o.topic),
    status: clampStr(o.status),
    priority: clampStr(o.priority),
    summary: clampStr(o.summary),
    related_projects: clampStrArray(o.related_projects),
    confidence: clampConfidence01(o.confidence),
  };
}

// Clamp to MAX_ARRAY_ITEMS: the top-level ontology arrays must be bounded even though
// Gemini's maxItems is only advisory on some inputs, and so the existing profile fed into
// the next update stays small.
function mapObjectArray<T>(arr: unknown, fn: (o: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(arr)) return [];
  const out: T[] = [];
  for (const item of arr) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out.push(fn(item as Record<string, unknown>));
      if (out.length >= MAX_ARRAY_ITEMS) break;
    }
  }
  return out;
}

function fallbackOntology(speakerName: string, speakerId: string): SpeakerOntology {
  return {
    schema_version: '1.0',
    speaker_id: speakerId,
    display_name: speakerName,
    aliases: [],
    identity_confidence: 0,
    professional_context: { company: '', role: '', domains: [], confidence: 0 },
    active_projects: [],
    relationships: [],
    responsibilities: [],
    open_threads: [],
    last_updated_at: new Date().toISOString(),
  };
}

/** Detect legacy markdown profiles (non-JSON strings). */
function isMarkdownProfile(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length > 0 && !trimmed.startsWith('{') && !trimmed.startsWith('[');
}

/** Wrap a legacy markdown profile into a minimal ontology. */
function wrapMarkdownProfile(speakerName: string, speakerId: string): SpeakerOntology {
  return fallbackOntology(speakerName, speakerId);
}

/** Strip deprecated keys and normalize before passing existing profile into the update prompt. */
function sanitizeExistingOntologyForUpdate(raw: string, speakerName: string, speakerId: string): string {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    delete parsed.summary_for_meeting_context;
    const normalized = parseOntologyResponse(JSON.stringify(parsed), speakerName, speakerId);
    return JSON.stringify(normalized, null, 2);
  } catch {
    return stripped;
  }
}

/** Allowlisted parse — never preserves summary_for_meeting_context or other unknown keys. */
function ontologyFromLooseParsed(parsed: Record<string, unknown>, speakerName: string, speakerId: string): SpeakerOntology {
  const pcRaw = parsed.professional_context;
  const professional_context =
    pcRaw && typeof pcRaw === 'object' && !Array.isArray(pcRaw)
      ? mapProfessionalContext(pcRaw as Record<string, unknown>)
      : mapProfessionalContext({});
  return {
    schema_version: typeof parsed.schema_version === 'string' ? parsed.schema_version : '1.0',
    speaker_id: typeof parsed.speaker_id === 'string' ? parsed.speaker_id : speakerId,
    display_name: clampStr(parsed.display_name) || speakerName,
    aliases: clampStrArray(parsed.aliases),
    identity_confidence: typeof parsed.identity_confidence === 'number' ? parsed.identity_confidence : 0,
    professional_context,
    active_projects: mapObjectArray(parsed.active_projects, mapActiveProject),
    relationships: mapObjectArray(parsed.relationships, mapRelationship),
    responsibilities: mapObjectArray(parsed.responsibilities, mapResponsibility),
    open_threads: mapObjectArray(parsed.open_threads, mapOpenThread),
    last_updated_at: typeof parsed.last_updated_at === 'string' ? parsed.last_updated_at : new Date().toISOString(),
  };
}

function parseOntologyResponse(raw: string, speakerName: string, speakerId: string): SpeakerOntology {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    return ontologyFromLooseParsed(parsed, speakerName, speakerId);
  } catch (e) {
    console.error('Failed to parse ontology JSON. Raw output:', raw, 'Error:', e);
    return fallbackOntology(speakerName, speakerId);
  }
}

// O-1: strict parse — returns null on unparseable output instead of an EMPTY fallback.
// The retry loop uses this to treat an HTTP-200 truncated/garbage body as retryable, and
// the handler uses it to fail (502) rather than silently return an empty ontology that
// would overwrite (wipe) the speaker's accumulated profile.
function parseOntologyStrict(raw: string, speakerName: string, speakerId: string): SpeakerOntology | null {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return ontologyFromLooseParsed(JSON.parse(stripped) as Record<string, unknown>, speakerName, speakerId);
  } catch {
    return null;
  }
}

const CONFIDENCE_RULES = `Confidence scores (0.0–1.0):
- Every object value must include a numeric field "confidence" in that object (not at the root except identity_confidence).
- professional_context.confidence reflects confidence in company/role/domains as a whole.
- Each item in active_projects, relationships, responsibilities, and open_threads must have its own "confidence" for that item's inferred content.
- 1.0 = stated explicitly in the transcript; ~0.5–0.8 = strongly implied; lower for weak inference; 0.0 when the block is empty or has no transcript support.`;

// Keep output compact. Without this (and thinkingBudget:0) flash-lite can run away to
// MAX_TOKENS and truncate the JSON, which used to wipe the profile. Verified necessary.
const TERSENESS_RULES = `Be TERSE and compact:
- Every string field is at most one short phrase (<= 120 characters). Never write paragraphs.
- Each array (aliases, domains, active_projects, relationships, responsibilities, open_threads) has at most 6 items.
- NEVER pad, repeat, or invent items to fill the structure. If a field has no transcript support, leave it empty ("" / []).`;

const NEW_PROFILE_SYSTEM = `You are a speaker ontology extraction engine for a meeting note application.

Your job is to create a practical, lightweight speaker memory ontology from a diarized meeting transcript.

The goal is not to create a perfect academic ontology. The goal is to create structured speaker context that helps future meeting notes become more accurate, relevant, and consistent.

${CONFIDENCE_RULES}

${TERSENESS_RULES}

Your JSON output must contain ONLY the keys shown in the required structure. Never output summary_for_meeting_context or any other key not listed there.`;

const UPDATE_PROFILE_SYSTEM = `You are a speaker ontology update engine for a meeting note application.

Your job is to update an existing lightweight speaker memory ontology using a new diarized meeting transcript.

The goal is to preserve useful speaker context while adding new professional information that improves future meeting summaries.

${CONFIDENCE_RULES}

${TERSENESS_RULES}

Never output deprecated fields. The field summary_for_meeting_context is not part of the schema and must not appear in your JSON output.`;

function requiredOntologyJsonSchema(speakerId: string, displayName: string, lastUpdated: string): string {
  return `{
  "schema_version": "1.0",
  "speaker_id": "${speakerId}",
  "display_name": "${displayName}",
  "aliases": [],
  "identity_confidence": 0.0,
  "professional_context": {
    "company": "",
    "role": "",
    "domains": [],
    "confidence": 0.0
  },
  "active_projects": [
    {
      "name": "",
      "role_in_project": "",
      "status": "active | paused | completed | unknown",
      "importance": "high | medium | low | unknown",
      "confidence": 0.0
    }
  ],
  "relationships": [
    {
      "person_or_group": "",
      "relationship_type": "collaborator | customer | manager | team_member | vendor | stakeholder | unknown",
      "context": "",
      "related_projects": [],
      "confidence": 0.0
    }
  ],
  "responsibilities": [
    {
      "description": "",
      "scope": "general | project-specific | meeting-specific",
      "related_projects": [],
      "status": "active | completed | unknown",
      "confidence": 0.0
    }
  ],
  "open_threads": [
    {
      "topic": "",
      "status": "open | waiting | resolved | unknown",
      "priority": "high | medium | low | unknown",
      "summary": "",
      "related_projects": [],
      "confidence": 0.0
    }
  ],
  "last_updated_at": "${lastUpdated}"
}`;
}

function buildNewProfilePrompt(name: string, speakerId: string, transcript: string, currentDate: string): string {
  return `Create a new speaker ontology for ${name} using the meeting transcript below.

Rules:
- Use only information that is explicitly stated or strongly supported by the transcript.
- Do not invent personal details, titles, companies, relationships, or responsibilities.
- Prefer useful business/professional context over personality analysis.
- Avoid storing sensitive personal information.
- If a field is unknown, use an empty string, empty array, or set the containing object's confidence to 0.0.
- Include every "confidence" field shown in the structure for professional_context and each array item.
- Keep the ontology compact and useful for downstream meeting notes.
- Be BRIEF: at most 3 items in each array (keep only the most important, highest-confidence facts and drop the rest), and every string field a short phrase of at most 80 characters, never a sentence or paragraph. A short, COMPLETE ontology is better than a long one.
- Output valid JSON only. Do not output markdown.
- Output ONLY the keys in the required structure below. Never output summary_for_meeting_context or any other extra key.

Required JSON structure:
${requiredOntologyJsonSchema(speakerId, name, currentDate)}

Transcript:
${transcript}`;
}

function buildUpdateProfilePrompt(
  name: string,
  speakerId: string,
  existingOntologyJson: string,
  transcript: string,
  currentDate: string
): string {
  return `Update the existing ontology for ${name} using the new transcript below.

Rules:
- Keep existing information unless the new transcript clearly updates or corrects it.
- Prefer newer transcript information when there is a direct conflict.
- Do not duplicate projects, relationships, responsibilities, or open threads.
- Merge similar items instead of creating near-duplicates.
- Use only information that is explicitly stated or strongly supported.
- Do not add sensitive personal information.
- Keep the ontology compact and useful for downstream meeting notes.
- Be BRIEF: at most 3 items in each array (merge/drop to keep only the most important, highest-confidence facts), and every string field a short phrase of at most 80 characters, never a sentence or paragraph. A short, COMPLETE ontology is better than a long one.
- Output valid JSON only. Do not output markdown.
- Output ONLY the keys in the required structure below. Never output summary_for_meeting_context or any other extra key, even if it appeared in the existing ontology.
- Refresh confidence scores on merge: each object's confidence should reflect current transcript support for that block.

Merge behavior:
- If the same project appears again, update its role, status, or importance only if the new transcript adds useful information.
- If the same relationship appears again, enrich the context instead of duplicating it.
- If a responsibility is repeated, keep one clear version.
- If an open thread is resolved, change its status to "resolved".
- If a new unresolved topic appears, add it to open_threads.
- Update last_updated_at to "${currentDate}".

Required JSON structure (same shape as new profiles; fill arrays/objects according to merged content):
${requiredOntologyJsonSchema(speakerId, name, currentDate)}

Existing ontology:
${existingOntologyJson}

New transcript:
${transcript}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // Auth gate: require an authenticated user. Primary signal is the app JWT minted by
  // supabase-token (already tenant-gated); fall back to a Microsoft Graph access token.
  // Without this, anyone could burn the org's Gemini quota. Mirrors note-audio-url.
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

  try {
    const body = (await req.json()) as RequestBody;
    const { speakerName, speakerId = '', transcriptText, existingProfile } = body;

    const apiKey = Deno.env.get('GEMINI_API_KEY') ?? Deno.env.get('GOOGLE_API_KEY') ?? '';
    const model = (Deno.env.get('GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL).trim();
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: 'No Gemini API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) as a Supabase secret.',
        }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    if (!speakerName || !transcriptText) {
      return new Response(JSON.stringify({ error: 'speakerName and transcriptText are required.' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const currentDate = new Date().toISOString();
    const resolvedSpeakerId = speakerId || speakerName.toLowerCase().replace(/\s+/g, '_');

    // Resolve existing profile: convert legacy markdown → minimal ontology JSON if needed
    let existingOntologyJson: string | null = null;
    if (existingProfile && existingProfile.trim()) {
      if (isMarkdownProfile(existingProfile)) {
        const wrapped = wrapMarkdownProfile(speakerName, resolvedSpeakerId);
        existingOntologyJson = JSON.stringify(wrapped, null, 2);
      } else {
        existingOntologyJson = sanitizeExistingOntologyForUpdate(existingProfile.trim(), speakerName, resolvedSpeakerId);
      }
    }

    // Cap the transcript so a long meeting can't push a single call past the 150s limit.
    const cappedTranscript = transcriptText.slice(0, MAX_TRANSCRIPT_CHARS);

    const systemPrompt = existingOntologyJson ? UPDATE_PROFILE_SYSTEM : NEW_PROFILE_SYSTEM;
    const userPrompt = existingOntologyJson
      ? buildUpdateProfilePrompt(speakerName, resolvedSpeakerId, existingOntologyJson, cappedTranscript, currentDate)
      : buildNewProfilePrompt(speakerName, resolvedSpeakerId, cappedTranscript, currentDate);

    const geminiResult = await callGeminiWithRetryAndFallback(apiKey, model, systemPrompt, userPrompt, speakerName, resolvedSpeakerId);
    // O-1: on failure return an ERROR (not an empty ontology). The client then throws and
    // does NOT overwrite the existing profile, so a bad LLM response can no longer wipe it.
    if (geminiResult.error || !geminiResult.ontology) {
      return new Response(JSON.stringify({ error: geminiResult.error ?? 'Ontology generation failed.' }), {
        status: geminiResult.status ?? 502,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ profile: JSON.stringify(geminiResult.ontology), model: geminiResult.model ?? model }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
