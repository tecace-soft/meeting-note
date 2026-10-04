import assert from 'node:assert/strict';
import test from 'node:test';
import { SignJWT } from 'jose';
import { verifyMeetingNoteIdentity } from './identity.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const objectId = '22222222-2222-4222-8222-222222222222';
const signingSecret = 'synthetic-local-test-key-with-32-bytes';
const options = { signingSecret, allowedTenantIds: [tenantId], currentDate: new Date('2026-10-04T00:00:00Z') };
const now = Math.floor(options.currentDate.getTime() / 1000);
const identity = { tenantId, objectId, verified: true };
async function token(overrides: Record<string, unknown> = {}, key = signingSecret) {
  return new SignJWT({
    iss: 'meeting-note', aud: 'authenticated', sub: objectId, iat: now, exp: now + 1800,
    role: 'authenticated', app_metadata: { meeting_knowledge_identity: identity }, ...overrides,
  }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(key));
}

test('resolves only a signed, verified, allowlisted tenant/object identity', async () => {
  assert.deepEqual(await verifyMeetingNoteIdentity(await token(), options), {
    authenticated: true, identity: { tenantId, objectId },
  });
});

for (const [name, overrides] of [
  ['wrong issuer', { iss: 'supabase' }], ['wrong audience', { aud: 'another-app' }],
  ['service role', { role: 'service_role' }], ['expired', { exp: now - 1 }],
  ['missing expiry', { exp: undefined }], ['missing issue time', { iat: undefined }],
  ['old issue time', { iat: now - 7200 }], ['future issue time', { iat: now + 120 }],
  ['name subject', { sub: 'Speaker A' }], ['different subject', { sub: tenantId }],
  ['old token', { app_metadata: undefined }],
  ['user-editable metadata', { app_metadata: undefined, user_metadata: { meeting_knowledge_identity: identity } }],
  ['unverified identity', { app_metadata: { meeting_knowledge_identity: { ...identity, verified: false } } }],
  ['foreign tenant', { app_metadata: { meeting_knowledge_identity: { ...identity, tenantId: objectId } } }],
] as const) {
  test(`rejects ${name} even with a valid server signature`, async () => {
    assert.equal((await verifyMeetingNoteIdentity(await token(overrides), options)).authenticated, false);
  });
}

test('rejects a forged signature and does not echo token content', async () => {
  const forged = await token({}, 'other-synthetic-key-with-at-least-32-bytes');
  const result = await verifyMeetingNoteIdentity(forged, options);
  assert.equal(result.authenticated, false);
  assert.ok(!JSON.stringify(result).includes(forged));
});

test('fails closed on absent or unsafe server configuration', async () => {
  for (const config of [{ ...options, signingSecret: '' }, { ...options, allowedTenantIds: [] },
    { ...options, allowedTenantIds: ['common'] }]) {
    assert.deepEqual(await verifyMeetingNoteIdentity(await token(), config), {
      authenticated: false, errorCode: 'IDENTITY_CONFIG_UNAVAILABLE',
    });
  }
});
