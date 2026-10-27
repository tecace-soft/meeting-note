// Orphan sweep: reconciles queued/processing jobs left by a crash or redeploy. With the
// S10 schema (DEC-0022) recoverOrphanedJobs claims each job whose lease expired by
// database time (the claim itself fails a job past its execution or claim cap) and
// either converges it to 'completed' from a persisted note or resumes it through the
// runner. Before the migration it falls
// back to failOrphanedJobs (the pre-S10 behavior: recover from a note, fail the rest).
// Started by startServer on boot and on an interval; nothing runs at import time.
// Imports config, db, ops, pipeline input helpers and the jobs modules (never routes).
import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { raiseIncident } from '../ops/incidents.js';
import type { TranscriptSegment } from '../parsers.js';
import type { SummarizeAudioInput, SummarizeAudioRequest, SummarizeAudioResult } from '../pipeline/types.js';
import { parseSummarizeInput } from '../pipeline/inputs.js';
import { createAudioSignedUrl } from '../pipeline/androidUpload.js';
import { updateWorkflowJob, ORPHANED_JOB_THRESHOLD_MS } from './store.js';
import {
  executionFromClaim, isMissingS10Schema, jobLeases, JobLeaseLostError, JOB_EXHAUSTED_ERROR, MAX_JOB_CLAIMS,
  MAX_JOB_EXECUTION_ATTEMPTS, type JobClaim, type JobExecution,
} from './lease.js';
import { runOwnedJob } from './runner.js';

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

// ---------------------------------------------------------------------------
// S10 recovery (DEC-0022)
// ---------------------------------------------------------------------------

// Pipelines one sweep may start. A bounded loop, not a concurrency cap (S13): the rest
// stay unclaimed and the next sweep (ORPHANED_JOB_SWEEP_INTERVAL_MS later) takes them.
export const MAX_RESUMES_PER_SWEEP = 5;
export const SWEEP_QUERY_TIMEOUT_MS = 15_000;
export const RESUME_UNREADABLE_REQUEST_MESSAGE = 'Server restarted while this job was running and the saved job could not be resumed. Please try again.';

export type RecoveryOutcome = 'completed' | 'failed' | 'resumed' | 'deferred' | 'lost';

