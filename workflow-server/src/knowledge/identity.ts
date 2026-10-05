import { jwtVerify } from 'jose';
import type { MicrosoftIdentity } from './contract.js';
import { isCanonicalMicrosoftId } from './access-contract.js';

export interface MeetingIdentityVerification {
  signingSecret: string;
  allowedTenantIds: readonly string[];
  currentDate?: Date;
}
export type MeetingIdentityResult = { authenticated: true; identity: MicrosoftIdentity }
  | { authenticated: false; errorCode: 'IDENTITY_CONFIG_UNAVAILABLE' | 'UNVERIFIED_IDENTITY' };

/**
 * Accept only signed tokens from the upgraded supabase-token exchange. Old tokens,
 * user_metadata, email domains and unverified Microsoft JWT decoding are not identity.
 * This resolves a person, not their meeting access or AXKH clearance.
 */
export async function verifyMeetingNoteIdentity(
  token: string, options: MeetingIdentityVerification,
): Promise<MeetingIdentityResult> {
  if (typeof options.signingSecret !== 'string' || new TextEncoder().encode(options.signingSecret).length < 32
    || !Array.isArray(options.allowedTenantIds) || options.allowedTenantIds.length === 0
    || options.allowedTenantIds.length > 32 || !options.allowedTenantIds.every(isCanonicalMicrosoftId)) {
    return { authenticated: false, errorCode: 'IDENTITY_CONFIG_UNAVAILABLE' };
  }
  if (typeof token !== 'string' || token.length === 0 || token.length > 16_384) {
    return { authenticated: false, errorCode: 'UNVERIFIED_IDENTITY' };
  }
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(options.signingSecret), {
      algorithms: ['HS256'], issuer: 'meeting-note', audience: 'authenticated',
      requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: '1h', currentDate: options.currentDate,
    });
    const metadata = payload.app_metadata;
    if (payload.role !== 'authenticated' || !isCanonicalMicrosoftId(payload.sub)
      || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return { authenticated: false, errorCode: 'UNVERIFIED_IDENTITY' };
    }
    const identity = (metadata as Record<string, unknown>).meeting_knowledge_identity;
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      return { authenticated: false, errorCode: 'UNVERIFIED_IDENTITY' };
    }
    const record = identity as Record<string, unknown>;
    if (record.verified !== true || !isCanonicalMicrosoftId(record.tenantId)
      || !isCanonicalMicrosoftId(record.objectId) || record.objectId !== payload.sub
      || !options.allowedTenantIds.includes(record.tenantId)) {
      return { authenticated: false, errorCode: 'UNVERIFIED_IDENTITY' };
    }
    return { authenticated: true, identity: { tenantId: record.tenantId, objectId: record.objectId } };
  } catch {
    return { authenticated: false, errorCode: 'UNVERIFIED_IDENTITY' };
  }
}
