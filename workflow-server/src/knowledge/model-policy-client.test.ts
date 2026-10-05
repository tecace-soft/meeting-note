import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeetingModelPolicyClient } from './model-policy-client.js';
import { hashPayload, sha256Text, type SourceUpsertEvent } from './contract.js';

const tid = '11111111-1111-4111-8111-111111111111';
const env = { MEETING_KNOWLEDGE_EXTRACTION_ENABLED: 'true', MEETING_KNOWLEDGE_AXKH_URL: 'https://axkh.example.test',
  MEETING_KNOWLEDGE_MODEL_POLICY_KEY: 'p'.repeat(40), MEETING_KNOWLEDGE_INGEST_KEY: 'i'.repeat(40),
  MEETING_KNOWLEDGE_ACCESS_KEY: 'a'.repeat(40), MEETING_KNOWLEDGE_TENANT_ID: tid,
  MEETING_KNOWLEDGE_EXTRACTION_MODEL: 'gemini-2.5-flash' };
function source(): SourceUpsertEvent {
  const plaintext = 'Synthetic discussion. We propose testing next week.';
  const payload = { contentRevision: 1, speakerRevision: 1, sourceHash: sha256Text(plaintext), plaintext,
    spans: [{ spanId: 's1', start: 0, end: plaintext.length, textHash: sha256Text(plaintext) }],
    title: 'Synthetic only', sourceUrl: 'https://meeting.example.test/summary-history?note_id=test', meetingAt: null, timezone: 'UTC' };
  return { schemaVersion: 1, eventId: '22222222-2222-4222-8222-222222222222', eventSeq: 1,
    integrationGeneration: 1, sourceApp: 'meeting-note', sourceId: 'synthetic-source', tenantId: tid,
    eventType: 'source.upsert', payload, payloadHash: hashPayload(payload) };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('disabled client neither validates deployment config nor calls transport', async () => {
  let calls = 0;
  const client = createMeetingModelPolicyClient({}, { fetch: async () => { calls++; throw new Error(); } });
  assert.equal(await client(source()), false); assert.equal(calls, 0);
});
test('only bound processing metadata is sent over dedicated HTTPS server identity', async () => {
  const client = createMeetingModelPolicyClient(env, { fetch: async (url, init) => {
    assert.equal(url, 'https://axkh.example.test/api/integrations/meeting-note/v1/model-policy');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.credentials, 'omit');
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${env.MEETING_KNOWLEDGE_MODEL_POLICY_KEY}`);
    const body = JSON.parse(String(init?.body)); assert.equal(Object.keys(body).length, 10);
    assert.equal(body.provider, 'gemini'); assert.equal(body.model, env.MEETING_KNOWLEDGE_EXTRACTION_MODEL);
    assert.equal(body.region, 'global'); assert.equal(body.retention, 'provider-default');
    assert.equal(String(init?.body).includes('Synthetic discussion'), false);
    return json({ ...body, allowed: true, policyRef: 'approved-operator-policy' });
  } });
  assert.equal(await client(source()), true);
});
test('pending or revoked classification returns no processing permission', async () => {
  const client = createMeetingModelPolicyClient(env, { fetch: async (_, init) => json({ ...JSON.parse(String(init?.body)), allowed: false, policyRef: null }) });
  assert.equal(await client(source()), false);
});
for (const [name, change] of Object.entries({ stale: { contentRevision: 2 }, differentModel: { model: 'other' },
  differentTenant: { tenantId: '33333333-3333-4333-8333-333333333333' }, extra: { clearance: 5 },
  noApproval: { policyRef: null }, guessedApproval: { allowed: 'true' }, emptyPolicy: { policyRef: '' }, controlPolicy: { policyRef: 'policy\n' } })) {
  test(`rejects ${name} response before granting model use`, async () => {
    const client = createMeetingModelPolicyClient(env, { fetch: async (_, init) => json({ ...JSON.parse(String(init?.body)), allowed: true, policyRef: 'policy', ...change }) });
    await assert.rejects(client(source()), { message: 'MODEL_POLICY_UNAVAILABLE' });
  });
}
for (const change of [{ MEETING_KNOWLEDGE_MODEL_POLICY_KEY: env.MEETING_KNOWLEDGE_INGEST_KEY },
  { MEETING_KNOWLEDGE_MODEL_POLICY_KEY: env.MEETING_KNOWLEDGE_ACCESS_KEY }, { MEETING_KNOWLEDGE_AXKH_URL: 'http://localhost:8787' },
  { MEETING_KNOWLEDGE_AXKH_URL: 'https://axkh.example.test?secret=value' }, { MEETING_KNOWLEDGE_EXTRACTION_MODEL: '../unknown' }]) {
  test(`invalid deployment configuration fails closed ${Object.keys(change)[0]} ${Object.values(change)[0]?.slice(0, 6)}`, () => {
    assert.throws(() => createMeetingModelPolicyClient({ ...env, ...change }), { message: 'MODEL_POLICY_UNAVAILABLE' });
  });
}
test('different source tenant is rejected before HTTP', async () => {
  let calls = 0; const event = source(); event.tenantId = '33333333-3333-4333-8333-333333333333';
  const client = createMeetingModelPolicyClient(env, { fetch: async () => { calls++; throw new Error(); } });
  await assert.rejects(client(event)); assert.equal(calls, 0);
});
test('untrusted HTTP errors expose only safe code', async () => {
  const client = createMeetingModelPolicyClient(env, { fetch: async () => new Response('private raw detail', { status: 503 }) });
  await assert.rejects(client(source()), { message: 'MODEL_POLICY_UNAVAILABLE' });
});
test('actual streamed reply bound rejects oversized response', async () => {
  const client = createMeetingModelPolicyClient(env, { fetch: async () => new Response('x'.repeat(16_385), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client(source()), { message: 'MODEL_POLICY_UNAVAILABLE' });
});
test('invalid UTF-8 JSON response does not authorize processing', async () => {
  const client = createMeetingModelPolicyClient(env, { fetch: async () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client(source()), { message: 'MODEL_POLICY_UNAVAILABLE' });
});
test('hanging transport is bounded and aborted even if it ignores cancellation', async () => {
  let signal: AbortSignal | undefined;
  const client = createMeetingModelPolicyClient(env, { fetch: async (_, init) => { signal = init?.signal ?? undefined; return await new Promise<Response>(() => undefined); } });
  await assert.rejects(client(source()), { message: 'MODEL_POLICY_UNAVAILABLE' }); assert.equal(signal?.aborted, true);
});
