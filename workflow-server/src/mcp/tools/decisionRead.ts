import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DECISION_STATUSES, type DecisionStatus } from '../../decisions/schema.js';
import { EntityResolver } from '../../decisions/normalize.js';
import { errorResult, jsonResult } from '../lib/formatters.js';
import { applyNoteAccessScope, fetchNote, getDataContext, getScopedUserId, noteAccessFilter, NOTE_TRANSCRIPT_SELECT, toIdValue } from '../lib/supabase.js';
import { normalizeTranscript } from '../lib/transcript.js';
import { buildNoteUrl } from './knowledge.js';

// Decision Graph M1 read tools (docs/decision-graph-mcp-plan.md). All reads go through the
// service_role-only SQL functions in migration 20261105120000, which apply the app's visibility
// rule (note visibility + sensitive meetings owner-only). Every decision carries its status and a
// fixed human label so clients never present a proposal as a decision.

export const STATUS_LABELS: Record<DecisionStatus, string> = {
  decided: '확정 (decided)',
  direction: '방향 (direction, 실행 미정)',
  proposed: '제안 (proposed, 확정 아님)',
  deferred: '보류 (deferred, 확정 아님)',
  status_report: '진행 보고 (status_report)',
  info: '정보 (info, 결정 아님)',
  customer_decided: '고객·파트너 측 결정 (customer_decided)',
  customer_stated: '고객·파트너 측 입장 (customer_stated, 확정 아님)',
};
const DEFAULT_STATUSES: DecisionStatus[] = ['decided', 'customer_decided', 'direction'];
const NO_DATA_MESSAGE = 'No decision data for these meetings yet. Decision extraction may be off, or these notes have not been processed. This does NOT mean no decisions were made: fall back to get_note_summary / search_notes.';
const STATUS_RULE = 'Always present each item with its statusLabel. Only status "decided" or "customer_decided" is a final decision; never describe proposed/direction/deferred/info items as decided.';

export interface DecisionRow {
  id: string; note_id: string; seq: number; text: string; status: DecisionStatus; side: string; decided_by: string | null;
  participants: string[] | null; why: string | null; trigger: string | null; alternatives_rejected: string[] | null;
  assumptions: string[] | null; effective_date: string | null; project: string | null; evidence_quote: string | null;
  evidence_segment_ids: string[] | null; evidence_match: boolean | null; valid_from: string; invalid_at: string | null;
  human_verified: boolean; meeting_title: string | null; meeting_kind: string | null; sensitivity: string; total_count: number | string;
}

