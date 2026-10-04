import { canonicalJson, validateMeetingKnowledgeEvent, type MeetingKnowledgeEvent } from './contract.js';
import { isCanonicalMicrosoftId } from './access-contract.js';
import { DELIVERY_ERROR_CODES } from './management-status.js';
import type { MeetingKnowledgeRpcClient } from './store.js';

export interface MeetingOutboxClaim {
  eventId: string;
  eventSeq: number;
  sourceId: string;
  tenantId: string;
  integrationGeneration: number;
  eventType: 'source.upsert' | 'access.changed' | 'source.deleted' | 'integration.disabled';
  snapshot: Record<string, unknown>;
  leaseToken: string;
  attempts: number;
}
export type MeetingDeliveryErrorCode = typeof DELIVERY_ERROR_CODES[number];
export interface MeetingOutboxStore {
  claim(tenantId: string, workerId: string): Promise<MeetingOutboxClaim[]>;
  prepare(claim: MeetingOutboxClaim, workerId: string, event: MeetingKnowledgeEvent): Promise<MeetingKnowledgeEvent | null>;
  ack(claim: MeetingOutboxClaim, workerId: string, payloadHash: string): Promise<boolean>;
  fail(claim: MeetingOutboxClaim, workerId: string, code: MeetingDeliveryErrorCode): Promise<boolean>;
}
export class MeetingOutboxError extends Error { constructor() { super('OUTBOX_UNAVAILABLE'); } }
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
function validClaim(value: unknown, tenantId: string): value is MeetingOutboxClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as MeetingOutboxClaim;
  return Object.keys(claim).length === 9
    && isCanonicalMicrosoftId(claim.eventId) && isCanonicalMicrosoftId(claim.leaseToken)
    && claim.tenantId === tenantId && positive(claim.eventSeq) && positive(claim.integrationGeneration)
    && positive(claim.attempts) && typeof claim.sourceId === 'string' && claim.sourceId.length > 0 && claim.sourceId.length <= 256
    && ['source.upsert', 'access.changed', 'source.deleted', 'integration.disabled'].includes(claim.eventType)
    && !!claim.snapshot && typeof claim.snapshot === 'object' && !Array.isArray(claim.snapshot);
}
/** Schema/hash validation plus immutable event/tenant/source/sequence binding. */
export function validateMeetingOutboxSeal(claim: MeetingOutboxClaim, event: unknown): MeetingKnowledgeEvent {
  const result = validateMeetingKnowledgeEvent(event);
  if (!result.valid || !['eventId', 'eventSeq', 'sourceId', 'tenantId', 'integrationGeneration', 'eventType']
    .every(key => result.event[key as keyof MeetingKnowledgeEvent] === claim[key as keyof MeetingOutboxClaim])) throw new MeetingOutboxError();
  const record = claim.snapshot.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new MeetingOutboxError();
  const snapshot = record as Record<string, unknown>;
  if (result.event.eventType === 'source.upsert') {
    const source = result.event.payload;
    if (source.contentRevision !== snapshot.contentRevision || source.speakerRevision !== snapshot.speakerRevision
      || source.sourceHash !== snapshot.sourceHash || source.plaintext !== claim.snapshot.plaintext) throw new MeetingOutboxError();
  } else if (result.event.eventType === 'access.changed') {
    if (result.event.payload.accessRevision !== snapshot.accessRevision) throw new MeetingOutboxError();
  } else if (result.event.eventType === 'source.deleted' || result.event.eventType === 'integration.disabled') {
    if (result.event.payload.lifecycleRevision !== snapshot.accessRevision) throw new MeetingOutboxError();
  }
  return result.event;
}
export function createMeetingOutboxStore(client: MeetingKnowledgeRpcClient): MeetingOutboxStore {
  async function call(name: string, args: Record<string, unknown>) {
    try {
      const result = await client.rpc(name, args);
      if (!result || result.error) throw new MeetingOutboxError();
      return JSON.parse(canonicalJson(result.data)) as unknown;
    } catch { throw new MeetingOutboxError(); }
  }
  function leaseArgs(claim: MeetingOutboxClaim, workerId: string) {
    if (!validClaim(claim, claim.tenantId) || !isCanonicalMicrosoftId(claim.tenantId) || !isCanonicalMicrosoftId(workerId)) throw new MeetingOutboxError();
    return { p_event_id: claim.eventId, p_worker_id: workerId, p_lease_token: claim.leaseToken };
  }
  return {
    async claim(tenantId, workerId) {
      if (!isCanonicalMicrosoftId(tenantId) || !isCanonicalMicrosoftId(workerId)) throw new MeetingOutboxError();
      const data = await call('meeting_knowledge_outbox_claim', { p_tenant_id: tenantId, p_worker_id: workerId, p_limit: 2, p_lease_seconds: 60 });
      if (!Array.isArray(data) || data.length > 2 || !data.every(claim => validClaim(claim, tenantId))
        || new Set(data.map(claim => claim.eventId)).size !== data.length) throw new MeetingOutboxError();
      return data;
    },
    async ack(claim, workerId, payloadHash) {
      if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new MeetingOutboxError();
      const result = await call('meeting_knowledge_outbox_ack', { ...leaseArgs(claim, workerId), p_payload_hash: payloadHash });
      if (typeof result !== 'boolean') throw new MeetingOutboxError();
      return result;
    },
    async prepare(claim, workerId, event) {
      const args = leaseArgs(claim, workerId);
      const candidate = validateMeetingOutboxSeal(claim, event);
      const result = await call('meeting_knowledge_outbox_prepare', { ...args, p_event: candidate });
      // SQL retains the first sealed payload on every retry; metadata config may
      // change, so validate against the claim, never against the new candidate hash.
      return result === null ? null : validateMeetingOutboxSeal(claim, result);
    },
    async fail(claim, workerId, code) {
      if (!DELIVERY_ERROR_CODES.includes(code)) throw new MeetingOutboxError();
      const result = await call('meeting_knowledge_outbox_fail', { ...leaseArgs(claim, workerId), p_error_code: code });
      if (typeof result !== 'boolean') throw new MeetingOutboxError();
      return result;
    },
  };
}
