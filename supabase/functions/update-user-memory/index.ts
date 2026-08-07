import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// F1' (dynamic relational memory): maintains a durable, per-user "personal
// memory" as a list of natural-language MEMORY ITEMS (ChatGPT / Claude-MEMORY.md
// style) rather than flat typed buckets. Given the user's existing memory and one
// new meeting transcript, an LLM emits an ordered list of ops (add / update /
// supersede / archive) that the server applies deterministically — dynamic
// learning, not append-only. USER-centered across all their meetings.
//
// Stateless like generate-profile: the client passes the existing memory in and
// writes the merged result back under its own RLS. Mirrors generate-profile /
// identify-speakers for auth gate, CORS, and the Gemini call chain.
//
// Old shape (F1c, version absent): { open_action_items[], collaborators[],
// active_projects[], recurring_topics[] }. On the first F1' write we fold those
// buckets into seed narrative items, then run the normal op flow on top.

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
const MAX_MEMORY_CHARS = 16000;
const MAX_ITEM_TEXT = 600;
const MAX_ENTITY = 80;
const MAX_ENTITIES_PER_ITEM = 12;
const MAX_OPS = 80;
// Item caps: at most ACTIVE_CAP active items (least-recently-updated beyond it are
// archived); at most TOTAL_CAP items overall (oldest archived beyond it are dropped).
const ACTIVE_CAP = 50;
const TOTAL_CAP = 80;
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
        // Disable "thinking" so the whole token budget goes to the JSON output.
        // On 2.5 models, thinking tokens can consume maxOutputTokens and truncate
        // the JSON mid-object, which then fails to parse.
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
    error: lastResult?.error ?? 'User-memory update failed after retries and fallback models.',
    status: lastResult?.status ?? 502,
  };
}

const MEMORY_SYSTEM_PROMPT = `You maintain a durable PERSONAL MEMORY for a single logged-in user, aggregated across all their meetings. The memory is a list of natural-language MEMORY ITEMS — each one self-contained sentence that captures context and relationships in prose, like a long-term personal memory (ChatGPT / MEMORY.md style). You are given the user's EXISTING memory items (each with an id) and ONE new meeting transcript. Emit an ordered list of OPERATIONS that fold this meeting into the memory.

The memory is USER-CENTERED and durable. Capture things worth remembering across meetings:
- open commitments the user still owes or is waiting on (including tasks other people assigned to them),
- who the user works with and the nature of those working relationships,
- active projects and their current status,
- recurring topics, decisions, and the WHY/HOW behind them,
- stable preferences the user expresses.

Write each memory as ONE natural-language sentence that carries its own context (who / what / why), not a bare keyword. Good: "Andrew owns all software implementation; Eun Seok is the designer and is only pulled in when a screen needs new design." Bad: "Eun Seok: designer".

OPERATIONS (emit an ordered JSON array; the server applies them in order):
- {"op":"add","text":"...","entities":["..."]}                 add a new memory
- {"op":"update","id":"...","text":"...","entities":["..."]}   refine an existing memory in place
- {"op":"supersede","id":"...","text":"...","entities":["..."]} replace a stale or contradicted memory with corrected info
- {"op":"archive","id":"..."}                                  the memory is no longer relevant

Rules:
- Prefer update/supersede over adding a near-duplicate of an existing memory.
- Supersede when the new meeting contradicts or resolves an existing memory (e.g. "the 50MB upload limit is under investigation" becomes "the 50MB limit was fixed via Supabase Pro; the cap is now 200MB").
- Only emit ops for genuinely durable, meeting-crossing context. Skip one-off small talk.
- Do NOT record the user themselves as a collaborator or relationship.
- Never fabricate names, commitments, or facts not supported by the transcript. Be conservative: when unsure, emit nothing for that point.
- entities: a few light tags (people / projects / topics) named in the item, to seed a future relationship graph. Keep them short.
- Use ids EXACTLY as given for update/supersede/archive. Never invent an id.
- If nothing durable is worth changing, return an empty ops array.

Return ONLY JSON of this exact shape (no prose, no markdown):
{"ops":[{"op":"add","text":"","entities":[""]}]}`;

function buildUserPrompt(itemsJson: string, transcript: string, selfName: string | null | undefined, noteId: string | null | undefined): string {
  const selfLine = selfName?.trim()
    ? `Logged-in user (self) — whose memory this is: "${selfName.trim()}"`
    : 'Logged-in user (self): unknown';
  const noteLine = noteId?.trim()
    ? `Current note id (provenance for new memories): "${noteId.trim()}"`
    : 'Current note id: (none)';

  return `${selfLine}
${noteLine}

EXISTING memory items (JSON array; each has an id — reference it in update / supersede / archive):
${itemsJson}

NEW meeting transcript:
${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`;
}

