// Summarize job runner: runs one in-process job through the pipeline, keeps its row's
// updated_at fresh with a heartbeat, writes the terminal status and runs the
// post-completion enrichment. Owns the in-memory completed-result cache read by the job
// status route. Imports pipeline, jobs/store and ops modules only (never index.ts or routes).
import { raiseIncident } from '../ops/incidents.js';
import type { SummarizeAudioInput, SummarizeAudioResult } from '../pipeline/types.js';
import { NoSpeechDetectedError } from '../pipeline/errors.js';
import { runSummarizeAudio } from '../pipeline/summarize.js';
import { finalizeNoteMemory } from '../pipeline/finalize.js';
import { updateWorkflowJob, JOB_HEARTBEAT_INTERVAL_MS } from './store.js';

export async function processSummarizeJob(jobId: string, input: SummarizeAudioInput): Promise<void> {
  // Keep updated_at fresh across long silent stages (e.g. the multi-minute
  // AssemblyAI poll) so a concurrent boot sweep never mistakes this live job
  // for an orphan.
  const heartbeat = setInterval(() => {
    void updateWorkflowJob(jobId, {});
  }, JOB_HEARTBEAT_INTERVAL_MS);
  try {
    const result = await runSummarizeAudio(input, jobId);
    // Terminal writes retry: a transient DB blip here would otherwise strand the
    // job at 'processing' forever and the client would poll until it times out.
    const marked = await updateWorkflowJob(jobId, {
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
    const message = error instanceof Error ? error.message : String(error);
    // A no-speech recording is a normal user outcome, not a system failure: mark
    // the job failed so the user sees the guidance message, but do not log it as
    // an error or raise an ops incident (that would be pure noise).
    if (error instanceof NoSpeechDetectedError) {
      console.log(`Workflow job ${jobId} ended with no detectable speech in the audio; surfacing to the user without an incident.`);
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
    await updateWorkflowJob(jobId, {
      status: 'failed',
      stage: 'failed',
      progress: 100,
      error: message,
    }, { retries: 4 });
  } finally {
    clearInterval(heartbeat);
  }
}

export const completedJobResults = new Map<string, SummarizeAudioResult>();
