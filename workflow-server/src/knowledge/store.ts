import type { MicrosoftIdentity } from './contract.js';
import { isCanonicalMicrosoftId, isMeetingSourceBinding } from './access-contract.js';
import type { MeetingSourceAccessRecord } from './source-access.js';
import { isManagementAcknowledgement, isMeetingOwnerStatus, type MeetingManagementAcknowledgement, type MeetingOwnerStatus } from './management-status.js';

/** Server-owned service-role client only. Never reuse a browser/user-token client. */
export interface MeetingKnowledgeRpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
export type MeetingKnowledgeMutationAction = 'confirm_participant' | 'revoke' | 'restore' | 'enable' | 'disable';
export interface MeetingKnowledgeMutation {
  sourceId: string;
  expectedAccessRevision: number;
  action: MeetingKnowledgeMutationAction;
  subjectObjectId?: string;
  verificationRef?: string;
}
export class MeetingKnowledgeStoreError extends Error {
  constructor(readonly code: 'SOURCE_NOT_MANAGEABLE' | 'REVISION_CONFLICT' | 'INVALID_MUTATION' | 'STORE_UNAVAILABLE') {
    super(code);
    this.name = 'MeetingKnowledgeStoreError';
  }
}
const validSourceId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const validIdentity = (value: unknown): value is MicrosoftIdentity => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as MicrosoftIdentity;
  return isCanonicalMicrosoftId(identity.tenantId) && isCanonicalMicrosoftId(identity.objectId);
};
function validRecord(value: unknown): value is MeetingSourceAccessRecord {
  if (!isMeetingSourceBinding(value)) return false;
  const record = value as MeetingSourceAccessRecord;
  const scoped = (identity: unknown): identity is MicrosoftIdentity => validIdentity(identity) && identity.tenantId === record.tenantId;
  return scoped(record.owner) && record.ownerIdentityVerified === true
    && typeof record.active === 'boolean' && typeof record.integrationEnabled === 'boolean'
    && Array.isArray(record.directShares) && record.directShares.every(scoped)
    && Array.isArray(record.denies) && record.denies.every(scoped)
    && Array.isArray(record.noteProjectIds) && record.noteProjectIds.every(validSourceId)
    && Array.isArray(record.confirmedParticipants) && record.confirmedParticipants.every(participant => participant
      && scoped(participant.identity) && scoped(participant.confirmedBy)
      && participant.confirmedBy.objectId === record.owner.objectId
      && typeof participant.verificationRef === 'string' && participant.verificationRef.length > 0 && participant.verificationRef.length <= 512)
    && Array.isArray(record.projects) && record.projects.every(project => project && validSourceId(project.projectId)
      && scoped(project.owner) && project.owner.objectId === record.owner.objectId
      && Array.isArray(project.sharedWith) && project.sharedWith.every(scoped));
}
function sqlError(error: unknown): MeetingKnowledgeStoreError {
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === 'P0001') {
      if (message === 'SOURCE_UNAVAILABLE') return new MeetingKnowledgeStoreError('SOURCE_NOT_MANAGEABLE');
      if (message === 'ACCESS_REVISION_CONFLICT') return new MeetingKnowledgeStoreError('REVISION_CONFLICT');
      if (message === 'INVALID_LEDGER_COMMAND') return new MeetingKnowledgeStoreError('INVALID_MUTATION');
    }
  }
  return new MeetingKnowledgeStoreError('STORE_UNAVAILABLE');
}

