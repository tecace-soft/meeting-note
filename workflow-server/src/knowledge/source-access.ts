import type { MicrosoftIdentity } from './contract.js';
import {
  isCanonicalMicrosoftId, isMeetingLiveAccessRequest, isMeetingSourceBinding,
  type MeetingSourceBinding, type MeetingLiveAccessRequest, type MeetingLiveAccessResponse,
} from './access-contract.js';

/** Server-owned records, never request bodies, speaker labels or extraction output. */
export interface MeetingSourceAccessRecord extends MeetingSourceBinding {
  owner: MicrosoftIdentity;
  ownerIdentityVerified: boolean;
  active: boolean;
  integrationEnabled: boolean;
  confirmedParticipants: {
    identity: MicrosoftIdentity;
    confirmedBy: MicrosoftIdentity;
    verificationRef: string;
  }[];
  directShares: MicrosoftIdentity[];
  noteProjectIds: string[];
  projects: { projectId: string; owner: MicrosoftIdentity; sharedWith: MicrosoftIdentity[] }[];
  denies: MicrosoftIdentity[];
}
export type MeetingSourceAccessDecision = { allowed: true }
  | { allowed: false; errorCode: 'SOURCE_UNAVAILABLE' | 'IDENTITY_MISMATCH' | 'ACCESS_REVOKED' | 'NOT_IN_AUDIENCE' };
const deny = (errorCode: Extract<MeetingSourceAccessDecision, { allowed: false }>['errorCode']): MeetingSourceAccessDecision =>
  ({ allowed: false, errorCode });
function validIdentity(value: unknown): value is MicrosoftIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as MicrosoftIdentity;
  return isCanonicalMicrosoftId(identity.tenantId) && isCanonicalMicrosoftId(identity.objectId);
}
const same = (a: MicrosoftIdentity, b: MicrosoftIdentity): boolean =>
  a.tenantId === b.tenantId && a.objectId === b.objectId;

/**
 * Note management ownership does not imply knowledge retrieval. A trusted loader
 * must validate/normalize legacy shares to the note owner's VERIFIED tenant and
 * read confirmed attendance/explicit denies atomically with current revisions.
 * This pure policy does not create that persistence or authenticate an AXKH caller.
 */
export function evaluateMeetingSourceAccess(
  identity: MicrosoftIdentity, source: MeetingSourceAccessRecord,
): MeetingSourceAccessDecision {
  if (!source || !isMeetingSourceBinding(source) || source.active !== true
    || source.integrationEnabled !== true || source.ownerIdentityVerified !== true
    || !validIdentity(source.owner) || source.owner.tenantId !== source.tenantId
    || !Array.isArray(source.denies) || !source.denies.every(validIdentity)
    || !Array.isArray(source.directShares) || !source.directShares.every(validIdentity)
    || !Array.isArray(source.confirmedParticipants) || !source.confirmedParticipants.every(participant =>
      participant && validIdentity(participant.identity) && validIdentity(participant.confirmedBy)
      && typeof participant.verificationRef === 'string' && participant.verificationRef.length > 0
      && participant.verificationRef.length <= 512)
    || !Array.isArray(source.noteProjectIds) || !source.noteProjectIds.every(id => typeof id === 'string' && id.length > 0)
    || !Array.isArray(source.projects) || !source.projects.every(project =>
      project && typeof project.projectId === 'string' && project.projectId.length > 0
      && validIdentity(project.owner) && Array.isArray(project.sharedWith) && project.sharedWith.every(validIdentity))) {
    return deny('SOURCE_UNAVAILABLE');
  }
  if (!validIdentity(identity) || identity.tenantId !== source.tenantId) return deny('IDENTITY_MISMATCH');
  if (source.denies.some(member => same(member, identity))) return deny('ACCESS_REVOKED');
  if (source.directShares.some(member => same(member, identity))) return { allowed: true };
  if (source.confirmedParticipants.some(participant =>
    same(participant.identity, identity) && same(participant.confirmedBy, source.owner))) return { allowed: true };
  if (source.projects.some(project => source.noteProjectIds.includes(project.projectId)
    && same(project.owner, source.owner) && project.sharedWith.some(member => same(member, identity)))) return { allowed: true };
  return deny('NOT_IN_AUDIENCE');
}

/**
 * Internal adapter for a future authenticated HTTP/MCP boundary. The loader must
 * be bound to the integration tenant/source and backed by current persistent
 * authority; never adapt the legacy unscoped static-key MCP lookup here.
 * Denials return only the caller-supplied binding, never titles or stored state.
 */
export async function checkMeetingSourceAccess(
  request: MeetingLiveAccessRequest,
  loadCurrentSource: (tenantId: string, sourceId: string) => Promise<MeetingSourceAccessRecord | null>,
): Promise<MeetingLiveAccessResponse> {
  if (!isMeetingLiveAccessRequest(request)) throw new Error('INVALID_SOURCE_ACCESS_REQUEST');
  const binding = { ...request };
  try {
    const source = await loadCurrentSource(binding.tenantId, binding.sourceId);
    const matches = source && [
      'tenantId', 'sourceId', 'contentRevision', 'speakerRevision', 'accessRevision', 'sourceHash', 'integrationGeneration',
    ].every(key => source[key as keyof MeetingSourceBinding] === binding[key as keyof MeetingSourceBinding]);
    const allowed = !!matches && evaluateMeetingSourceAccess(
      { tenantId: binding.tenantId, objectId: binding.objectId }, source!,
    ).allowed;
    return { ...binding, allowed };
  } catch {
    return { ...binding, allowed: false };
  }
}
