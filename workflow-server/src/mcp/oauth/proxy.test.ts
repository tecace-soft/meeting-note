import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { handleOAuthRequest, isAllowedRedirectUri, resolveUserIdFromProxyAccessToken, type EntraClient, type OAuthProxyConfig } from './proxy.js';
import { deriveOAuthKeys, issueToken, verifyPkceS256, verifyToken } from './tokens.js';

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const VERIFIER = 'a'.repeat(43) + '-verifier_123';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function fakeEntra(overrides: Partial<EntraClient> = {}): EntraClient {
  return {
    authorizeUrl: ({ redirectUri, state }) => `https://login.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`,
    exchangeCode: async (code) => (code === 'entra-code' ? { accessToken: 'graph-at', refreshToken: 'entra-rt-1' } : undefined),
    refresh: async (rt) => (rt.startsWith('entra-rt') ? { accessToken: 'graph-at', refreshToken: 'entra-rt-2' } : undefined),
    resolveUserId: async (at) => (at === 'graph-at' ? 'oid-alice' : undefined),
    ...overrides,
  };
}

async function startServer(makeConfig: (base: string) => OAuthProxyConfig | undefined): Promise<{ base: string; server: Server; config: () => OAuthProxyConfig | undefined }> {
  // eslint-disable-next-line prefer-const -- the server closure below captures config before it is assigned (needs base, resolved after listen), so const is not viable.
  let config: OAuthProxyConfig | undefined;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void handleOAuthRequest(req, res, url, config);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config = makeConfig(base);
  return { base, server, config: () => config };
}

function proxyConfig(base: string, entra = fakeEntra()): OAuthProxyConfig {
  return {
    issuer: base,
    resource: `${base}/mcp-chatgpt`,
    keys: deriveOAuthKeys('x'.repeat(40)),
    allowedRedirectHosts: new Set(['chatgpt.com']),
    entra,
  };
}

async function register(base: string, redirectUris = [REDIRECT]) {
  const response = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: 'ChatGPT' }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// Walks authorize → (fake) Entra → callback and returns the code ChatGPT would receive.
async function obtainCode(base: string, clientId: string, extra: Record<string, string> = {}): Promise<URL> {
  const authorize = new URL(`${base}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE,
    code_challenge_method: 'S256', state: 'chatgpt-state', resource: `${base}/mcp-chatgpt`, scope: 'mcp', ...extra,
  })) authorize.searchParams.set(k, v);
  const toEntra = await fetch(authorize, { redirect: 'manual' });
  assert.equal(toEntra.status, 302);
  const entraUrl = new URL(toEntra.headers.get('location') ?? '');
  assert.equal(entraUrl.searchParams.get('redirect_uri'), `${base}/oauth/callback`);
  const callback = new URL(`${base}/oauth/callback`);
  callback.searchParams.set('code', 'entra-code');
  callback.searchParams.set('state', entraUrl.searchParams.get('state') ?? '');
  const toClient = await fetch(callback, { redirect: 'manual' });
  assert.equal(toClient.status, 302);
  return new URL(toClient.headers.get('location') ?? '');
}

async function token(base: string, params: Record<string, string>) {
  const response = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

test('metadata advertises DCR, S256 and iss support', async () => {
  const { base, server } = await startServer(proxyConfig);
  try {
    const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(meta.issuer, base);
    assert.equal(meta.registration_endpoint, `${base}/oauth/register`);
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    assert.equal(meta.authorization_response_iss_parameter_supported, true);
  } finally {
    server.close();
  }
});

test('full flow: register → authorize → callback → token → refresh → bearer resolves the user', async () => {
  const { base, server, config } = await startServer(proxyConfig);
  try {
    const reg = await register(base);
    assert.equal(reg.status, 201);
    const clientId = reg.body.client_id as string;

    const back = await obtainCode(base, clientId);
    assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
    assert.equal(back.searchParams.get('state'), 'chatgpt-state');
    assert.equal(back.searchParams.get('iss'), base);
    const code = back.searchParams.get('code') ?? '';

    const tokens = await token(base, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: `${base}/mcp-chatgpt` });
    assert.equal(tokens.status, 200);
    assert.equal(tokens.body.token_type, 'Bearer');
    assert.equal(await resolveUserIdFromProxyAccessToken(config(), tokens.body.access_token), 'oid-alice');

    // Code is single-use.
    const replay = await token(base, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    assert.equal(replay.body.error, 'invalid_grant');

    const refreshed = await token(base, { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: clientId });
    assert.equal(refreshed.status, 200);
    assert.equal(await resolveUserIdFromProxyAccessToken(config(), refreshed.body.access_token), 'oid-alice');
  } finally {
    server.close();
  }
});

test('token endpoint rejects a wrong PKCE verifier and a code bound to another redirect', async () => {
  const { base, server } = await startServer(proxyConfig);
  try {
    const clientId = (await register(base)).body.client_id as string;
    const code1 = (await obtainCode(base, clientId)).searchParams.get('code') ?? '';
    const badPkce = await token(base, { grant_type: 'authorization_code', code: code1, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'b'.repeat(50) });
    assert.equal(badPkce.body.error, 'invalid_grant');
    const code2 = (await obtainCode(base, clientId)).searchParams.get('code') ?? '';
    const badRedirect = await token(base, { grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: 'https://chatgpt.com/other', code_verifier: VERIFIER });
    assert.equal(badRedirect.body.error, 'invalid_grant');
  } finally {
    server.close();
  }
});

test('DCR rejects redirect URIs outside the allowlist; authorize rejects forged clients without redirecting', async () => {
  const { base, server } = await startServer(proxyConfig);
  try {
    assert.equal((await register(base, ['https://evil.example/cb'])).status, 400);
    assert.equal((await register(base, ['http://chatgpt.com/cb'])).status, 400);
    const forged = await fetch(`${base}/oauth/authorize?client_id=forged&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code`, { redirect: 'manual' });
    assert.equal(forged.status, 400);
    const clientId = (await register(base)).body.client_id as string;
    const otherRedirect = await fetch(`${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://chatgpt.com/x')}&response_type=code`, { redirect: 'manual' });
    assert.equal(otherRedirect.status, 400);
  } finally {
    server.close();
  }
});

