// Microsoft caller identity for the workflow-server and the merged MCP server.
//
// Every route that accepts a raw Microsoft Graph access token resolves the caller here, so the
// org gate cannot drift between routes (security review 2026-10-15, R02 of 2026-09-29).
//
// Rules:
//   - Graph `/me` validates the token (signature, expiry, revocation) and gives the object id.
//   - The tenant id is the `tid` of that SAME token. Decoding it without verifying the
//     signature is safe only because Graph has just accepted the token; it is never read from
//     an unvalidated token.
//   - The tenant id is the only org signal. The email / Graph `mail` is display data: any Entra
//     tenant admin can set `mail` to an address in a domain they do not own (nOAuth class).
//   - ALLOWED_MS_TENANT_IDS (the same variable the edge functions and the knowledge routes read)
//     lists the allowed tenants. B2B guests of an allowed tenant carry its `tid` and pass.
//   - The Graph id must be an object id (UUID) and equal the token's `oid` (401 otherwise).
//   - Confused-deputy check: the token's `appid` / `azp` should be a known Meeting Note client
//     (knownClientIdsFromEnv). Log-only by default; MS_TOKEN_REQUIRE_KNOWN_CLIENT=true denies.
//
// Rollout safety: when ALLOWED_MS_TENANT_IDS is empty, ordinary routes keep the pre-2026-10-15
// behaviour (any Graph-valid caller, data still scoped by object id) and log one warning, so a
// deploy cannot lock every user out. Routes that serve shared org content (product docs) pass
// `requireOrg: true` and fail closed instead. GET /health reports the mode (`msTenantGate`).

export type TenantGateMode = 'enforced' | 'unconfigured';

export interface MicrosoftCaller {
  /** Microsoft object id from Graph /me (data scoping and admin checks use this). */
  id: string;
  /** Display only. Graph `mail`, else UPN, lower-cased. Never an authorization input. */
  email: string;
  name: string | null;
  /** `tid` of the Graph-accepted token, lower-cased; '' for opaque tokens. */
  tenantId: string;
  /** True only when the tenant allowlist is configured and the tenant is in it. */
  orgVerified: boolean;
}

export class MicrosoftIdentityError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'MicrosoftIdentityError';
    this.status = status;
  }
}

export interface ResolveMicrosoftCallerOptions {
  /** Defaults to ALLOWED_MS_TENANT_IDS from the environment. */
  allowedTenantIds?: readonly string[];
  /** Deny when the allowlist is unconfigured (shared org content). */
  requireOrg?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Log label for the known-client check: 'api' | 'product-docs' | 'mcp-graph' | 'mcp-admin'. */
  surface?: string;
  /** Defaults to knownClientIdsFromEnv(). */
  knownClientIds?: readonly string[];
  /** Defaults to MS_TOKEN_REQUIRE_KNOWN_CLIENT. */
  clientGateMode?: ClientGateMode;
}

const GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName';
const DEFAULT_TIMEOUT_MS = 8_000;
export const ACCOUNT_NOT_PERMITTED =
  'This account is not permitted to use Meeting Note. Please sign in with your organization account.';

/** Comma-separated tenant ids, trimmed and lower-cased, empties dropped. */
export function parseTenantIds(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
}

export function allowedTenantIdsFromEnv(): string[] {
  return parseTenantIds(process.env.ALLOWED_MS_TENANT_IDS);
}

export function tenantGateMode(allowedTenantIds: readonly string[] = allowedTenantIdsFromEnv()): TenantGateMode {
  return allowedTenantIds.length > 0 ? 'enforced' : 'unconfigured';
}

/**
 * `tid` of a JWT-shaped token, lower-cased, or '' (opaque / malformed / non-string tid).
 * Call ONLY with a token that Graph has just accepted.
 */
export function tenantIdFromGraphAcceptedToken(accessToken: string): string {
  return graphTokenClaims(accessToken)?.tenantId ?? '';
}

export interface GraphTokenClaims {
  tenantId: string;
  objectId: string;
  /** `appid` (v1 token) or `azp` (v2 token): the app registration the token was issued to. */
  clientId: string;
}

/** Lower-cased routing claims of a JWT-shaped token; null when opaque or malformed. */
export function graphTokenClaims(accessToken: string): GraphTokenClaims | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const claims = payload as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
    return { tenantId: text(claims.tid), objectId: text(claims.oid), clientId: text(claims.appid) || text(claims.azp) };
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 401 unless the Graph id is an object id (UUID) equal to the `oid` of a decodable token. */
export function assertGraphIdentityBinding(accessToken: string, graphObjectId: string): void {
  const id = graphObjectId.trim().toLowerCase();
  if (!UUID.test(id)) throw new MicrosoftIdentityError(401, 'Microsoft Graph /me returned an unexpected user id.');
  const claims = graphTokenClaims(accessToken);
  if (claims && claims.objectId !== id) throw new MicrosoftIdentityError(401, 'Microsoft token does not match the Graph user.');
}

