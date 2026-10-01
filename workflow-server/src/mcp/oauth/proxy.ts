import type { IncomingMessage, ServerResponse } from 'node:http';
import { getMicrosoftUserIdFromGraph } from '../lib/microsoftGraph.js';
import { consumeCodeId, deriveOAuthKeys, issueToken, verifyPkceS256, verifyToken, type OAuthKeys } from './tokens.js';

// OAuth 2.1 authorization server facade for MCP clients that connect with only a URL + "OAuth"
// (ChatGPT plugins). Those clients discover this server from the protected-resource metadata
// and register themselves (DCR). Entra supports neither DCR nor CIMD, so this server plays the
// authorization server and delegates the actual sign-in to the pre-registered Entra app:
//
//   client ──/oauth/authorize──▶ here ──302──▶ Entra login ──/oauth/callback──▶ here
//          ◀──code (PKCE-bound)──             (Entra code → tokens → Graph /me oid)
//   client ──/oauth/token──▶ access token (aud = MCP resource) + refresh token
//
// The resolved user is the Microsoft object id, the same id the web app and personal MCP tokens
// use, so data scoping is unchanged.

export const OAUTH_PATHS = new Set([
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/mcp-chatgpt',
  '/.well-known/openid-configuration',
  '/.well-known/openid-configuration/mcp-chatgpt',
  '/mcp-chatgpt/.well-known/openid-configuration',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/callback',
  '/oauth/token',
]);

const ENTRA_SCOPES = 'openid profile offline_access User.Read';
const MCP_SCOPE = 'mcp';
const MAX_BODY_BYTES = 64 * 1024;

export interface EntraTokens {
  accessToken: string;
  refreshToken?: string;
}

// Seams to Entra/Graph, injectable so the flow is testable without network.
export interface EntraClient {
  authorizeUrl(params: { redirectUri: string; state: string }): string;
  exchangeCode(code: string, redirectUri: string): Promise<EntraTokens | undefined>;
  refresh(refreshToken: string): Promise<EntraTokens | undefined>;
  resolveUserId(accessToken: string): Promise<string | undefined>;
}

export interface OAuthProxyConfig {
  issuer: string; // this server's public base URL
  resource: string; // canonical MCP resource (PRM `resource`)
  keys: OAuthKeys;
  allowedRedirectHosts: Set<string>;
  entra: EntraClient;
}

export function createEntraClient(tenantId: string, clientId: string, clientSecret: string): EntraClient {
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`;
  const tokenRequest = async (params: Record<string, string>): Promise<EntraTokens | undefined> => {
    try {
      const response = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: ENTRA_SCOPES, ...params }),
        signal: AbortSignal.timeout(10000),
      });
      const data = (await response.json()) as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
      if (!response.ok || !data.access_token) {
        console.warn(`[oauth] Entra token request failed: ${data.error ?? response.status} ${data.error_description?.split('\n')[0] ?? ''}`);
        return undefined;
      }
      return { accessToken: data.access_token, refreshToken: data.refresh_token };
    } catch (error) {
      console.warn(`[oauth] Entra token request error: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  return {
    authorizeUrl: ({ redirectUri, state }) =>
      `${base}/authorize?${new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: ENTRA_SCOPES,
        state,
        prompt: 'select_account',
      })}`,
    exchangeCode: (code, redirectUri) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    refresh: (refreshToken) => tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    resolveUserId: getMicrosoftUserIdFromGraph,
  };
}

