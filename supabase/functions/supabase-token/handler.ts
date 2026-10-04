import {
  MicrosoftIdentityVerificationError,
  readMicrosoftIdentityVerificationConfig,
  verifyMicrosoftIdentityForExchange,
} from '../_shared/verified-microsoft-identity.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-ms-access-token, x-ms-id-token',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlJson(header);
  const encodedPayload = base64UrlJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** Comma-separated env var → normalized lowercase list (empty entries dropped). */
function parseCsvEnv(name: string): string[] {
  return (Deno.env.get(name) ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Decode a JWT's payload WITHOUT verifying the signature. Safe here only because the token
 * has already been validated by a successful Microsoft Graph /me call; we read `tid` purely
 * for tenant authorization. Microsoft Graph access tokens are opaque by contract, so this may
 * return null — callers must fall back to another signal (email domain) when it does.
 */
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

async function getMicrosoftUser(accessToken: string): Promise<{
  id: string | null;
  email: string | null;
  name: string | null;
  error?: string;
}> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    return {
      id: null,
      email: null,
      name: null,
      error: `Microsoft Graph /me rejected the token (${response.status}).`,
    };
  }
  const data = (await response.json()) as {
    id?: unknown;
    displayName?: unknown;
    mail?: unknown;
    userPrincipalName?: unknown;
  };
  return {
    id: typeof data.id === 'string' && data.id.trim() ? data.id.trim() : null,
    email: typeof data.mail === 'string' && data.mail.trim()
      ? data.mail.trim()
      : typeof data.userPrincipalName === 'string' && data.userPrincipalName.trim()
        ? data.userPrincipalName.trim()
        : null,
    name: typeof data.displayName === 'string' && data.displayName.trim() ? data.displayName.trim() : null,
    error: 'Microsoft Graph /me did not return a user id.',
  };
}

export async function handleSupabaseTokenRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // Validate enabled configuration even for legacy exchanges: an incomplete rollout fails closed.
  let identityConfig;
  try {
    identityConfig = readMicrosoftIdentityVerificationConfig((name) => Deno.env.get(name));
  } catch {
    return jsonResponse({ error: 'Meeting knowledge identity verification is not configured.' }, 503);
  }

  const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET') ?? Deno.env.get('JWT_SECRET') ?? '';
  if (!jwtSecret) {
    return jsonResponse({ error: 'Supabase JWT signing secret is not configured.' }, 500);
  }

  const accessToken = req.headers.get('x-ms-access-token')?.trim() ?? '';
  if (!accessToken) {
    return jsonResponse({ error: 'Missing Microsoft access token.' }, 401);
  }

  const user = await getMicrosoftUser(accessToken);
  if (!user.id) {
    return jsonResponse({ error: user.error ?? 'Unauthorized' }, 401);
  }

  let verifiedIdentity;
  try {
    verifiedIdentity = await verifyMicrosoftIdentityForExchange(
      identityConfig,
      req.headers.get('x-ms-id-token'),
      user.id,
    );
  } catch (error) {
    const status = error instanceof MicrosoftIdentityVerificationError ? error.status : 401;
    return jsonResponse({ error: 'Microsoft identity verification failed.' }, status);
  }

  // Keep the legacy login gate for clients without a verified identity. New knowledge identity
  // uses only the verified ID token's tenant; opaque Graph access-token claims and email are
  // never authoritative for that identity. A verified, allowed tenant also supports opaque tokens.
  const allowedTenants = parseCsvEnv('ALLOWED_MS_TENANT_IDS');
  const allowedDomains = parseCsvEnv('ALLOWED_EMAIL_DOMAINS');
  if (allowedTenants.length === 0 && allowedDomains.length === 0) {
    // Misconfiguration, not a user error: never mint tokens with the gate effectively disabled.
    return jsonResponse(
      { error: 'Access control is not configured. Set ALLOWED_MS_TENANT_IDS or ALLOWED_EMAIL_DOMAINS.' },
      500
    );
  }
  const claims = decodeJwtClaims(accessToken);
  const tokenTenantId = verifiedIdentity?.identity.tenantId ??
    (typeof claims?.tid === 'string' ? claims.tid.trim().toLowerCase() : '');
  const userDomain = emailDomain(user.email ?? '');
  const tenantAllowed = tokenTenantId !== '' && allowedTenants.includes(tokenTenantId);
  const domainAllowed = userDomain !== '' && allowedDomains.includes(userDomain);
  if (!tenantAllowed && !domainAllowed) {
    return jsonResponse(
      { error: 'This account is not permitted to use Meeting Note. Please sign in with your organization account.' },
      403
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(now + 60 * 60, verifiedIdentity?.idTokenExpiresAt ?? Infinity);
  if (expiresAt <= now) return jsonResponse({ error: 'Microsoft identity verification failed.' }, 401);
  const token = await signJwt({
    aud: 'authenticated',
    exp: expiresAt,
    iat: now,
    iss: 'meeting-note',
    role: 'authenticated',
    sub: verifiedIdentity?.identity.objectId ?? user.id,
    ...(verifiedIdentity ? {
      app_metadata: { meeting_knowledge_identity: verifiedIdentity.identity },
    } : {}),
    email: user.email ?? '',
    user_metadata: {
      provider: 'microsoft',
      name: user.name ?? '',
    },
  }, jwtSecret);

  return jsonResponse({
    access_token: token,
    token_type: 'bearer',
    expires_at: expiresAt,
    expires_in: expiresAt - now,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
  });
}
