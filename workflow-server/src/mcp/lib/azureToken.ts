import { createRemoteJWKSet, jwtVerify } from 'jose';

const jwksByTenant = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(tenantId: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksByTenant.get(tenantId);
  if (existing) return existing;

  const jwks = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
  );
  jwksByTenant.set(tenantId, jwks);
  return jwks;
}

export async function getMeetingNoteUserIdFromAzureToken(
  accessToken: string,
  options: {
    audience: string;
    scope?: string;
    tenantId?: string;
  }
): Promise<string | undefined> {
  const tenantId = options.tenantId?.trim();
  if (!tenantId) return undefined;

  const { payload } = await jwtVerify(accessToken, getJwks(tenantId), {
    audience: options.audience,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  });

  if (options.scope) {
    const scopes = typeof payload.scp === 'string' ? payload.scp.split(/\s+/).filter(Boolean) : [];
    if (!scopes.includes(options.scope)) return undefined;
  }

  return typeof payload.oid === 'string' && payload.oid.trim() ? payload.oid.trim() : undefined;
}