// Returns undefined (proxy disabled) unless every required setting is present.
export function buildOAuthProxyConfig(options: {
  issuer: string;
  resource: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  signingSecret?: string;
  allowedRedirectHosts: Set<string>;
}): OAuthProxyConfig | undefined {
  const { tenantId, clientId, clientSecret, signingSecret } = options;
  const missing = getMissingProxySettings(options);
  if (!options.issuer || missing.length > 0) {
    warnProxyDisabledOnce(`missing ${missing.join(', ') || 'request host'}`);
    return undefined;
  }
  let keys: OAuthKeys;
  try {
    keys = deriveOAuthKeys(signingSecret!);
  } catch (error) {
    // A bad secret must disable only the proxy, never break /mcp (Claude) on the same request path.
    warnProxyDisabledOnce(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  return {
    issuer: options.issuer,
    resource: options.resource,
    keys,
    allowedRedirectHosts: options.allowedRedirectHosts,
    entra: createEntraClient(tenantId!, clientId!, clientSecret!),
  };
}

// Names (never values) of the env vars the proxy still needs, for the startup diagnostic.
export function getMissingProxySettings(options: { tenantId?: string; clientId?: string; clientSecret?: string; signingSecret?: string }): string[] {
  return [
    ['MCP_AZURE_TENANT_ID', options.tenantId],
    ['MCP_OAUTH_CLIENT_ID', options.clientId],
    ['MCP_OAUTH_CLIENT_SECRET', options.clientSecret],
    ['MCP_OAUTH_SIGNING_SECRET', options.signingSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name as string);
}

// The config is rebuilt per request, so log the reason once per process, not on every hit.
let proxyDisabledWarned = false;
function warnProxyDisabledOnce(reason: string): void {
  if (proxyDisabledWarned) return;
  proxyDisabledWarned = true;
  console.warn(`[oauth] ChatGPT OAuth proxy disabled (${reason}); /mcp-chatgpt falls back to Entra-direct metadata.`);
}

export function getAuthorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
    // RFC 9207: authorization responses carry `iss`, which also lets ChatGPT use its fixed
    // redirect URI (https://chatgpt.com/connector_platform_oauth_redirect).
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}

function normalizeResource(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function isAllowedRedirectUri(uri: string, allowedHosts: Set<string>): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash && allowedHosts.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function sendOAuthJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function sendOAuthError(res: ServerResponse, status: number, error: string, description: string): void {
  sendOAuthJson(res, status, { error, error_description: description });
}

function sendPlainError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readParams(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readBody(req);
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function withQuery(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.toString();
}

// ---- endpoints ----

async function handleRegister(req: IncomingMessage, res: ServerResponse, config: OAuthProxyConfig): Promise<void> {
  if (req.method !== 'POST') return sendOAuthError(res, 405, 'invalid_request', 'Use POST.');
  let body: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return sendOAuthError(res, 400, 'invalid_client_metadata', 'Body must be JSON.');
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    return sendOAuthError(res, 400, 'invalid_redirect_uri', 'Provide 1-10 redirect_uris.');
  }
  const rejected = redirectUris.find((uri) => !isAllowedRedirectUri(uri, config.allowedRedirectHosts));
  if (rejected) return sendOAuthError(res, 400, 'invalid_redirect_uri', `Redirect URI not allowed: ${rejected}`);
  const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : undefined;

  // The client id IS the registration: a signed record of the allowed redirect URIs.
  const clientId = await issueToken(config.keys, 'client', config.issuer, { redirect_uris: redirectUris, ...(clientName ? { client_name: clientName } : {}) });
  sendOAuthJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    ...(clientName ? { client_name: clientName } : {}),
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: MCP_SCOPE,
  });
}

async function verifyClient(config: OAuthProxyConfig, clientId: string | undefined): Promise<string[] | undefined> {
  if (!clientId) return undefined;
  const payload = await verifyToken(config.keys, 'client', clientId, config.issuer);
  const uris = payload?.redirect_uris;
  return Array.isArray(uris) ? uris.filter((u): u is string => typeof u === 'string') : undefined;
}

async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL, config: OAuthProxyConfig): Promise<void> {
  const q = url.searchParams;
  const clientId = q.get('client_id') ?? undefined;
  const redirectUri = q.get('redirect_uri') ?? undefined;
  const state = q.get('state') ?? undefined;

  // Until client + redirect_uri are trusted, never redirect (RFC 6749 §4.1.2.1).
  const registeredUris = await verifyClient(config, clientId);
  if (!registeredUris) return sendPlainError(res, 400, 'Unknown or invalid client_id. Remove and re-add the connector.');
  if (!redirectUri || !registeredUris.includes(redirectUri)) return sendPlainError(res, 400, 'redirect_uri does not match the registered client.');

  const fail = (error: string, description: string) =>
    redirect(res, withQuery(redirectUri, { error, error_description: description, state, iss: config.issuer }));

  if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
  const codeChallenge = q.get('code_challenge');
  if (!codeChallenge || q.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  const resource = q.get('resource');
  if (resource && normalizeResource(resource) !== normalizeResource(config.resource)) return fail('invalid_target', 'Unknown resource.');

  const upstreamState = await issueToken(config.keys, 'state', config.issuer, {
    cid: clientId,
    ruri: redirectUri,
    cc: codeChallenge,
    st: state ?? null,
  });
  redirect(res, config.entra.authorizeUrl({ redirectUri: `${config.issuer}/oauth/callback`, state: upstreamState }));
}

async function handleCallback(req: IncomingMessage, res: ServerResponse, url: URL, config: OAuthProxyConfig): Promise<void> {
  const q = url.searchParams;
  const pending = await verifyToken(config.keys, 'state', q.get('state') ?? '', config.issuer);
  if (!pending || typeof pending.ruri !== 'string' || typeof pending.cid !== 'string' || typeof pending.cc !== 'string') {
    return sendPlainError(res, 400, 'Sign-in session expired or invalid. Start the connection again from ChatGPT.');
  }
  const clientState = typeof pending.st === 'string' ? pending.st : undefined;
  const back = (params: Record<string, string | undefined>) =>
    redirect(res, withQuery(pending.ruri as string, { ...params, state: clientState, iss: config.issuer }));

  const upstreamError = q.get('error');
  if (upstreamError) return back({ error: upstreamError === 'access_denied' ? 'access_denied' : 'server_error', error_description: 'Microsoft sign-in did not complete.' });
  const entraCode = q.get('code');
  if (!entraCode) return back({ error: 'server_error', error_description: 'Microsoft sign-in returned no code.' });

  const entraTokens = await config.entra.exchangeCode(entraCode, `${config.issuer}/oauth/callback`);
  if (!entraTokens) return back({ error: 'server_error', error_description: 'Microsoft token exchange failed.' });
  const userId = await config.entra.resolveUserId(entraTokens.accessToken);
  if (!userId) return back({ error: 'access_denied', error_description: 'Could not resolve the Microsoft account.' });

  const code = await issueToken(config.keys, 'code', config.issuer, {
    sub: userId,
    cid: pending.cid,
    ruri: pending.ruri,
    cc: pending.cc,
    ...(entraTokens.refreshToken ? { ert: entraTokens.refreshToken } : {}),
  });
  back({ code });
}

async function issueTokenPair(config: OAuthProxyConfig, userId: string, clientId: string, entraRefreshToken?: string) {
  const accessToken = await issueToken(config.keys, 'access', config.issuer, { sub: userId, cid: clientId, scope: MCP_SCOPE }, normalizeResource(config.resource));
  const refreshToken = entraRefreshToken
    ? await issueToken(config.keys, 'refresh', config.issuer, { sub: userId, cid: clientId, ert: entraRefreshToken })
    : undefined;
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: MCP_SCOPE,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  };
}

