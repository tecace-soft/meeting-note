// Summarize job runner: claims one job (S10, DEC-0022), runs it through the pipeline, keeps
// its lease (or, before the S10 migration, its updated_at) fresh with a heartbeat, writes
// the terminal status and runs the post-completion enrichment. Owns the in-memory
// completed-result cache read by the job status route. Imports pipeline, jobs/store,
// jobs/lease and ops modules only (never index.ts or routes).
import { raiseIncident } from '../ops/incidents.js';
import type { SummarizeAudioInput, SummarizeAudioResult } from '../pipeline/types.js';
import { AudioUnavailableError, NoSpeechDetectedError } from '../pipeline/errors.js';
import { runSummarizeAudio } from '../pipeline/summarize.js';
import { finalizeNoteMemory } from '../pipeline/finalize.js';
import { updateWorkflowJob, JOB_HEARTBEAT_INTERVAL_MS, type JobRef } from './store.js';
import { executionFromClaim, jobLeases, JobLeaseLostError, type ClaimOutcome, type JobExecution } from './lease.js';
import { delay } from '../ai/geminiFallback.js';

export const completedJobResults = new Map<string, SummarizeAudioResult>();

// A transient start-claim error is retried this many times in total, with a short
// linear backoff, before the job is left to the orphan sweep.
export const START_CLAIM_TRIES = 3;
export const START_CLAIM_BACKOFF_MS = 500;

// Retries a transient start-claim error. When an earlier try may have committed (its
// response was lost), a later try sees the row as already claimed; a fenced renewal as
// this process at generation 1 proves whether that claim was ours.
async function claimForStart(jobId: string, input: SummarizeAudioInput): Promise<ClaimOutcome> {
  let outcome = await jobLeases.claim(jobId, 'start');
  let uncertain = false;
  for (let attempt = 1; attempt < START_CLAIM_TRIES && outcome.kind === 'error'; attempt += 1) {
    uncertain = true;
    console.warn(`Could not claim workflow job ${jobId} (${outcome.message}); retrying (${attempt + 1}/${START_CLAIM_TRIES}).`);
    await delay(START_CLAIM_BACKOFF_MS * attempt);
    outcome = await jobLeases.claim(jobId, 'start');
  }
  if (outcome.kind !== 'not-claimable' || !uncertain) return outcome;
  const claim = {
    jobId, userId: input.userId, noteId: input.noteId, status: 'queued', stage: 'queued', generation: 1, attempt: 1, claimCount: 1,
    transcriptId: null, submissionState: 'none' as const, submissionCount: 0,
  };
  const probe = await jobLeases.renew(executionFromClaim(claim, { resumed: false }));
  if (probe !== 'ok') return outcome;
  console.log(`Workflow job ${jobId}: an earlier start claim whose response was lost belongs to this process; running it.`);
  return { kind: 'claimed', claim };
}

// Starts a freshly inserted job. With the S10 schema the run is owned (claimed lease,
// fenced writes); before the migration it runs exactly as before S10.
export async function processSummarizeJob(jobId: string, input: SummarizeAudioInput): Promise<void> {
  const outcome = await claimForStart(jobId, input);
  if (outcome.kind === 'exhausted') return;
  if (outcome.kind === 'unsupported') {
    await runJob(jobId, input);
    return;
  }
  if (outcome.kind === 'not-claimable') {
    console.warn(`Workflow job ${jobId} is already owned by another execution; not starting it again.`);
    return;
  }
  if (outcome.kind === 'error') {
    // Never run unowned when ownership is unknown (the claim may have landed). The row
    // stays queued and the orphan sweep resumes it once its lease or heartbeat is stale.
    console.warn(`Could not claim workflow job ${jobId} (${outcome.message}); the orphan sweep resumes it once it is stale.`);
    return;
  }
  await runJob(executionFromClaim(outcome.claim, { resumed: false }), input);
}

// Runs a job the caller already owns: the orphan sweep's resume path.
export async function runOwnedJob(execution: JobExecution, input: SummarizeAudioInput): Promise<void> {
  await runJob(execution, input);
}

