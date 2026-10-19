import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'npm:jose@6.2.10';
import { handleSupabaseTokenRequest } from './handler.ts';

// Real RSA/HMAC operations; only Graph/JWKS HTTP responses are synthetic.
const tenantId = '11111111-1111-4111-8111-111111111111';
const objectId = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const clientId = '44444444-4444-4444-8444-444444444444';
const secret = 'synthetic-server-key-for-offline-test-only';
const keys = await generateKeyPair('RS256');
const forgedKeys = await generateKeyPair('RS256');
const publicJwk = { ...await exportJWK(keys.publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
const now = Math.floor(Date.now() / 1000);
const externalTenantId = '99999999-9999-4999-8999-999999999999';
// ALLOWED_EMAIL_DOMAINS stays set in every case: it must have no effect (security review
// 2026-10-15). The spoofed profiles below claim a mail in exactly that domain.
function configure(enabled = 'true', requireIdToken = 'false', requireKnownClient = 'false') {
  for (const [key, value] of Object.entries({
    MEETING_KNOWLEDGE_VERIFY_IDENTITY: enabled, ALLOWED_MS_TENANT_IDS: tenantId,
    ALLOWED_EMAIL_DOMAINS: 'tecace.com', MS_ID_TOKEN_CLIENT_IDS: clientId, MSAL_CLIENT_ID: '',
    SUPABASE_JWT_SECRET: secret, JWT_SECRET: '', SUPABASE_TOKEN_REQUIRE_ID_TOKEN: requireIdToken,
    MS_TOKEN_REQUIRE_KNOWN_CLIENT: requireKnownClient, MS_KNOWN_CLIENT_IDS: '',
  })) Deno.env.set(key, value);
}
// JWT-shaped Graph access tokens. Their signatures are never checked locally: in production
// Graph /me verifies them, here the Graph mock below accepts exactly these strings.
function graphToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.synthetic-signature`;
}
const memberGraphToken = graphToken({ tid: tenantId, oid: objectId });
const outsiderObjectId = '77777777-7777-4777-8777-777777777777';
const externalGraphToken = graphToken({ tid: externalTenantId, oid: outsiderObjectId });
const opaqueGraphToken = 'EwBwA8l6BAAUopaque-personal-account-token';
const otherAppId = '55555555-5555-4555-8555-555555555555';
const knownAppGraphToken = graphToken({ tid: tenantId, oid: objectId, azp: clientId });
const foreignAppGraphToken = graphToken({ tid: tenantId, oid: objectId, appid: otherAppId });
const oidMismatchGraphToken = graphToken({ tid: tenantId, oid: outsiderObjectId });
const nonUuidGraphToken = graphToken({ tid: tenantId });
const timeoutGraphToken = graphToken({ tid: tenantId, oid: objectId, note: 'graph-times-out' });
const graphProfiles = new Map<string, Record<string, unknown>>([
  [memberGraphToken, { id: objectId.toUpperCase(), mail: 'synthetic@example.test', displayName: 'Synthetic' }],
  // nOAuth: an outside tenant admin set the user's mail to an address in the allowlisted domain.
  [externalGraphToken, { id: outsiderObjectId, mail: 'hansoo@tecace.com', displayName: 'Hansoo Lee' }],
  [opaqueGraphToken, { id: outsiderObjectId, mail: null, userPrincipalName: 'hansoo@tecace.com', displayName: 'Hansoo Lee' }],
  [knownAppGraphToken, { id: objectId, mail: 'synthetic@example.test', displayName: 'Synthetic' }],
  [foreignAppGraphToken, { id: objectId, mail: 'synthetic@example.test', displayName: 'Synthetic' }],
  // Graph says objectId, the token claims another oid: never bound.
  [oidMismatchGraphToken, { id: objectId, mail: 'synthetic@example.test', displayName: 'Synthetic' }],
  [nonUuidGraphToken, { id: '0123456789abcdef', mail: 'msa@example.test', displayName: 'MSA' }],
]);
let graphCalls = 0;
async function idToken(changes: Record<string, unknown> = {}, forged = false) {
  return new SignJWT({
    iss: `https://login.microsoftonline.com/${tenantId}/v2.0`, aud: clientId,
    tid: tenantId, oid: objectId, sub: 'synthetic-oidc-subject',
    iat: now, nbf: now, exp: now + 1500, ...changes,
  }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .sign(forged ? forgedKeys.privateKey : keys.privateKey);
}
function request(id?: string, accessToken = memberGraphToken) {
  return new Request('https://edge.example.test/supabase-token', {
    method: 'POST', headers: { 'x-ms-access-token': accessToken,
      ...(id === undefined ? {} : { 'x-ms-id-token': id }) },
  });
}
async function exchange(input: Request) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value === `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`) {
      return Promise.resolve(Response.json({ keys: [publicJwk] }));
    }
    if (value.startsWith('https://graph.microsoft.com/v1.0/me?')) {
      graphCalls += 1;
      const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (bearer === timeoutGraphToken) {
        return Promise.reject(new DOMException('The signal has been aborted', 'TimeoutError'));
      }
      const profile = graphProfiles.get(bearer);
      return Promise.resolve(profile
        ? Response.json(profile)
        : new Response('private Microsoft error', { status: 401 }));
    }
    throw new Error('Unexpected network request in offline test');
  }) as typeof fetch;
  try { return await handleSupabaseTokenRequest(input); }
  finally { globalThis.fetch = realFetch; }
}
async function signedPayload(response: Response) {
  const body = await response.json();
  const { payload } = await jwtVerify(body.access_token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'], issuer: 'meeting-note', audience: 'authenticated',
  });
  return { body, payload };
}

