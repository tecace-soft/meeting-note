// S10 job ownership (DEC-0022): conditional claim, lease renewal, fenced writes, the fenced
// request load and execution begin, and the AssemblyAI submission-begin marker, all
// through the RPCs in supabase/migrations/20261026120000_workflow_job_s10_lease_and_resume.sql.
// Expiry and the attempt/claim caps are judged inside those RPCs by database time and
// row state, never by this process. Imports db only; store, runner and sweep build on it.
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { supabase } from '../db/supabaseClient.js';

// A lease outlives several missed heartbeats (JOB_HEARTBEAT_INTERVAL_MS = 60 s) so a DB
// blip never hands a live job to another instance. Equal to the pre-S10 orphan threshold.
export const JOB_LEASE_SECONDS = 5 * 60;
// A pre-S10 row has no lease; it is recoverable only once its updated_at heartbeat is
// this stale, exactly like the pre-S10 orphan sweep.
export const LEGACY_STALE_SECONDS = 5 * 60;
// Executions that actually started, counting the first run. A job that crashes the
// process every time (a poison job) is failed by the next recover claim, in SQL.
export const MAX_JOB_EXECUTION_ATTEMPTS = 3;
// Claims of any kind, including recoveries that deferred without running (note lookup
// error, lost response, failed write). Bounds every deferred loop, also in SQL.
export const MAX_JOB_CLAIMS = 10;
// Every lease RPC is bounded; a hung database call must not hold a job or a sweep.
export const JOB_LEASE_RPC_TIMEOUT_MS = 10_000;
// The stored request can carry tens of MB of base64 attachments, so its read gets more
// time on a slow instance. It is read only, so a timeout costs nothing but a retry.
export const JOB_REQUEST_LOAD_TIMEOUT_MS = 120_000;

// Written by the claim RPC, in the request's language, when a recover claim finds the
// caps used up. The recording itself is untouched.
export const JOB_EXHAUSTED_ERROR = {
  en: 'The server was interrupted repeatedly while processing this recording, so processing stopped. Your recording is still saved; please start the summary again.',
  ko: '이 녹음을 처리하는 동안 서버가 여러 번 중단되어 처리를 멈췄어요. 녹음은 그대로 남아 있으니 요약을 다시 시작해 주세요.',
} as const;

// Identifies this process as a lease owner. Readable in logs, unique per boot.
export const JOB_INSTANCE_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export type TranscriptSubmissionState = 'none' | 'submitting' | 'submitted';
export type ClaimMode = 'start' | 'recover';

export interface JobClaim {
  jobId: string;
  userId: string;
  noteId: string | null;
  status: string;
  stage: string | null;
  generation: number;
  attempt: number;
  claimCount: number;
  transcriptId: string | null;
  submissionState: TranscriptSubmissionState;
  submissionCount: number;
}

// One owned execution of a job row. Mutable fields track what this execution has
// durably recorded; `lost` is set once any fenced call proves another owner took over.
export interface JobExecution {
  readonly jobId: string;
  readonly owner: string;
  readonly generation: number;
  attempt: number;
  readonly resumed: boolean;
  // Why an earlier execution may have submitted this audio to AssemblyAI without a
  // durable record of it, or null when it cannot have:
  // - 'pre-s10-run-outcome-unknown': a pre-S10 instance ran the row (no state to write);
  // - 'submit-marker-missing': an S10 run got past input loading but its submission
  //   marker never landed (marking failed twice and it submitted anyway, or it died
  //   between the stage write and the marker; the second case over-reports, cost 0).
  readonly unknownPriorSubmission: 'pre-s10-run-outcome-unknown' | 'submit-marker-missing' | null;
  transcriptId: string | null;
  submissionState: TranscriptSubmissionState;
  lost: boolean;
}

export class JobLeaseLostError extends Error {
  constructor(jobId: string, generation: number, during: string) {
    super(`Workflow job ${jobId} lost its lease (generation ${generation}) during ${during}.`);
    this.name = 'JobLeaseLostError';
  }
}

