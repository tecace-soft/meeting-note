// Strict validation of Prompt A output. The handoff asks for "JSON Schema validation"; zod is
// the validator already in this package (no new dependency). The enums are the fixed taxonomy:
// an unknown status, side, kind or type fails validation, which makes callJsonModel retry and,
// if every attempt fails, marks the run failed. Nothing invalid is ever stored.
//
// Leniency is limited to shape noise flash-lite produces without changing meaning: missing
// optional strings become null, missing lists become [], and "null"/"" strings become null.
import { z } from 'zod';

export const DECISION_STATUSES = [
  'decided', 'direction', 'proposed', 'deferred', 'status_report', 'info', 'customer_decided', 'customer_stated',
] as const;
export const DECISION_SIDES = ['tecace', 'customer', 'partner'] as const;
export const MEETING_KINDS = ['internal', 'internal-dev', 'internal-exec', 'customer', 'partner', 'vendor', 'hiring', 'out-of-scope'] as const;
export const SENSITIVITIES = ['normal', 'customer-commercial', 'financial', 'hr'] as const;
export const QUALITIES = ['ok', 'thin', 'garbled', 'summary-only'] as const;
export const ISSUE_TYPES = ['issue', 'risk', 'open_question'] as const;

export type DecisionStatus = (typeof DECISION_STATUSES)[number];

const MAX_TEXT = 2000;

// Optional free text: undefined / null / "" / "null" → null; otherwise trimmed and capped.
const optText = z.preprocess((v) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t === '' || t.toLowerCase() === 'null' ? null : t.slice(0, MAX_TEXT);
}, z.string().nullable());

const reqText = z.string().trim().min(1).max(MAX_TEXT);

const textList = z.preprocess(
  (v) => (v === undefined || v === null ? [] : v),
  z.array(z.preprocess((x) => (typeof x === 'string' ? x.trim() : x), z.string())).transform((xs) => xs.filter((x) => x !== '').slice(0, 50)),
);

const enumLower = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(values));

const participantSchema = z.preprocess(
  // Tolerate a bare name string in place of {name}.
  (v) => (typeof v === 'string' ? { name: v } : v),
  z.object({ name: z.string().trim(), org: optText, role: optText }),
);

export const decisionSchema = z.object({
  id: z.string().trim().min(1),
  text: reqText,
  status: enumLower(DECISION_STATUSES),
  side: enumLower(DECISION_SIDES),
  by: optText,
  with: textList,
  why: optText,
  trigger: optText,
  alternatives_rejected: textList,
  assumptions: textList,
  effective_date: optText,
  project: optText,
  evidence: optText,
});

export const actionSchema = z.object({
  id: optText,
  text: reqText,
  owner: optText,
  due: optText,
  from_decision: optText,
  evidence: optText,
});

export const issueSchema = z.object({
  id: optText,
  text: reqText,
  type: enumLower(ISSUE_TYPES),
  raised_by: optText,
  evidence: optText,
});

export const extractionSchema = z.object({
  meeting: z.object({
    meeting_note_id: optText,
    date: optText,
    title: optText,
    meeting_kind: enumLower(MEETING_KINDS),
    participants: z.preprocess((v) => (v == null ? [] : v), z.array(participantSchema)),
    orgs: textList,
    projects: textList,
    purpose: optText,
    sensitivity: z.preprocess((v) => (v == null || v === '' ? 'normal' : v), enumLower(SENSITIVITIES)),
    quality: z.preprocess((v) => (v == null || v === '' ? 'ok' : v), enumLower(QUALITIES)),
    quality_notes: optText,
  }),
  decisions: z.preprocess((v) => (v == null ? [] : v), z.array(decisionSchema)),
  actions: z.preprocess((v) => (v == null ? [] : v), z.array(actionSchema)),
  issues: z.preprocess((v) => (v == null ? [] : v), z.array(issueSchema)),
  references_to_past: z.preprocess(
    (v) => (v == null ? [] : v),
    z.array(z.object({ text: reqText, evidence: optText })),
  ),
});

export type DecisionExtraction = z.infer<typeof extractionSchema>;
export type ExtractedDecision = z.infer<typeof decisionSchema>;

export type ParseResult = { ok: true; value: DecisionExtraction } | { ok: false; error: string };

function stripFences(text: string): string {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : t;
}

/** Parse + validate raw model text. Never throws. */
export function parseDecisionExtraction(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(raw));
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message.slice(0, 160)}` };
  }
  // 2026-11-05 held-out: one note made flash-lite wrap the whole object in an array on every
  // attempt ("[{ meeting, decisions, ... }]"). Unwrap exactly that shape; anything else still fails.
  if (Array.isArray(json)) {
    const wrapped = json.find((x) => x && typeof x === 'object' && !Array.isArray(x) && 'meeting' in (x as object));
    if (wrapped) json = wrapped;
  }
  const result = extractionSchema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    return { ok: false, error: `schema: ${first?.path.join('.') || '(root)'} ${first?.message ?? 'invalid'}`.slice(0, 240) };
  }
  // Decision ids must be unique so actions can reference them unambiguously.
  const ids = new Set<string>();
  for (const d of result.data.decisions) {
    if (ids.has(d.id)) return { ok: false, error: `schema: duplicate decision id ${d.id}` };
    ids.add(d.id);
  }
  return { ok: true, value: result.data };
}