Deno.test('verified exchange signs normalized identity and bounds Supabase expiry to the ID token', async () => {
  configure();
  const response = await exchange(request(await idToken()));
  assert.equal(response.status, 200);
  const { body, payload } = await signedPayload(response);
  assert.equal(payload.sub, objectId);
  assert.deepEqual(payload.app_metadata, { meeting_knowledge_identity: { tenantId, objectId, verified: true } });
  assert.equal(payload.exp, now + 1500);
  assert.equal(body.expires_at, payload.exp);
});

for (const name of ['flag-disabled', 'legacy-without-id-token'] as const) {
  Deno.test(`${name} cannot acquire verified knowledge metadata`, async () => {
    configure(name === 'flag-disabled' ? 'false' : 'true');
    const response = await exchange(request(name === 'flag-disabled' ? 'intentionally-invalid' : undefined));
    assert.equal(response.status, 200);
    const { payload } = await signedPayload(response);
    assert.equal(payload.app_metadata, undefined);
    assert.equal(payload.sub, objectId.toUpperCase());
  });
}

for (const name of ['forged-signature', 'wrong-audience', 'wrong-object', 'wrong-tenant', 'expired'] as const) {
  Deno.test(`${name} fails without issuing a weaker login token`, async () => {
    configure();
    const changes = name === 'wrong-audience' ? { aud: tenantId }
      : name === 'wrong-object' ? { oid: tenantId }
      : name === 'wrong-tenant' ? { tid: clientId }
      : name === 'expired' ? { exp: now - 1 } : {};
    const response = await exchange(request(await idToken(changes, name === 'forged-signature')));
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.access_token, undefined);
    assert.equal(body.error, 'Microsoft identity verification failed.');
  });
}

for (const [name, accessToken] of [['external-tenant', externalGraphToken], ['opaque-personal', opaqueGraphToken]] as const) {
  Deno.test(`${name} token with an allowlisted-domain mail is denied (no email-domain fallback)`, async () => {
    configure('false');
    const response = await exchange(request(undefined, accessToken));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.access_token, undefined);
  });
}

Deno.test('external tenant cannot pass by sending a member ID token for another user', async () => {
  configure();
  const response = await exchange(request(await idToken(), externalGraphToken));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).access_token, undefined);
});

Deno.test('an empty tenant allowlist fails closed even when ALLOWED_EMAIL_DOMAINS is set', async () => {
  configure('false');
  Deno.env.set('ALLOWED_MS_TENANT_IDS', '');
  const response = await exchange(request());
  assert.equal(response.status, 500);
  assert.equal((await response.json()).access_token, undefined);
});

