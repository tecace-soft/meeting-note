// F1' personal memory + F4 note_insight, folded server-side after every summary.
//
// This runs inside the workflow-server summarize pipeline (fresh + regenerate) so
// it covers EVERY note regardless of client. Memory was previously folded only by
// the web client (src/lib/userMemory.ts), which left mobile-created notes (and
// their owners' memory) empty — the reason the boss saw an empty memory screen.
//
// Two focused Gemini calls per note:
//  - MEMORY: durable, cross-meeting UNDERSTANDING as narrative items, merged via
//    add/update/supersede/archive ops applied deterministically here.
//  - INSIGHT (F4): a per-THIS-meeting structured index (actions/decisions/topics/
//    people/companies) written to note_insight for keyword+structured search.
// Kept as two prompts so neither can truncate or degrade the other. The logic
// mirrors the (now superseded) update-user-memory edge function.

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callGemini, GeminiApiError } from './gemini.js';

// Bounds to keep prompt/cost sane and the base from growing without limit.
const MAX_TRANSCRIPT_CHARS = 24000;
const MAX_MEMORY_CHARS = 16000;
const MAX_ITEM_TEXT = 600;
const MAX_ENTITY = 80;
const MAX_ENTITIES_PER_ITEM = 12;
const MAX_OPS = 80;
const ACTIVE_CAP = 50;
const TOTAL_CAP = 80;
const MAX_STR = 400;
const PROCESSED_CAP = 500;

// F4 note_insight bounds.
const MAX_INSIGHT_ITEMS = 30;
const MAX_INSIGHT_TEXT = 400;
const MAX_INSIGHT_FIELD = 120;

const DEFAULT_MEMORY_MODEL = 'gemini-2.5-flash-lite';
const DEFAULT_MEMORY_FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'];

type ItemStatus = 'active' | 'archived';

export interface MemoryItem {
  id: string;
  text: string;
  entities: string[];
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
  sourceNoteIds: string[];
}

export type Op =
  | { op: 'add'; text: string; entities: string[] }
  | { op: 'update'; id: string; text: string; entities: string[] }
  | { op: 'supersede'; id: string; text: string; entities: string[] }
  | { op: 'archive'; id: string };

export interface InsightAction {
  text: string;
  owner: string;
  due: string;
  status: string;
}
export interface InsightDecision {
  text: string;
  rationale: string;
}
export interface NoteInsight {
  actions: InsightAction[];
  decisions: InsightDecision[];
  topics: string[];
  people: string[];
  companies: string[];
  sourceModel: string | null;
}

function str(v: unknown, max = MAX_STR): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function normalizeEntities(v: unknown): string[] {
  const out: string[] = [];
  for (const raw of asArray(v)) {
    const sv = str(raw, MAX_ENTITY);
    if (sv && !out.includes(sv)) out.push(sv);
    if (out.length >= MAX_ENTITIES_PER_ITEM) break;
  }
  return out;
}

function newId(): string {
  return randomUUID();
}

function addNoteId(existing: string[], noteId: string | null | undefined): string[] {
  const id = noteId?.trim();
  if (!id) return existing;
  return existing.includes(id) ? existing : [...existing, id];
}

function normalizeItem(raw: unknown, now: string): MemoryItem | null {
  const o = asObject(raw);
  const text = str(o.text, MAX_ITEM_TEXT);
  if (!text) return null;
  const id = str(o.id, 80) || newId();
  const status: ItemStatus = o.status === 'archived' ? 'archived' : 'active';
  const createdAt = str(o.createdAt, 40) || now;
  const updatedAt = str(o.updatedAt, 40) || createdAt;
  const sourceNoteIds = asArray(o.sourceNoteIds).map((v) => str(v, 80)).filter(Boolean).slice(0, 50);
  return { id, text, entities: normalizeEntities(o.entities), status, createdAt, updatedAt, sourceNoteIds };
}

function isV2(input: unknown): boolean {
  const o = asObject(input);
  return o.version === 2 && Array.isArray(o.items);
}

