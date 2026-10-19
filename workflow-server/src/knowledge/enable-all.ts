import type { MeetingManagementAcknowledgement, MeetingOwnerStatus } from './management-status.js';
import type { MeetingSourceAccessRecord } from './source-access.js';

/**
 * Meeting Note management command only (not part of the AXKH-shared contract files).
 * One owner click = initialize (idempotent) then enable (no-op when already on).
 */
type Identity = { tenantId: string; objectId: string };
export interface EnableAllStore {
  initialize(identity: Identity, sourceId: string): Promise<MeetingSourceAccessRecord>;
  mutate(identity: Identity, command: { action: 'enable'; sourceId: string; expectedAccessRevision: number }):
    Promise<MeetingSourceAccessRecord | MeetingManagementAcknowledgement>;
  getOwnedStatus(identity: Identity, sourceId: string): Promise<MeetingOwnerStatus>;
}
export type EnableAllResult = Pick<MeetingManagementAcknowledgement, 'sourceId' | 'accessRevision' | 'integrationGeneration' | 'integrationEnabled'>;

/** At most one re-read after an ACCESS_REVISION conflict; never an open-ended loop. */
export const ENABLE_ALL_MAX_CONFLICT_RETRIES = 1;

/** `initialized` tells the UI the safe state ("settings exist, delivery off") was reached before the failure. */
export class EnableAllFailure extends Error {
  constructor(readonly code: string, readonly initialized: boolean) {
    super(code);
    this.name = 'EnableAllFailure';
  }
}
const codeOf = (error: unknown): string => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  ? error.code : 'STORE_UNAVAILABLE';
const summarize = (record: EnableAllResult): EnableAllResult => ({ sourceId: record.sourceId, accessRevision: record.accessRevision,
  integrationGeneration: record.integrationGeneration, integrationEnabled: record.integrationEnabled });
/** Unsupported transcripts and sources over the delivery limit must not be switched on. */
const blocked = (status: MeetingOwnerStatus): boolean => status.unsupportedTranscript
  || (status.processing !== undefined && status.processing.sizing !== 'ready');

async function enableOnce(store: EnableAllStore, identity: Identity, sourceId: string, revision: number): Promise<EnableAllResult> {
  const result = await store.mutate(identity, { action: 'enable', sourceId, expectedAccessRevision: revision });
  if (result.sourceId !== sourceId || !result.integrationEnabled) throw new EnableAllFailure('STORE_UNAVAILABLE', false);
  return summarize(result);
}
async function enableWithBoundedRetry(store: EnableAllStore, identity: Identity, sourceId: string, first: MeetingSourceAccessRecord): Promise<EnableAllResult> {
  let record = first;
  for (let attempt = 0; attempt <= ENABLE_ALL_MAX_CONFLICT_RETRIES; attempt++) {
    try { return await enableOnce(store, identity, sourceId, record.accessRevision); }
    catch (error) {
      if (codeOf(error) !== 'REVISION_CONFLICT' || attempt === ENABLE_ALL_MAX_CONFLICT_RETRIES) throw error;
      record = await store.initialize(identity, sourceId); // idempotent re-read of the current revision
      if (record.integrationEnabled) return summarize(record);
    }
  }
  throw new EnableAllFailure('REVISION_CONFLICT', false);
}

export async function enableAll(store: EnableAllStore, identity: Identity, sourceId: string): Promise<EnableAllResult> {
  let initialized = false;
  try {
    // Ownership is enforced by the status read (non-owner -> SOURCE_NOT_MANAGEABLE) before any write.
    const before = await store.getOwnedStatus(identity, sourceId);
    // Sizing is visible for unenrolled notes too (supabase/tests/meeting_knowledge_owner_operability.sql),
    // so block oversized sources before initialize creates an integration row.
    if (blocked(before)) throw new EnableAllFailure('SOURCE_BLOCKED', false);
    const record = await store.initialize(identity, sourceId);
    initialized = true;
    if (record.integrationEnabled) return summarize(record);
    // Backstop: the note may have been edited between the pre-check and initialize.
    if (blocked(await store.getOwnedStatus(identity, sourceId))) throw new EnableAllFailure('SOURCE_BLOCKED', false);
    return await enableWithBoundedRetry(store, identity, sourceId, record);
  } catch (error) {
    throw new EnableAllFailure(codeOf(error), initialized);
  }
}
