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
// Fallbacks after the primary. Both gemini-2.0-* were retired (404) — kept only live models.
const DEFAULT_MEMORY_FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-3.1-flash-lite'];
// F1'' consolidation pass runs after each fold in prod (one extra flash-lite call,
// gated to memories with >= CONSOLIDATION_MIN_ITEMS active items). Off-switch for cost.
const CONSOLIDATION_ENABLED = (process.env.MEMORY_CONSOLIDATION_ENABLED ?? 'true').toLowerCase() !== 'false';

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
// F4 refinement (boss 2026-08-13): index the general "because X, therefore Y" chains,
// not only firm decisions, so reverse "what did I do / what happened" queries resolve.
export interface InsightEvent {
  cause: string;
  effect: string;
}
export interface NoteInsight {
  actions: InsightAction[];
  decisions: InsightDecision[];
  events: InsightEvent[];
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

  const events: InsightEvent[] = [];
  for (const raw of asArray(o.events).slice(0, MAX_INSIGHT_ITEMS)) {
    const e = asObject(raw);
    const cause = str(e.cause, MAX_INSIGHT_TEXT);
    const effect = str(e.effect, MAX_INSIGHT_TEXT);
    // A cause->effect pair needs BOTH halves; drop a one-sided fragment.
    if (!cause || !effect) continue;
    events.push({ cause, effect });
  }