/** Fold the old F1c bucket shape into seed narrative items (run once on migration). */
function foldV1ToItems(input: unknown, selfName: string | null | undefined, now: string): MemoryItem[] {
  const o = asObject(input);
  const self = selfName?.trim().toLowerCase() ?? '';
  const items: MemoryItem[] = [];

  const seed = (text: string, entities: string[]) => {
    const t = str(text, MAX_ITEM_TEXT);
    if (!t) return;
    items.push({ id: newId(), text: t, entities: normalizeEntities(entities), status: 'active', createdAt: now, updatedAt: now, sourceNoteIds: [] });
  };

  const clean = (x: string): string => x.replace(/[\s.]+$/, '');
  for (const raw of asArray(o.open_action_items)) {
    const it = asObject(raw);
    const text = str(it.text, MAX_ITEM_TEXT);
    if (!text) continue;
    const by = str(it.assigned_by, 120);
    const suffix = by && by.toLowerCase() !== 'self' && by.toLowerCase() !== self ? ` (assigned by ${by})` : '';
    seed(`Open commitment: ${clean(text)}${suffix}.`, by && by.toLowerCase() !== 'self' ? [by] : []);
  }
  for (const raw of asArray(o.collaborators)) {
    const it = asObject(raw);
    const name = str(it.name, 120);
    if (!name || name.toLowerCase() === self) continue;
    const mc = typeof it.meeting_count === 'number' && it.meeting_count > 1 ? ` (seen across ${Math.floor(it.meeting_count)} meetings)` : '';
    seed(`${clean(name)} is a recurring collaborator of the user${mc}.`, [name]);
  }
  for (const raw of asArray(o.active_projects)) {
    const it = asObject(raw);
    const name = str(it.name, 160);
    if (!name) continue;
    const status = str(it.status, 200);
    seed(`Active project "${clean(name)}"${status ? ` — ${clean(status)}` : ''}.`, [name]);
  }
  for (const raw of asArray(o.recurring_topics)) {
    const it = asObject(raw);
    const topic = str(it.topic, 200);
    if (!topic) continue;
    seed(`Recurring topic: ${clean(topic)}.`, [topic]);
  }
  return items;
}

