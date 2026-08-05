import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// F1c: maintains a durable, per-user "personal memory" base by merging one
// meeting's transcript into the user's existing memory. USER-centered across all
// their meetings (open commitments incl. ones OTHERS assigned to them, frequent
// collaborators, active projects, recurring topics) — distinct from the
// per-speaker "self" profile (which only captures what the user personally said).
//
// Stateless like generate-profile: the client passes the existing memory in and
// writes the merged result back under its own RLS. Mirrors generate-profile /
// identify-speakers for auth gate, CORS, and the Gemini call chain.

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

interface RequestBody {
  transcriptText: string;
  selfName?: string | null;
  noteId?: string | null;
  existingMemory?: unknown;
}

// Bounds to keep the prompt (and cost) sane, and to stop the base from growing
// without limit. The transcript and the existing memory are both truncated.
const MAX_TRANSCRIPT_CHARS = 24000;
const MAX_MEMORY_CHARS = 12000;
const MAX_ACTION_ITEMS = 100;
const MAX_COLLABORATORS = 100;
const MAX_PROJECTS = 60;
const MAX_TOPICS = 60;
const MAX_STR = 400;

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
        maxOutputTokens: 8192,
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
    error: lastResult?.error ?? 'User-memory update failed after retries and fallback models.',
    status: lastResult?.status ?? 502,
  };
}

const MEMORY_SYSTEM_PROMPT = `You maintain a durable PERSONAL MEMORY for a single logged-in user, aggregated across all their meetings. You are given the user's EXISTING memory (JSON) and ONE new meeting transcript. Return the UPDATED memory that folds this meeting into what was already known.

The memory is USER-CENTERED. Capture:
- open_action_items: things the user still needs to do or follow up on, INCLUDING items other people assigned to them ("Andrew, can you send the deck?"). Set assigned_by to who assigned it (or "self"). Drop an item if this meeting clearly says it is now done.
- collaborators: people the user meets with. Increment meeting_count when a person appears again; update last_seen. Do not list the user themselves.
- active_projects: projects the user is working on, with a short status.
- recurring_topics: topics/decisions that recur across the user's meetings.

Merge rules:
- MERGE, do not duplicate: if a new item/person/project/topic already exists, update it in place (refine text, bump meeting_count, update status) instead of adding a near-duplicate.
- Keep only what is still relevant. It is fine to drop stale/finished items.
- confidence is 0.0–1.0. Be conservative; prefer omitting over inventing. Never fabricate names or commitments not supported by the transcript.
- source_note_id: for a NEW action item, set it to the provided current note id; otherwise keep the existing value.
- Preserve existing entries that this meeting does not contradict.

Return ONLY JSON of the exact shape (no prose, no markdown):
{"memory":{"open_action_items":[{"text":"","assigned_by":null,"source_note_id":null,"confidence":0.0}],"collaborators":[{"name":"","speaker_id":null,"meeting_count":1,"last_seen":null,"confidence":0.0}],"active_projects":[{"name":"","status":null,"confidence":0.0}],"recurring_topics":[{"topic":"","confidence":0.0}]}}`;

function buildUserPrompt(body: RequestBody, existingMemoryJson: string): string {
  const transcript = body.transcriptText.slice(0, MAX_TRANSCRIPT_CHARS);
  const selfLine = body.selfName?.trim()
    ? `Logged-in user (self) — whose memory this is: "${body.selfName.trim()}"`
    : 'Logged-in user (self): unknown';
  const noteLine = body.noteId?.trim() ? `Current note id (for new items' source_note_id): "${body.noteId.trim()}"` : 'Current note id: (none)';

  return `${selfLine}
${noteLine}

EXISTING memory (merge INTO this; empty object means first meeting):
${existingMemoryJson}

NEW meeting transcript:
${transcript}`;
}

interface ActionItem { text: string; assigned_by: string | null; source_note_id: string | null; confidence: number }
interface Collaborator { name: string; speaker_id: string | null; meeting_count: number; last_seen: string | null; confidence: number }
interface Project { name: string; status: string | null; confidence: number }
interface Topic { topic: string; confidence: number }
interface UserMemory {
  open_action_items: ActionItem[];
  collaborators: Collaborator[];
  active_projects: Project[];
  recurring_topics: Topic[];
}