type ItemStatus = 'active' | 'archived';

interface MemoryItem {
  id: string;
  text: string;
  entities: string[];
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
  sourceNoteIds: string[];
}

type Op =
  | { op: 'add'; text: string; entities: string[] }
  | { op: 'update'; id: string; text: string; entities: string[] }
  | { op: 'supersede'; id: string; text: string; entities: string[] }
  | { op: 'archive'; id: string };

function str(v: unknown, max = MAX_STR): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function normalizeEntities(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    const s = str(raw, MAX_ENTITY);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_ENTITIES_PER_ITEM) break;
  }
  return out;
}

function newId(): string {
  return crypto.randomUUID();
}

function addNoteId(existing: string[], noteId: string | null | undefined): string[] {
  const id = noteId?.trim();
  if (!id) return existing;
  return existing.includes(id) ? existing : [...existing, id];
}

/** Coerce an already-v2 item into a well-typed, bounded MemoryItem. */
function normalizeItem(raw: unknown, now: string): MemoryItem | null {
  const o = asObject(raw);
  const text = str(o.text, MAX_ITEM_TEXT);
  if (!text) return null;
  const id = str(o.id, 80) || newId();
  const status: ItemStatus = o.status === 'archived' ? 'archived' : 'active';
  const createdAt = str(o.createdAt, 40) || now;
  const updatedAt = str(o.updatedAt, 40) || createdAt;
  const sourceNoteIds = Array.isArray(o.sourceNoteIds)
    ? (o.sourceNoteIds as unknown[]).map((v) => str(v, 80)).filter(Boolean).slice(0, 50)
    : [];
  return { id, text, entities: normalizeEntities(o.entities), status, createdAt, updatedAt, sourceNoteIds };
}

function isV2(input: unknown): boolean {
  const o = asObject(input);
  return o.version === 2 && Array.isArray(o.items);
}

/** Fold the old F1c bucket shape into seed narrative items (run once on migration). */
function foldV1ToItems(input: unknown, selfName: string | null | undefined, now: string): MemoryItem[] {
  const o = asObject(input);
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const self = selfName?.trim().toLowerCase() ?? '';
  const items: MemoryItem[] = [];

  const seed = (text: string, entities: string[]) => {
    const t = str(text, MAX_ITEM_TEXT);
    if (!t) return;
    items.push({
      id: newId(),
      text: t,
      entities: normalizeEntities(entities),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      sourceNoteIds: [],
    });
  };

  const clean = (x: string): string => x.replace(/[\s.]+$/, '');
  for (const raw of arr(o.open_action_items)) {
    const it = asObject(raw);
    const text = str(it.text, MAX_ITEM_TEXT);
    if (!text) continue;
    const by = str(it.assigned_by, 120);
    const suffix = by && by.toLowerCase() !== 'self' && by.toLowerCase() !== self ? ` (assigned by ${by})` : '';
    seed(`Open commitment: ${clean(text)}${suffix}.`, by && by.toLowerCase() !== 'self' ? [by] : []);
  }
  for (const raw of arr(o.collaborators)) {
    const it = asObject(raw);
    const name = str(it.name, 120);
    if (!name || name.toLowerCase() === self) continue;
    const mc = typeof it.meeting_count === 'number' && it.meeting_count > 1 ? ` (seen across ${Math.floor(it.meeting_count)} meetings)` : '';
    seed(`${clean(name)} is a recurring collaborator of the user${mc}.`, [name]);
  }
  for (const raw of arr(o.active_projects)) {
    const it = asObject(raw);
    const name = str(it.name, 160);
    if (!name) continue;
    const status = str(it.status, 200);
    seed(`Active project "${clean(name)}"${status ? ` — ${clean(status)}` : ''}.`, [name]);
  }
  for (const raw of arr(o.recurring_topics)) {
    const it = asObject(raw);
    const topic = str(it.topic, 200);
    if (!topic) continue;
    seed(`Recurring topic: ${clean(topic)}.`, [topic]);
  }

  return items;
}

/** Produce the starting item list: normalize if already v2, otherwise migrate v1 buckets. */
function toStartingItems(existingMemory: unknown, selfName: string | null | undefined, now: string): MemoryItem[] {
  if (isV2(existingMemory)) {
    const o = asObject(existingMemory);
    return (o.items as unknown[])
      .map((raw) => normalizeItem(raw, now))
      .filter((x): x is MemoryItem => x !== null)
      .slice(0, TOTAL_CAP);
  }
  return foldV1ToItems(existingMemory, selfName, now).slice(0, TOTAL_CAP);
}