// Pre-S10: bump updated_at. S10: renew the lease by database time; a renewal that proves
// another owner took over marks the execution lost, which stops it at its next check.
async function heartbeat(job: string | JobExecution): Promise<void> {
  if (typeof job === 'string') {
    await updateWorkflowJob(job, {});
    return;
  }
  const outcome = await jobLeases.renew(job);
  if (outcome === 'ok') return;
  if (outcome === 'lost') {
    if (!job.lost) console.warn(`Workflow job ${job.jobId} lost its lease (generation ${job.generation}) at a heartbeat; stopping at the next checkpoint.`);
    job.lost = true;
    return;
  }
  console.warn(`Could not renew the lease of workflow job ${job.jobId} (${outcome}); retrying at the next heartbeat.`);
}

async function writeFailed(job: JobRef, jobId: string, message: string): Promise<void> {
  try {
    await updateWorkflowJob(job, {
      status: 'failed',
      stage: 'failed',
      progress: 100,
      error: message,
    }, { retries: 4 });
  } catch (error) {
    if (!(error instanceof JobLeaseLostError)) throw error;
    console.warn(`${error.message} The failure was not written; the current owner decides the outcome of job ${jobId}.`);
  }
}

async function runJob(job: string | JobExecution, input: SummarizeAudioInput): Promise<void> {
  const jobId = typeof job === 'string' ? job : job.jobId;
  // Keep the lease (or updated_at) fresh across long silent stages (e.g. the
  // multi-minute AssemblyAI poll) so the orphan sweep never mistakes this live job
  // for an orphan.
  const timer = setInterval(() => {
    void heartbeat(job);
  }, JOB_HEARTBEAT_INTERVAL_MS);
  try {
    const result = await runSummarizeAudio(input, job);
    // Terminal writes retry: a transient DB blip here would otherwise strand the
    // job at 'processing' forever and the client would poll until it times out.
    const marked = await updateWorkflowJob(job, {
      status: 'completed',
      stage: 'completed',
      progress: 100,
      result,
      error: null,
    }, { retries: 4 });
    if (!marked) {
      // FIX 1: the note is already persisted (runSummarizeAudio inserted it), but
      // the terminal 'completed' write failed after all retries, leaving the job
      // at 'processing'. Do not re-run anything: the periodic orphan sweep
      // reconciles this job to 'completed' from the existing note once it goes
      // stale. Surface it so the divergence is observable.
      console.warn(`Workflow job ${jobId} completed but its terminal status write failed; the note is persisted and the orphan sweep will reconcile it.`);
    }
    completedJobResults.set(jobId, result);
    // Post-completion enrichment (memory fold + speaker-ID). Runs after the job is
    // marked completed so the client sees the summary immediately; awaited here so the
    // work still finishes in-process (heartbeat keeps the row fresh). Never throws.
    await finalizeNoteMemory(input, result.transcript);
  } catch (error) {
    // S10: another execution owns this job now. Write nothing (no failure, no
    // enrichment, no incident); the owner decides the outcome.
    if (error instanceof JobLeaseLostError) {
      console.warn(`${error.message} This execution stops without writing.`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // A no-speech recording is a normal user outcome, not a system failure: mark
    // the job failed so the user sees the guidance message, but do not log it as
    // an error or raise an ops incident (that would be pure noise).
    if (error instanceof NoSpeechDetectedError) {
      console.log(`Workflow job ${jobId} ended with no detectable speech in the audio; surfacing to the user without an incident.`);
    } else if (error instanceof AudioUnavailableError) {
      // An expired signed link on a resume is an expected outcome (the user restarts the
      // summary, which signs a new link). Re-signing web links is a separate task (#23).
      console.warn(`Workflow job ${jobId} could not be resumed because its audio link no longer answers (${error.detail}); surfacing to the user without an incident.`);
    } else {
      console.error(`Workflow job ${jobId} failed:`, error);
      void raiseIncident({
        title: 'Summarize audio job failed',
        error,
        context: {
          jobId,
          noteId: input.noteId,
          userId: input.userId,
          fileName: input.fileName,
          promptId: input.promptId,
          meetingAt: input.meetingAt,
        },
      });
    }
    await writeFailed(job, jobId, message);
  } finally {
    clearInterval(timer);
  }
}
