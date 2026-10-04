import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { SignJWT } from 'jose';
import { createMeetingKnowledgeHttpHandler, type MeetingKnowledgeHttpEnvironment, type MeetingKnowledgeHttpStore } from './http.js';
import type { MeetingSourceAccessRecord } from './source-access.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const objectId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const otherTenant = '44444444-4444-4444-8444-444444444444';
const key = 'synthetic-server-key-not-a-production-secret';
const signingSecret = 'synthetic-jwt-key-not-a-production-secret';
const identity = { tenantId, objectId };
const owner = { tenantId, objectId: ownerId };
const binding = { tenantId, objectId, sourceId: 'synthetic-note', contentRevision: 1,
  speakerRevision: 1, accessRevision: 1, sourceHash: 'a'.repeat(64), integrationGeneration: 1 };
const current = (): MeetingSourceAccessRecord => ({ ...binding, owner,
  ownerIdentityVerified: true, active: true, integrationEnabled: true,
  directShares: [identity], confirmedParticipants: [], denies: [], noteProjectIds: [], projects: [] });
const environment = (): MeetingKnowledgeHttpEnvironment => ({
  MEETING_KNOWLEDGE_ACCESS_ENABLED: 'true', MEETING_KNOWLEDGE_ACCESS_KEY: key,
  MEETING_KNOWLEDGE_TENANT_ID: tenantId, MEETING_KNOWLEDGE_MANAGEMENT_ENABLED: 'true',
  SUPABASE_JWT_SECRET: signingSecret, ALLOWED_MS_TENANT_IDS: tenantId,
  APP_FRONTEND_ORIGIN: 'https://synthetic.example.test',
});
async function token(legacy = false, secret = signingSecret): Promise<string> {
  return new SignJWT({ role: 'authenticated', ...(legacy ? {} : {
    app_metadata: { meeting_knowledge_identity: { ...owner, verified: true } },
  }) }).setProtectedHeader({ alg: 'HS256' }).setSubject(ownerId).setIssuer('meeting-note')
    .setAudience('authenticated').setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}
