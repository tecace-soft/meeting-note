import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { sha256Text } from './contract.js';
import { rawSpans } from './delivery.js';
import { fetchMeetingEvidence, type MeetingEvidenceStore } from './evidence.js';
import { isMeetingEvidenceFetchRequest, isMeetingEvidenceFetchResponse } from './evidence-contract.js';
import { createMeetingKnowledgeHttpHandler, type MeetingKnowledgeHttpStore } from './http.js';
import { createMeetingKnowledgeStore } from './store.js';
import type { MeetingSourceAccessRecord } from './source-access.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const objectId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const key = 'synthetic-server-key-not-a-production-secret';
const plaintext = 'a'.repeat(7_999) + '😀' + '한국어 evidence.';
const binding = { tenantId, objectId, sourceId: 'synthetic-note', contentRevision: 1,
  speakerRevision: 1, accessRevision: 1, sourceHash: sha256Text(plaintext), integrationGeneration: 2 };
const source = (): MeetingSourceAccessRecord => ({ ...binding,
  owner: { tenantId, objectId: ownerId }, ownerIdentityVerified: true, active: true, integrationEnabled: true,
  directShares: [{ tenantId, objectId }], confirmedParticipants: [], denies: [], noteProjectIds: [], projects: [],
});
const spans = rawSpans(binding.sourceId, binding.contentRevision, plaintext);
const request = () => ({ ...binding, spanIds: spans.map(span => span.spanId) });
const store = (record = source(), text = plaintext): MeetingEvidenceStore => ({
  async loadCurrentSource() { return record; },
  async loadCurrentEvidence() { return { record, plaintext: text }; },
});

test('wire rejects arbitrary offsets, extras, duplicate/unknown shape and excessive IDs', () => {
  assert.ok(isMeetingEvidenceFetchRequest(request()));
  for (const value of [null, [], binding, { ...request(), start: 0 }, { ...request(), spanIds: [] },
    { ...request(), spanIds: [spans[0].spanId, spans[0].spanId] },
    { ...request(), spanIds: Array.from({ length: 9 }, (_, i) => `span-${i}`) },
    { ...request(), spanIds: ['x'.repeat(257)] }, { ...request(), objectId: 'email@example.test' }]) {
    assert.equal(isMeetingEvidenceFetchRequest(value), false);
  }
});
test('original raw spans preserve UTF16 surrogate boundaries and requested order without metadata', async () => {
  const result = await fetchMeetingEvidence({ ...request(), spanIds: [...request().spanIds].reverse() }, store());
  assert.ok(result); assert.ok(isMeetingEvidenceFetchResponse(result));
  assert.equal(result.spans[1].end, 7_999);
  assert.equal(result.spans[0].text, plaintext.slice(7_999));
  assert.equal(result.spans[0].textHash, sha256Text(result.spans[0].text));
  assert.deepEqual(Object.keys(result).sort(), [...Object.keys(binding), 'spans'].sort());
  assert.deepEqual(Object.keys(result.spans[0]).sort(), ['end', 'spanId', 'start', 'text', 'textHash']);
  assert.equal(isMeetingEvidenceFetchResponse({ ...result, title: 'private' }), false);
  assert.equal(isMeetingEvidenceFetchResponse({ ...result, spans: [{ ...result.spans[0], text: '' }] }), false);
});
test('every binding revision, lifecycle state and hash must match current evidence', async () => {
  for (const field of ['contentRevision', 'speakerRevision', 'accessRevision', 'integrationGeneration'] as const) {
    assert.equal(await fetchMeetingEvidence({ ...request(), [field]: binding[field] + 1 }, store()), null);
  }
  for (const change of [{ active: false }, { integrationEnabled: false }, { ownerIdentityVerified: false },
    { sourceHash: 'b'.repeat(64) }, { sourceId: 'other-note' }]) {
    assert.equal(await fetchMeetingEvidence(request(), store({ ...source(), ...change })), null);
  }
  assert.equal(await fetchMeetingEvidence(request(), store(source(), plaintext + 'changed')), null);
  assert.equal(await fetchMeetingEvidence({ ...request(), spanIds: ['unknown-span'] }, store()), null);
  assert.equal(await fetchMeetingEvidence(request(), store(source(), 'x'.repeat(1_048_577))), null);
});
test('ownership alone cannot read; participant, direct and own project shares can; denial wins', async () => {
  const record = source(); record.directShares = [];
  assert.equal(await fetchMeetingEvidence({ ...request(), objectId: ownerId }, store(record)), null);
  record.confirmedParticipants.push({ identity: { tenantId, objectId }, confirmedBy: record.owner, verificationRef: 'synthetic' });
  assert.ok(await fetchMeetingEvidence(request(), store(record)));
  record.denies.push({ tenantId, objectId });
  assert.equal(await fetchMeetingEvidence(request(), store(record)), null);
  record.denies = []; record.confirmedParticipants = []; record.noteProjectIds = ['project'];
  record.projects.push({ projectId: 'project', owner: record.owner, sharedWith: [{ tenantId, objectId }] });
  assert.ok(await fetchMeetingEvidence(request(), store(record)));
  record.noteProjectIds = [];
  assert.equal(await fetchMeetingEvidence(request(), store(record)), null);
});
test('revocation/edit after first authorization or during read never returns snippets', async () => {
  for (const action of ['revoke', 'edit', 'delete'] as const) {
    const record = source(); let loads = 0;
    const loader: MeetingEvidenceStore = {
      async loadCurrentSource() { loads++; return structuredClone(record); },
      async loadCurrentEvidence() {
        const snapshot = { record: structuredClone(record), plaintext };
        if (action === 'revoke') record.denies.push({ tenantId, objectId });
        if (action === 'edit') record.contentRevision++;
        if (action === 'delete') record.active = false;
        return snapshot;
      },
    };
    assert.equal(await fetchMeetingEvidence(request(), loader), null); assert.equal(loads, 2);
  }
  assert.equal(await fetchMeetingEvidence(request(), { ...store(), async loadCurrentEvidence() { throw new Error('private'); } }), null);
});