// Rebuilds the pipeline input from the job's stored request. Returns null when it is
// unusable or names another user or note than the row (never run foreign input).
export async function resumeInputFromRequest(claim: JobClaim, request: unknown): Promise<SummarizeAudioInput | null> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  let input: SummarizeAudioInput;
  try {
    input = parseSummarizeInput(request as SummarizeAudioRequest);
  } catch {
    return null;
  }
  if (input.userId !== claim.userId || input.noteId !== claim.noteId) return null;
  const record = request as Record<string, unknown>;
  // The Android route stored the object path it uploaded itself (server-written, so
  // trusted); a resume signs a fresh link instead of relying on the old one.
  if (record.source === 'android_recording' && typeof record.storagePath === 'string' && record.storagePath.trim()) {
    try {
      input.downloadUrl = await createAudioSignedUrl(record.storagePath);
    } catch (error) {
      console.warn(`Could not re-sign the Android recording for workflow job ${claim.jobId}; resuming with the stored link. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return input;
}

async function failClaimed(execution: JobExecution, message: string): Promise<RecoveryOutcome> {
  const written = await updateWorkflowJob(execution, { status: 'failed', stage: 'failed', progress: 100, error: message }, { retries: 2 });
  if (written) console.log(`Marked orphaned workflow job ${execution.jobId} as failed: ${message}`);
  // A failed write defers: the lease expires and the next claim (bounded by the SQL claim
  // cap) tries again. No execution was started, so no attempt was used.
  return written ? 'failed' : 'deferred';
}

// The claim RPC already failed the row in SQL (executions or claims used up). Only report it.
function reportExhausted(claim: JobClaim): void {
  console.warn(`Workflow job ${claim.jobId} stopped after ${claim.attempt} execution(s) and ${claim.claimCount} claim(s); the claim marked it failed.`);
  void raiseIncident({
    title: 'Workflow job stopped after repeated interruptions',
    error: new Error(JOB_EXHAUSTED_ERROR.en),
    context: { jobId: claim.jobId, noteId: claim.noteId, userId: claim.userId, attempt: claim.attempt, claims: claim.claimCount, stage: claim.stage },
  });
}

// Decides the outcome of one claimed orphan. Every read and write is fenced by the claim,
// so a concurrent sweep or a late original owner can never both act on it. Order: the
// cheap note check, then the (possibly large) request read, then the execution count,
// so a deferral never uses an execution attempt (only a claim, which SQL bounds).
export async function recoverClaimedJob(claim: JobClaim): Promise<RecoveryOutcome> {
  const execution = executionFromClaim(claim, { resumed: true });
  try {
    // FIX 1 (convergence): a persisted note means the work finished; converge to
    // completed instead of running (and paying for) it again.
    if (claim.noteId) {
      const { data: note, error } = await supabase
        .from('note')
        .select('*')
        .eq('id', claim.noteId)
        .abortSignal(AbortSignal.timeout(SWEEP_QUERY_TIMEOUT_MS))
        .maybeSingle();
      if (error) {
        // Unknown whether the note exists: neither rerun nor fail. The lease expires and
        // a later sweep tries again.
        console.warn(`Could not look up the note of orphaned workflow job ${claim.jobId}; a later sweep retries: ${error.message}`);
        return 'deferred';
      }
      const row = note as Record<string, unknown> | null;
      if (row && (typeof row.user_id !== 'string' || row.user_id === claim.userId)) {
        const written = await updateWorkflowJob(execution, {
          status: 'completed',
          stage: 'completed',
          progress: 100,
          result: reconstructResultFromNote(row),
          error: null,
        }, { retries: 2 });
        if (written) console.log(`Recovered orphaned workflow job ${claim.jobId} to completed from an existing note.`);
        return written ? 'completed' : 'deferred';
      }
    }
    const loaded = await jobLeases.loadRequest(execution);
    if (loaded.outcome === 'lost') throw new JobLeaseLostError(claim.jobId, claim.generation, 'the request load');
    if (loaded.outcome !== 'ok') {
      console.warn(`Could not load the stored request of orphaned workflow job ${claim.jobId} (${loaded.outcome}); a later sweep retries.`);
      return 'deferred';
    }
    const input = await resumeInputFromRequest(claim, loaded.request);
    if (!input) return await failClaimed(execution, RESUME_UNREADABLE_REQUEST_MESSAGE);
    const begun = await jobLeases.beginExecution(execution);
    if (begun.outcome === 'lost') throw new JobLeaseLostError(claim.jobId, claim.generation, 'the execution start');
    if (begun.outcome !== 'ok' || begun.attempt === null) {
      console.warn(`Could not count the resumed execution of workflow job ${claim.jobId} (${begun.outcome}); a later sweep retries.`);
      return 'deferred';
    }
    execution.attempt = begun.attempt;
    console.log(`Resuming orphaned workflow job ${claim.jobId} (execution ${begun.attempt} of ${MAX_JOB_EXECUTION_ATTEMPTS}, claim ${claim.claimCount} of ${MAX_JOB_CLAIMS}, generation ${claim.generation}, stage ${claim.stage ?? 'unknown'}, transcript id ${claim.transcriptId ? 'saved' : 'not saved'}, submission ${claim.submissionState}).`);
    void runOwnedJob(execution, input);
    return 'resumed';
  } catch (error) {
    if (error instanceof JobLeaseLostError) {
      console.warn(`${error.message} Another execution took this orphan over.`);
      return 'lost';
    }
    throw error;
  }
}

// Boot and periodic entry point. The candidate scan uses this process's clock only to
// pick rows; the claim RPC re-checks expiry by database time and is the only authority.
export async function recoverOrphanedJobs(): Promise<void> {
  if (!env.supabaseUrl || !env.serviceRoleKey) return;
  const now = Date.now();
  const leaseCutoff = new Date(now).toISOString();
  const heartbeatCutoff = new Date(now - ORPHANED_JOB_THRESHOLD_MS).toISOString();
  const { data, error } = await supabase
    .from('workflow_job')
    .select('id, lease_expires_at')
    .in('status', ['queued', 'processing'])
    .or(`lease_expires_at.lt."${leaseCutoff}",and(lease_expires_at.is.null,updated_at.lt."${heartbeatCutoff}")`)
    .order('updated_at', { ascending: true })
    .limit(MAX_ORPHAN_RECONCILE)
    .abortSignal(AbortSignal.timeout(SWEEP_QUERY_TIMEOUT_MS));
  if (error) {
    if (isMissingS10Schema(error)) {
      await failOrphanedJobs();
      return;
    }
    console.warn(`Could not scan for orphaned workflow jobs: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{ id: string }>;
  let started = 0;
  for (const [index, row] of rows.entries()) {
    if (started >= MAX_RESUMES_PER_SWEEP) {
      console.log(`Resumed ${started} orphaned workflow job(s) this sweep; ${rows.length - index} more wait for the next sweep.`);
      return;
    }
    const outcome = await jobLeases.claim(row.id, 'recover');
    if (outcome.kind === 'unsupported') {
      // Columns exist but the RPCs do not (partially applied migration): no S10 instance
      // can own a job, so the pre-S10 sweep is safe and keeps jobs from stranding.
      console.warn(`S10 claim RPC unavailable (${outcome.message}); using the pre-S10 orphan sweep.`);
      await failOrphanedJobs();
      return;
    }
    if (outcome.kind === 'error') {
      console.warn(`Could not claim orphaned workflow job ${row.id}: ${outcome.message}`);
      continue;
    }
    if (outcome.kind === 'not-claimable') continue;
    if (outcome.kind === 'exhausted') {
      reportExhausted(outcome.claim);
      continue;
    }
    if (await recoverClaimedJob(outcome.claim) === 'resumed') started += 1;
  }
}
