import {
  MicrosoftIdentityVerificationError,
  readMicrosoftIdentityVerificationConfig,
  verifyMicrosoftIdentityForExchange,
} from '../_shared/verified-microsoft-identity.ts';
import {
  clientKindOf,
  enforceKnownClient,
  enforceMsAllowlist,
  graphAccessTokenTenantId,
  graphIdentityBindingError,
} from '../_shared/msGraphAllowlist.ts';

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

const GRAPH_TIMEOUT_MS = 8_000;

async function getMicrosoftUser(accessToken: string): Promise<{
  id: string | null;
  email: string | null;
  name: string | null;
  error?: string;
  /** 503 when Graph could not be reached in time; otherwise 401. */
  status?: 401 | 503;
}> {
  let response: Response;
  try {
    response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
  } catch {
    // Timeout or network failure: a Microsoft outage, not a bad token. 503 lets clients retry
    // instead of treating it as a sign-out.
    return { id: null, email: null, name: null, error: 'Microsoft Graph did not respond. Try again.', status: 503 };
  }
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

type LegacyReason = 'id_token_missing' | 'verification_disabled';


/**
 * One structured line per exchange that did not use a verified ID token. Counting these lines
 * (Supabase dashboard > Edge Functions > supabase-token > Logs) tells when every client sends
 * an ID token, which is the precondition for SUPABASE_TOKEN_REQUIRE_ID_TOKEN=true.
 */
function logLegacyExchange(req: Request, reason: LegacyReason, outcome: 'allowed' | 'denied' | 'blocked'): void {
  console.info(JSON.stringify({ event: 'supabase_token_legacy_exchange', reason, client: clientKindOf(req.headers.get('user-agent')), outcome }));
}

/** Exact `true` opts in. Default off so installed mobile builds without an ID token keep working. */
function requireIdToken(): boolean {
  return Deno.env.get('SUPABASE_TOKEN_REQUIRE_ID_TOKEN')?.trim().toLowerCase() === 'true';
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

  // Legacy (no verified ID token) exchanges can be switched off once every client sends one.
  // The switch needs ID-token verification itself, so an inconsistent rollout fails closed.
  const idTokenRequired = requireIdToken();
  if (idTokenRequired && !identityConfig.enabled) {
    return jsonResponse({ error: 'Meeting knowledge identity verification is not configured.' }, 503);
  }
  const idTokenHeader = req.headers.get('x-ms-id-token');
  if (idTokenRequired && idTokenHeader === null) {
    logLegacyExchange(req, 'id_token_missing', 'blocked');
    return jsonResponse({ error: 'A Microsoft ID token is required. Update the app and sign in again.' }, 401);
  }

  const user = await getMicrosoftUser(accessToken);
  if (!user.id) {
    return jsonResponse({ error: user.error ?? 'Unauthorized' }, user.status ?? 401);
  }
  // The Graph id must be an object id, and the decoded `oid` of the same token must match it.
  const bindingError = graphIdentityBindingError(accessToken, user.id);
  if (bindingError) {
    return jsonResponse({ error: 'Microsoft identity verification failed.' }, 401);
  }

  let verifiedIdentity;
  try {
    verifiedIdentity = await verifyMicrosoftIdentityForExchange(
      identityConfig,
      idTokenHeader,
      user.id,
    );
  } catch (error) {
    const status = error instanceof MicrosoftIdentityVerificationError ? error.status : 401;
    return jsonResponse({ error: 'Microsoft identity verification failed.' }, status);
  }

  // The tenant id is the only org signal (security review 2026-10-15): the email / Graph `mail`
  // is never consulted, because any Entra tenant admin can set it to an address in our domain.
  // Verified exchange: the tenant of the signature-verified ID token.
  // Legacy exchange: the `tid` of the access token Graph has just accepted. Delete this branch
  // once SUPABASE_TOKEN_REQUIRE_ID_TOKEN=true is on in every environment.
  if (idTokenRequired && !verifiedIdentity) {
    logLegacyExchange(req, 'verification_disabled', 'blocked');
    return jsonResponse({ error: 'A Microsoft ID token is required. Update the app and sign in again.' }, 401);
  }
  const legacyReason: LegacyReason | null = verifiedIdentity
    ? null
    : idTokenHeader === null ? 'id_token_missing' : 'verification_disabled';
  const tokenTenantId = verifiedIdentity?.identity.tenantId ?? graphAccessTokenTenantId(accessToken);
  const allowlist = enforceMsAllowlist({ tenantId: tokenTenantId }, (name) => Deno.env.get(name));
  if (legacyReason) logLegacyExchange(req, legacyReason, allowlist.allowed ? 'allowed' : 'denied');
  if (!allowlist.allowed) {
    return jsonResponse({ error: allowlist.error }, allowlist.status ?? 403);
  }
  // Confused-deputy check (appid / azp of the access token). Log-only until
  // MS_TOKEN_REQUIRE_KNOWN_CLIENT=true.
  const knownClient = enforceKnownClient(accessToken, { client: clientKindOf(req.headers.get('user-agent')) });
  if (!knownClient.allowed) {
    return jsonResponse({ error: knownClient.error }, knownClient.status ?? 403);
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