test('service RPC request includes full binding and refuses unexpected result metadata', async () => {
  let called: unknown;
  const rpc = createMeetingKnowledgeStore({ async rpc(name, args) {
    called = { name, args }; return { data: { record: source(), plaintext }, error: null };
  } });
  assert.deepEqual(await rpc.loadCurrentEvidence(binding), { record: source(), plaintext });
  assert.deepEqual(called, { name: 'meeting_knowledge_current_evidence', args: {
    p_tenant_id: tenantId, p_source_id: binding.sourceId, p_object_id: objectId,
    p_content_revision: 1, p_speaker_revision: 1, p_access_revision: 1,
    p_integration_generation: 2, p_source_hash: binding.sourceHash,
  } });
  const bad = createMeetingKnowledgeStore({ async rpc() { return { data: { record: source(), plaintext, title: 'private' }, error: null }; } });
  await assert.rejects(bad.loadCurrentEvidence(binding), /STORE_UNAVAILABLE/);
});

test('real loopback HTTP authenticates dedicated key and returns only version-bound snippets', async () => {
  let reads = 0;
  const record = source();
  const httpStore: MeetingKnowledgeHttpStore = {
    ...store(record), async loadCurrentEvidence() { reads++; return { record, plaintext }; },
    async initialize() { throw new Error('not used'); }, async mutate() { throw new Error('not used'); },
    async getOwnedStatus() { throw new Error('not used'); },
  };
  const env = { MEETING_KNOWLEDGE_ACCESS_ENABLED: 'true', MEETING_KNOWLEDGE_ACCESS_KEY: key, MEETING_KNOWLEDGE_TENANT_ID: tenantId };
  const handler = createMeetingKnowledgeHttpHandler(httpStore, env);
  const disabled = createMeetingKnowledgeHttpHandler(httpStore, {});
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname.startsWith('/disabled')) { url.pathname = url.pathname.slice(9); void disabled(req, res, url); }
    else void handler(req, res, url);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const post = (body: unknown, auth = `Bearer ${key}`, path = '') => fetch(`http://127.0.0.1:${address.port}${path}/knowledge/v1/evidence-fetch`, {
    method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    for (const auth of ['', 'Bearer wrong']) assert.equal((await post(request(), auth)).status, 401);
    assert.equal((await post(request(), `Bearer ${key}`, '/disabled')).status, 404); assert.equal(reads, 0);
    const success = await post(request()); assert.equal(success.status, 200);
    assert.equal(success.headers.get('cache-control'), 'no-store');
    assert.equal(success.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await success.json(), await fetchMeetingEvidence(request(), store(record)));
    for (const body of [{ ...request(), offsets: [0, 4] }, { ...request(), spanIds: ['unknown'] },
      { ...request(), tenantId: ownerId }, { ...request(), contentRevision: 2 }, { text: 'x'.repeat(8_192) }]) {
      const response = await post(body); assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
    }
    record.denies.push({ tenantId, objectId });
    assert.equal((await post(request())).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