/** Parse the model's ops array, tolerating markdown fences and stray prose. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to substring extraction */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* give up */
    }
  }
  return undefined;
}

function parseOps(rawText: string): Op[] | null {
  const stripped = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const parsed = tryParseJson(stripped);
  if (parsed === undefined) return null;
  const rawOps = (parsed as { ops?: unknown }).ops ?? parsed;
  if (!Array.isArray(rawOps)) return null;

  const ops: Op[] = [];
  for (const raw of rawOps.slice(0, MAX_OPS)) {
    const o = asObject(raw);
    const kind = str(o.op, 20).toLowerCase();
    if (kind === 'add') {
      const text = str(o.text, MAX_ITEM_TEXT);
      if (text) ops.push({ op: 'add', text, entities: normalizeEntities(o.entities) });
    } else if (kind === 'update' || kind === 'supersede') {
      const id = str(o.id, 80);
      const text = str(o.text, MAX_ITEM_TEXT);
      if (id && text) ops.push({ op: kind, id, text, entities: normalizeEntities(o.entities) });
    } else if (kind === 'archive') {
      const id = str(o.id, 80);
      if (id) ops.push({ op: 'archive', id });
    }
  }
  return ops;
}

/** Apply the ops to the item list deterministically. Unknown ids are ignored. */
function applyOps(items: MemoryItem[], ops: Op[], noteId: string | null | undefined, now: string): MemoryItem[] {
  const byId = new Map<string, MemoryItem>();
  for (const it of items) byId.set(it.id, it);

  for (const op of ops) {
    if (op.op === 'add') {
      const item: MemoryItem = {
        id: newId(),
        text: op.text,
        entities: op.entities,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        sourceNoteIds: addNoteId([], noteId),
      };
      items.push(item);
      byId.set(item.id, item);
    } else if (op.op === 'update' || op.op === 'supersede') {
      const item = byId.get(op.id);
      if (!item) continue;
      item.text = op.text;
      if (op.entities.length) item.entities = op.entities;
      item.status = 'active';
      item.updatedAt = now;
      item.sourceNoteIds = addNoteId(item.sourceNoteIds, noteId);
    } else if (op.op === 'archive') {
      const item = byId.get(op.id);
      if (!item) continue;
      item.status = 'archived';
      item.updatedAt = now;
    }
  }
  return items;
}

/** Archive least-recently-updated active items beyond ACTIVE_CAP; drop oldest archived beyond TOTAL_CAP. */
function enforceCaps(items: MemoryItem[]): MemoryItem[] {
  const activeByRecency = items
    .filter((i) => i.status === 'active')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const demote = new Set(activeByRecency.slice(ACTIVE_CAP).map((i) => i.id));
  for (const it of items) if (demote.has(it.id)) it.status = 'archived';

  if (items.length <= TOTAL_CAP) return items;
  const archivedOldestFirst = items
    .filter((i) => i.status === 'archived')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const drop = new Set(archivedOldestFirst.slice(0, items.length - TOTAL_CAP).map((i) => i.id));
  return items.filter((i) => !drop.has(i.id));
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

  const now = new Date().toISOString();
  const selfName = body.selfName ?? null;
  const noteId = body.noteId ?? null;

  // Starting items: normalize an existing v2 memory, or fold the old F1c buckets
  // into seed items on first migration. Then prompt the LLM for ops over the
  // active items, apply them deterministically, and enforce the caps.
  const startingItems = toStartingItems(body.existingMemory, selfName, now);

  const activeForPrompt = startingItems
    .filter((i) => i.status === 'active')
    .map((i) => ({ id: i.id, text: i.text, entities: i.entities }));
  let itemsJson = JSON.stringify(activeForPrompt);
  if (itemsJson.length > MAX_MEMORY_CHARS) itemsJson = itemsJson.slice(0, MAX_MEMORY_CHARS);

  const userPrompt = buildUserPrompt(itemsJson, transcriptText, selfName, noteId);

  const result = await callGeminiWithRetryAndFallback(apiKey, model, MEMORY_SYSTEM_PROMPT, userPrompt);
  if (result.error) {
    return jsonResponse({ error: result.error }, result.status ?? 502);
  }

  const ops = parseOps(result.rawText);
  if (ops === null) {
    // Include a short preview of the raw model output so a parse failure can be
    // diagnosed from the client console without server log access.
    return jsonResponse(
      {
        error: 'Could not parse the memory operations from the model output.',
        debug: (result.rawText || '').slice(0, 600),
        model: result.model ?? null,
      },
      502
    );
  }

  const items = enforceCaps(applyOps(startingItems, ops, noteId, now));
  return jsonResponse({ memory: { version: 2, items } });
});