function clamp01(n: unknown): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function str(v: unknown, max = MAX_STR): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function optStr(v: unknown, max = MAX_STR): string | null {
  const s = str(v, max);
  return s ? s : null;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Coerce arbitrary input (existing memory or model output) into a bounded, well-typed UserMemory. */
function normalizeMemory(input: unknown): UserMemory {
  const o = asObject(input);
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  const open_action_items: ActionItem[] = arr(o.open_action_items)
    .map((raw) => {
      const it = asObject(raw);
      const text = str(it.text);
      if (!text) return null;
      return {
        text,
        assigned_by: optStr(it.assigned_by, 120),
        source_note_id: optStr(it.source_note_id, 80),
        confidence: clamp01(it.confidence),
      } as ActionItem;
    })
    .filter((x): x is ActionItem => x !== null)
    .slice(0, MAX_ACTION_ITEMS);

  const collaborators: Collaborator[] = arr(o.collaborators)
    .map((raw) => {
      const it = asObject(raw);
      const name = str(it.name, 120);
      if (!name) return null;
      const mc = typeof it.meeting_count === 'number' && Number.isFinite(it.meeting_count)
        ? Math.max(1, Math.min(100000, Math.floor(it.meeting_count)))
        : 1;
      return {
        name,
        speaker_id: optStr(it.speaker_id, 80),
        meeting_count: mc,
        last_seen: optStr(it.last_seen, 40),
        confidence: clamp01(it.confidence),
      } as Collaborator;
    })
    .filter((x): x is Collaborator => x !== null)
    .slice(0, MAX_COLLABORATORS);

  const active_projects: Project[] = arr(o.active_projects)
    .map((raw) => {
      const it = asObject(raw);
      const name = str(it.name, 160);
      if (!name) return null;
      return { name, status: optStr(it.status, 200), confidence: clamp01(it.confidence) } as Project;
    })
    .filter((x): x is Project => x !== null)
    .slice(0, MAX_PROJECTS);

  const recurring_topics: Topic[] = arr(o.recurring_topics)
    .map((raw) => {
      const it = asObject(raw);
      const topic = str(it.topic, 200);
      if (!topic) return null;
      return { topic, confidence: clamp01(it.confidence) } as Topic;
    })
    .filter((x): x is Topic => x !== null)
    .slice(0, MAX_TOPICS);

  return { open_action_items, collaborators, active_projects, recurring_topics };
}

function parseMergedMemory(rawText: string): UserMemory | null {
  const stripped = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  const mem = (parsed as { memory?: unknown }).memory ?? parsed;
  return normalizeMemory(mem);
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
  if (!transcriptText) {
    return jsonResponse({ error: 'transcriptText is required.' }, 400);
  }

  const apiKey = Deno.env.get('GEMINI_API_KEY') ?? Deno.env.get('GOOGLE_API_KEY') ?? '';
  const model = (Deno.env.get('GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL).trim();
  if (!apiKey) {
    return jsonResponse({ error: 'No Gemini API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY) as a Supabase secret.' }, 500);
  }

  // Normalize the incoming existing memory before prompting so a malformed base
  // can never poison the merge, and cap its serialized size.
  const existingMemory = normalizeMemory(body.existingMemory);
  let existingMemoryJson = JSON.stringify(existingMemory);
  if (existingMemoryJson.length > MAX_MEMORY_CHARS) {
    existingMemoryJson = existingMemoryJson.slice(0, MAX_MEMORY_CHARS);
  }

  const normalizedBody: RequestBody = { transcriptText, selfName: body.selfName, noteId: body.noteId };
  const userPrompt = buildUserPrompt(normalizedBody, existingMemoryJson);

  const result = await callGeminiWithRetryAndFallback(apiKey, model, MEMORY_SYSTEM_PROMPT, userPrompt);
  if (result.error) {
    return jsonResponse({ error: result.error }, result.status ?? 502);
  }

  const merged = parseMergedMemory(result.rawText);
  if (!merged) {
    return jsonResponse({ error: 'Could not parse the updated memory from the model output.' }, 502);
  }

  return jsonResponse({ memory: merged });
});
