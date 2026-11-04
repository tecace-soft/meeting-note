// Job A: per-note decision extraction (F1). Runs after a note's transcript is finalized, behind
// DECISION_GRAPH_ENABLED. Flow: load note → idempotency check → run row → Prompt A over the FULL
// transcript (+ summary as secondary) → strict validation (retried by callJsonModel) →
// normalization + evidence check → atomic replace via SQL → run row done/failed with metrics.
//
// Idempotent on (note_id, prompt_version): a note with a 'done' run for the current prompt
// version is skipped unless force=true. Human-verified rows are protected by the SQL function.
// Never throws to callers.
import type { SupabaseClient } from '@supabase/supabase-js';
import { callJsonModel } from '../memory.js';
import { dedupeModels } from '../gemini.js';
import { STANDARD_FALLBACK_CHAIN } from '../gemini-models.js';
import { calculateGeminiUsageCost } from '../costs.js';
import { normalizeTranscript, type TranscriptSegment } from '../mcp/lib/transcript.js';
import { buildSpeakerContextFromSegments } from '../pipeline/speakerContext.js';
import { DECISION_PROMPT_VERSION, DECISION_SYSTEM_PROMPT, buildDecisionUserPrompt } from './prompt.js';
import { parseDecisionExtraction, type DecisionExtraction } from './schema.js';
import { resolverFromStored } from './normalize.js';
import { buildExtractionPayload, writeExtraction, type ExtractionMetrics } from './store.js';

// flash-lite has a 1M-token window; ~600k chars of Korean/English is far below it and bounds
// cost on pathological recordings. Truncation is recorded in quality_notes and metrics.
export const MAX_DECISION_TRANSCRIPT_CHARS = 600_000;
const MAX_OUTPUT_TOKENS = 16_384;
// A 'running' row younger than this blocks a second concurrent run for the same note.
const RUNNING_LEASE_MS = 15 * 60 * 1000;

export interface NoteForExtraction {
  id: string;
  user_id: string;
  name?: string | null;
  summary?: string | null;
  summary_edit?: string | null;
  transcription?: string | null;
  diarization?: unknown;
  meeting_at?: string | null;
  created_at?: string | null;
}

export const NOTE_EXTRACTION_SELECT = 'id, user_id, name, summary, summary_edit, transcription, diarization, meeting_at, created_at';

export interface PreparedInput {
  segments: TranscriptSegment[];
  transcript: string;
  truncated: boolean;
  summary: string | null;
  meetingDate: string;
  speakerContext: string | null;
}

