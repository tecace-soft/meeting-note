// Turns a validated Prompt A extraction into the payload of public.mn_replace_note_extraction
// (normalized names, evidence match + segment ids, per-run metrics), and writes it.
// buildExtractionPayload is pure so tests and the eval script run the exact production logic.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DecisionExtraction, DecisionStatus } from './schema.js';
import { DECISION_STATUSES } from './schema.js';
import { EntityResolver, isSpeakerLabel, type AliasCandidate, type EntityType } from './normalize.js';
import { TranscriptIndex, isSummaryEvidence, type EvidenceSegment } from './evidence.js';

export interface PayloadEntity {
  type: EntityType;
  canonical_name: string;
  aliases: string[];
  attrs: Record<string, string>;
  role: 'participant' | 'involved_org' | 'about_project' | null;
}

export interface ExtractionPayload {
  id_prefix: string;
  run_id: string | null;
  prompt_version: string;
  record: {
    meeting_date: string;
    title: string | null;
    meeting_kind: string;
    purpose: string | null;
    sensitivity: string;
    quality: string;
    quality_notes: string | null;
    duplicate_of: string | null;
    references_to_past: Array<{ text: string; evidence: string | null }>;
  };
  entities: PayloadEntity[];
  decisions: Array<Record<string, unknown> & { local_id: string; status: DecisionStatus }>;
  actions: Array<Record<string, unknown>>;
  issues: Array<Record<string, unknown>>;
}

export interface ExtractionMetrics {
  decisions: number;
  actions: number;
  issues: number;
  status_counts: Record<string, number>;
  /** decided / decisions. Over 0.7 suggests over-classification (handoff §6). */
  decided_ratio: number | null;
  /** Quoted items whose quote is found in the transcript / quoted items (decisions + actions + issues). */
  evidence_match_rate: number | null;
  /** Items whose evidence is 'summary' or empty / all items. */
  evidence_summary_rate: number | null;
  evidence_quoted: number;
  evidence_matched: number;
}

export interface BuildContext {
  noteId: string;
  meetingDate: string; // YYYY-MM-DD
  promptVersion: string;
  runId: string | null;
  segments: EvidenceSegment[];
  resolver?: EntityResolver;
}

/** 'D:<yymmdd>-<note6>-<nn>' prefix part: '<yymmdd>-<note6>'. */
export function idPrefix(noteId: string, meetingDate: string): string {
  const yymmdd = meetingDate.replace(/-/g, '').slice(2, 8);
  const note6 = noteId.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toLowerCase() || 'note00';
  return `${yymmdd}-${note6}`;
}