function toStartingItems(existingMemory: unknown, selfName: string | null | undefined, now: string): MemoryItem[] {
  if (isV2(existingMemory)) {
    return asArray(asObject(existingMemory).items)
      .map((raw) => normalizeItem(raw, now))
      .filter((x): x is MemoryItem => x !== null)
      .slice(0, TOTAL_CAP);
  }
  return foldV1ToItems(existingMemory, selfName, now).slice(0, TOTAL_CAP);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
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

function applyOps(items: MemoryItem[], ops: Op[], noteId: string | null | undefined, now: string): MemoryItem[] {
  const byId = new Map<string, MemoryItem>();
  for (const it of items) byId.set(it.id, it);

  for (const op of ops) {
    if (op.op === 'add') {
      const item: MemoryItem = { id: newId(), text: op.text, entities: op.entities, status: 'active', createdAt: now, updatedAt: now, sourceNoteIds: addNoteId([], noteId) };
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

function enforceCaps(items: MemoryItem[]): MemoryItem[] {
  const activeByRecency = items.filter((i) => i.status === 'active').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const demote = new Set(activeByRecency.slice(ACTIVE_CAP).map((i) => i.id));
  for (const it of items) if (demote.has(it.id)) it.status = 'archived';

  if (items.length <= TOTAL_CAP) return items;
  const archivedOldestFirst = items.filter((i) => i.status === 'archived').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const drop = new Set(archivedOldestFirst.slice(0, items.length - TOTAL_CAP).map((i) => i.id));
  return items.filter((i) => !drop.has(i.id));
}

function normalizeInsightStrings(v: unknown): string[] {
  const out: string[] = [];
  for (const raw of asArray(v)) {
    const value = str(raw, MAX_INSIGHT_FIELD);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= MAX_INSIGHT_ITEMS) break;
  }
  return out;
}

function parseInsight(rawText: string, model: string | null): NoteInsight | null {
  const stripped = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const parsed = tryParseJson(stripped);
  if (parsed === undefined) return null;
  const o = asObject(parsed);

  const actions: InsightAction[] = [];
  for (const raw of asArray(o.actions).slice(0, MAX_INSIGHT_ITEMS)) {
    const a = asObject(raw);
    const text = str(a.text, MAX_INSIGHT_TEXT);
    if (!text) continue;
    actions.push({ text, owner: str(a.owner, MAX_INSIGHT_FIELD), due: str(a.due, MAX_INSIGHT_FIELD), status: str(a.status, 40) || 'open' });
  }

  const decisions: InsightDecision[] = [];
  for (const raw of asArray(o.decisions).slice(0, MAX_INSIGHT_ITEMS)) {
    const d = asObject(raw);
    const text = str(d.text, MAX_INSIGHT_TEXT);
    if (!text) continue;
    decisions.push({ text, rationale: str(d.rationale, MAX_INSIGHT_TEXT) });
  }

  return {
    actions,
    decisions,
    topics: normalizeInsightStrings(o.topics),
    people: normalizeInsightStrings(o.people),
    companies: normalizeInsightStrings(o.companies),
    sourceModel: model,
  };
}

const MEMORY_SYSTEM_PROMPT = `You maintain a durable PERSONAL MEMORY for a single logged-in user, accumulated across all their meetings. Think of it as the user's evolving long-term UNDERSTANDING of their own work (ChatGPT / MEMORY.md style) — NOT a to-do list, and NOT a CRM dump of names and topics. You are given the user's EXISTING memory items (each with an id) and ONE new meeting transcript. Emit an ordered list of OPERATIONS that fold this meeting into the memory.

WHAT TO CAPTURE — prioritize CONTEXT and RELATIONSHIPS over bare facts:
- Decisions and the REASONING behind them: what was decided, WHY, what was rejected, and the constraint or trade-off that drove it.
- How things CONNECT: how a project, person, problem, or topic relates to another; dependencies; how one thing led to, unblocked, or blocks another.
- How things EVOLVED: what changed since before and why (record this with a supersede).
- The nature of working RELATIONSHIPS: not "X is a collaborator", but what the user and X are doing together and who owns what.
- The user's priorities, direction, and stable preferences.
Open commitments still matter, but record them WITH their context and why — never as a bare task line.

STYLE:
- Prefer FEWER, RICHER, connected memories over many shallow ones. One sentence that ties a decision to its reason beats three fact fragments.
- Each memory is one self-contained sentence carrying who / what / WHY.
  Good: "The team is moving memory from flat fact-buckets to a narrative + relational store because the boss wants ChatGPT-style memory that captures why decisions were made, not just a CRM-like list."
  Bad: "Memory feature development.", "50MB limit.", "Admin dashboard: no permission."
- Do NOT split one subject across several items (one storage-limit topic → ONE memory, not four). Do NOT emit a roadmap/summary item that just restates other items.

HOW TO FOLD (follow this order — it is what prevents duplicate build-up):
1. FIRST walk the EXISTING items one by one. For each, ask: does this meeting add detail to it, change it, or resolve/contradict it? If yes, emit an "update" (enrich in place) or "supersede" (replace stale/contradicted) on THAT id — reuse the id EXACTLY. Most meetings mostly CONTINUE existing threads, so expect more update/supersede than add.
2. THEN "add" a new memory ONLY for a subject that NO existing item already covers.
3. It is a DEFECT to "add" an item whose subject / project / person / entities already match an existing item — that creates a duplicate. When a subject already exists, you MUST update/supersede its id instead. When unsure whether something is new, treat it as an update to the closest existing item.

OPERATIONS (emit an ordered JSON array; the server applies them in order):
- {"op":"update","id":"...","text":"...","entities":["..."]}   PREFER THIS: refine/enrich an existing memory in place
- {"op":"supersede","id":"...","text":"...","entities":["..."]} replace a stale or contradicted memory with corrected info
- {"op":"add","text":"...","entities":["..."]}                 add a memory for a genuinely NEW subject only
- {"op":"archive","id":"..."}                                  the memory is no longer relevant

DEDUP (critical — the memory must not accumulate duplicates):
- ONE subject = ONE memory item. Fold every related sub-fact about a subject into that single item via update; never emit sibling items for the same subject (e.g. "an index layer is needed", "backfilling long notes is hard", "search filtering exists" are all the SAME subject → update ONE item, do not add three).
- FOCUS each item on ITS OWN subject. Update an item ONLY when the meeting genuinely changes or adds detail to THAT specific subject. Do NOT touch items the meeting does not actually discuss, and NEVER append a generic cross-cutting clause (e.g. "the focus is now on X", "this relates to the broader effort") to several items — that smears unrelated memories together and makes them look duplicate.
- Supersede when the new meeting resolves or contradicts an existing memory (e.g. "the 50MB upload limit is under investigation" becomes "the 50MB limit was a Supabase free-tier cap, fixed by upgrading to Supabase Pro; the cap is now 200MB").

BOUNDS:
- Emit AT MOST 20 operations total. Prefer a few high-value update/supersede ops over many adds. NEVER pad the array, repeat an op, or emit empty/placeholder ops.

GROUNDING:
- Only durable, meeting-crossing understanding. Skip one-off small talk and pure logistics.
- Do NOT record the user themselves as a collaborator or relationship.
- Never fabricate names, decisions, or facts not supported by the transcript or existing memory. When unsure, say nothing.
- entities: a few short tags (people / projects / topics) named in the item, to seed a future relationship graph.
- Use ids EXACTLY as given for update/supersede/archive. Never invent an id.
- A content-rich meeting almost ALWAYS yields several ops (updates to existing threads + adds for genuinely new subjects). Return an empty ops array ONLY when the meeting has no durable content at all (pure logistics / small talk). Do not go empty just to avoid duplicates — fold via update instead.

Return ONLY JSON of this exact shape (no prose, no markdown; update/supersede reuse an existing id, add has no id):
{"ops":[{"op":"update","id":"","text":"","entities":[""]},{"op":"add","text":"","entities":[""]}]}`;

const INSIGHT_SYSTEM_PROMPT = `You extract a STRUCTURED INDEX of ONE meeting, for later search and filtering. Scope is THIS meeting only — capture what THIS transcript contains, not cross-meeting understanding.

Extract:
- actions: concrete action items / tasks / commitments stated in the meeting. Each: text (what), owner (who is responsible, or "" if unclear), due (deadline/timeframe, or ""), status ("open" unless the transcript says it is done or blocked).
- decisions: FIRM choices the meeting reached that RESOLVE an open question — one option picked over an alternative, or something explicitly rejected ("decided NOT to build X"). Each: text (what was decided), rationale (the stated reason, or ""). Decisions are RARE — most meetings have 0-3; a long list means you are mislabeling. STRICT exclusions, these are NOT decisions (leave them out): status/progress ("X is done / implemented / completed"), needs and tasks ("X is needed", "will do X", "should build X" → those are actions), and ideas merely being discussed or explored. When in doubt, it is NOT a decision.
- topics: short topic/keyword tags discussed (products, features, problems, themes).
- people: names of real people mentioned or participating (skip generic labels like "Speaker 1").
- companies: organizations / companies mentioned.

RULES:
- Keep the meeting's ORIGINAL LANGUAGE (Korean stays Korean). Do NOT translate.
- Only what the transcript supports. Never invent names, decisions, or deadlines. When unsure, omit.
- Keep each entry short. Deduplicate within each list. Any list may be empty; return them all.
- BE SELECTIVE, NOT EXHAUSTIVE. Hard limits: at most 20 actions, 15 decisions, 15 topics, 20 people, 15 companies. Keep only the most important/salient items. Do NOT turn every noun into a topic, or every mention into a person/company — a short, high-signal list is the goal.
- NEVER output empty-string ("") entries and NEVER pad a list to a length. If a list has nothing, return []. Never output a speaker label (e.g. "Speaker A", "Speaker 1") as a person.

Return ONLY JSON of this exact shape (no prose, no markdown):
{"actions":[{"text":"","owner":"","due":"","status":""}],"decisions":[{"text":"","rationale":""}],"topics":[""],"people":[""],"companies":[""]}`;

// Gemini responseSchema (OpenAPI subset). Forces structurally-valid JSON so the model
// cannot emit the malformed / runaway JSON that used to fail parsing (~60% of the time).
// Semantics are still validated by parseInsight / parseOps afterward.
const INSIGHT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { text: { type: 'STRING' }, owner: { type: 'STRING' }, due: { type: 'STRING' }, status: { type: 'STRING' } },
        required: ['text'],
      },
    },
    decisions: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, rationale: { type: 'STRING' } }, required: ['text'] },
    },
    topics: { type: 'ARRAY', items: { type: 'STRING' } },
    people: { type: 'ARRAY', items: { type: 'STRING' } },
    companies: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['actions', 'decisions', 'topics', 'people', 'companies'],
} as const;

