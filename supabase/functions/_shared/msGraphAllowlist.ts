/**
 * Single source of truth for the Microsoft TENANT allowlist that gates every edge function
 * that accepts a Microsoft token.
 *
 * supabase-token mints an app JWT only after this check passes; mcp-token, admin-analytics,
 * admin-controls, generate-profile, identify-speakers and note-audio-url apply the SAME check
 * on their Microsoft Graph path. Without it, a bare Microsoft Graph access token (any tenant,
 * even a personal MSA) would satisfy a naive `GET /me` call.
 *
 * The policy (security review 2026-10-15, nOAuth class):
 *   - The tenant id is the ONLY org signal. It comes from a signature-verified ID token, or
 *     from the `tid` of a Graph access token that Microsoft Graph has just accepted.
 *   - The email / UPN domain is NEVER an org signal. Graph `mail` is an attribute any Entra
 *     tenant admin can set to an address in a domain they do not own (e.g. `x@tecace.com`),
 *     so "tenant OR email domain" let an outside tenant mint an app JWT.
 *   - FAIL CLOSED (500) when ALLOWED_MS_TENANT_IDS is empty (never run with the gate off).
 *   - ALLOWED_EMAIL_DOMAINS is ignored. When it is still set, a warning is logged once per
 *     isolate so the operator removes it.
 *
 * B2B guests of an allowlisted tenant are allowed: a guest signed in through that tenant's
 * authority receives tokens whose `tid` is that tenant.
 */

type GetEnv = (name: string) => string | undefined;

const DEFAULT_GET_ENV: GetEnv = (name) => Deno.env.get(name);

const ACCESS_CONTROL_UNCONFIGURED =
  'Access control is not configured. Set ALLOWED_MS_TENANT_IDS.';
/** Message kept byte-for-byte identical to supabase-token's original gate. */
const ACCOUNT_NOT_PERMITTED =
  'This account is not permitted to use Meeting Note. Please sign in with your organization account.';

export interface MsAllowlistDecision {
  allowed: boolean;
  /** 500 when the allowlist is unconfigured (misconfiguration), 403 when the account is denied. */
  status?: 403 | 500;
  error?: string;
}

export interface MsGraphAuthResult {
  userId: string | null;
  error?: string;
  /** 401 invalid Graph token, 403 not allowlisted, 500 allowlist unconfigured. */
  status?: 401 | 403 | 500;
}