async function handleToken(req: IncomingMessage, res: ServerResponse, config: OAuthProxyConfig): Promise<void> {
  if (req.method !== 'POST') return sendOAuthError(res, 405, 'invalid_request', 'Use POST.');
  let params: Record<string, string>;
  try {
    params = await readParams(req);
  } catch {
    return sendOAuthError(res, 400, 'invalid_request', 'Malformed request body.');
  }
  const clientId = params.client_id;
  if (!(await verifyClient(config, clientId))) return sendOAuthError(res, 401, 'invalid_client', 'Unknown client_id.');
  if (params.resource && normalizeResource(params.resource) !== normalizeResource(config.resource)) {
    return sendOAuthError(res, 400, 'invalid_target', 'Unknown resource.');
  }

  if (params.grant_type === 'authorization_code') {
    const code = await verifyToken(config.keys, 'code', params.code ?? '', config.issuer);
    if (!code || typeof code.sub !== 'string' || typeof code.jti !== 'string' || typeof code.exp !== 'number') {
      return sendOAuthError(res, 400, 'invalid_grant', 'Invalid or expired authorization code.');
    }
    if (code.cid !== clientId || code.ruri !== params.redirect_uri) {
      return sendOAuthError(res, 400, 'invalid_grant', 'Code was issued to a different client or redirect_uri.');
    }
    if (!params.code_verifier || typeof code.cc !== 'string' || !verifyPkceS256(params.code_verifier, code.cc)) {
      return sendOAuthError(res, 400, 'invalid_grant', 'PKCE verification failed.');
    }
    if (!consumeCodeId(code.jti, code.exp)) return sendOAuthError(res, 400, 'invalid_grant', 'Authorization code already used.');
    return sendOAuthJson(res, 200, await issueTokenPair(config, code.sub, clientId, typeof code.ert === 'string' ? code.ert : undefined));
  }

  if (params.grant_type === 'refresh_token') {
    const refresh = await verifyToken(config.keys, 'refresh', params.refresh_token ?? '', config.issuer);
    if (!refresh || typeof refresh.sub !== 'string' || typeof refresh.ert !== 'string' || refresh.cid !== clientId) {
      return sendOAuthError(res, 400, 'invalid_grant', 'Invalid or expired refresh token.');
    }
    // Re-check with Entra on every refresh, so a disabled/removed account or revoked consent
    // stops working within one access-token lifetime.
    const entraTokens = await config.entra.refresh(refresh.ert);
    const userId = entraTokens ? await config.entra.resolveUserId(entraTokens.accessToken) : undefined;
    if (!entraTokens || userId !== refresh.sub) {
      return sendOAuthError(res, 400, 'invalid_grant', 'Microsoft session is no longer valid. Reconnect the connector.');
    }
    return sendOAuthJson(res, 200, await issueTokenPair(config, userId, clientId, entraTokens.refreshToken ?? refresh.ert));
  }

  return sendOAuthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
}