export type JobWritePatch = {
  status?: 'processing' | 'completed' | 'failed';
  stage?: string;
  progress?: number;
  result?: unknown;
  error?: string | null;
  assembly_transcript_id?: string | null;
  transcript_submission_state?: TranscriptSubmissionState;
};

type RpcError = { code?: string; message: string };
export type JobLeaseRpc = (name: string, args: Record<string, unknown>, timeoutMs: number) => PromiseLike<{ data: unknown; error: RpcError | null }>;

export type ClaimOutcome =
  | { kind: 'claimed'; claim: JobClaim }
  | { kind: 'exhausted'; claim: JobClaim }
  | { kind: 'not-claimable' }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string };
export type FencedOutcome = 'ok' | 'lost' | 'unsupported' | 'error';

// PostgREST answers PGRST202 for an RPC missing from its schema cache; Postgres answers
// 42883 (undefined function) or 42703 (undefined column) before the migration exists.
export function isMissingS10Schema(error: RpcError | null | undefined): boolean {
  return Boolean(error && ['PGRST202', '42883', '42703', 'PGRST204'].includes(String(error.code ?? '')));
}

const PRE_S10_STAGES = new Set(['queued', 'loading inputs']);

export function executionFromClaim(claim: JobClaim, options: { resumed: boolean; owner?: string }): JobExecution {
  return {
    jobId: claim.jobId,
    owner: options.owner ?? JOB_INSTANCE_ID,
    generation: claim.generation,
    attempt: claim.attempt,
    resumed: options.resumed,
    // A resumed row past input loading with no submission state may have been submitted.
    // Generation 1 on a recover claim means no S10 instance ever claimed the row.
    unknownPriorSubmission: !options.resumed || claim.submissionState !== 'none' || PRE_S10_STAGES.has(claim.stage ?? 'queued')
      ? null
      : claim.generation === 1 ? 'pre-s10-run-outcome-unknown' : 'submit-marker-missing',
    transcriptId: claim.transcriptId,
    submissionState: claim.submissionState,
    lost: false,
  };
}

function parseClaimRow(row: unknown): { claim: JobClaim; exhausted: boolean } | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.user_id !== 'string') return null;
  if (typeof r.execution_generation !== 'number' || typeof r.attempt_count !== 'number') return null;
  if (r.claim_outcome !== 'claimed' && r.claim_outcome !== 'exhausted') return null;
  const state = r.transcript_submission_state;
  return {
    exhausted: r.claim_outcome === 'exhausted',
    claim: {
      jobId: r.id,
      userId: r.user_id,
      noteId: typeof r.note_id === 'string' ? r.note_id : null,
      status: typeof r.status === 'string' ? r.status : '',
      stage: typeof r.stage === 'string' ? r.stage : null,
      generation: r.execution_generation,
      attempt: r.attempt_count,
      claimCount: typeof r.claim_count === 'number' ? r.claim_count : 0,
      transcriptId: typeof r.assembly_transcript_id === 'string' && r.assembly_transcript_id.trim() ? r.assembly_transcript_id : null,
      submissionState: state === 'submitting' || state === 'submitted' ? state : 'none',
      submissionCount: typeof r.transcript_submission_count === 'number' ? r.transcript_submission_count : 0,
    },
  };
}

