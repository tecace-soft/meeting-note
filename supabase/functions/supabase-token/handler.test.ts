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
function configure(enabled = 'true') {
  for (const [key, value] of Object.entries({
    MEETING_KNOWLEDGE_VERIFY_IDENTITY: enabled, ALLOWED_MS_TENANT_IDS: tenantId,
    ALLOWED_EMAIL_DOMAINS: 'example.test', MS_ID_TOKEN_CLIENT_IDS: clientId, MSAL_CLIENT_ID: '',
    SUPABASE_JWT_SECRET: secret, JWT_SECRET: '',
  })) Deno.env.set(key, value);
}
async function idToken(changes: Record<string, unknown> = {}, forged = false) {
  return new SignJWT({
    iss: `https://login.microsoftonline.com/${tenantId}/v2.0`, aud: clientId,
    tid: tenantId, oid: objectId, sub: 'synthetic-oidc-subject',
    iat: now, nbf: now, exp: now + 1500, ...changes,
  }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .sign(forged ? forgedKeys.privateKey : keys.privateKey);
}
function request(id?: string) {
  return new Request('https://edge.example.test/supabase-token', {
    method: 'POST', headers: { 'x-ms-access-token': 'synthetic-graph-token',
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
      const authorized = new Headers(init?.headers).get('authorization') === 'Bearer synthetic-graph-token';
      return Promise.resolve(authorized
        ? Response.json({ id: objectId.toUpperCase(), mail: 'synthetic@example.test', displayName: 'Synthetic' })
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
