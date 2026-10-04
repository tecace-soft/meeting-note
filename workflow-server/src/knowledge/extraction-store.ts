import { canonicalJson, hashPayload, validateMeetingKnowledgeEvent, type SourceUpsertEvent } from './contract.js';
import { isCanonicalMicrosoftId } from './access-contract.js';
import type { ExtractionResult } from './extraction.js';
import type { MeetingKnowledgeRpcClient } from './store.js';

export interface MeetingExtractionClaim {
  jobId: string; tenantId: string; sourceId: string; integrationGeneration: number;
  sourceEvent: SourceUpsertEvent; leaseToken: string; attempts: number;
}
export const MEETING_EXTRACTION_FAILURE_CODES = ['POLICY_DENIED', 'POLICY_UNAVAILABLE', 'SOURCE_STALE',
  'CURRENT_UNAVAILABLE', 'CANCELLED', 'EXTRACTION_FAILED', 'INVALID_SNAPSHOT', 'PAYLOAD_TOO_LARGE'] as const;
export type MeetingExtractionFailureCode = typeof MEETING_EXTRACTION_FAILURE_CODES[number];
export interface MeetingExtractionStore {
  claim(tenantId: string, workerId: string): Promise<MeetingExtractionClaim[]>;
  current(claim: MeetingExtractionClaim, workerId: string): Promise<boolean>;
  complete(claim: MeetingExtractionClaim, workerId: string, result: ExtractionResult): Promise<boolean>;
  fail(claim: MeetingExtractionClaim, workerId: string, code: MeetingExtractionFailureCode): Promise<boolean>;
}
export class MeetingExtractionStoreError extends Error {
  constructor(readonly code: 'STORE_UNAVAILABLE' | 'PAYLOAD_TOO_LARGE' = 'STORE_UNAVAILABLE') {
    super(code === 'PAYLOAD_TOO_LARGE' ? 'EXTRACTION_PAYLOAD_TOO_LARGE' : 'EXTRACTION_STORE_UNAVAILABLE');
  }
}
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
export function isMeetingExtractionClaim(value: unknown, tenantId: string): value is MeetingExtractionClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as MeetingExtractionClaim;
  const source = validateMeetingKnowledgeEvent(claim.sourceEvent);
  return Object.keys(claim).length === 7 && isCanonicalMicrosoftId(claim.jobId)
    && isCanonicalMicrosoftId(claim.leaseToken) && claim.tenantId === tenantId && isCanonicalMicrosoftId(tenantId)
    && positive(claim.attempts) && positive(claim.integrationGeneration)
    && source.valid && source.event.eventType === 'source.upsert' && source.event.tenantId === tenantId
    && source.event.sourceId === claim.sourceId && source.event.integrationGeneration === claim.integrationGeneration;
}
export function validateMeetingExtractionResult(claim: MeetingExtractionClaim, raw: ExtractionResult): ExtractionResult {
  try {
    const result = JSON.parse(canonicalJson(raw)) as ExtractionResult;
    const source = claim.sourceEvent;
    const valid = validateMeetingKnowledgeEvent({ ...source, eventId: claim.jobId, eventType: 'units.upsert',
      payload: result.payload, payloadHash: hashPayload(result.payload) }, source);
    const run = result.run;
    if (!valid.valid || Object.keys(result).sort().join(',') !== 'coverage,payload,run' || !run
      || Object.keys(run).sort().join(',') !== 'calls,inputHash,model,promptVersion,runId,usage'
      || run.runId !== claim.jobId || result.payload.extractorRun.runId !== claim.jobId
      || run.model !== result.payload.extractorRun.model || run.promptVersion !== result.payload.extractorRun.promptVersion
      || run.inputHash !== hashPayload(source) || !Number.isSafeInteger(run.calls) || run.calls < 0 || run.calls > 64
      || !run.usage || Object.keys(run.usage).sort().join(',') !== 'inputTokens,outputTokens,totalTokens'
      || Object.values(run.usage).some(count => count !== null && (!Number.isSafeInteger(count) || count < 0))
      || !Array.isArray(result.coverage) || result.coverage.length < 1 || result.coverage.length > 65
      || result.payload.units.length > 500 || result.payload.units.some(unit => unit.lifecycle !== 'candidate'
        || !['reported', 'hypothesis', 'uncertain'].includes(unit.epistemic ?? ''))) throw new Error();
    let offset = 0; let accepted = 0;
    const spans = new Set(source.payload.spans.map(span => span.spanId));
    for (const [index, state] of result.coverage.entries()) {
      if (Object.keys(state).some(key => !['index', 'start', 'end', 'sourceSpanIds', 'processable', 'status',
        'rawFallback', 'acceptedCandidates', 'rejectedCandidates', 'errorCode'].includes(key))
        || state.index !== index || state.start !== offset || !positive(state.end) || state.end <= state.start
        || state.end > source.payload.plaintext.length || typeof state.processable !== 'boolean'
        || !['success', 'failed', 'skipped'].includes(state.status) || typeof state.rawFallback !== 'boolean'
        || (state.errorCode !== undefined && !['TIMEOUT', 'MODEL_FAILED', 'INVALID_OUTPUT', 'TRUNCATED_OUTPUT',
          'INVALID_METADATA', 'LIMIT_REACHED', 'INVALID_CANDIDATE'].includes(state.errorCode))
        || !Number.isSafeInteger(state.acceptedCandidates) || state.acceptedCandidates < 0 || state.acceptedCandidates > 32
        || !Number.isSafeInteger(state.rejectedCandidates) || state.rejectedCandidates < 0 || state.rejectedCandidates > 32
        || !Array.isArray(state.sourceSpanIds) || state.sourceSpanIds.length < 1
        || state.sourceSpanIds.some(id => !spans.has(id)) || new Set(state.sourceSpanIds).size !== state.sourceSpanIds.length) throw new Error();
      offset = state.end; accepted += state.acceptedCandidates;
    }
    if (offset !== source.payload.plaintext.length || accepted !== result.payload.units.length) throw new Error();
    return result;
  } catch { throw new MeetingExtractionStoreError(); }
}
export function createMeetingExtractionStore(client: MeetingKnowledgeRpcClient): MeetingExtractionStore {
  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([Promise.resolve().then(() => client.rpc(name, args)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MeetingExtractionStoreError()), 5_000);
      })]);
      if (!result || result.error) {
        const error = result?.error as { code?: unknown; message?: unknown } | undefined;
        if (error?.code === 'P0001' && error.message === 'EXTRACTION_PAYLOAD_TOO_LARGE') throw new MeetingExtractionStoreError('PAYLOAD_TOO_LARGE');
        throw new Error();
      }
      return JSON.parse(canonicalJson(result.data));
    } catch (error) { if (error instanceof MeetingExtractionStoreError) throw error; throw new MeetingExtractionStoreError(); }
    finally { if (timer) clearTimeout(timer); }
  }
  function lease(claim: MeetingExtractionClaim, workerId: string) {
    if (!isMeetingExtractionClaim(claim, claim.tenantId) || !isCanonicalMicrosoftId(workerId)) throw new MeetingExtractionStoreError();
    return { p_job_id: claim.jobId, p_worker_id: workerId, p_lease_token: claim.leaseToken };
  }
  async function bool(name: string, args: Record<string, unknown>) {
    const value = await call(name, args); if (typeof value !== 'boolean') throw new MeetingExtractionStoreError(); return value;
  }
  return {
    async claim(tenantId, workerId) {
      if (!isCanonicalMicrosoftId(tenantId) || !isCanonicalMicrosoftId(workerId)) throw new MeetingExtractionStoreError();
      const data = await call('meeting_knowledge_extraction_claim', { p_tenant_id: tenantId, p_worker_id: workerId });
      if (!Array.isArray(data) || data.length > 1 || !data.every(item => isMeetingExtractionClaim(item, tenantId))) throw new MeetingExtractionStoreError();
      return data;
    },
    async current(claim, workerId) { return bool('meeting_knowledge_extraction_current', lease(claim, workerId)); },
    async complete(claim, workerId, raw) {
      const args = lease(claim, workerId); const result = validateMeetingExtractionResult(claim, raw);
      return bool('meeting_knowledge_extraction_complete', { ...args, p_payload: result.payload, p_coverage: result.coverage, p_run: result.run });
    },
    async fail(claim, workerId, code) {
      if (!MEETING_EXTRACTION_FAILURE_CODES.includes(code)) throw new MeetingExtractionStoreError();
      return bool('meeting_knowledge_extraction_fail', { ...lease(claim, workerId), p_error_code: code });
    },
  };
}
