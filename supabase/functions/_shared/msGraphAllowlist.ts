/**
 * Single source of truth for the Microsoft tenant / email-domain allowlist that gates every
 * Gemini-spending edge function.
 *
 * supabase-token mints an app JWT only after this check passes; generate-profile and
 * identify-speakers apply the SAME check on their Microsoft Graph FALLBACK path. Without it, a
 * bare Microsoft Graph access token (any tenant, even a personal MSA) would satisfy a naive
 * `GET /me` call and let an outside account burn the org's paid Gemini key (cost / DoS).
 *
 * The policy (mirrors supabase-token's original inline gate exactly):
 *   - FAIL CLOSED when neither allowlist env var is configured (never run with the gate off).
 *   - Otherwise allow the identity when its tenant id is allowlisted OR its email domain is.
 */

type GetEnv = (name: string) => string | undefined;

const DEFAULT_GET_ENV: GetEnv = (name) => Deno.env.get(name);

/** Message kept byte-for-byte identical to supabase-token's original gate. */
const ACCESS_CONTROL_UNCONFIGURED =
  'Access control is not configured. Set ALLOWED_MS_TENANT_IDS or ALLOWED_EMAIL_DOMAINS.';
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

/** Lowercased domain part of an email / UPN, or '' when there is no '@'. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

/**
 * Decode a JWT's payload WITHOUT verifying the signature. Safe here only because the token has
 * already been validated by a successful Microsoft Graph /me call; we read `tid` purely for
 * tenant authorization. Microsoft Graph access tokens are opaque by contract, so this may return
 * null, so callers must fall back to another signal (email domain) when it does.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
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

/**
 * THE allowlist policy, shared by every gate so it cannot drift. Fails CLOSED when neither
 * allowlist env var is set; otherwise allows when the tenant id OR the email domain is
 * allowlisted. `tenantId` may come from a verified ID token (preferred) or from the opaque
 * access-token claims; both are lowercased before comparison.
 */
export function enforceMsAllowlist(
  identity: { tenantId: string; email: string | null },
  getEnv: GetEnv = DEFAULT_GET_ENV,
): MsAllowlistDecision {
  const allowedTenants = parseCsvEnv('ALLOWED_MS_TENANT_IDS', getEnv);
  const allowedDomains = parseCsvEnv('ALLOWED_EMAIL_DOMAINS', getEnv);
  if (allowedTenants.length === 0 && allowedDomains.length === 0) {
    // Misconfiguration, not a user error: never run with the gate effectively disabled.
    return { allowed: false, status: 500, error: ACCESS_CONTROL_UNCONFIGURED };
  }
  const tenantId = (identity.tenantId ?? '').trim().toLowerCase();
  const domain = emailDomain(identity.email ?? '');
  const tenantAllowed = tenantId !== '' && allowedTenants.includes(tenantId);
  const domainAllowed = domain !== '' && allowedDomains.includes(domain);
  if (!tenantAllowed && !domainAllowed) {
    return { allowed: false, status: 403, error: ACCOUNT_NOT_PERMITTED };
  }
  return { allowed: true };
}

/** Resolve id, tenant id, and email/UPN for a Microsoft Graph access token. */
async function fetchMicrosoftGraphUser(
  accessToken: string,
): Promise<{ id: string | null; email: string | null; error?: string }> {
  const response = await fetch(
    'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName',
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return {
      id: null,
      email: null,
      error: `Microsoft Graph /me rejected the token (${response.status}). ${detail.slice(0, 300)}`,
    };
  }
  const data = (await response.json()) as {
    id?: unknown;
    mail?: unknown;
    userPrincipalName?: unknown;
  };
  const id = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : null;
  const email = typeof data.mail === 'string' && data.mail.trim()
    ? data.mail.trim()
    : typeof data.userPrincipalName === 'string' && data.userPrincipalName.trim()
      ? data.userPrincipalName.trim()
      : null;
  return { id, email };
}

/**
 * FALLBACK auth for the Gemini edge functions: validate a Microsoft Graph access token via
 * `/me` AND enforce the tenant/domain allowlist. Returns the user id ONLY when the token is
 * valid and the account is allowlisted (replacing the old bare `getMicrosoftUserId`, which
 * accepted any valid Graph token regardless of tenant). On failure, `status` carries 401
 * (invalid token), 403 (not allowlisted), or 500 (allowlist unconfigured).
 */
export async function authorizeMicrosoftGraphToken(
  accessToken: string,
  getEnv: GetEnv = DEFAULT_GET_ENV,
): Promise<MsGraphAuthResult> {
  const user = await fetchMicrosoftGraphUser(accessToken);
  if (!user.id) {
    return { userId: null, error: user.error ?? 'Microsoft Graph /me did not return a user id.', status: 401 };
  }
  const claims = decodeJwtClaims(accessToken);
  const tenantId = typeof claims?.tid === 'string' ? claims.tid.trim().toLowerCase() : '';
  const decision = enforceMsAllowlist({ tenantId, email: user.email }, getEnv);
  if (!decision.allowed) {
    return { userId: null, error: decision.error, status: decision.status };
  }
  return { userId: user.id };
}