  return {
    actions,
    decisions,
    events,
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
- actions: concrete action items / tasks / commitments stated in the meeting. Each: text (what), owner (the REAL NAME of the person responsible, see OWNER ATTRIBUTION below, or "" if genuinely unattributable), due (deadline/timeframe, or ""), status ("open" unless the transcript says it is done or blocked).
- decisions: FIRM choices the meeting reached that RESOLVE an open question — one option picked over an alternative, or something explicitly rejected ("decided NOT to build X"). Each: text (what was decided), rationale (the stated reason, or ""). Decisions are RARE — most meetings have 0-3; a long list means you are mislabeling. STRICT exclusions, these are NOT decisions (leave them out): status/progress ("X is done / implemented / completed"), needs and tasks ("X is needed", "will do X", "should build X" → those are actions), and ideas merely being discussed or explored. When in doubt, it is NOT a decision.
- events: cause->effect chains — what happened / was done and what it led to. This is BROADER than decisions: it is NOT limited to firm choices; it captures the general "what did we do / what happened and why" narrative (a change made and its result, a problem and its fix, an event and its consequence). Each: cause (the trigger / what was done / what happened) and effect (the result / consequence / outcome). Both halves REQUIRED — skip a pair if either side is missing. Prefer concrete, meeting-specific chains; do not restate an action verbatim as an event. CONCISE: write each side as a SHORT paraphrase — a clause, roughly under 15 words. NEVER copy a verbatim transcript sentence, and NEVER put a generic speaker label ("Speaker A/B") in cause or effect; use the person's real name (via SPEAKER CONTEXT) or state the fact with no subject.
- topics: short topic/keyword tags discussed (products, features, problems, themes).
- people: real people mentioned OR participating in the meeting. Use SPEAKER CONTEXT (when given) to include the actual participants by their real names. Skip generic labels like "Speaker 1" / "Speaker A".
- companies: organizations / companies mentioned.

OWNER ATTRIBUTION (fill action "owner"):
- Each transcript line is prefixed with its speaker. First-person commitments ("I'll do X", "제가/저는 ~ 할게요", "제가 ~ 드릴게요") → owner is the SPEAKER of that line. Explicit assignment ("Andrew, can you ~", "~님이 해주세요") → owner is the named/assigned person.
- Resolve the responsible speaker to a REAL NAME via SPEAKER CONTEXT. If the speaker is a generic label (e.g. "Speaker B") and no context resolves it to a real name, leave owner "" — NEVER output a bare "Speaker A/B" label as owner.

RULES:
- OUTPUT LANGUAGE (critical): write every field value — actions.text, decisions, events (cause/effect), topics — in the SAME language the meeting is spoken in. If the transcript is Korean, they MUST be Korean. These instructions and the SPEAKER CONTEXT block are written in English, but they are directions ONLY: do NOT let them switch the output language, and NEVER translate the meeting content into English. (owner/people names may stay in their original script.)
- Only what the transcript supports. Never invent names, decisions, or deadlines. When unsure, omit.
- Do NOT expand or "correct" a transliterated proper noun into a guessed original spelling — keep it as spoken (e.g. "오픈클로어" stays "오픈클로어"; never invent an English form like "OpenChorus"). Applies to every field.
- Keep each entry short. Deduplicate within each list. Any list may be empty; return them all.
- BE SELECTIVE, NOT EXHAUSTIVE. Hard limits: at most 20 actions, 15 decisions, 15 events, 15 topics, 20 people, 15 companies. Keep only the most important/salient items. Do NOT turn every noun into a topic, or every mention into a person/company — a short, high-signal list is the goal.
- NEVER output empty-string ("") entries and NEVER pad a list to a length. If a list has nothing, return []. Never output a speaker label (e.g. "Speaker A", "Speaker 1") as a person.

Return ONLY JSON of this exact shape (no prose, no markdown):
{"actions":[{"text":"","owner":"","due":"","status":""}],"decisions":[{"text":"","rationale":""}],"events":[{"cause":"","effect":""}],"topics":[""],"people":[""],"companies":[""]}`;

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
    events: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { cause: { type: 'STRING' }, effect: { type: 'STRING' } }, required: ['cause', 'effect'] },
    },
    topics: { type: 'ARRAY', items: { type: 'STRING' } },
    people: { type: 'ARRAY', items: { type: 'STRING' } },
    companies: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['actions', 'decisions', 'events', 'topics', 'people', 'companies'],
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

function buildInsightUserPrompt(
  transcript: string,
  noteId: string | null | undefined,
  speakerContext: string | null | undefined,
): string {
  const noteLine = noteId?.trim() ? `Meeting note id: "${noteId.trim()}"` : 'Meeting note id: (none)';
  // Transcript lines are prefixed with a speaker (a real name, or a generic "Speaker A/B"
  // when diarization has not been named yet). SPEAKER CONTEXT, when present, maps those
  // labels to real people so the model can attribute action owners by name.
  const speakerLine = speakerContext?.trim()
    ? `\nSPEAKER CONTEXT (maps transcript speaker labels to real people — use it to fill action "owner"):\n'''\n${speakerContext.trim()}\n'''\n`
    : '';
  return `${noteLine}
${speakerLine}
MEETING transcript (each line is prefixed with its speaker):
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
export async function callJsonModel<T>(input: {
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
      events: insight.events,
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
  speakerContext?: string | null;
}): Promise<{ insight: NoteInsight } | { error: string }> {
  const transcript = input.transcript.trim();
  if (!transcript) return { error: 'empty transcript' };
  const out = await callJsonModel<NoteInsight>({
    apiKey: input.apiKey,
    models: resolveModels(input.model, input.fallbackModels),
    systemPrompt: INSIGHT_SYSTEM_PROMPT,
    userPrompt: buildInsightUserPrompt(transcript, input.noteId ?? null, input.speakerContext ?? null),
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
  speakerContext?: string | null;
}): Promise<{ ok: boolean; reason?: string }> {
  if (!input.userId || !input.noteId || !input.transcript.trim()) return { ok: false, reason: 'empty transcript' };
  const res = await extractInsight({
    apiKey: input.apiKey,
    model: input.model,
    fallbackModels: input.fallbackModels,
    transcript: input.transcript,
    noteId: input.noteId,
    speakerContext: input.speakerContext ?? null,
  });
  if ('error' in res) return { ok: false, reason: res.error };
  const wrote = await writeNoteInsight(input.supabase, input.userId, input.noteId, res.insight, new Date().toISOString());
  return wrote ? { ok: true } : { ok: false, reason: 'db upsert failed' };
}

// ---------------------------------------------------------------------------
// F5.1: context-based speaker identification (text signals only). Ported from the
// identify-speakers edge function so it can run server-side at ingest and be measured by
// the F8 harness. Suggestion-only — the caller decides what to auto-apply (by confidence).
// ---------------------------------------------------------------------------

const MAX_IDENTIFY_LABELS = 20;
const MAX_ROSTER_ENTRIES = 40;
const MAX_ROSTER_SUMMARY = 800;
// Optional personal-memory context block (F8 A/B experiment only). Prod NEVER passes
// personalMemory, so the prompt is byte-identical to today unless the eval sets it.
const MAX_IDENTIFY_MEMORY_CHARS = 4000;

export interface SpeakerRosterEntry {
  speakerId: string;
  name: string;
  summary?: string;
}

export interface SpeakerSuggestion {
  label: string;
  speakerId: string | null;
  name: string | null;
  confidence: number;
  isSelf: boolean;
  rationale: string;
}

// NOTE: keep this prompt in sync with supabase/functions/identify-speakers/index.ts
// (the web-UI copy). Both are text-only speaker identification; they must behave the same.
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
- rationale: one short sentence citing the evidence (a quote, the matched interaction role, or the self/roster prior).

Return ONLY JSON of the exact shape:
{"suggestions":[{"label":"Speaker A","speakerId":"<roster id or null>","name":"<name or null>","confidence":0.0,"isSelf":false,"rationale":"..."}]}
Include exactly one object per distinct label given, in the same order.`;

// NOTE: no responseSchema here on purpose. A nested object-array schema makes
// gemini-2.5-flash-lite hang/slow badly (the same failure that kept MEMORY schema-less);
// parseSuggestions + callJsonModel's parse-retry already guarantee reliability.

function clamp01(n: unknown): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// A person can accumulate more than one roster entry (e.g. "Andrew Yoo" and "Andrew Yoo (유영준)"
// are stored as two speaker rows). Sending both made the model pick a different speakerId per
// meeting for the SAME person and flip isSelf. Collapse entries whose names match after
// stripping a parenthetical script variant, keeping the RICHEST profile, and order richest-first
// as a light "regular collaborator" prior. Shapes the request ONLY — no DB mutation.
function normalizeSpeakerName(name: string): string {
  return name.replace(/\s*[(（【[].*$/, '').trim().toLowerCase();
}
export function dedupeRosterByName(roster: SpeakerRosterEntry[]): SpeakerRosterEntry[] {
  const byName = new Map<string, SpeakerRosterEntry>();
  for (const entry of roster) {
    const key = normalizeSpeakerName(entry.name);
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing || (entry.summary?.length ?? 0) > (existing.summary?.length ?? 0)) {
      byName.set(key, entry);
    }
  }
  return [...byName.values()].sort((a, b) => (b.summary?.length ?? 0) - (a.summary?.length ?? 0));
}

function buildIdentifyUserPrompt(
  transcript: string,
  labels: string[],
  roster: SpeakerRosterEntry[],
  selfName: string | null,
  personalMemory?: string | null,
): string {
  const rosterText = roster.length
    ? roster
        .map((entry, index) => {
          const summary = (entry.summary || '').slice(0, MAX_ROSTER_SUMMARY).trim() || '(no profile yet)';
          return `${index + 1}. speakerId="${entry.speakerId}" name="${entry.name}"\n${summary}`;
        })
        .join('\n\n')
    : '(the user has no saved speakers yet)';
  const selfLine = selfName?.trim()
    ? `Logged-in user (self), usually present: "${selfName.trim()}"`
    : 'Logged-in user (self): unknown';
  // Prod passes no personalMemory → this block is absent and the prompt is unchanged.
  // The F8 A/B eval sets it to test whether cross-meeting memory improves identification.
  const memoryText = (personalMemory || '').slice(0, MAX_IDENTIFY_MEMORY_CHARS).trim();
  const memoryBlock = memoryText
    ? `\n\nUSER'S PERSONAL MEMORY (durable cross-meeting context about the self and the people they work with; use it as a prior for who is likely present and which role each person plays):
${memoryText}`
    : '';
  return `${selfLine}

Anonymous labels to identify (return one suggestion per label, in this order):
${labels.map((l) => `- ${l}`).join('\n')}

Known speaker roster:
${rosterText}${memoryBlock}

Transcript (speakers are anonymous):
${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`;
}

// Returns null ONLY for unparseable output (so callJsonModel retries); a parsed-but-empty
// result is a valid []. Drops any speakerId not in the roster (never trust an invented id).
function parseSuggestions(rawText: string, validSpeakerIds: Set<string>, requestedLabels: string[]): SpeakerSuggestion[] | null {
  const parsed = tryParseJson(rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
  if (parsed === undefined) return null;
  const arr = asArray(asObject(parsed).suggestions);
  const allowed = new Set(requestedLabels);
  const seen = new Set<string>();
  const out: SpeakerSuggestion[] = [];
  for (const item of arr) {
    const o = asObject(item);
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    if (!label || !allowed.has(label) || seen.has(label)) continue;
    seen.add(label);
    let speakerId = typeof o.speakerId === 'string' && o.speakerId.trim() ? o.speakerId.trim() : null;
    if (speakerId && !validSpeakerIds.has(speakerId)) speakerId = null;
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

/**
 * Identify who each anonymous speaker label most likely is, from text signals + the user's
 * saved-speaker roster. Pure (no DB). Suggestion-only; confidence-based auto-apply is the
 * caller's decision. Shared by the ingest pipeline and the F8 speaker-id eval surface.
 */
export async function identifySpeakers(input: {
  apiKey: string;
  model?: string;
  fallbackModels?: string[];
  transcript: string;
  labels: string[];
  roster: SpeakerRosterEntry[];
  selfName?: string | null;
  // F8 A/B experiment only. Prod leaves this undefined → prompt unchanged. When set, the
  // user's durable personal memory is injected as an extra identification prior.
  personalMemory?: string | null;
}): Promise<{ suggestions: SpeakerSuggestion[] } | { error: string }> {
  const labels = Array.from(new Set(input.labels.map((l) => l.trim()).filter(Boolean))).slice(0, MAX_IDENTIFY_LABELS);
  if (labels.length === 0) return { suggestions: [] };
  const roster = dedupeRosterByName(input.roster).slice(0, MAX_ROSTER_ENTRIES);
  const validIds = new Set(roster.map((r) => r.speakerId));
  const out = await callJsonModel<SpeakerSuggestion[]>({
    apiKey: input.apiKey,
    models: resolveModels(input.model, input.fallbackModels),
    systemPrompt: IDENTIFY_SYSTEM_PROMPT,
    userPrompt: buildIdentifyUserPrompt(input.transcript.trim(), labels, roster, input.selfName ?? null, input.personalMemory ?? null),
    parse: (text) => parseSuggestions(text, validIds, labels),
  });
  if ('error' in out) return { error: out.error };
  return { suggestions: out.value };
}

/**
 * Render a stored user_memory value into a compact, bounded text block for injecting as
 * BACKGROUND context into the summary prompt. Active v2 items only; returns '' for empty,
 * absent, or legacy-v1 memory (nothing worth injecting). Pure (no DB).
 */
export function renderMemoryForContext(memory: unknown, maxChars = 4000): string {
  const obj = memory && typeof memory === 'object' && !Array.isArray(memory) ? (memory as Record<string, unknown>) : {};
  if (obj.version !== 2 || !Array.isArray(obj.items)) return '';
  const lines: string[] = [];
  for (const raw of obj.items) {
    const it = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    if (it.status === 'archived') continue;
    const text = typeof it.text === 'string' ? it.text.trim() : '';
    if (text) lines.push(`- ${text}`);
  }
  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) : out;
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

// ---------------------------------------------------------------------------
// F1'' — memory dedup consolidation pass
//
// The fold's supersede prompting collapses same-note duplicates, but F8 measured
// that ~6-8 near-duplicate ACTIVE items still accrete ACROSS meetings (same
// subject, different phrasing → parallel `add`s the fold didn't merge). Prompt
// tuning hit its ceiling there. This is a SEPARATE, focused pass: give a model
// ONLY the active item list (not the transcript) and ask it to group near-dups;
// the server then merges each group DETERMINISTICALLY (keep the first id, union
// text/entities/sources, archive the losers). It never invents facts (only
// combines existing items) and is fully best-effort — any model/parse failure or
// too-small a list leaves the memory exactly as the fold produced it.
// ---------------------------------------------------------------------------

const CONSOLIDATION_MIN_ITEMS = 6; // below this, accretion is negligible — skip the extra call
const MAX_CONSOLIDATION_GROUPS = 40;

export interface ConsolidationGroup {
  ids: string[];
  text: string;
  entities: string[];
}

const MEMORY_CONSOLIDATION_SYSTEM_PROMPT = `You consolidate a single user's long-term PERSONAL MEMORY item list by merging NEAR-DUPLICATES. The list may contain items that describe the SAME underlying subject / project / person / problem in different words — accreted because earlier folds added instead of merging. Merge ONLY those.
Rules:
- Group ONLY items that truly refer to the same subject. If subjects differ, do NOT merge (over-merging is a WORSE defect than a leftover duplicate).
- For each group, write ONE merged "text" that combines the information of the grouped items in the most current, richest phrasing. Do NOT invent any fact not present in the grouped items.
- Output ONLY groups of 2+ ids. Do NOT output singletons (unique items are left untouched).
- Every id belongs to at most one group. If nothing should be merged, return an empty groups array.
- Write "text" in the SAME language as the items (do not translate).
Return ONLY JSON: {"groups":[{"ids":["id1","id2"],"text":"merged sentence","entities":["..."]}]}`;

/** Build the consolidation user prompt from the active items (id + text + entities). */
export function buildConsolidationPrompt(activeItems: Array<{ id: string; text: string; entities: string[] }>): string {
  return `MEMORY ITEMS (JSON):\n${JSON.stringify(activeItems)}\n\nMerge only near-duplicate items. Answer with the specified JSON only.`;
}

/** Parse the model's consolidation groups; keep only well-formed groups of >=2 ids. Null iff unparseable JSON. */
export function parseConsolidationGroups(rawText: string): ConsolidationGroup[] | null {
  const stripped = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const parsed = tryParseJson(stripped);
  if (parsed === undefined) return null;
  const rawGroups = (parsed as { groups?: unknown }).groups ?? parsed;
  if (!Array.isArray(rawGroups)) return null;
  const groups: ConsolidationGroup[] = [];
  for (const raw of rawGroups.slice(0, MAX_CONSOLIDATION_GROUPS)) {
    const o = asObject(raw);
    const ids: string[] = [];
    for (const idRaw of asArray(o.ids)) {
      const id = str(idRaw, 80);
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length < 2) continue;
    groups.push({ ids, text: str(o.text, MAX_ITEM_TEXT), entities: normalizeEntities(o.entities) });
  }
  return groups;
}

/**
 * Deterministically merge each group into its first (survivor) id and archive the losers.
 * Mutates + returns `items`. An id is used by at most one group; ids that are missing,
 * already archived, or already claimed by an earlier group are ignored. Never drops
 * information: survivor text/entities/sourceNoteIds absorb the losers'.
 */
export function applyConsolidation(items: MemoryItem[], groups: ConsolidationGroup[], now: string): { items: MemoryItem[]; merged: number } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const claimed = new Set<string>();
  let merged = 0;
  for (const g of groups) {
    const ids = g.ids.filter((id) => {
      const it = byId.get(id);
      return it !== undefined && it.status === 'active' && !claimed.has(id);
    });
    if (ids.length < 2) continue;
    const survivor = byId.get(ids[0])!;
    const losers = ids.slice(1).map((id) => byId.get(id)!);
    survivor.text = (g.text.trim() || survivor.text).slice(0, MAX_ITEM_TEXT);
    for (const src of [...losers.map((l) => l.entities), g.entities]) {
      for (const e of src) if (e && !survivor.entities.includes(e) && survivor.entities.length < MAX_ENTITIES_PER_ITEM) survivor.entities.push(e);
    }
    for (const l of losers) for (const n of l.sourceNoteIds) if (n && !survivor.sourceNoteIds.includes(n)) survivor.sourceNoteIds.push(n);
    survivor.status = 'active';
    survivor.updatedAt = now;
    for (const l of losers) { l.status = 'archived'; l.updatedAt = now; merged += 1; }
    for (const id of ids) claimed.add(id);
  }
  return { items, merged };
}

/**
 * Run the consolidation pass on a memory item list. Best-effort: returns items unchanged
 * (merged 0, ran false) when there are too few active items to bother, or on any
 * model/parse failure — it must NEVER break the fold. The model only PROPOSES groups; the
 * merge is deterministic (applyConsolidation). Shared by foldNoteIntoMemory and the F8 eval.
 */
export async function consolidateMemory(input: {
  apiKey: string;
  model?: string;
  fallbackModels?: string[];
  items: MemoryItem[];
  now?: string;
}): Promise<{ items: MemoryItem[]; merged: number; ran: boolean }> {
  const now = input.now ?? new Date().toISOString();
  const active = input.items.filter((i) => i.status === 'active');
  if (active.length < CONSOLIDATION_MIN_ITEMS) return { items: input.items, merged: 0, ran: false };

  const activeForPrompt = active.map((i) => ({ id: i.id, text: i.text, entities: i.entities }));
  const out = await callJsonModel<ConsolidationGroup[]>({
    apiKey: input.apiKey,
    models: resolveModels(input.model, input.fallbackModels),
    systemPrompt: MEMORY_CONSOLIDATION_SYSTEM_PROMPT,
    userPrompt: buildConsolidationPrompt(activeForPrompt),
    parse: (text) => parseConsolidationGroups(text),
    maxOutputTokens: 4096,
  });
  if ('error' in out) return { items: input.items, merged: 0, ran: false };
  const { items, merged } = applyConsolidation(input.items, out.value, now);
  return { items, merged, ran: true };
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
  speakerContext?: string | null;
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
    extractInsight({ apiKey, model: input.model, fallbackModels: input.fallbackModels, transcript, noteId, speakerContext: input.speakerContext ?? null }),
  ]);

  // Memory: only write when the fold produced valid ops. A model failure leaves memory
  // untouched AND does not mark the note processed, so a later run can retry.
  let memoryItemCount = 0;
  let memoryProcessed = false;
  if (!('error' in memoryRes)) {
    // F1'': collapse near-duplicate active items the fold left accreted. Best-effort —
    // consolidateMemory returns the fold's items unchanged on skip/failure, so this can
    // only make memory cleaner, never break the write.
    let finalItems = memoryRes.items;
    if (CONSOLIDATION_ENABLED) {
      const consolidated = await consolidateMemory({ apiKey, model: input.model, fallbackModels: input.fallbackModels, items: finalItems, now });
      finalItems = consolidated.items;
    }
    const nextProcessed = [...processedNoteIds, noteId].slice(-PROCESSED_CAP);
    const { error } = await supabase
      .from('user_memory')
      .upsert({ user_id: userId, memory: { version: 2, items: finalItems }, processed_note_ids: nextProcessed, updated_at: now }, { onConflict: 'user_id' });
    if (!error) {
      memoryItemCount = finalItems.length;
      memoryProcessed = true;
    }
  }

  // Insight (F4): one row per note, best-effort. Written even if memory failed.
  const insightWritten = 'insight' in insightRes ? await writeNoteInsight(supabase, userId, noteId, insightRes.insight, now) : false;

  return { memoryItemCount, insightWritten, skipped: !memoryProcessed && !insightWritten };
}