test('authorize requires S256 PKCE and the right resource (errors go back to the client)', async () => {
  const { base, server } = await startServer(proxyConfig);
  try {
    const clientId = (await register(base)).body.client_id as string;
    const noPkce = await fetch(`${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&state=s`, { redirect: 'manual' });
    assert.equal(noPkce.status, 302);
    assert.equal(new URL(noPkce.headers.get('location') ?? '').searchParams.get('error'), 'invalid_request');
    const wrongResource = await fetch(`${base}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256&resource=${encodeURIComponent('https://other.example/mcp')}`, { redirect: 'manual' });
    assert.equal(new URL(wrongResource.headers.get('location') ?? '').searchParams.get('error'), 'invalid_target');
  } finally {
    server.close();
  }
});

test('refresh fails once Entra no longer accepts the refresh token', async () => {
  const entra = fakeEntra();
  const { base, server } = await startServer((b) => proxyConfig(b, entra));
  try {
    const clientId = (await register(base)).body.client_id as string;
    const code = (await obtainCode(base, clientId)).searchParams.get('code') ?? '';
    const tokens = await token(base, { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER });
    entra.refresh = async () => undefined; // account disabled / consent revoked
    const refreshed = await token(base, { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: clientId });
    assert.equal(refreshed.body.error, 'invalid_grant');
  } finally {
    server.close();
  }
});

test('unconfigured proxy answers 503/404 instead of half-working', async () => {
  const { base, server } = await startServer(() => undefined);
  try {
    assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
    assert.equal((await fetch(`${base}/oauth/register`, { method: 'POST' })).status, 503);
  } finally {
    server.close();
  }
});

// ---- token primitives ----

test('tokens of one kind cannot be used as another, and audience is enforced', async () => {
  const keys = deriveOAuthKeys('y'.repeat(40));
  const access = await issueToken(keys, 'access', 'https://iss', { sub: 'u' }, 'https://iss/mcp-chatgpt');
  assert.equal((await verifyToken(keys, 'access', access, 'https://iss', 'https://iss/mcp-chatgpt'))?.sub, 'u');
  assert.equal(await verifyToken(keys, 'client', access, 'https://iss'), undefined);
  assert.equal(await verifyToken(keys, 'access', access, 'https://iss', 'https://iss/other'), undefined);
  assert.equal(await verifyToken(deriveOAuthKeys('z'.repeat(40)), 'access', access, 'https://iss', 'https://iss/mcp-chatgpt'), undefined);
  assert.throws(() => deriveOAuthKeys('short'));
});

test('PKCE S256 and redirect allowlist helpers', () => {
  assert.equal(verifyPkceS256(VERIFIER, CHALLENGE), true);
  assert.equal(verifyPkceS256('short', CHALLENGE), false);
  assert.equal(isAllowedRedirectUri(REDIRECT, new Set(['chatgpt.com'])), true);
  assert.equal(isAllowedRedirectUri('https://chatgpt.com.evil.example/cb', new Set(['chatgpt.com'])), false);
});

test('a too-short signing secret disables the proxy instead of throwing', async () => {
  const { buildOAuthProxyConfig } = await import('./proxy.js');
  const config = buildOAuthProxyConfig({ issuer: 'https://x', resource: 'https://x/mcp-chatgpt', tenantId: 't', clientId: 'c', clientSecret: 's', signingSecret: 'short', allowedRedirectHosts: new Set() });
  assert.equal(config, undefined);
});

test('missing-settings diagnostic names only the absent env vars', async () => {
  const { getMissingProxySettings } = await import('./proxy.js');
  assert.deepEqual(getMissingProxySettings({ tenantId: 't', clientId: 'c' }), ['MCP_OAUTH_CLIENT_SECRET', 'MCP_OAUTH_SIGNING_SECRET']);
  assert.deepEqual(getMissingProxySettings({ tenantId: 't', clientId: 'c', clientSecret: 's', signingSecret: 'x' }), []);
});