/** ILIKE "contains" pattern with the user's text treated literally. */
export function containsPattern(text: string | undefined): string | null {
  const t = text?.trim();
  if (!t) return null;
  return `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function clip(text: string | null | undefined, max: number): string | null {
  if (text == null) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatDecision(row: DecisionRow, full = false) {
  return {
    id: row.id,
    date: row.valid_from,
    meetingTitle: row.meeting_title,
    noteId: row.note_id,
    noteUrl: buildNoteUrl(row.note_id),
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    isFinal: row.status === 'decided' || row.status === 'customer_decided',
    side: row.side,
    decidedBy: row.decided_by,
    text: full ? row.text : clip(row.text, 300),
    why: full ? row.why : clip(row.why, 200),
    project: row.project,
    evidenceQuote: full ? row.evidence_quote : clip(row.evidence_quote, 200),
    evidenceVerified: row.evidence_match === true,
    humanVerified: row.human_verified,
    supersededOn: row.invalid_at,
  };
}

export async function queryVisibleDecisions(userId: string, filters: {
  noteIds?: string[] | null; statuses?: string[] | null; from?: string | null; to?: string | null; person?: string | null;
  project?: string | null; query?: string | null; decisionIds?: string[] | null; includeSuperseded?: boolean; limit?: number; offset?: number;
}): Promise<{ rows: DecisionRow[]; total: number }> {
  const { supabase } = getDataContext();
  const { data, error } = await supabase.rpc('mn_visible_decisions', {
    p_user_id: userId,
    p_note_ids: filters.noteIds ?? null,
    p_statuses: filters.statuses ?? null,
    p_from: filters.from ?? null,
    p_to: filters.to ?? null,
    p_person: filters.person ?? null,
    p_project: filters.project ?? null,
    p_query: filters.query ?? null,
    p_decision_ids: filters.decisionIds ?? null,
    p_include_superseded: filters.includeSuperseded ?? false,
    p_limit: filters.limit ?? 20,
    p_offset: filters.offset ?? 0,
  });
  if (error) throw error;
  const rows = (data as DecisionRow[]) ?? [];
  return { rows, total: rows.length ? Number(rows[0].total_count) : 0 };
}

async function visibleRecordCount(userId: string, noteIds: string[] | null): Promise<number> {
  const { supabase } = getDataContext();
  const { data, error } = await supabase.rpc('mn_visible_record_count', { p_user_id: userId, p_note_ids: noteIds });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Decisions block for get_meeting_brief. Null when there is no scoped user or no data. */
export async function meetingDecisionsBlock(noteId: string): Promise<unknown> {
  const userId = getScopedUserId();
  if (!userId) return null;
  try {
    const { rows } = await queryVisibleDecisions(userId, { noteIds: [noteId], includeSuperseded: true, limit: 50 });
    if (rows.length === 0) return { available: false, message: NO_DATA_MESSAGE };
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    return { available: true, rule: STATUS_RULE, byStatus, items: rows.map((r) => formatDecision(r)) };
  } catch (error) {
    return { available: false, message: `Decision data unavailable: ${(error as Error).message?.slice(0, 120)}` };
  }
}

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export function registerDecisionReadTools(server: McpServer): void {
  server.registerTool(
    'get_decisions',
    {
      title: 'Get Decisions',
      description: [
        'List decisions recorded from meetings you can access, with status, reason, decision maker, verbatim transcript evidence and a link to the meeting. Use for "what did we decide about X / why / who decided".',
        'Filters: projectId (one of your Meeting Note projects), projectName (free text, matches extracted project names and aliases), person, status, from/to dates (YYYY-MM-DD), query (text in the decision or reason).',
        'By default returns final decisions plus directions (status decided, customer_decided, direction); pass status to include proposed/deferred/info/etc.',
        STATUS_RULE,
        'If coverage.notesWithDecisionData is 0, decision data does not exist yet for that scope: say so and fall back to summaries; do not conclude nothing was decided.',
      ].join(' '),
      inputSchema: {
        projectId: z.string().min(1).optional(),
        projectName: z.string().min(1).max(100).optional(),
        person: z.string().min(1).max(100).optional(),
        status: z.array(z.enum(DECISION_STATUSES)).min(1).max(8).optional(),
        from: dateString.optional(),
        to: dateString.optional(),
        query: z.string().min(1).max(200).optional(),
        includeSuperseded: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().regex(/^\d+$/).optional(),
      },
    },
    async ({ projectId, projectName, person, status, from, to, query, includeSuperseded, limit, cursor }) => {
      const userId = getScopedUserId();
      if (!userId) return errorResult('get_decisions needs a signed-in user.');
      let noteIds: string[] | null = null;
      if (projectId) {
        const { supabase } = getDataContext();
        let q = supabase.from('note').select('id').contains('projects', [toIdValue(projectId)]).limit(500);
        q = applyNoteAccessScope(q, await noteAccessFilter(userId));
        const { data, error } = await q;
        if (error) return errorResult(error.message);
        noteIds = ((data as Array<{ id: string }>) ?? []).map((r) => String(r.id));
        if (noteIds.length === 0) return jsonResult({ decisions: [], coverage: { notesInScope: 0, notesWithDecisionData: 0 }, message: `No accessible notes in project ${projectId}.` });
      }
      // Resolve a person alias (e.g. "Kotak" → 김교탁) to the stored canonical name.
      const personName = person ? (new EntityResolver().resolve('person', person) ?? person).replace(/\s*\(추정\)$/, '') : undefined;
      const offset = cursor ? Number(cursor) : 0;
      const pageSize = limit ?? 20;
      try {
        const { rows, total } = await queryVisibleDecisions(userId, {
          noteIds,
          statuses: status ?? DEFAULT_STATUSES,
          from: from ?? null,
          to: to ?? null,
          person: containsPattern(personName),
          project: containsPattern(projectName),
          query: containsPattern(query),
          includeSuperseded: includeSuperseded ?? false,
          limit: pageSize,
          offset,
        });
        const covered = await visibleRecordCount(userId, noteIds);
        const byStatus: Record<string, number> = {};
        for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
        return jsonResult({
          rule: STATUS_RULE,
          statusesIncluded: status ?? DEFAULT_STATUSES,
          totalMatching: total,
          byStatusOnPage: byStatus,
          decisions: rows.map((r) => formatDecision(r)),
          coverage: { notesInScope: noteIds ? noteIds.length : null, notesWithDecisionData: covered },
          message: covered === 0 ? NO_DATA_MESSAGE : undefined,
          nextCursor: offset + rows.length < total ? String(offset + rows.length) : null,
        });
      } catch (error) {
        return errorResult(`get_decisions failed: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    'explain_decision',
    {
      title: 'Explain Decision',
      description: [
        'Explain one decision by id (from get_decisions or get_meeting_brief): full text, why, trigger, rejected alternatives, assumptions, the verbatim evidence with the surrounding transcript lines, actions derived from it, and links to earlier/later decisions when recorded.',
        STATUS_RULE,
      ].join(' '),
      inputSchema: { decisionId: z.string().min(1).max(100) },
    },
    async ({ decisionId }) => {
      const userId = getScopedUserId();
      if (!userId) return errorResult('explain_decision needs a signed-in user.');
      try {
        const { rows } = await queryVisibleDecisions(userId, { decisionIds: [decisionId], includeSuperseded: true, limit: 1 });
        const row = rows[0];
        if (!row) return errorResult(`Decision not found or not accessible: ${decisionId}`);
        const { supabase } = getDataContext();
        const [actionsRes, linksRes, note] = await Promise.all([
          supabase.rpc('mn_visible_actions', { p_user_id: userId, p_decision_ids: [decisionId], p_note_ids: null }),
          supabase.rpc('mn_visible_links', { p_user_id: userId, p_decision_ids: [decisionId] }),
          fetchNote(row.note_id, NOTE_TRANSCRIPT_SELECT).catch(() => null),
        ]);
        const segments = note ? normalizeTranscript(note.diarization) : [];
        const idx = (row.evidence_segment_ids ?? []).map((s) => Number(String(s).replace(/^s/, ''))).filter((n) => Number.isInteger(n) && n >= 0 && n < segments.length);
        const context = idx.length
          ? segments.slice(Math.max(0, Math.min(...idx) - 3), Math.min(segments.length, Math.max(...idx) + 4)).map((s) => `${s.speaker}: ${s.text}`)
          : [];
        const links = ((linksRes.data as Array<{ new_decision: string; old_decision: string; rel: string; confidence: number | null; reason: string | null; reviewed: boolean }>) ?? [])
          .map((l) => ({ rel: l.rel, direction: l.new_decision === decisionId ? 'this decision → earlier' : 'later → this decision', otherDecisionId: l.new_decision === decisionId ? l.old_decision : l.new_decision, confidence: l.confidence, reason: l.reason, reviewed: l.reviewed }));
        return jsonResult({
          rule: STATUS_RULE,
          decision: {
            ...formatDecision(row, true),
            trigger: row.trigger,
            alternativesRejected: row.alternatives_rejected ?? [],
            assumptions: row.assumptions ?? [],
            effectiveDate: row.effective_date,
            participants: row.participants ?? [],
            meetingKind: row.meeting_kind,
          },
          evidenceContext: context,
          actions: ((actionsRes.data as Array<Record<string, unknown>>) ?? []).map((a) => ({ text: a.text, owner: a.owner, due: a.due, status: a.status, evidenceVerified: a.evidence_match === true })),
          links,
          linksNote: links.length ? undefined : 'No cross-meeting links recorded yet (linking job not run for this decision).',
        });
      } catch (error) {
        return errorResult(`explain_decision failed: ${(error as Error).message}`);
      }
    },
  );
}