Deno.test('require-ID-token flag blocks legacy exchanges before any Graph call', async () => {
  configure('true', 'true');
  graphCalls = 0;
  const response = await exchange(request());
  assert.equal(response.status, 401);
  assert.equal((await response.json()).access_token, undefined);
  assert.equal(graphCalls, 0);
});

Deno.test('require-ID-token flag still accepts a verified ID token', async () => {
  configure('true', 'true');
  const response = await exchange(request(await idToken()));
  assert.equal(response.status, 200);
  const { payload } = await signedPayload(response);
  assert.deepEqual(payload.app_metadata, { meeting_knowledge_identity: { tenantId, objectId, verified: true } });
});

Deno.test('require-ID-token flag without ID-token verification fails closed', async () => {
  configure('false', 'true');
  const response = await exchange(request(await idToken()));
  assert.equal(response.status, 503);
});

async function captureInfo<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const realInfo = console.info;
  const lines: string[] = [];
  console.info = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { return { result: await run(), lines }; }
  finally { console.info = realInfo; }
}

Deno.test('a token whose oid differs from the Graph id is rejected', async () => {
  configure('false');
  const response = await exchange(request(undefined, oidMismatchGraphToken));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).access_token, undefined);
});

Deno.test('a non-UUID Graph id (personal account) is rejected', async () => {
  configure('false');
  const response = await exchange(request(undefined, nonUuidGraphToken));
  assert.equal(response.status, 401);
});

Deno.test('a Graph timeout is a 503, not a sign-out', async () => {
  configure('false');
  const response = await exchange(request(undefined, timeoutGraphToken));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).access_token, undefined);
});

Deno.test('unknown appid is logged without its value and still allowed by default', async () => {
  configure('false');
  const { result, lines } = await captureInfo(() => exchange(request(undefined, foreignAppGraphToken)));
  assert.equal(result.status, 200);
  const line = lines.find((entry) => entry.includes('ms_token_client_check'));
  assert.ok(line);
  assert.deepEqual(JSON.parse(line!), { event: 'ms_token_client_check', reason: 'unknown_client', client: 'other', knownClient: false, enforced: false });
  assert.ok(!lines.join(' ').includes(otherAppId));
});

Deno.test('MS_TOKEN_REQUIRE_KNOWN_CLIENT blocks an unknown appid and passes the app registration', async () => {
  configure('false', 'false', 'true');
  const denied = await captureInfo(() => exchange(request(undefined, foreignAppGraphToken)));
  assert.equal(denied.result.status, 403);
  const known = await captureInfo(() => exchange(request(undefined, knownAppGraphToken)));
  assert.equal(known.result.status, 200);
  assert.ok(!known.lines.some((entry) => entry.includes('ms_token_client_check')));
  Deno.env.set('MS_ID_TOKEN_CLIENT_IDS', '');
  const unconfigured = await captureInfo(() => exchange(request(undefined, knownAppGraphToken)));
  assert.equal(unconfigured.result.status, 500);
});

Deno.test('enabled but missing audience configuration fails before Graph lookup', async () => {
  configure();
  Deno.env.set('MS_ID_TOKEN_CLIENT_IDS', '');
  const response = await handleSupabaseTokenRequest(request());
  assert.equal(response.status, 503);
});

Deno.test('CORS permits the new ID-token header and rejects unsupported methods', async () => {
  const options = await handleSupabaseTokenRequest(new Request('https://edge.example.test', { method: 'OPTIONS' }));
  assert.equal(options.status, 200);
  assert.ok(options.headers.get('Access-Control-Allow-Headers')?.includes('x-ms-id-token'));
  assert.equal((await handleSupabaseTokenRequest(new Request('https://edge.example.test'))).status, 405);
});

Deno.test('Graph rejection never echoes a raw upstream error or mints a token', async () => {
  configure('false');
  const input = new Request('https://edge.example.test', { method: 'POST', headers: { 'x-ms-access-token': 'wrong' } });
  const response = await exchange(input);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.access_token, undefined);
  assert.ok(!JSON.stringify(body).includes('private Microsoft error'));
});
