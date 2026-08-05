import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

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
}

// Bounds to keep the prompt (and cost) sane on long meetings / large speaker directories.
const MAX_TRANSCRIPT_CHARS = 24000;
const MAX_ROSTER_ENTRIES = 40;
const MAX_LABELS = 30;
const MAX_SUMMARY_CHARS = 700;

/** Override with `GEMINI_MODEL` secret. If a model 404s, set e.g. `gemini-2.5-flash-lite` or `gemini-2.5-flash`. */
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_GEMINI_FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'];
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

const IDENTIFY_SYSTEM_PROMPT = `You identify who each anonymous speaker in a meeting transcript most likely is.
You are given: (1) a transcript whose speakers are anonymous labels like "Speaker A", "Speaker B"; (2) a roster of the user's KNOWN speakers, each with a short profile summary; (3) the display name of the logged-in user ("self"), who is usually present in their own meetings.

For EACH distinct anonymous label, decide the single most likely identity using text signals only:
- Direct address / vocatives ("Thanks, Hansoo", "Andrew, what do you think?") and self-introductions ("this is Jin") — these are strong.
- Topic / project / responsibility overlap with a roster profile.
- The self prior: if address or context indicates the logged-in user, mark isSelf true.

Rules:
- If the label best matches a roster entry, return its exact speakerId and name.
- If the transcript clearly NAMES a person who is NOT in the roster, return speakerId=null and that name (a new-name suggestion).
- If you cannot tell, return speakerId=null, name=null (unknown). Do NOT guess to fill every slot.
- confidence is 0.0–1.0 reflecting how sure you are. Be conservative: prefer a lower confidence or unknown over a wrong identity.
- Never invent a speakerId that is not in the roster.
- rationale: one short sentence citing the evidence (a quote or the matched topic).

Return ONLY JSON of the exact shape:
{"suggestions":[{"label":"Speaker A","speakerId":"<roster id or null>","name":"<name or null>","confidence":0.0,"isSelf":false,"rationale":"..."}]}
Include exactly one object per distinct label given, in the same order.`;

function buildIdentifyUserPrompt(body: RequestBody): string {
  const transcript = body.transcriptText.slice(0, MAX_TRANSCRIPT_CHARS);
  const labels = body.labels.slice(0, MAX_LABELS);
  const roster = body.roster.slice(0, MAX_ROSTER_ENTRIES);

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
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : null;

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
  const roster = Array.isArray(body.roster)
    ? body.roster
        .filter((r): r is RosterEntry =>
          Boolean(r) && typeof r === 'object' &&
          typeof (r as RosterEntry).speakerId === 'string' &&
          typeof (r as RosterEntry).name === 'string')
        .map((r) => ({ speakerId: r.speakerId, name: r.name, summary: typeof r.summary === 'string' ? r.summary : '' }))
    : [];

  if (!transcriptText || labels.length === 0) {
    return jsonResponse({ error: 'transcriptText and at least one label are required.' }, 400);
  }

  const apiKey = Deno.env.get('GEMINI_API_KEY') ?? Deno.env.get('GOOGLE_API_KEY') ?? '';
  const model = (Deno.env.get('GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL).trim();
  if (!apiKey) {
    return jsonResponse({ error: 'No Gemini API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) as a Supabase secret.' }, 500);
  }

  const normalizedBody: RequestBody = { transcriptText, labels, roster, selfName: body.selfName };
  const userPrompt = buildIdentifyUserPrompt(normalizedBody);

  const result = await callGeminiWithRetryAndFallback(apiKey, model, IDENTIFY_SYSTEM_PROMPT, userPrompt);
  if (result.error) {
    return jsonResponse({ error: result.error }, result.status ?? 502);
  }

  const validSpeakerIds = new Set(roster.map((r) => r.speakerId));
  const suggestions = parseSuggestions(result.rawText, validSpeakerIds, labels.slice(0, MAX_LABELS));
  return jsonResponse({ suggestions });
});
