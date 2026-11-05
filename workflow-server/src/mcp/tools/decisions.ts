import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { GEMINI_2_5_FLASH_LITE, GEMINI_3_1_FLASH_LITE } from '../../gemini-models.js';
import { extractDecisions, prepareInput, refinePayload, runDecisionExtraction, DECISION_PIPELINE_VERSION, NOTE_EXTRACTION_SELECT, type NoteForExtraction } from '../../decisions/job.js';
import { buildExtractionPayload } from '../../decisions/store.js';
import { errorResult, jsonResult } from '../lib/formatters.js';
import { getDataContext, getScopedUserId } from '../lib/supabase.js';

// Decision Graph eval / backfill trigger (docs/decision-graph.md). Lets the note OWNER run Job A
// on their own notes from an MCP client while the automatic pipeline is still off
// (DECISION_GRAPH_ENABLED), so the gold-set eval needs no local setup or shared keys.
// Owner-only on purpose: extraction reads the full transcript and, with write=true, stores rows.
// dry run (default) stores nothing and returns the extraction with its quality metrics.
export const MAX_DECISION_NOTES_PER_CALL = 3;

export function registerDecisionTools(server: McpServer): void {
  server.registerTool(
    'run_decision_extraction',
    {
      title: 'Run Decision Extraction (eval)',
      description:
        'Decision Graph evaluation tool. Runs decision extraction (Prompt A) on up to 3 notes YOU OWN and returns the structured decisions (status, decided_by, evidence quote) plus quality metrics: evidence match rate against the transcript, status distribution, decided ratio, latency and estimated cost. Default dryRun=true stores nothing. dryRun=false stores the result in the decision tables (re-running replaces unverified rows). Each note takes one model call over the full transcript (can take tens of seconds); call with one note at a time for long meetings. Only for evaluating or backfilling the Decision Graph, not for answering questions about meetings.',
      inputSchema: {
        noteIds: z.array(z.string().min(1)).min(1).max(MAX_DECISION_NOTES_PER_CALL),
        model: z.enum([GEMINI_3_1_FLASH_LITE, GEMINI_2_5_FLASH_LITE]).optional().describe('Lite model to evaluate. Default: the configured decision model.'),
        dryRun: z.boolean().optional().describe('Default true: return results without storing them.'),
      },
    },
    async ({ noteIds, model, dryRun }) => {
      const userId = getScopedUserId();
      if (!userId) return errorResult('run_decision_extraction needs a signed-in user (owner-scoped).');
      if (!env.geminiApiKey) return errorResult('Gemini API key is not configured on the server.');
      const { supabase } = getDataContext();
      const chosenModel = model ?? env.decisionGraphModel;
      const write = dryRun === false;
      const results: unknown[] = [];

      for (const noteId of noteIds as string[]) {
        const { data, error } = await supabase.from('note').select(NOTE_EXTRACTION_SELECT).eq('id', noteId).maybeSingle();
        if (error) { results.push({ noteId, ok: false, error: error.message }); continue; }
        const note = data as NoteForExtraction | null;
        // Same "not found" for missing and not-owned notes, so ids cannot be probed.
        if (!note || note.user_id !== userId) { results.push({ noteId, ok: false, error: 'Note not found or not owned by you.' }); continue; }

        if (write) {
          const out = await runDecisionExtraction({ supabase, apiKey: env.geminiApiKey, noteId, model: chosenModel, timeZone: env.decisionGraphTimeZone, force: true });
          results.push(out.status === 'done' ? { noteId, ok: true, stored: true, runId: out.runId, metrics: out.metrics } : { noteId, ok: false, error: `${out.status}: ${out.reason}` });
          continue;
        }

        const prepared = prepareInput(note, env.decisionGraphTimeZone);
        if ('error' in prepared) { results.push({ noteId, ok: false, error: prepared.error }); continue; }
        // No fallback model in dry runs: the eval measures exactly the requested model.
        const res = await extractDecisions({ apiKey: env.geminiApiKey, model: chosenModel, fallbackModels: [], noteId, title: note.name, prepared });
        if ('error' in res) { results.push({ noteId, ok: false, error: res.error, latencyMs: res.latencyMs }); continue; }
        const built = buildExtractionPayload(res.extraction, {
          noteId, meetingDate: prepared.meetingDate, promptVersion: DECISION_PIPELINE_VERSION, runId: null, segments: prepared.segments,
        });
        const { payload, aliasCandidates } = built;
        const { metrics, refine } = await refinePayload({ apiKey: env.geminiApiKey, model: chosenModel, payload, metrics: built.metrics, segments: prepared.segments, sideFixes: built.sideFixes });
        results.push({
          noteId,
          ok: true,
          stored: false,
          model: res.model,
          promptVersion: DECISION_PIPELINE_VERSION,
          latencyMs: res.latencyMs,
          inputChars: prepared.transcript.length,
          transcriptTruncated: prepared.truncated,
          usage: res.usage,
          metrics,
          statusAdjustments: refine.adjustments,
          verifier: refine.verifier,
          meeting: { date: payload.record.meeting_date, ...pick(res.extraction.meeting, ['title', 'meeting_kind', 'sensitivity', 'quality', 'quality_notes']) },
          decisions: payload.decisions.map((d) => ({
            id: d.local_id, status: d.status, side: d.side, text: d.text, decidedBy: d.decided_by, project: d.project,
            why: d.why, evidence: d.evidence_quote, evidenceMatch: d.evidence_match,
          })),
          actions: payload.actions.map((a) => ({ text: a.text, owner: a.owner, due: a.due, fromDecision: a.from_decision, evidenceMatch: a.evidence_match })),
          issues: payload.issues.map((i) => ({ type: i.type, text: i.text, evidenceMatch: i.evidence_match })),
          referencesToPast: payload.record.references_to_past,
          aliasCandidates,
        });
      }
      return jsonResult({ dryRun: !write, results });
    },
  );
}

function pick<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}
