import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'npm:jose@6.2.10';
import {
  MicrosoftIdentityVerificationError,
  readMicrosoftIdentityVerificationConfig,
  verifyMicrosoftIdentityForExchange,
} from './verified-microsoft-identity.ts';

// All IDs, claims, and keys in this file are synthetic. No live credentials/JWKS are needed.
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const NOW = 1_800_000_000;
const config = { enabled: true, allowedTenantIds: [TENANT], clientIds: [CLIENT] };
const keys = await generateKeyPair('RS256');
const forgedKeys = await generateKeyPair('RS256');
const options = { keyResolver: () => keys.publicKey, currentDate: new Date(NOW * 1_000) };
const baseClaims = {
  tid: TENANT,
  oid: OBJECT_ID,
  iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  aud: CLIENT,
  exp: NOW + 60,
  iat: NOW - 60,
  nbf: NOW - 60,
};

async function token(changes: Record<string, unknown> = {}, forged = false): Promise<string> {
  return new SignJWT({ ...baseClaims, ...changes }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .sign(forged ? forgedKeys.privateKey : keys.privateKey);
}

async function rejectsIdentity(value: string, graphId = OBJECT_ID): Promise<void> {
  await assert.rejects(
    verifyMicrosoftIdentityForExchange(config, value, graphId, options),
    (error: unknown) => error instanceof MicrosoftIdentityVerificationError && error.status === 401,
  );
}

Deno.test('verified RS256 identity binds signed tenant/oid to Graph /me and returns expiry', async () => {
  assert.deepEqual(await verifyMicrosoftIdentityForExchange(config, await token(), OBJECT_ID, options), {
    identity: { tenantId: TENANT, objectId: OBJECT_ID, verified: true },
    idTokenExpiresAt: NOW + 60,
  });
});

Deno.test('valid oid binds case-insensitively to the Graph UUID', async () => {
  const objectId = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
  assert.equal((await verifyMicrosoftIdentityForExchange(
    config, await token({ oid: objectId.toUpperCase() }), objectId, options,
  ))?.identity.objectId, objectId);
});

Deno.test('forged signature cannot mint a verified identity', async () => {
  await rejectsIdentity(await token({}, true));
});

for (const [name, claims] of Object.entries({
  'wrong app audience': { aud: '55555555-5555-4555-8555-555555555555' },
  'array audience': { aud: [CLIENT] },
  'token-controlled issuer': { iss: 'https://attacker.invalid/v2.0' },
  'other tenant issuer': { iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` },
  'v1 issuer': { iss: `https://sts.windows.net/${TENANT}/` },
  'disallowed tenant': { tid: OTHER_TENANT },
  'unsafe tenant route': { tid: '../common?url=https://attacker.invalid' },
  'oid mismatch': { oid: '66666666-6666-4666-8666-666666666666' },
  'name as oid': { oid: 'Synthetic Person' },
  'expired token': { exp: NOW },
  'future nbf': { nbf: NOW + 1 },
  'future iat': { iat: NOW + 1 },
  'stale identity': { iat: NOW - 7_201 },
  'exp missing': { exp: undefined },
  'nbf missing': { nbf: undefined },
  'iat missing': { iat: undefined },
  'oid missing': { oid: undefined },
  'tid missing': { tid: undefined },
  'string exp': { exp: String(NOW + 60) },
  'fractional iat': { iat: NOW - 0.5 },
  'invalid lifetime': { iat: NOW, exp: NOW - 1 },
})) {
  Deno.test(`rejects ${name}`, async () => {
    await rejectsIdentity(await token(claims));
  });
}

Deno.test('Graph id must be a UUID even with a valid token', async () => {
  await rejectsIdentity(await token(), 'Synthetic Person');
});

Deno.test('untrusted tenant never invokes a key resolver', async () => {
  let calls = 0;
  await assert.rejects(verifyMicrosoftIdentityForExchange(
    config, await token({ tid: OTHER_TENANT }), OBJECT_ID,
    { ...options, keyResolver: () => { calls += 1; return keys.publicKey; } },
  ));
  assert.equal(calls, 0);
});

Deno.test('token jku cannot choose a JWKS endpoint', async () => {
  const value = await new SignJWT(baseClaims)
    .setProtectedHeader({ alg: 'RS256', jku: 'https://attacker.invalid/keys' }).sign(keys.privateKey);
  assert.equal((await verifyMicrosoftIdentityForExchange(config, value, OBJECT_ID, options))?.identity.verified, true);
});

Deno.test('rejects HS256 even with matching payload', async () => {
  const value = await new SignJWT(baseClaims).setProtectedHeader({ alg: 'HS256' })
    .sign(new Uint8Array(32));
  await rejectsIdentity(value);
});

Deno.test('rejects malformed, empty, unsigned and oversized provided tokens', async () => {
  const valid = await token();
  for (const value of ['', 'opaque', valid.split('.').slice(0, 2).join('.'),
    `${valid.split('.')[0]}.${valid.split('.')[1]}.`, 'a'.repeat(16_385)]) {
    await rejectsIdentity(value);
  }
});

Deno.test('legacy missing token yields no verified identity', async () => {
  assert.equal(await verifyMicrosoftIdentityForExchange(config, null, OBJECT_ID, options), null);
});

Deno.test('disabled feature ignores supplied tokens without minting verified identity', async () => {
  assert.equal(await verifyMicrosoftIdentityForExchange(
    { enabled: false, allowedTenantIds: [], clientIds: [] }, 'invalid', OBJECT_ID, options,
  ), null);
});

Deno.test('enabled misconfiguration fails 503 even when token is missing', async () => {
  for (const badConfig of [
    { ...config, clientIds: [] }, { ...config, allowedTenantIds: [] },
    { ...config, clientIds: ['not-an-app-id'] }, { ...config, allowedTenantIds: ['common'] },
  ]) {
    await assert.rejects(verifyMicrosoftIdentityForExchange(badConfig, null, OBJECT_ID, options),
      (error: unknown) => error instanceof MicrosoftIdentityVerificationError && error.status === 503);
  }
});

Deno.test('configuration is explicitly opt-in and accepts only configured app IDs', () => {
  assert.equal(readMicrosoftIdentityVerificationConfig(() => undefined).enabled, false);
  const env: Record<string, string> = {
    MEETING_KNOWLEDGE_VERIFY_IDENTITY: 'true', ALLOWED_MS_TENANT_IDS: TENANT, MSAL_CLIENT_ID: CLIENT,
  };
  assert.deepEqual(readMicrosoftIdentityVerificationConfig((name) => env[name]), config);
  delete env.MSAL_CLIENT_ID;
  assert.throws(() => readMicrosoftIdentityVerificationConfig((name) => env[name]),
    (error: unknown) => error instanceof MicrosoftIdentityVerificationError && error.status === 503);
});