export function createMeetingKnowledgeStore(client: MeetingKnowledgeRpcClient) {
  async function call(name: string, args: Record<string, unknown>, tenantId: string, sourceId: string, allowMissing: boolean) {
    let result: { data: unknown; error: unknown };
    try { result = await client.rpc(name, args); } catch { throw new MeetingKnowledgeStoreError('STORE_UNAVAILABLE'); }
    if (!result || result.error) throw sqlError(result?.error);
    if (result.data === null && allowMissing) return null;
    if (!validRecord(result.data) || result.data.tenantId !== tenantId || result.data.sourceId !== sourceId) {
      throw new MeetingKnowledgeStoreError('STORE_UNAVAILABLE');
    }
    return result.data;
  }
  function manageArgs(identity: MicrosoftIdentity, sourceId: string) {
    if (!validIdentity(identity) || !validSourceId(sourceId)) throw new MeetingKnowledgeStoreError('INVALID_MUTATION');
    return { p_tenant_id: identity.tenantId, p_source_id: sourceId, p_owner_object_id: identity.objectId };
  }
  return {
    async initialize(identity: MicrosoftIdentity, sourceId: string): Promise<MeetingSourceAccessRecord> {
      const record = await call('meeting_knowledge_initialize', manageArgs(identity, sourceId), identity.tenantId, sourceId, false);
      if (!record || record.owner.objectId !== identity.objectId) throw new MeetingKnowledgeStoreError('STORE_UNAVAILABLE');
      return record;
    },
    async getOwnedStatus(identity: MicrosoftIdentity, sourceId: string): Promise<MeetingOwnerStatus> {
      const args = manageArgs(identity, sourceId);
      let result: { data: unknown; error: unknown };
      try { result = await client.rpc('meeting_knowledge_owner_status', args); }
      catch { throw new MeetingKnowledgeStoreError('STORE_UNAVAILABLE'); }
      if (!result || result.error) throw sqlError(result?.error);
      if (result.data === null) throw new MeetingKnowledgeStoreError('SOURCE_NOT_MANAGEABLE');
      if (!isMeetingOwnerStatus(result.data, sourceId)) throw new MeetingKnowledgeStoreError('STORE_UNAVAILABLE');
      return result.data;
    },
    async mutate(identity: MicrosoftIdentity, command: MeetingKnowledgeMutation): Promise<MeetingSourceAccessRecord | MeetingManagementAcknowledgement> {
      if (!command || !Number.isSafeInteger(command.expectedAccessRevision) || command.expectedAccessRevision < 1
        || !['confirm_participant', 'revoke', 'restore', 'enable', 'disable'].includes(command.action)
        || Object.keys(command).some(key => !['sourceId', 'expectedAccessRevision', 'action', 'subjectObjectId', 'verificationRef'].includes(key))) {
        throw new MeetingKnowledgeStoreError('INVALID_MUTATION');
      }
      const isSubjectAction = ['confirm_participant', 'revoke', 'restore'].includes(command.action);
      if ((isSubjectAction && !isCanonicalMicrosoftId(command.subjectObjectId))
        || (!isSubjectAction && command.subjectObjectId !== undefined)
        || (command.action === 'confirm_participant' && (typeof command.verificationRef !== 'string'
          || command.verificationRef.length < 1 || command.verificationRef.length > 512))
        || (command.action !== 'confirm_participant' && command.verificationRef !== undefined)) {
        throw new MeetingKnowledgeStoreError('INVALID_MUTATION');
      }
      const args = { ...manageArgs(identity, command.sourceId), p_expected_access_revision: command.expectedAccessRevision,
        p_action: command.action, p_subject_object_id: command.subjectObjectId ?? null, p_verification_ref: command.verificationRef ?? null };
      if (command.action === 'disable') {
        // A transcript may have been removed; disabling must remain possible.
        let result: { data: unknown; error: unknown };
        try { result = await client.rpc('meeting_knowledge_mutate', args); }
        catch { throw new MeetingKnowledgeStoreError('STORE_UNAVAILABLE'); }
        if (!result || result.error) throw sqlError(result?.error);
        if (isManagementAcknowledgement(result.data, command.sourceId) && result.data.integrationEnabled === false) return result.data;
        if (!validRecord(result.data) || result.data.sourceId !== command.sourceId || result.data.tenantId !== identity.tenantId
          || result.data.owner.objectId !== identity.objectId || result.data.integrationEnabled !== false) throw new MeetingKnowledgeStoreError('STORE_UNAVAILABLE');
        return result.data;
      }
      const record = await call('meeting_knowledge_mutate', args, identity.tenantId, command.sourceId, false);
      if (!record || record.owner.objectId !== identity.objectId) throw new MeetingKnowledgeStoreError('STORE_UNAVAILABLE');
      return record;
    },
    async loadCurrentSource(tenantId: string, sourceId: string): Promise<MeetingSourceAccessRecord | null> {
      if (!isCanonicalMicrosoftId(tenantId) || !validSourceId(sourceId)) throw new MeetingKnowledgeStoreError('INVALID_MUTATION');
      return call('meeting_knowledge_current_source', { p_tenant_id: tenantId, p_source_id: sourceId }, tenantId, sourceId, true);
    },
  };
}
