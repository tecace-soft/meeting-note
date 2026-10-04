import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'npm:jose@6.2.10';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_IDENTITY_AGE_SECONDS = 2 * 60 * 60;
const tenantKeys = new Map<string, JWTVerifyGetKey>();

export interface VerifiedMicrosoftIdentity {
  tenantId: string;
  objectId: string;
  verified: true;
}

export interface MicrosoftIdentityVerificationConfig {
  enabled: boolean;
  allowedTenantIds: string[];
  clientIds: string[];
}

export class MicrosoftIdentityVerificationError extends Error {
  constructor(public readonly status: 401 | 503) {
    super(status === 503
      ? 'Meeting knowledge identity verification is not configured.'
      : 'Microsoft identity verification failed.');
    this.name = 'MicrosoftIdentityVerificationError';
  }
}

/** Explicit server settings only. Email and Graph access-token claims never grant this identity. */
export function readMicrosoftIdentityVerificationConfig(
  getEnv: (name: string) => string | undefined,
): MicrosoftIdentityVerificationConfig {
  const enabled = getEnv('MEETING_KNOWLEDGE_VERIFY_IDENTITY')?.trim().toLowerCase() === 'true';
  const csv = (value: string | undefined) => (value ?? '').split(',')
    .map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const config = {
    enabled,
    allowedTenantIds: csv(getEnv('ALLOWED_MS_TENANT_IDS')),
    clientIds: csv(getEnv('MS_ID_TOKEN_CLIENT_IDS') || getEnv('MSAL_CLIENT_ID')),
  };
  if (enabled) assertConfigured(config);
  return config;
}

function assertConfigured(config: MicrosoftIdentityVerificationConfig): void {
  for (const entries of [config.allowedTenantIds, config.clientIds]) {
    if (!entries.length || entries.length > 32 || entries.some((entry) => !UUID.test(entry))) {
      throw new MicrosoftIdentityVerificationError(503);
    }
  }
}

function getTenantKeys(tenantId: string): JWTVerifyGetKey {
  let keys = tenantKeys.get(tenantId);
  if (!keys) {
    // Fixed Microsoft origin/path, never a token-controlled jku/x5u/issuer endpoint.
    keys = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`),
      { timeoutDuration: 5_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 },
    );
    if (tenantKeys.size >= 32) tenantKeys.clear();
    tenantKeys.set(tenantId, keys);
  }
  return keys;
}

/**
 * Only decoded tid routes to an allowlisted, fixed JWKS; nothing decoded is authoritative.
 * keyResolver/currentDate exist for offline signature tests; production callers omit them.
 * Legacy exchanges intentionally receive no verified knowledge identity.
 */
export async function verifyMicrosoftIdentityForExchange(
  config: MicrosoftIdentityVerificationConfig,
  idToken: string | null,
  graphObjectId: string,
  options: { keyResolver?: JWTVerifyGetKey; currentDate?: Date } = {},
): Promise<{ identity: VerifiedMicrosoftIdentity; idTokenExpiresAt: number } | null> {
  if (!config.enabled) return null;
  assertConfigured(config);
  if (idToken === null) return null;
  try {
    if (!idToken || idToken.length > MAX_TOKEN_LENGTH || idToken.split('.').length !== 3) {
      throw new Error('Invalid compact token');
    }
    const routingClaims = decodeJwt(idToken);
    const tenantId = typeof routingClaims.tid === 'string' ? routingClaims.tid.toLowerCase() : '';
    if (!UUID.test(tenantId) || !config.allowedTenantIds.includes(tenantId)) {
      throw new Error('Untrusted tenant');
    }
    const { payload } = await jwtVerify(idToken, options.keyResolver ?? getTenantKeys(tenantId), {
      algorithms: ['RS256'],
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: config.clientIds,
      requiredClaims: ['tid', 'oid', 'exp', 'nbf', 'iat'],
      maxTokenAge: MAX_IDENTITY_AGE_SECONDS,
      currentDate: options.currentDate,
    });
    const objectId = typeof payload.oid === 'string' ? payload.oid.toLowerCase() : '';
    if (payload.tid !== tenantId || typeof payload.aud !== 'string' ||
        !config.clientIds.includes(payload.aud) || !UUID.test(objectId) || !UUID.test(graphObjectId) ||
        objectId !== graphObjectId.toLowerCase() ||
        !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.nbf) || payload.exp! <= payload.iat! ||
        payload.nbf! >= payload.exp!) {
      throw new Error('Invalid identity binding');
    }
    return { identity: { tenantId, objectId, verified: true }, idTokenExpiresAt: payload.exp! };
  } catch {
    // Never surface claims, signing errors, or token material to responses/logs.
    throw new MicrosoftIdentityVerificationError(401);
  }
}