function buildMemoryUserPrompt(itemsJson: string, transcript: string, selfName: string | null | undefined, noteId: string | null | undefined): string {
  const selfLine = selfName?.trim() ? `Logged-in user (self) — whose memory this is: "${selfName.trim()}"` : 'Logged-in user (self): unknown';
  const noteLine = noteId?.trim() ? `Current note id (provenance for new memories): "${noteId.trim()}"` : 'Current note id: (none)';
  return `${selfLine}
${noteLine}

EXISTING memory items (JSON array; each has an id — reference it in update / supersede / archive):
${itemsJson}

NEW meeting transcript:
${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`;
}

function buildInsightUserPrompt(transcript: string, noteId: string | null | undefined): string {
  const noteLine = noteId?.trim() ? `Meeting note id: "${noteId.trim()}"` : 'Meeting note id: (none)';
  return `${noteLine}

MEETING transcript:
${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_ATTEMPTS_PER_MODEL = 3;

/**
 * Call Gemini for a JSON extraction and PARSE it inside the retry loop. Retries up to
 * 3 times per model, then falls through to the next fallback model, on BOTH:
 *  - transient HTTP failures (429/5xx/network), with backoff; and
 *  - an HTTP 200 whose body does not parse/validate (parse() returns null).
 *
 * The second case is the reliability fix (F8 stability finding 2026-08-11): flash-lite
 * intermittently emits malformed or runaway JSON, and the old code returned that 200 as
 * success so the caller silently dropped the note (no insight/memory, ~60% of the time).
 * Now an unparseable body is treated as a retryable failure, so a re-attempt or a
 * fallback model can produce valid JSON. `parse` MUST return null only for
 * unparseable/invalid output — a legitimately empty result (e.g. zero memory ops) is a
 * non-null value and is NOT retried.
 */
async function callJsonModel<T>(input: {
  apiKey: string;
  models: string[];
  systemPrompt: string;
  userPrompt: string;
  parse: (text: string) => T | null;
  maxOutputTokens?: number;
  responseSchema?: unknown;
}): Promise<{ value: T; model: string } | { error: string }> {
  let lastError = 'no models attempted';
  for (const model of input.models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
      try {
        const result = await callGemini({
          apiKey: input.apiKey,
          model,
          parts: [{ text: `${input.systemPrompt}\n\n${input.userPrompt}` }],
          responseMimeType: 'application/json',
          responseSchema: input.responseSchema,
          // thinkingBudget 0 → all output budget goes to the JSON.
          maxOutputTokens: input.maxOutputTokens ?? 8192,
          temperature: 0.1,
          thinkingBudget: 0,
        });
        const parsed = input.parse(result.text);
        if (parsed !== null) return { value: parsed, model };
        // HTTP 200 but unparseable/invalid body → retryable (try again / next model).
        lastError = `${model}: unparseable output len=${result.text.length}`;
        if (attempt === MAX_ATTEMPTS_PER_MODEL) break; // exhausted this model → next model
      } catch (error) {
        lastError = `${model}: ${(error as Error).message}`;
        const retryable = error instanceof GeminiApiError && error.retryable;
        if (!retryable || attempt === MAX_ATTEMPTS_PER_MODEL) break; // non-retryable or exhausted → next model
        await sleep(600 * attempt + Math.floor(Math.random() * 300));
      }
    }
  }
  return { error: lastError };
}

/** Upsert one note's structured index (one row per note). Returns whether it wrote. */
async function writeNoteInsight(
  supabase: SupabaseClient,
  userId: string,
  noteId: string,
  insight: NoteInsight,
  now: string,
): Promise<boolean> {
  const { error } = await supabase.from('note_insight').upsert(
    {
      note_id: noteId,
      user_id: userId,
      actions: insight.actions,
      decisions: insight.decisions,
      topics: insight.topics,
      people: insight.people,
      companies: insight.companies,
      source_model: insight.sourceModel,
      updated_at: now,
    },
    { onConflict: 'note_id' },
  );
  return !error;
}

function resolveModels(model: string | undefined, fallbackModels: string[] | undefined): string[] {
  const primary = (model ?? DEFAULT_MEMORY_MODEL).trim() || DEFAULT_MEMORY_MODEL;
  return [primary, ...(fallbackModels ?? DEFAULT_MEMORY_FALLBACK_MODELS)].filter((m, i, all) => m && all.indexOf(m) === i);
}

/**
 * Pure insight extraction: one Gemini call + parse, NO DB write. This is the exact
 * producer both the store path (extractAndStoreInsight / foldNoteIntoMemory) and the
 * F8 eval harness run, so the eval measures the real logic, not a copy. Returns the
 * parsed insight or an error reason.
 */
export async function extractInsight(input: {
  apiKey: string;
  model?: string;
  fallbackModels?: string[];
  transcript: string;
  noteId?: string | null;
}): Promise<{ insight: NoteInsight } | { error: string }> {
  const transcript = input.transcript.trim();
  if (!transcript) return { error: 'empty transcript' };
  const out = await callJsonModel<NoteInsight>({
    apiKey: input.apiKey,
    models: resolveModels(input.model, input.fallbackModels),
    systemPrompt: INSIGHT_SYSTEM_PROMPT,
    userPrompt: buildInsightUserPrompt(transcript, input.noteId ?? null),
    parse: (text) => parseInsight(text, null),
    responseSchema: INSIGHT_SCHEMA,
  });
  if ('error' in out) return { error: `gemini: ${out.error.slice(0, 240)}` };
  return { insight: { ...out.value, sourceModel: out.model } };
}

/**
 * Insight-only extraction (no memory fold). Used by the backfill path to populate
 * note_insight for existing notes without touching anyone's personal memory.
 */
export async function extractAndStoreInsight(input: {
  supabase: SupabaseClient;
  apiKey: string;
  model?: string;
  fallbackModels?: string[];
  userId: string;
  noteId: string;
  transcript: string;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!input.userId || !input.noteId || !input.transcript.trim()) return { ok: false, reason: 'empty transcript' };
  const res = await extractInsight({
    apiKey: input.apiKey,
    model: input.model,
    fallbackModels: input.fallbackModels,
    transcript: input.transcript,
    noteId: input.noteId,
  });
  if ('error' in res) return { ok: false, reason: res.error };
  const wrote = await writeNoteInsight(input.supabase, input.userId, input.noteId, res.insight, new Date().toISOString());
  return wrote ? { ok: true } : { ok: false, reason: 'db upsert failed' };
}

export interface MemoryFoldComputation {
  priorActiveCount: number;
  ops: Op[];
  items: MemoryItem[];
}

/**
 * Pure memory fold: given the prior memory (v2 items, v1 buckets, or empty) and one
 * transcript, run the memory model and apply its ops deterministically. NO DB read or
 * write. Shared by foldNoteIntoMemory and the F8 eval so both fold identically. `now`
 * is injectable so eval runs are deterministic (Power-of-Ten rule 9).
 */
export async function computeMemoryFold(input: {
  apiKey: string;
  model?: string;
  fallbackModels?: string[];
  priorMemory: unknown;
  transcript: string;
  selfName: string | null;
  noteId?: string | null;
  now?: string;
}): Promise<MemoryFoldComputation | { error: string }> {
  const transcript = input.transcript.trim();
  if (!transcript) return { error: 'empty transcript' };
  const now = input.now ?? new Date().toISOString();
  const noteId = input.noteId ?? null;
  const startingItems = toStartingItems(input.priorMemory ?? { version: 2, items: [] }, input.selfName, now);

  const activeForPrompt = startingItems
    .filter((i) => i.status === 'active')
    .map((i) => ({ id: i.id, text: i.text, entities: i.entities }));
  let itemsJson = JSON.stringify(activeForPrompt);
  if (itemsJson.length > MAX_MEMORY_CHARS) itemsJson = itemsJson.slice(0, MAX_MEMORY_CHARS);

  const out = await callJsonModel<Op[]>({
    apiKey: input.apiKey,
    models: resolveModels(input.model, input.fallbackModels),
    systemPrompt: MEMORY_SYSTEM_PROMPT,
    userPrompt: buildMemoryUserPrompt(itemsJson, transcript, input.selfName, noteId),
    parse: (text) => parseOps(text),
    // NOTE: no responseSchema for memory — constraining the ops-union schema made
    // flash-lite very slow (10s+ vs 2s for insight) on the fold task, for no
    // reliability gain (retry + the ops cap already give 100% here). Insight, whose
    // fixed shape the model satisfies instantly, keeps its schema. See F8 notes.
  });
  if ('error' in out) return { error: `gemini: ${out.error.slice(0, 240)}` };
  const ops = out.value;
  const items = enforceCaps(applyOps(startingItems, ops, noteId, now));
  return { priorActiveCount: activeForPrompt.length, ops, items };
}

export interface FoldNoteResult {
  memoryItemCount: number;
  insightWritten: boolean;
  skipped: boolean;
}

/**
 * Fold ONE note into the owner's personal memory and write its note_insight index.
 * Best-effort and idempotent: a note already in processed_note_ids is skipped, so a
 * regenerate or resumed job never double-folds. Uses the service-role client, so it
 * works for any note regardless of which client created it (web or mobile).
 */
export async function foldNoteIntoMemory(input: {
  supabase: SupabaseClient;
  apiKey: string;
  model?: string;
  fallbackModels?: string[];
  userId: string;
  noteId: string;
  transcript: string;
  selfName: string | null;
}): Promise<FoldNoteResult> {
  const { supabase, apiKey, userId, noteId } = input;
  const transcript = input.transcript.trim();
  if (!userId || !noteId || !transcript) return { memoryItemCount: 0, insightWritten: false, skipped: true };

  const { data: row } = await supabase
    .from('user_memory')
    .select('memory, processed_note_ids')
    .eq('user_id', userId)
    .maybeSingle();
  const processedNoteIds: string[] = Array.isArray((row as { processed_note_ids?: unknown } | null)?.processed_note_ids)
    ? ((row as { processed_note_ids: string[] }).processed_note_ids)
    : [];
  if (processedNoteIds.includes(noteId)) return { memoryItemCount: 0, insightWritten: false, skipped: true };

  const now = new Date().toISOString();
  const selfName = input.selfName ?? null;
  const existingMemory = (row as { memory?: unknown } | null)?.memory ?? { version: 2, items: [] };

  // Two focused producers, concurrently: memory fold + note_insight extraction.
  // These are the exact pure functions the F8 eval harness measures.
  const [memoryRes, insightRes] = await Promise.all([
    computeMemoryFold({ apiKey, model: input.model, fallbackModels: input.fallbackModels, priorMemory: existingMemory, transcript, selfName, noteId, now }),
    extractInsight({ apiKey, model: input.model, fallbackModels: input.fallbackModels, transcript, noteId }),
  ]);

  // Memory: only write when the fold produced valid ops. A model failure leaves memory
  // untouched AND does not mark the note processed, so a later run can retry.
  let memoryItemCount = 0;
  let memoryProcessed = false;
  if (!('error' in memoryRes)) {
    const nextProcessed = [...processedNoteIds, noteId].slice(-PROCESSED_CAP);
    const { error } = await supabase
      .from('user_memory')
      .upsert({ user_id: userId, memory: { version: 2, items: memoryRes.items }, processed_note_ids: nextProcessed, updated_at: now }, { onConflict: 'user_id' });
    if (!error) {
      memoryItemCount = memoryRes.items.length;
      memoryProcessed = true;
    }
  }

  // Insight (F4): one row per note, best-effort. Written even if memory failed.
  const insightWritten = 'insight' in insightRes ? await writeNoteInsight(supabase, userId, noteId, insightRes.insight, now) : false;

  return { memoryItemCount, insightWritten, skipped: !memoryProcessed && !insightWritten };
}