// Handles an OAuth-proxy path. With the proxy unconfigured, these paths answer 404/503 so
// clients fall back cleanly and nothing is half-enabled.
export async function handleOAuthRequest(req: IncomingMessage, res: ServerResponse, url: URL, config: OAuthProxyConfig | undefined): Promise<void> {
  const isMetadata = url.pathname.includes('/.well-known/');
  if (!config) {
    return isMetadata ? sendOAuthJson(res, 404, { error: 'not_found' }) : sendOAuthError(res, 503, 'temporarily_unavailable', 'OAuth is not configured on this server.');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
    });
    res.end();
    return;
  }
  try {
    if (isMetadata) return sendOAuthJson(res, 200, getAuthorizationServerMetadata(config.issuer));
    if (url.pathname === '/oauth/register') return await handleRegister(req, res, config);
    if (url.pathname === '/oauth/authorize') return await handleAuthorize(req, res, url, config);
    if (url.pathname === '/oauth/callback') return await handleCallback(req, res, url, config);
    if (url.pathname === '/oauth/token') return await handleToken(req, res, config);
    sendOAuthJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(`[oauth] ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) sendOAuthError(res, 500, 'server_error', 'Internal error.');
  }
}

// Bearer check for /mcp-chatgpt: returns the user id for a valid proxy-issued access token.
export async function resolveUserIdFromProxyAccessToken(config: OAuthProxyConfig | undefined, token: string | undefined): Promise<string | undefined> {
  if (!config || !token) return undefined;
  const payload = await verifyToken(config.keys, 'access', token, config.issuer, normalizeResource(config.resource));
  return typeof payload?.sub === 'string' && payload.sub ? payload.sub : undefined;
}
