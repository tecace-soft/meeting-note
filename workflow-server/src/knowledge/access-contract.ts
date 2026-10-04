/** Shared source-check wire types. Transport authentication is required separately. */
export interface MeetingSourceBinding {
  tenantId: string;
  sourceId: string;
  contentRevision: number;
  speakerRevision: number;
  accessRevision: number;
  sourceHash: string;
  integrationGeneration: number;
}
export interface MeetingLiveAccessRequest extends MeetingSourceBinding { objectId: string }
export interface MeetingLiveAccessResponse extends MeetingLiveAccessRequest { allowed: boolean }

export const isCanonicalMicrosoftId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export function isMeetingSourceBinding(value: unknown): value is MeetingSourceBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return isCanonicalMicrosoftId(source.tenantId)
    && typeof source.sourceId === 'string' && source.sourceId.length > 0 && source.sourceId.length <= 256
    && typeof source.sourceHash === 'string' && /^[0-9a-f]{64}$/.test(source.sourceHash)
    && ['contentRevision', 'speakerRevision', 'accessRevision', 'integrationGeneration'].every(key =>
      typeof source[key] === 'number' && Number.isSafeInteger(source[key]) && source[key] >= 1);
}

export function isMeetingLiveAccessRequest(value: unknown): value is MeetingLiveAccessRequest {
  if (!isMeetingSourceBinding(value)) return false;
  const request = value as MeetingLiveAccessRequest;
  return isCanonicalMicrosoftId(request.objectId)
    && Object.keys(request).length === 8
    && Object.keys(request).every(key => [
      'tenantId', 'objectId', 'sourceId', 'contentRevision', 'speakerRevision',
      'accessRevision', 'sourceHash', 'integrationGeneration',
    ].includes(key));
}