export function buildExtractionPayload(extraction: DecisionExtraction, ctx: BuildContext): {
  payload: ExtractionPayload;
  metrics: ExtractionMetrics;
  aliasCandidates: AliasCandidate[];
} {
  const resolver = ctx.resolver ?? new EntityResolver();
  const index = new TranscriptIndex(ctx.segments);
  const m = extraction.meeting;
  resolver.collectQualityNoteHints(m.quality_notes);
  resolver.setOrgNames(['TecAce', 'Samsung', ...m.orgs, ...m.participants.map((p) => p.org ?? '').filter(Boolean)]);

  const person = (name: string | null) => resolver.resolve('person', name);
  const project = (name: string | null) => resolver.resolve('project', name);

  let quoted = 0;
  let matched = 0;
  let summaryEvidence = 0;
  let totalItems = 0;
  const evidenceOf = (evidence: string | null) => {
    totalItems += 1;
    if (isSummaryEvidence(evidence)) {
      summaryEvidence += 1;
      return { evidence_quote: evidence?.trim() ? 'summary' : null, evidence_segment_ids: [], evidence_match: null };
    }
    const result = index.check(evidence);
    quoted += 1;
    if (result.match) matched += 1;
    return { evidence_quote: evidence, evidence_segment_ids: result.segmentIds, evidence_match: result.match };
  };

  // Rule 8: out-of-scope meetings carry no decisions.
  const outOfScope = m.meeting_kind === 'out-of-scope';
  const rawDecisions = outOfScope ? [] : extraction.decisions;

  const decisions = rawDecisions.map((d) => ({
    local_id: d.id,
    text: d.text,
    status: d.status,
    side: d.side,
    decided_by: person(d.by),
    participants: d.with.map((n) => person(n)).filter((n): n is string => Boolean(n)),
    why: d.why,
    trigger: d.trigger,
    alternatives_rejected: d.alternatives_rejected,
    assumptions: d.assumptions,
    effective_date: d.effective_date,
    project: project(d.project),
    ...evidenceOf(d.evidence),
  }));
  const decisionIds = new Set(decisions.map((d) => d.local_id));

  const actions = extraction.actions.map((a) => ({
    text: a.text,
    owner: person(a.owner),
    due: a.due,
    // A dangling reference (e.g. to a decision dropped for out-of-scope) is stored as null.
    from_decision: a.from_decision && decisionIds.has(a.from_decision) ? a.from_decision : null,
    ...evidenceOf(a.evidence),
  }));

  const issues = extraction.issues.map((i) => ({
    text: i.text,
    type: i.type,
    raised_by: person(i.raised_by),
    ...evidenceOf(i.evidence),
  }));

  // Entities linked to this meeting. Guesses ("(추정)") and speaker labels are not persisted
  // as entities; they stay visible on the rows that mention them.
  const entities = new Map<string, PayloadEntity>();
  const addEntity = (type: EntityType, rawName: string | null | undefined, role: PayloadEntity['role'], attrs: Record<string, string> = {}) => {
    if (!rawName || !rawName.trim() || /\(추정\)\s*$/.test(rawName) || isSpeakerLabel(rawName)) return;
    const canonical = resolver.resolve(type, rawName);
    if (!canonical) return;
    const def = resolver.lookup(type, canonical);
    const k = `${type}|${canonical}|${role ?? ''}`;
    if (entities.has(k)) return;
    const aliases = new Set(def?.aliases ?? []);
    if (rawName.trim() !== canonical) aliases.add(rawName.trim());
    entities.set(k, { type, canonical_name: canonical, aliases: [...aliases], attrs: { ...(def?.attrs ?? {}), ...attrs }, role });
  };
  for (const p of m.participants) {
    const attrs: Record<string, string> = {};
    if (p.org) attrs.org = p.org;
    addEntity('person', p.name, 'participant', attrs);
  }
  for (const o of m.orgs) addEntity('org', o, 'involved_org');
  for (const p of m.projects) addEntity('project', p, 'about_project');
  for (const d of decisions) if (d.project) addEntity('project', d.project, 'about_project');

  const statusCounts: Record<string, number> = Object.fromEntries(DECISION_STATUSES.map((s) => [s, 0]));
  for (const d of decisions) statusCounts[d.status] += 1;

  const payload: ExtractionPayload = {
    id_prefix: idPrefix(ctx.noteId, ctx.meetingDate),
    run_id: ctx.runId,
    prompt_version: ctx.promptVersion,
    record: {
      // The note's own date is authoritative; the model's "date" is not trusted (summaries
      // have had wrong dates).
      meeting_date: ctx.meetingDate,
      title: m.title,
      meeting_kind: m.meeting_kind,
      purpose: m.purpose,
      sensitivity: m.sensitivity,
      quality: m.quality,
      quality_notes: m.quality_notes,
      duplicate_of: null, // duplicate detection is a later step (handoff §4)
      references_to_past: extraction.references_to_past,
    },
    entities: [...entities.values()],
    decisions,
    actions,
    issues,
  };

  const metrics: ExtractionMetrics = {
    decisions: decisions.length,
    actions: actions.length,
    issues: issues.length,
    status_counts: statusCounts,
    decided_ratio: decisions.length ? round(statusCounts.decided / decisions.length) : null,
    evidence_match_rate: quoted ? round(matched / quoted) : null,
    evidence_summary_rate: totalItems ? round(summaryEvidence / totalItems) : null,
    evidence_quoted: quoted,
    evidence_matched: matched,
  };

  return { payload, metrics, aliasCandidates: resolver.candidates };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Atomic replace via the SQL function (service_role only). */
export async function writeExtraction(
  supabase: SupabaseClient,
  noteId: string,
  userId: string,
  payload: ExtractionPayload,
): Promise<{ ok: true; counts: Record<string, number> } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc('mn_replace_note_extraction', {
    p_note_id: noteId,
    p_user_id: userId,
    p_payload: payload,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, counts: (data ?? {}) as Record<string, number> };
}