async function fixture(run: (base: string, calls: unknown[], record: MeetingSourceAccessRecord) => Promise<void>,
  config: MeetingKnowledgeHttpEnvironment = environment(), failure?: string) {
  const calls: unknown[] = [];
  const record = current();
  const store: MeetingKnowledgeHttpStore = {
    async loadCurrentSource(tenant, source) { calls.push(['load', tenant, source]); if (failure) throw new Error('synthetic-private-db-detail'); return record; },
    async initialize(actor, source) { calls.push(['initialize', actor, source]); if (failure) throw { code: failure, message: 'synthetic-private-db-detail' }; return record; },
    async mutate(actor, command) { calls.push(['mutate', actor, command]); if (failure) throw { code: failure, message: 'synthetic-private-db-detail' }; return record; },
  };
  const handler = createMeetingKnowledgeHttpHandler(store, config);
  const server = createServer((req, res) => { void handler(req, res, new URL(req.url!, 'http://localhost')).then(handled => {
    if (!handled) { res.writeHead(404); res.end(); }
  }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`, calls, record); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
function post(base: string, path: string, body: unknown, authorization = `Bearer ${key}`, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: 'POST', headers: { authorization, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
const access = '/knowledge/v1/access-check';
const management = '/knowledge/v1/source-access';

test('both paths default off and other host paths fall through', async () => {
  await fixture(async (base, calls) => {
    for (const path of [access, management, '/health']) assert.equal((await post(base, path, binding)).status, 404);
    assert.deepEqual(calls, []);
  }, {});
});
for (const config of [ { MEETING_KNOWLEDGE_ACCESS_KEY: '' }, { MEETING_KNOWLEDGE_ACCESS_KEY: 'x'.repeat(513) },
  { MEETING_KNOWLEDGE_TENANT_ID: 'a display name' } ]) {
  test('enabled source check rejects incomplete or malformed configuration', async () => {
    await fixture(async (base, calls) => { assert.equal((await post(base, access, binding)).status, 503); assert.deepEqual(calls, []); }, { ...environment(), ...config });
  });
}
test('server secret is separate from user JWTs and missing/wrong credentials never load source', async () => {
  await fixture(async (base, calls) => {
    for (const auth of ['', 'Bearer wrong', `Bearer ${await token()}`]) assert.equal((await post(base, access, binding, auth)).status, 401);
    assert.deepEqual(calls, []);
  });
});
test('base64-shaped dedicated server keys match the AXKH adapter format', async () => {
  const base64Key = 'a'.repeat(32) + '+/==';
  await fixture(async base => { assert.equal((await post(base, access, binding, `Bearer ${base64Key}`)).status, 200); },
    { ...environment(), MEETING_KNOWLEDGE_ACCESS_KEY: base64Key });
});
test('tenant scope and strict request shape are enforced before store access', async () => {
  await fixture(async (base, calls) => {
    assert.equal((await post(base, access, { ...binding, tenantId: otherTenant })).status, 403);
    assert.equal((await post(base, access, { ...binding, approved: true })).status, 400);
    assert.equal((await post(base, access + '?tenantId=' + tenantId, binding)).status, 400);
    assert.deepEqual(calls, []);
  });
});
test('actual HTTP source response binds caller and versions and contains no stored metadata', async () => {
  await fixture(async (base, calls, record) => {
    const allowed = await post(base, access, binding);
    assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await allowed.json(), { ...binding, allowed: true });
    record.denies.push(identity);
    assert.deepEqual(await (await post(base, access, binding)).json(), { ...binding, allowed: false });
    record.denies = []; record.contentRevision++;
    assert.deepEqual(await (await post(base, access, binding)).json(), { ...binding, allowed: false });
    assert.equal(calls.length, 3);
  });
});
test('source database failure denies without echoing raw upstream errors', async () => {
  await fixture(async base => { assert.deepEqual(await (await post(base, access, binding)).json(), { ...binding, allowed: false }); }, environment(), 'STORE_UNAVAILABLE');
});
test('source check refuses methods, CORS, non-JSON, oversized and invalid JSON bodies', async () => {
  await fixture(async (base, calls) => {
    for (const method of ['GET', 'OPTIONS']) {
      const response = await fetch(base + access, { method, headers: { origin: 'https://synthetic.example.test' } });
      assert.equal(response.status, 405); assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    assert.equal((await post(base, access, binding, `Bearer ${key}`, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(base, access, { text: 'x'.repeat(8_192) })).status, 413);
    assert.equal((await fetch(base + access, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{' })).status, 400);
    assert.deepEqual(calls, []);
  });
});
test('owner management requires verified identity; legacy, forged and service credentials cannot mutate', async () => {
  await fixture(async (base, calls) => {
    for (const value of [key, await token(true), await token(false, 'synthetic-different-signing-secret')]) {
      assert.equal((await post(base, management, { action: 'initialize', sourceId: binding.sourceId }, `Bearer ${value}`)).status, 401);
    }
    assert.deepEqual(calls, []);
  });
});
test('owner identity is derived from signed JWT and management exposes only minimal acknowledgement', async () => {
  await fixture(async (base, calls) => {
    const jwt = await token();
    const initialized = await post(base, management, { action: 'initialize', sourceId: binding.sourceId }, `Bearer ${jwt}`);
    assert.equal(initialized.status, 200);
    assert.deepEqual(await initialized.json(), { sourceId: binding.sourceId, accessRevision: 1, integrationGeneration: 1, integrationEnabled: true });
    assert.deepEqual(calls[0], ['initialize', owner, binding.sourceId]);
    const command = { action: 'confirm_participant', sourceId: binding.sourceId, expectedAccessRevision: 1, subjectObjectId: objectId, verificationRef: 'synthetic-owner-confirmation' };
    assert.equal((await post(base, management, command, `Bearer ${jwt}`)).status, 200);
    assert.deepEqual(calls[1], ['mutate', owner, command]);
  });
});
for (const bad of [ { action: 'initialize', sourceId: binding.sourceId, tenantId },
  { action: 'initialize', sourceId: binding.sourceId, expectedAccessRevision: 1 },
  { action: 'revoke', sourceId: binding.sourceId },
  { action: 'revoke', sourceId: binding.sourceId, expectedAccessRevision: 1, subjectObjectId: 'Speaker A' },
  { action: 'confirm_participant', sourceId: binding.sourceId, expectedAccessRevision: 1, subjectObjectId: objectId },
  { action: 'enable', sourceId: binding.sourceId, expectedAccessRevision: 1, subjectObjectId: objectId },
  { action: 'restore', sourceId: binding.sourceId, expectedAccessRevision: 1, subjectObjectId: objectId, verificationRef: 'unexpected' } ]) {
  test('management refuses injected identity, missing revisions and malformed mutation details', async () => {
    await fixture(async (base, calls) => { assert.equal((await post(base, management, bad, `Bearer ${await token()}`)).status, 400); assert.deepEqual(calls, []); });
  });
}
for (const [code, status] of [['SOURCE_NOT_MANAGEABLE', 404], ['REVISION_CONFLICT', 409], ['INVALID_MUTATION', 400], ['STORE_UNAVAILABLE', 503]] as const) {
  test(`management maps ${code} to safe ${status}`, async () => {
    await fixture(async base => {
      const response = await post(base, management, { action: 'initialize', sourceId: binding.sourceId }, `Bearer ${await token()}`);
      assert.equal(response.status, status); assert.ok(!(await response.text()).includes('synthetic-private-db-detail'));
    }, environment(), code);
  });
}
test('management uses explicit frontend CORS and rejects foreign origins before mutation', async () => {
  await fixture(async (base, calls) => {
    const response = await fetch(base + management, { method: 'OPTIONS', headers: { origin: 'https://synthetic.example.test' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), 'https://synthetic.example.test');
    assert.equal((await post(base, management, { action: 'initialize', sourceId: binding.sourceId }, `Bearer ${await token()}`, { origin: 'https://foreign.example.test' })).status, 403);
    assert.equal((await fetch(base + management, { method: 'OPTIONS' })).status, 403);
    assert.deepEqual(calls, []);
  });
});
test('enabled owner management with incomplete signing configuration returns503 before database writes', async () => {
  await fixture(async (base, calls) => { assert.equal((await post(base, management, {}, `Bearer ${await token()}`)).status, 503); assert.deepEqual(calls, []); }, { ...environment(), SUPABASE_JWT_SECRET: '' });
});
