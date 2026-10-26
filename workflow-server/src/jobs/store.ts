import { supabase } from '../db/supabaseClient.js';
import { delay } from '../ai/geminiFallback.js';
import type { TranscriptSegment } from '../parsers.js';

export interface WorkflowJobRow {
  id: string;
  user_id: string;
  note_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  stage: string | null;
  progress: number | null;
  result: unknown;
  error: string | null;
}

// While a job is running, bump its updated_at on this cadence so the boot-time
// orphan sweep (failOrphanedJobs) can distinguish a live job on another
// instance from one stranded by a crashed/redeployed process.
export const JOB_HEARTBEAT_INTERVAL_MS = 60_000;

// A queued/processing job whose updated_at is older than this is considered
// orphaned. Must exceed the heartbeat interval by a safe margin so a genuinely
// live job (heartbeating every minute) is never swept.
export const ORPHANED_JOB_THRESHOLD_MS = 5 * 60_000;

// How often to re-scan for orphans. A boot-only scan would miss a job orphaned
// moments before boot (not yet past the staleness threshold), stranding it
// forever; a periodic scan cleans it once it crosses the threshold.
export const ORPHANED_JOB_SWEEP_INTERVAL_MS = 2 * 60_000;

export async function updateWorkflowJob(jobId: string | null, patch: {
  status?: WorkflowJobRow['status'];
  stage?: string;
  progress?: number;
  result?: unknown;
  error?: string | null;
}, options?: { retries?: number }): Promise<boolean> {
  if (!jobId) return false;
  const retries = Math.max(0, options?.retries ?? 0);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const { error } = await supabase.from('workflow_job').update({
      ...patch,
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);
    if (!error) return true;
    if (attempt < retries) {
      await delay(Math.min(1000 * 2 ** attempt, 8000));
      continue;
    }
    console.warn(`Could not update workflow job ${jobId}: ${error.message}`);
  }
  return false;
}

// FIX 2: transcribe -> summarize checkpoint. AssemblyAI transcription is the
// slowest and most expensive step, and until the final note insert its output
// lived only in a local variable. A summary failure or a process restart between
// transcription and insert therefore discarded the already-paid transcript and
// forced a full re-transcription on the next retry. The checkpoint persists the
// diarized segments keyed by noteId AFTER transcription succeeds and BEFORE the
// Gemini summary call, so a retry carrying the same noteId reuses them instead
// of paying AssemblyAI again. Keyed by noteId (not jobId) so it survives across
// job retries -- the mobile client reuses noteId when it retries. This is a
// durable checkpoint on the existing job model, not a redesign of it.
export interface TranscriptCheckpoint {
  segments: TranscriptSegment[];
  audioDurationSeconds: number | null;
  detectedLanguage: 'en' | 'ko' | null;
}

export async function loadTranscriptCheckpoint(noteId: string, userId: string): Promise<TranscriptCheckpoint | null> {
  const { data, error } = await supabase
    .from('workflow_transcript_checkpoint')
    .select('segments, audio_duration_seconds, detected_language')
    .eq('note_id', noteId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    // Fail-soft: a missing table (migration not applied) or any read error must
    // not break the pipeline. Fall back to a fresh transcription.
    console.warn(`Could not load transcript checkpoint for note ${noteId}: ${error.message}`);
    return null;
  }
  if (!data) return null;
  const row = data as { segments: unknown; audio_duration_seconds: unknown; detected_language: unknown };
  if (!Array.isArray(row.segments) || row.segments.length === 0) return null;
  const detected = row.detected_language;
  return {
    segments: row.segments as TranscriptSegment[],
    audioDurationSeconds: typeof row.audio_duration_seconds === 'number' ? row.audio_duration_seconds : null,
    detectedLanguage: detected === 'en' || detected === 'ko' ? detected : null,
  };
}

export async function saveTranscriptCheckpoint(input: { noteId: string; userId: string } & TranscriptCheckpoint): Promise<void> {
  const { error } = await supabase
    .from('workflow_transcript_checkpoint')
    .upsert({
      note_id: input.noteId,
      user_id: input.userId,
      segments: input.segments,
      audio_duration_seconds: input.audioDurationSeconds,
      detected_language: input.detectedLanguage,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'note_id' });
  if (error) {
    // Best-effort: a checkpoint write failure must not fail an otherwise-healthy
    // transcription. Worst case we re-transcribe on a retry (the pre-fix behavior).
    console.warn(`Could not persist transcript checkpoint for note ${input.noteId}: ${error.message}`);
  }
}

export async function deleteTranscriptCheckpoint(noteId: string): Promise<void> {
  const { error } = await supabase
    .from('workflow_transcript_checkpoint')
    .delete()
    .eq('note_id', noteId);
  if (error) {
    // Best-effort cleanup; a leftover checkpoint is harmless (it is only read on a
    // retry for the same noteId, which the persisted note already short-circuits).
    console.warn(`Could not delete transcript checkpoint for note ${noteId}: ${error.message}`);
  }
}