/**
 * App registrations whose Graph tokens this server expects (confused-deputy check):
 * MS_KNOWN_CLIENT_IDS (explicit list), the Meeting Note web/mobile app (MS_ID_TOKEN_CLIENT_IDS,
 * MSAL_CLIENT_ID, VITE_MSAL_CLIENT_ID), the MCP OAuth proxy app (MCP_OAUTH_CLIENT_ID) and the
 * MCP admin dashboard app (MCP_ADMIN_CLIENT_ID).
 */
export function knownClientIdsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const names = ['MS_KNOWN_CLIENT_IDS', 'MS_ID_TOKEN_CLIENT_IDS', 'MSAL_CLIENT_ID', 'VITE_MSAL_CLIENT_ID', 'MCP_OAUTH_CLIENT_ID', 'MCP_ADMIN_CLIENT_ID'];
  return [...new Set(names.flatMap((name) => parseTenantIds(env[name])))];
}

export type ClientGateMode = 'log-only' | 'enforced';

export function clientGateMode(env: NodeJS.ProcessEnv = process.env): ClientGateMode {
  return env.MS_TOKEN_REQUIRE_KNOWN_CLIENT?.trim().toLowerCase() === 'true' ? 'enforced' : 'log-only';
}

/**
 * Logs (no client id, user or token data) when the Graph-accepted token was issued to an app
 * that is not a known client; throws 403 only when MS_TOKEN_REQUIRE_KNOWN_CLIENT=true.
 */
export function checkKnownClient(
  accessToken: string,
  surface: string,
  knownClientIds: readonly string[] = knownClientIdsFromEnv(),
  mode: ClientGateMode = clientGateMode(),
): void {
  const clientId = graphTokenClaims(accessToken)?.clientId ?? '';
  if (clientId !== '' && knownClientIds.includes(clientId)) return;
  const enforced = mode === 'enforced';
  const reason = knownClientIds.length === 0 ? 'known_clients_unconfigured' : clientId === '' ? 'client_claim_missing' : 'unknown_client';
  console.info(JSON.stringify({ event: 'ms_token_client_check', reason, client: surface, knownClient: false, enforced }));
  if (enforced) throw new MicrosoftIdentityError(403, ACCOUNT_NOT_PERMITTED);
}

let warnedUnconfigured = false;

function warnUnconfiguredOnce(): void {
  if (warnedUnconfigured) return;
  warnedUnconfigured = true;
  console.warn('[auth] ALLOWED_MS_TENANT_IDS is not set: Microsoft callers from ANY tenant are accepted '
    + '(data stays scoped by object id; product docs are refused). Set it to the TecAce tenant id.');
}

/**
 * Org decision for a Graph-accepted caller. Throws 403 for a tenant outside a configured
 * allowlist, or for any caller when `requireOrg` and the allowlist is unconfigured.
 */
export function decideTenant(tenantId: string, allowedTenantIds: readonly string[], requireOrg: boolean): boolean {
  if (allowedTenantIds.length === 0) {
    warnUnconfiguredOnce();
    if (requireOrg) throw new MicrosoftIdentityError(403, ACCOUNT_NOT_PERMITTED);
    return false;
  }
  if (!tenantId || !allowedTenantIds.includes(tenantId)) {
    throw new MicrosoftIdentityError(403, ACCOUNT_NOT_PERMITTED);
  }
  return true;
}

/** Validate the Graph token, then apply the tenant gate to the same token. */
export async function resolveMicrosoftCaller(
  accessToken: string,
  options: ResolveMicrosoftCallerOptions = {},
): Promise<MicrosoftCaller> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(GRAPH_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new MicrosoftIdentityError(401, `Microsoft Graph /me rejected the token (${response.status}).`);
  }
  const data = (await response.json()) as { id?: unknown; displayName?: unknown; mail?: unknown; userPrincipalName?: unknown };
  if (typeof data.id !== 'string' || !data.id.trim()) {
    throw new MicrosoftIdentityError(401, 'Microsoft Graph /me did not return a user id.');
  }
  assertGraphIdentityBinding(accessToken, data.id);
  const tenantId = tenantIdFromGraphAcceptedToken(accessToken);
  const orgVerified = decideTenant(tenantId, options.allowedTenantIds ?? allowedTenantIdsFromEnv(), options.requireOrg === true);
  checkKnownClient(accessToken, options.surface ?? 'api', options.knownClientIds, options.clientGateMode);
  const email = typeof data.mail === 'string' && data.mail.trim()
    ? data.mail.trim()
    : typeof data.userPrincipalName === 'string' ? data.userPrincipalName.trim() : '';
  const name = typeof data.displayName === 'string' && data.displayName.trim() ? data.displayName.trim() : null;
  return { id: data.id.trim(), email: email.toLowerCase(), name, tenantId, orgVerified };
}