export function createJobLeaseStore(rpc: JobLeaseRpc, owner: string = JOB_INSTANCE_ID) {
  async function call(name: string, args: Record<string, unknown>, timeoutMs = JOB_LEASE_RPC_TIMEOUT_MS): Promise<{ data: unknown; error: RpcError | null }> {
    try {
      return await rpc(name, args, timeoutMs);
    } catch (error) {
      // A timeout or network failure is an unknown outcome, never proof of ownership.
      return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
    }
  }
  // A fenced RPC that ran without error but matched no row proves the lease is gone.
  function fenced(error: RpcError | null, ok: boolean): FencedOutcome {
    if (error) return isMissingS10Schema(error) ? 'unsupported' : 'error';
    return ok ? 'ok' : 'lost';
  }
  const fence = (execution: JobExecution) => ({ p_job_id: execution.jobId, p_owner: execution.owner, p_generation: execution.generation });
  return {
    owner,
    async claim(jobId: string, mode: ClaimMode): Promise<ClaimOutcome> {
      const { data, error } = await call('workflow_job_claim', {
        p_job_id: jobId,
        p_owner: owner,
        p_mode: mode,
        p_lease_seconds: JOB_LEASE_SECONDS,
        p_legacy_stale_seconds: LEGACY_STALE_SECONDS,
        p_max_attempts: MAX_JOB_EXECUTION_ATTEMPTS,
        p_max_claims: MAX_JOB_CLAIMS,
        p_exhausted_error_en: JOB_EXHAUSTED_ERROR.en,
        p_exhausted_error_ko: JOB_EXHAUSTED_ERROR.ko,
      });
      if (error) return isMissingS10Schema(error) ? { kind: 'unsupported', message: error.message } : { kind: 'error', message: error.message };
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (rows.length === 0) return { kind: 'not-claimable' };
      const parsed = parseClaimRow(rows[0]);
      if (!parsed) return { kind: 'error', message: 'workflow_job_claim returned an unexpected row shape.' };
      return parsed.exhausted ? { kind: 'exhausted', claim: parsed.claim } : { kind: 'claimed', claim: parsed.claim };
    },
    async release(execution: JobExecution): Promise<FencedOutcome> {
      const { data, error } = await call('workflow_job_release', fence(execution));
      return fenced(error, data === true);
    },
    async persistNote(execution: JobExecution, note: Record<string, unknown>, mode: 'insert' | 'diarization'): Promise<FencedOutcome> {
      const { data, error } = await call('workflow_job_persist_note', { ...fence(execution), p_note: note, p_mode: mode });
      return fenced(error, data === true);
    },
    async writeEnrichment(execution: JobExecution, kind: 'memory' | 'insight', payload: Record<string, unknown>): Promise<FencedOutcome> {
      const { data, error } = await call('workflow_job_write_enrichment', { ...fence(execution), p_kind: kind, p_payload: payload });
      return fenced(error, data === true);
    },
    async finishPostprocessing(execution: JobExecution): Promise<FencedOutcome> {
      const { data, error } = await call('workflow_job_postprocessing_done', fence(execution));
      return fenced(error, data === true);
    },
    async renew(execution: JobExecution): Promise<FencedOutcome> {
      const { data, error } = await call('workflow_job_renew_lease', { ...fence(execution), p_lease_seconds: JOB_LEASE_SECONDS });
      return fenced(error, data === true);
    },
    async write(execution: JobExecution, patch: JobWritePatch): Promise<FencedOutcome> {
      const { data, error } = await call('workflow_job_write', { ...fence(execution), p_patch: patch });
      return fenced(error, data === true);
    },
    // The stored request, read only after a resume's cheap checks passed.
    async loadRequest(execution: JobExecution): Promise<{ outcome: FencedOutcome; request: unknown }> {
      const { data, error } = await call('workflow_job_load_request', fence(execution), JOB_REQUEST_LOAD_TIMEOUT_MS);
      return { outcome: fenced(error, data !== null && data !== undefined), request: data ?? null };
    },
    // Counts a resumed execution as started; returns the new attempt count.
    async beginExecution(execution: JobExecution): Promise<{ outcome: FencedOutcome; attempt: number | null }> {
      const { data, error } = await call('workflow_job_begin_execution', { ...fence(execution), p_max_attempts: MAX_JOB_EXECUTION_ATTEMPTS });
      const attempt = typeof data === 'number' ? data : null;
      return { outcome: fenced(error, attempt !== null), attempt };
    },
    // Returns the new submission count, or the fenced outcome when it could not be marked.
    async beginTranscriptSubmission(execution: JobExecution): Promise<{ outcome: FencedOutcome; count: number | null }> {
      const { data, error } = await call('workflow_job_begin_transcript_submission', fence(execution));
      const count = typeof data === 'number' ? data : null;
      return { outcome: fenced(error, count !== null), count };
    },
  };
}

export type JobLeaseStore = ReturnType<typeof createJobLeaseStore>;

export const jobLeases: JobLeaseStore = createJobLeaseStore(
  (name, args, timeoutMs) => supabase.rpc(name, args).abortSignal(AbortSignal.timeout(timeoutMs)),
);
