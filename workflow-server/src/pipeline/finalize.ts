import { assertExecutionActive } from '../runtime/executionScope.js';
import { jobLeases, JobLeaseLostError, type JobExecution } from '../jobs/lease.js';
// Post-completion finalize stage: folds the note into the owner's personal memory and
// names a solo recording's speaker at ingest (F5.1), refreshing note_insight. Runs after
// the job is marked completed and never throws. Imports shared config, db and memory
// modules (never index.ts or routes).
import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { formatTranscriptText, type TranscriptSegment } from '../parsers.js';
import { extractAndStoreInsight, foldNoteIntoMemory } from '../memory.js';
import { buildSpeakerContextFromSegments } from './speakerContext.js';
import type { SummarizeAudioInput } from './types.js';

// Post-summary enrichment that does NOT change the returned summary: fold the note
// into the owner's personal memory (F1' + note_insight/F4 index) and auto-identify
// speakers (F5.1). Run by the callers AFTER the job is marked completed / the response
// is sent, so the user sees the summary without waiting on these extra Gemini calls.
// Guaranteed non-throwing: each step is best-effort and the whole body is guarded, so a
// caller can await or fire-and-forget it without risk of an unhandled rejection.
export async function finalizeNoteMemory(input: SummarizeAudioInput, segments: TranscriptSegment[], execution?: JobExecution): Promise<boolean> {
  let complete = true;
  try {
    assertExecutionActive();
    const writeEnrichment = execution ? fencedEnrichmentWriter(execution) : undefined;
    const transcriptText = formatTranscriptText(segments, 'original');
    // Fold into personal memory + write the note_insight index. Idempotent:
    // foldNoteIntoMemory skips already-folded notes, so a retry never double-counts.
    try {
      const fold = await foldNoteIntoMemory({
        supabase,
        writeEnrichment,
        apiKey: env.geminiApiKey,
        userId: input.userId,
        noteId: input.noteId,
        transcript: transcriptText,
        selfName: input.userName ?? null,
        // Same speaker-name hint the summary uses, so action owners resolve to real
        // names instead of "" (transcript labels are generic "Speaker A/B" at this stage).
        speakerContext: input.speakerContext || null,
      });
      complete = complete && fold.complete;
      console.log(`Memory fold note=${input.noteId} items=${fold.memoryItemCount} insight=${fold.insightWritten} skipped=${fold.skipped}`);
    } catch (memoryError) {
      complete = false;
      console.warn(`Memory fold failed for note ${input.noteId}:`, memoryError);
    }

    // F5.1: auto-identify speakers and (high-confidence only) name the diarization +
    // refresh note_insight. Runs AFTER the memory fold so an auto-ID cannot flow into
    // personal memory (conservative scope).
    try {
      await autoIdentifySpeakersAtIngest({
        noteId: input.noteId,
        userId: input.userId,
        selfName: input.userName ?? null,
        segments,
        execution,
      });
    } catch (identifyError) {
      complete = false;
      console.warn(`Auto speaker identify failed for note ${input.noteId}:`, identifyError);
    }
  } catch (finalizeError) {
    complete = false;
    console.warn(`finalizeNoteMemory failed for note ${input.noteId}:`, finalizeError);
  }
  return complete;
}

// F5.1: at ingest, auto-name speakers ONLY in the reliable SINGLE-speaker case (a solo
// recording = the owner's own voice, named deterministically below). Multi-speaker self
// auto-apply was REMOVED 2026-08-25: a read-only measurement (eval/self-autoapply-precision.ts)
// found it only ~60% precise at conf>=0.8-0.9 with NO safe note-size bucket, so ~40% of the time
// it stamped a TEAMMATE's label as the owner and corrupted note_insight owner attribution (the
// "wrong-self" error class, root-caused via eval/speaker-diagnose.ts — the one confusion type a
// self-only policy does NOT protect against). Multi-speaker naming is now human-in-the-loop via
// the Suggest sheet (client-side identify, self guess pre-checked for one-tap confirmation).
// Re-extracts note_insight from the named transcript; does NOT re-fold personal memory (the fold
// above kept generic labels, so a misID can't corrupt memory). Best-effort.

