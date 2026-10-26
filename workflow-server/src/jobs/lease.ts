// S10 job ownership (DEC-0022): conditional claim, lease renewal, fenced writes and the
// AssemblyAI submission-begin marker, all through the RPCs in
// supabase/migrations/20261026120000_workflow_job_s10_lease_and_resume.sql. Expiry is
// judged by database time inside those RPCs, never by this process's clock.
// Imports db only; the store, runner and orphan sweep build on it.
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { supabase } from '../db/supabaseClient.js';

// A lease outlives several missed heartbeats (JOB_HEARTBEAT_INTERVAL_MS = 60 s) so a DB
// blip never hands a live job to another instance. Equal to the pre-S10 orphan threshold.
export const JOB_LEASE_SECONDS = 5 * 60;
// A pre-S10 row has no lease; it is recoverable only once its updated_at heartbeat is
// this stale, exactly like the pre-S10 orphan sweep.
export const LEGACY_STALE_SECONDS = 5 * 60;
// Executions per job, counting the first run. A job that crashes the process every time
// (a poison job) is failed on the claim after this many, so it cannot loop forever.
export const MAX_JOB_EXECUTION_ATTEMPTS = 3;
// Every lease RPC is bounded; a hung database call must not hold a job or a sweep.
export const JOB_LEASE_RPC_TIMEOUT_MS = 10_000;

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
  request: unknown;
  generation: number;
  attempt: number;
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
  readonly attempt: number;
  readonly resumed: boolean;
  // True when a pre-S10 instance ran this row and may already have submitted it to
  // AssemblyAI without recording that (it had no submission state to write).
  readonly legacyUnknownSubmission: boolean;
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
export type JobLeaseRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError | null }>;

export type ClaimOutcome =
  | { kind: 'claimed'; claim: JobClaim }
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
    // Generation 1 on a recover claim means no S10 instance ever claimed the row. If it
    // had progressed past input loading, the pre-S10 run may have paid AssemblyAI.
    legacyUnknownSubmission: options.resumed && claim.generation === 1
      && claim.submissionState === 'none' && !PRE_S10_STAGES.has(claim.stage ?? 'queued'),
    transcriptId: claim.transcriptId,
    submissionState: claim.submissionState,
    lost: false,
  };
}

function parseClaimRow(row: unknown): JobClaim | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.user_id !== 'string') return null;
  if (typeof r.execution_generation !== 'number' || typeof r.attempt_count !== 'number') return null;
  const state = r.transcript_submission_state;
  return {
    jobId: r.id,
    userId: r.user_id,
    noteId: typeof r.note_id === 'string' ? r.note_id : null,
    status: typeof r.status === 'string' ? r.status : '',
    stage: typeof r.stage === 'string' ? r.stage : null,
    request: r.request ?? null,
    generation: r.execution_generation,
    attempt: r.attempt_count,
    transcriptId: typeof r.assembly_transcript_id === 'string' && r.assembly_transcript_id.trim() ? r.assembly_transcript_id : null,
    submissionState: state === 'submitting' || state === 'submitted' ? state : 'none',
    submissionCount: typeof r.transcript_submission_count === 'number' ? r.transcript_submission_count : 0,
  };
}

export function createJobLeaseStore(rpc: JobLeaseRpc, owner: string = JOB_INSTANCE_ID) {
  async function call(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: RpcError | null }> {
    try {
      return await rpc(name, args);
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
  return {
    owner,
    async claim(jobId: string, mode: ClaimMode): Promise<ClaimOutcome> {
      const { data, error } = await call('workflow_job_claim', {
        p_job_id: jobId,
        p_owner: owner,
        p_mode: mode,
        p_lease_seconds: JOB_LEASE_SECONDS,
        p_legacy_stale_seconds: LEGACY_STALE_SECONDS,
      });
      if (error) return isMissingS10Schema(error) ? { kind: 'unsupported', message: error.message } : { kind: 'error', message: error.message };
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (rows.length === 0) return { kind: 'not-claimable' };
      const claim = parseClaimRow(rows[0]);
      if (!claim) return { kind: 'error', message: 'workflow_job_claim returned an unexpected row shape.' };
      return { kind: 'claimed', claim };
    },
    async renew(execution: JobExecution): Promise<FencedOutcome> {
      const { data, error } = await call('workflow_job_renew_lease', {
        p_job_id: execution.jobId,
        p_owner: execution.owner,
        p_generation: execution.generation,
        p_lease_seconds: JOB_LEASE_SECONDS,
      });
      return fenced(error, data === true);
    },
    async write(execution: JobExecution, patch: JobWritePatch): Promise<FencedOutcome> {
      const { data, error } = await call('workflow_job_write', {
        p_job_id: execution.jobId,
        p_owner: execution.owner,
        p_generation: execution.generation,
        p_patch: patch,
      });
      return fenced(error, data === true);
    },
    // Returns the new submission count, or the fenced outcome when it could not be marked.
    async beginTranscriptSubmission(execution: JobExecution): Promise<{ outcome: FencedOutcome; count: number | null }> {
      const { data, error } = await call('workflow_job_begin_transcript_submission', {
        p_job_id: execution.jobId,
        p_owner: execution.owner,
        p_generation: execution.generation,
      });
      const count = typeof data === 'number' ? data : null;
      return { outcome: fenced(error, count !== null), count };
    },
  };
}

export type JobLeaseStore = ReturnType<typeof createJobLeaseStore>;

export const jobLeases: JobLeaseStore = createJobLeaseStore(
  (name, args) => supabase.rpc(name, args).abortSignal(AbortSignal.timeout(JOB_LEASE_RPC_TIMEOUT_MS)),
);