/** Comma-separated env var -> normalized lowercase list (empty entries dropped). */
export function parseCsvEnv(name: string, getEnv: GetEnv = DEFAULT_GET_ENV): string[] {
  return (getEnv(name) ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Decode a JWT's payload WITHOUT verifying the signature. Safe ONLY for a token that Microsoft
 * Graph has just accepted (Graph verified the signature, so the payload is genuine). Graph
 * access tokens are opaque by contract (personal MSA tokens are not JWTs at all), so this may
 * return null; the caller then has no tenant and is denied.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Lowercased `tid` of a Graph-accepted access token, or '' when it has none (opaque / MSA). */
export function graphAccessTokenTenantId(accessToken: string): string {
  return graphAccessTokenClaims(accessToken)?.tenantId ?? '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GraphTokenClaims {
  tenantId: string;
  objectId: string;
  /** `appid` (v1 token) or `azp` (v2 token): the app registration the token was issued to. */
  clientId: string;
}

/** Lowercased routing claims of a Graph-accepted JWT access token; null when opaque. */
export function graphAccessTokenClaims(accessToken: string): GraphTokenClaims | null {
  const claims = decodeJwtClaims(accessToken);
  if (!claims) return null;
  const text = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
  return { tenantId: text(claims.tid), objectId: text(claims.oid), clientId: text(claims.appid) || text(claims.azp) };
}

/**
 * The Graph `/me` id must be an Entra object id (UUID), and a decodable token must carry the
 * same `oid`. Returns an error message to reject with (401), or null when bound.
 */
export function graphIdentityBindingError(accessToken: string, graphObjectId: string): string | null {
  const id = graphObjectId.trim().toLowerCase();
  if (!UUID.test(id)) return 'Microsoft Graph /me returned an unexpected user id.';
  const claims = graphAccessTokenClaims(accessToken);
  if (claims && claims.objectId !== id) return 'Microsoft token does not match the Graph user.';
  return null;
}

/**
 * App registrations whose Graph tokens are expected (confused-deputy check). The Meeting Note
 * web + mobile app (`MS_ID_TOKEN_CLIENT_IDS`, else `MSAL_CLIENT_ID`) plus any extra ids in
 * `MS_KNOWN_CLIENT_IDS`.
 */
export function knownClientIds(getEnv: GetEnv = DEFAULT_GET_ENV): string[] {
  const ids = [
    ...parseCsvEnv('MS_KNOWN_CLIENT_IDS', getEnv),
    ...parseCsvEnv('MS_ID_TOKEN_CLIENT_IDS', getEnv),
    ...parseCsvEnv('MSAL_CLIENT_ID', getEnv),
  ];
  return [...new Set(ids)];
}

export type ClientKind = 'mobile' | 'browser' | 'other';

/** Coarse caller class from the User-Agent. No user, token or device identifiers. */
export function clientKindOf(userAgent: string | null): ClientKind {
  const agent = userAgent ?? '';
  if (agent.startsWith('Dart/')) return 'mobile';
  if (agent.includes('Mozilla/')) return 'browser';
  return 'other';
}

/**
 * Confused-deputy check on the Graph-accepted token's `appid` / `azp`. A token issued to some
 * other app (Graph Explorer, Azure CLI, a third-party app) is LOGGED and still allowed, unless
 * MS_TOKEN_REQUIRE_KNOWN_CLIENT=true (then 403; 500 when no known client is configured).
 * The log carries no client id, user or token data, only whether the client was known.
 */
export function enforceKnownClient(
  accessToken: string,
  context: { client: ClientKind },
  getEnv: GetEnv = DEFAULT_GET_ENV,
): MsAllowlistDecision {
  const known = knownClientIds(getEnv);
  const clientId = graphAccessTokenClaims(accessToken)?.clientId ?? '';
  if (clientId !== '' && known.includes(clientId)) return { allowed: true };
  const enforced = getEnv('MS_TOKEN_REQUIRE_KNOWN_CLIENT')?.trim().toLowerCase() === 'true';
  const reason = known.length === 0 ? 'known_clients_unconfigured' : clientId === '' ? 'client_claim_missing' : 'unknown_client';
  console.info(JSON.stringify({ event: 'ms_token_client_check', reason, client: context.client, knownClient: false, enforced }));
  if (!enforced) return { allowed: true };
  if (known.length === 0) return { allowed: false, status: 500, error: 'Known Microsoft clients are not configured.' };
  return { allowed: false, status: 403, error: ACCOUNT_NOT_PERMITTED };
}

let warnedIgnoredDomainAllowlist = false;

/** Logs once per isolate when the retired ALLOWED_EMAIL_DOMAINS is still configured. */
function warnIfDomainAllowlistConfigured(getEnv: GetEnv): void {
  if (warnedIgnoredDomainAllowlist) return;
  if (parseCsvEnv('ALLOWED_EMAIL_DOMAINS', getEnv).length === 0) return;
  warnedIgnoredDomainAllowlist = true;
  console.warn(JSON.stringify({
    event: 'ms_allowlist_email_domains_ignored',
    message: 'ALLOWED_EMAIL_DOMAINS is set but ignored: only ALLOWED_MS_TENANT_IDS grants access. Remove the secret.',
  }));
}

/**
 * THE allowlist policy, shared by every gate so it cannot drift. Fails CLOSED when
 * ALLOWED_MS_TENANT_IDS is empty; otherwise allows only an allowlisted tenant id.
 * `tenantId` must come from a verified ID token or from a Graph-accepted access token.
 */
export function enforceMsAllowlist(
  identity: { tenantId: string },
  getEnv: GetEnv = DEFAULT_GET_ENV,
): MsAllowlistDecision {
  warnIfDomainAllowlistConfigured(getEnv);
  const allowedTenants = parseCsvEnv('ALLOWED_MS_TENANT_IDS', getEnv);
  if (allowedTenants.length === 0) {
    // Misconfiguration, not a user error: never run with the gate effectively disabled.
    return { allowed: false, status: 500, error: ACCESS_CONTROL_UNCONFIGURED };
  }
  const tenantId = (identity.tenantId ?? '').trim().toLowerCase();
  if (tenantId === '' || !allowedTenants.includes(tenantId)) {
    return { allowed: false, status: 403, error: ACCOUNT_NOT_PERMITTED };
  }
  return { allowed: true };
}

/** Resolve the object id for a Microsoft Graph access token (Graph validates the token). */
async function fetchMicrosoftGraphUserId(
  accessToken: string,
): Promise<{ id: string | null; error?: string }> {
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id', {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    return { id: null, error: `Microsoft Graph /me rejected the token (${response.status}).` };
  }
  const data = (await response.json()) as { id?: unknown };
  const id = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : null;
  return { id };
}

/**
 * Graph-token auth for the edge functions: validate a Microsoft Graph access token via `/me`,
 * bind its `oid` to the Graph id, enforce the tenant allowlist on the `tid` of that same,
 * Graph-accepted token, then run the known-client check. Returns the user id ONLY when all pass. On failure, `status` carries 401 (invalid token), 403 (not
 * allowlisted), or 500 (allowlist unconfigured).
 */
export async function authorizeMicrosoftGraphToken(
  accessToken: string,
  getEnv: GetEnv = DEFAULT_GET_ENV,
  context: { client: ClientKind } = { client: 'other' },
): Promise<MsGraphAuthResult> {
  // Configuration first: a misconfigured gate must not spend a Graph call per request.
  const configured = enforceMsAllowlist({ tenantId: '' }, getEnv);
  if (configured.status === 500) {
    return { userId: null, error: configured.error, status: 500 };
  }
  const user = await fetchMicrosoftGraphUserId(accessToken);
  if (!user.id) {
    return { userId: null, error: user.error ?? 'Microsoft Graph /me did not return a user id.', status: 401 };
  }
  const bindingError = graphIdentityBindingError(accessToken, user.id);
  if (bindingError) return { userId: null, error: bindingError, status: 401 };
  const decision = enforceMsAllowlist({ tenantId: graphAccessTokenTenantId(accessToken) }, getEnv);
  if (!decision.allowed) {
    return { userId: null, error: decision.error, status: decision.status };
  }
  const client = enforceKnownClient(accessToken, context, getEnv);
  if (!client.allowed) return { userId: null, error: client.error, status: client.status };
  return { userId: user.id };
}