export async function autoIdentifySpeakersAtIngest(input: {
  noteId: string;
  userId: string;
  selfName: string | null;
  segments: TranscriptSegment[];
  execution?: JobExecution;
}): Promise<void> {
  if (!env.geminiApiKey) return;
  const { noteId, userId, selfName, segments } = input;
  const anonLabels = Array.from(new Set(segments.map((s) => s.speaker).filter((name) => /^speaker\s/i.test(name))));
  if (anonLabels.length === 0) return;

  // Single-speaker note = the owner's own recording, so the one voice IS the self. Name it
  // deterministically instead of asking the model, which abstains on a context-free monologue
  // (no vocatives / self-intro / interaction-role signals to reason from). Skips the Gemini
  // call entirely. Needs the owner's name; without it we leave the label for a manual rename.
  if (anonLabels.length === 1) {
    if (!selfName?.trim()) return;
    await applyNamedSpeakers(noteId, userId, segments, new Map([[anonLabels[0], selfName.trim()]]), input.execution);
    return;
  }

  // Multi-speaker note: do NOT auto-identify or auto-apply "self" at ingest (see the header
  // comment for the measured rationale — ~60% precision, no safe note-size bucket, ~40%
  // wrong-self corruption). The Suggest sheet handles multi-speaker naming with the user in the
  // loop. This also skips a Gemini identify call whose only ingest purpose was the self apply.
}

// Apply resolved speaker names to a note's diarization and re-extract note_insight from the
// named transcript (so owners/participants resolve to real people). Shared by the ingest
// auto-identify paths (single-speaker self-naming + multi-speaker identification).
async function applyNamedSpeakers(
  noteId: string,
  userId: string,
  segments: TranscriptSegment[],
  nameByLabel: Map<string, string>,
  execution?: JobExecution,
): Promise<void> {
  if (nameByLabel.size === 0) return;
  const namedSegments = segments.map((seg) => {
    const name = nameByLabel.get(seg.speaker);
    return name ? { ...seg, speaker: name } : seg;
  });
  assertExecutionActive();
  if (execution) {
    const outcome = execution.lost ? 'lost' : await jobLeases.persistNote(execution, {
      id: noteId, user_id: userId, diarization: namedSegments, diarization_before: segments,
    }, 'diarization');
    if (outcome !== 'ok') throw new JobLeaseLostError(execution.jobId, execution.generation, 'speaker enrichment');
  }
  const { error: updateError } = execution ? { error: null } : await supabase.from('note').update({ diarization: namedSegments }).eq('id', noteId);
  if (updateError) {
    console.warn(`Diarization update failed for note ${noteId}: ${updateError.message}`);
    return;
  }
  const insight = await extractAndStoreInsight({
    supabase,
    writeEnrichment: execution ? fencedEnrichmentWriter(execution) : undefined,
    apiKey: env.geminiApiKey,
    userId,
    noteId,
    transcript: formatTranscriptText(namedSegments, 'original'),
    speakerContext: buildSpeakerContextFromSegments(namedSegments),
  });
  if (!insight.ok && execution) throw new Error('Speaker insight enrichment did not finish.');
  console.log(`Auto-named ${nameByLabel.size} speaker(s) for note ${noteId}: ${Array.from(nameByLabel.values()).join(', ')}`);
}

function fencedEnrichmentWriter(execution: JobExecution) {
  return async (kind: 'memory' | 'insight', payload: Record<string, unknown>): Promise<boolean> => {
    assertExecutionActive();
    if (execution.lost) throw new JobLeaseLostError(execution.jobId, execution.generation, 'enrichment');
    const outcome = await jobLeases.writeEnrichment(execution, kind, payload);
    if (outcome !== 'ok') throw new JobLeaseLostError(execution.jobId, execution.generation, `enrichment (${outcome})`);
    return true;
  };
}