/** Calendar date of an ISO timestamp in the given IANA zone, as YYYY-MM-DD. */
export function meetingDateOf(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function prepareInput(note: NoteForExtraction, timeZone: string): PreparedInput | { error: string } {
  let segments = normalizeTranscript(note.diarization).filter((s) => s.text.trim());
  if (segments.length === 0) segments = normalizeTranscript(note.transcription ?? null);
  if (segments.length === 0) return { error: 'empty transcript' };
  const meetingDate = meetingDateOf(note.meeting_at || note.created_at, timeZone);
  if (!meetingDate) return { error: 'note has no meeting_at/created_at' };

  // Keep whole segments up to the cap, so evidence indexes stay aligned with what the model saw.
  const kept: TranscriptSegment[] = [];
  let chars = 0;
  for (const seg of segments) {
    const line = `${seg.speaker}: ${seg.text}`;
    if (chars + line.length + 1 > MAX_DECISION_TRANSCRIPT_CHARS && kept.length > 0) break;
    kept.push(seg);
    chars += line.length + 1;
  }
  const summary = (note.summary_edit || note.summary || '').trim() || null;
  return {
    segments: kept,
    transcript: kept.map((s) => `${s.speaker}: ${s.text}`).join('\n'),
    truncated: kept.length < segments.length,
    summary,
    meetingDate,
    speakerContext: buildSpeakerContextFromSegments(kept),
  };
}

export interface ExtractResult {
  extraction: DecisionExtraction;
  model: string;
  latencyMs: number;
  usage: { promptTokens: number; outputTokens: number; estimatedCostUsd: number } | null;
}

/** Pure extraction: one model call + validation, no DB. Shared by the job and the eval script. */
export async function extractDecisions(input: {
  apiKey: string;
  model: string;
  fallbackModels?: string[];
  noteId: string;
  title?: string | null;
  prepared: PreparedInput;
}): Promise<ExtractResult | { error: string; latencyMs: number }> {
  const started = Date.now();
  const lastErrors: string[] = [];
  const out = await callJsonModel<DecisionExtraction>({
    apiKey: input.apiKey,
    models: dedupeModels([input.model, ...(input.fallbackModels ?? STANDARD_FALLBACK_CHAIN)]),
    systemPrompt: DECISION_SYSTEM_PROMPT,
    userPrompt: buildDecisionUserPrompt({
      noteId: input.noteId,
      meetingDate: input.prepared.meetingDate,
      title: input.title,
      transcript: input.prepared.transcript,
      summary: input.prepared.summary,
      speakerContext: input.prepared.speakerContext,
      transcriptTruncated: input.prepared.truncated,
    }),
    parse: (text) => {
      const r = parseDecisionExtraction(text);
      if (r.ok) return r.value;
      lastErrors.push(r.error);
      return null;
    },
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  const latencyMs = Date.now() - started;
  if ('error' in out) {
    const schemaHint = lastErrors.length ? ` | last validation error: ${lastErrors[lastErrors.length - 1]}` : '';
    return { error: `${out.error.slice(0, 240)}${schemaHint}`, latencyMs };
  }
  const usage = out.usageMetadata
    ? (() => {
        const cost = calculateGeminiUsageCost({ model: out.model, inputType: 'text', usageMetadata: out.usageMetadata });
        return { promptTokens: cost.promptTokens, outputTokens: cost.candidatesTokens, estimatedCostUsd: cost.estimatedCostUsd };
      })()
    : null;
  return { extraction: out.value, model: out.model, latencyMs, usage };
}

export type RunOutcome =
  | { status: 'done'; runId: string; metrics: ExtractionMetrics }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; runId?: string; reason: string };

export async function runDecisionExtraction(input: {
  supabase: SupabaseClient;
  apiKey: string;
  noteId: string;
  model: string;
  timeZone: string;
  force?: boolean;
  promptVersion?: string;
}): Promise<RunOutcome> {
  const { supabase, noteId } = input;
  const promptVersion = input.promptVersion ?? DECISION_PROMPT_VERSION;
  try {
    if (!input.apiKey) return { status: 'skipped', reason: 'no Gemini API key' };

    const { data: note, error: noteError } = await supabase
      .from('note')
      .select(NOTE_EXTRACTION_SELECT)
      .eq('id', noteId)
      .maybeSingle();
    if (noteError) return { status: 'failed', reason: `note read: ${noteError.message}` };
    if (!note) return { status: 'skipped', reason: 'note not found' };
    const n = note as NoteForExtraction;

    if (!input.force) {
      const { data: prior, error: priorError } = await supabase
        .from('mn_extraction_runs')
        .select('status, created_at')
        .eq('note_id', noteId)
        .eq('prompt_version', promptVersion)
        .in('status', ['done', 'running'])
        .order('created_at', { ascending: false })
        .limit(5);
      if (priorError) return { status: 'failed', reason: `run lookup: ${priorError.message}` };
      const rows = (prior ?? []) as Array<{ status: string; created_at: string }>;
      if (rows.some((r) => r.status === 'done')) return { status: 'skipped', reason: `already extracted (${promptVersion})` };
      if (rows.some((r) => r.status === 'running' && Date.now() - new Date(r.created_at).getTime() < RUNNING_LEASE_MS)) {
        return { status: 'skipped', reason: 'another run is in progress' };
      }
    }

    const prepared = prepareInput(n, input.timeZone);
    if ('error' in prepared) {
      await insertRun(supabase, { note_id: noteId, user_id: n.user_id, prompt_version: promptVersion, model: input.model, status: 'skipped', error: prepared.error, finished_at: new Date().toISOString() });
      return { status: 'skipped', reason: prepared.error };
    }

    const runId = await insertRun(supabase, {
      note_id: noteId,
      user_id: n.user_id,
      prompt_version: promptVersion,
      model: input.model,
      status: 'running',
      input_chars: prepared.transcript.length,
    });
    if (!runId) return { status: 'failed', reason: 'could not create run row' };

    const extracted = await extractDecisions({ apiKey: input.apiKey, model: input.model, noteId, title: n.name, prepared });
    if ('error' in extracted) {
      await finishRun(supabase, runId, { status: 'failed', error: extracted.error, metrics: { latency_ms: extracted.latencyMs } });
      return { status: 'failed', runId, reason: extracted.error };
    }

    const { data: storedEntities } = await supabase
      .from('mn_entities')
      .select('type, canonical_name, aliases')
      .eq('user_id', n.user_id);
    const resolver = resolverFromStored((storedEntities ?? []) as Array<{ type: string; canonical_name: string; aliases: string[] | null }>);

    const { payload, metrics, aliasCandidates } = buildExtractionPayload(extracted.extraction, {
      noteId,
      meetingDate: prepared.meetingDate,
      promptVersion,
      runId,
      segments: prepared.segments,
      resolver,
    });

    const runMetrics = {
      ...metrics,
      latency_ms: extracted.latencyMs,
      transcript_truncated: prepared.truncated,
      model: extracted.model,
      ...(extracted.usage ?? {}),
    };

    const written = await writeExtraction(supabase, noteId, n.user_id, payload);
    if (!written.ok) {
      await finishRun(supabase, runId, { status: 'failed', error: `store: ${written.error}`, output_json: extracted.extraction, metrics: runMetrics, alias_candidates: aliasCandidates, model: extracted.model });
      return { status: 'failed', runId, reason: `store: ${written.error}` };
    }
    await finishRun(supabase, runId, { status: 'done', output_json: extracted.extraction, metrics: runMetrics, alias_candidates: aliasCandidates, model: extracted.model });
    if (metrics.decided_ratio !== null && metrics.decided_ratio > 0.7 && metrics.decisions >= 4) {
      console.warn(`[decision-graph] note=${noteId} decided_ratio=${metrics.decided_ratio} (>0.7, possible over-classification)`);
    }
    return { status: 'done', runId, metrics };
  } catch (error) {
    return { status: 'failed', reason: (error as Error).message?.slice(0, 240) ?? 'unknown error' };
  }
}

async function insertRun(supabase: SupabaseClient, row: Record<string, unknown>): Promise<string | null> {
  const { data, error } = await supabase.from('mn_extraction_runs').insert(row).select('id').single();
  if (error) {
    console.warn(`[decision-graph] run insert failed for note ${String(row.note_id)}: ${error.message}`);
    return null;
  }
  return (data as { id: string }).id;
}

async function finishRun(supabase: SupabaseClient, runId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from('mn_extraction_runs')
    .update({ ...patch, finished_at: new Date().toISOString() })
    .eq('id', runId);
  if (error) console.warn(`[decision-graph] run update failed for ${runId}: ${error.message}`);
}
