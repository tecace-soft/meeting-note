// Orphan sweep: reconciles queued/processing jobs left stale by a crash or redeploy,
// recovering to 'completed' from an already persisted note and failing the rest. Started
// by startServer on boot and on an interval. Imports config, db and jobs/store only.
import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import type { TranscriptSegment } from '../parsers.js';
import type { SummarizeAudioResult } from '../pipeline/types.js';
import { updateWorkflowJob, ORPHANED_JOB_THRESHOLD_MS } from './store.js';

// Jobs run in-process via fire-and-forget, so a crash/redeploy leaves their
// rows stuck at 'queued'/'processing' forever and clients poll for the full
// hour. On boot, fail such rows that have gone stale (older than the orphan
// threshold) so clients get a prompt, retryable error. The staleness guard
// (backed by the per-job heartbeat) prevents sweeping a live job owned by an
// overlapping instance during a zero-downtime deploy.
// Cap how many stale jobs one sweep reconciles so a pathological backlog cannot
// unbound the per-note existence query or the per-job recovery updates.
export const MAX_ORPHAN_RECONCILE = 200;

// FIX 1 (convergence): rebuild a job result from a note that was already
// persisted. Lets a stranded job be recovered to 'completed' instead of 'failed',
// so the client never retries (and never spawns a duplicate pipeline) for work
// that already finished. Selected with '*' and read defensively so historical
// schema drift (missing translation / duration columns) cannot break recovery.
export function reconstructResultFromNote(noteRow: Record<string, unknown>): SummarizeAudioResult {
  const summaryTranslations = (noteRow.summary_translations ?? {}) as Record<'en' | 'ko', string>;
  const transcriptionTranslations = (noteRow.transcription_translations ?? {}) as Partial<Record<'en' | 'ko', string>>;
  const diarizationTranslations = (noteRow.diarization_translations ?? {}) as Partial<Record<'en' | 'ko', TranscriptSegment[]>>;
  const detected = noteRow.transcription_language;
  return {
    transcript: Array.isArray(noteRow.diarization) ? (noteRow.diarization as TranscriptSegment[]) : [],
    summary: typeof noteRow.summary === 'string' ? noteRow.summary : '',
    summaryTranslations,
    transcriptionLanguage: detected === 'en' || detected === 'ko' ? detected : null,
    transcriptionTranslations,
    diarizationTranslations,
    title: typeof noteRow.name === 'string' ? noteRow.name : '',
    tags: Array.isArray(noteRow.tags) ? (noteRow.tags as string[]) : [],
    audioDurationSeconds: typeof noteRow.duration_seconds === 'number' ? noteRow.duration_seconds : null,
    meetingStartAt: typeof noteRow.meeting_at === 'string' ? noteRow.meeting_at : null,
  };
}

export async function failOrphanedJobs(): Promise<void> {
  if (!env.supabaseUrl || !env.serviceRoleKey) return;
  const cutoff = new Date(Date.now() - ORPHANED_JOB_THRESHOLD_MS).toISOString();
  const { data, error } = await supabase
    .from('workflow_job')
    .select('id, user_id, note_id')
    .in('status', ['queued', 'processing'])
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(MAX_ORPHAN_RECONCILE);
  if (error) {
    console.warn(`Could not scan for orphaned workflow jobs: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{ id: string; user_id: string | null; note_id: string | null }>;
  if (rows.length === 0) return;

  // FIX 1 (convergence): a stranded job whose note was already persisted (the
  // 'completed' status write failed after the note insert succeeded) must NOT be
  // marked 'failed' -- that prompts the client to retry and spawn a second full
  // transcribe+summary run, duplicating the note and double-billing. Recover such
  // jobs to 'completed' from the existing note; fail only the rest.
  const noteIds = Array.from(new Set(rows.map((row) => row.note_id).filter((id): id is string => Boolean(id))));
  const notesById = new Map<string, Record<string, unknown>>();
  if (noteIds.length > 0) {
    const { data: noteData, error: noteError } = await supabase
      .from('note')
      .select('*')
      .in('id', noteIds);
    if (noteError) {
      // If the note lookup fails we cannot safely recover; fall back to the
      // original fail-all behavior rather than leaving jobs stranded.
      console.warn(`Could not look up notes while reconciling orphaned jobs: ${noteError.message}`);
    } else {
      for (const note of (noteData ?? []) as Array<Record<string, unknown>>) {
        if (typeof note.id === 'string') notesById.set(note.id, note);
      }
    }
  }

  const recoverable: Array<{ jobId: string; note: Record<string, unknown> }> = [];
  const failedIds: string[] = [];
  for (const row of rows) {
    const note = row.note_id ? notesById.get(row.note_id) : undefined;
    // Only recover when the note belongs to the same user as the job.
    if (note && (typeof note.user_id !== 'string' || note.user_id === row.user_id)) {
      recoverable.push({ jobId: row.id, note });
    } else {
      failedIds.push(row.id);
    }
  }

  for (const { jobId, note } of recoverable) {
    const recovered = await updateWorkflowJob(jobId, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      result: reconstructResultFromNote(note),
      error: null,
    }, { retries: 2 });
    if (!recovered) {
      // Could not converge to 'completed'; fail it so the client is not left
      // polling forever. The persisted note remains intact either way.
      failedIds.push(jobId);
    }
  }
  if (recoverable.length > 0) {
    console.log(`Recovered ${recoverable.length} orphaned workflow job(s) to completed from an existing note.`);
  }

  if (failedIds.length === 0) return;
  const { error: updateError } = await supabase
    .from('workflow_job')
    .update({
      status: 'failed',
      stage: 'failed',
      error: 'Server restarted while this job was running. Please try again.',
      updated_at: new Date().toISOString(),
    })
    .in('id', failedIds);
  if (updateError) {
    console.warn(`Could not fail ${failedIds.length} orphaned workflow job(s): ${updateError.message}`);
    return;
  }
  console.log(`Marked ${failedIds.length} orphaned workflow job(s) as failed.`);
}
