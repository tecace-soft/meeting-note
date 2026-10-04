import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeetingKnowledgeStore, MeetingKnowledgeStoreError, type MeetingKnowledgeMutation } from './store.js';
import type { MeetingSourceAccessRecord } from './source-access.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const owner = { tenantId, objectId: '22222222-2222-4222-8222-000000000001' };
const member = { tenantId, objectId: '22222222-2222-4222-8222-000000000002' };
const sourceId = 'synthetic-note';
const record = (): MeetingSourceAccessRecord => ({
  tenantId, sourceId, contentRevision: 1, speakerRevision: 1, accessRevision: 1, sourceHash: 'a'.repeat(64),
  integrationGeneration: 1, owner, ownerIdentityVerified: true, active: true, integrationEnabled: false,
  confirmedParticipants: [], directShares: [], noteProjectIds: [], projects: [], denies: [],
});
const storeFor = (data: unknown = record(), error: unknown = null) => createMeetingKnowledgeStore({
  rpc: async () => ({ data, error }),
});
const isError = (code: MeetingKnowledgeStoreError['code']) => (error: unknown) =>
  error instanceof MeetingKnowledgeStoreError && error.code === code && error.message === code;

test('initialization uses only the verified caller identity as owner and tenant', async () => {
  let calls = 0;
  const store = createMeetingKnowledgeStore({ rpc: async (name, args) => {
    calls++;
    assert.equal(name, 'meeting_knowledge_initialize');
    assert.deepEqual(args, { p_tenant_id: tenantId, p_source_id: sourceId, p_owner_object_id: owner.objectId });
    return { data: record(), error: null };
  } });
  assert.equal((await store.initialize(owner, sourceId)).integrationEnabled, false);
  assert.equal(calls, 1);
});
test('current-source lookup is a single atomic RPC and permits missing source', async () => {
  const store = createMeetingKnowledgeStore({ rpc: async (name, args) => {
    assert.equal(name, 'meeting_knowledge_current_source');
    assert.deepEqual(args, { p_tenant_id: tenantId, p_source_id: sourceId });
    return { data: null, error: null };
  } });
  assert.equal(await store.loadCurrentSource(tenantId, sourceId), null);
  await assert.rejects(storeFor(null).initialize(owner, sourceId), isError('STORE_UNAVAILABLE'));
});
test('participant mutation passes optimistic revision and evidence but no caller-controlled owner fields', async () => {
  const store = createMeetingKnowledgeStore({ rpc: async (name, args) => {
    assert.equal(name, 'meeting_knowledge_mutate');
    assert.deepEqual(args, { p_tenant_id: tenantId, p_source_id: sourceId, p_owner_object_id: owner.objectId,
      p_expected_access_revision: 1, p_action: 'confirm_participant', p_subject_object_id: member.objectId,
      p_verification_ref: 'synthetic-owner-confirmation' });
    return { data: record(), error: null };
  } });
  await store.mutate(owner, { sourceId, expectedAccessRevision: 1, action: 'confirm_participant',
    subjectObjectId: member.objectId, verificationRef: 'synthetic-owner-confirmation' });
});
for (const action of ['revoke', 'restore', 'enable', 'disable'] as const) {
  test(`accepts scoped ${action} mutation and supplies explicit SQL null optional args`, async () => {
    const subjectObjectId = ['revoke', 'restore'].includes(action) ? member.objectId : undefined;
    const store = createMeetingKnowledgeStore({ rpc: async (_name, args) => {
      assert.equal(args.p_action, action);
      assert.equal(args.p_subject_object_id, subjectObjectId ?? null);
      assert.equal(args.p_verification_ref, null);
      return { data: record(), error: null };
    } });
    await store.mutate(owner, { sourceId, expectedAccessRevision: 1, action, subjectObjectId });
  });
}
for (const [message, code] of [
  ['SOURCE_UNAVAILABLE', 'SOURCE_NOT_MANAGEABLE'], ['ACCESS_REVISION_CONFLICT', 'REVISION_CONFLICT'],
  ['INVALID_LEDGER_COMMAND', 'INVALID_MUTATION'], ['private sensitive database diagnostic', 'STORE_UNAVAILABLE'],
] as const) {
  test(`SQL ${code} exposes only the mapped safe error`, async () => {
    await assert.rejects(storeFor(null, { code: 'P0001', message, details: 'synthetic private detail' })
      .initialize(owner, sourceId), isError(code));
  });
}
test('unknown SQLSTATE and thrown transport errors never expose upstream text', async () => {
  await assert.rejects(storeFor(null, { code: '42P01', message: 'private table name' }).initialize(owner, sourceId), isError('STORE_UNAVAILABLE'));
  const store = createMeetingKnowledgeStore({ rpc: () => { throw new Error('private token'); } });
  await assert.rejects(store.initialize(owner, sourceId), isError('STORE_UNAVAILABLE'));
});
const command: MeetingKnowledgeMutation = { sourceId, expectedAccessRevision: 1, action: 'confirm_participant',
  subjectObjectId: member.objectId, verificationRef: 'synthetic-reference' };
for (const [name, value] of Object.entries({
  'missing evidence': { ...command, verificationRef: undefined }, 'oversized evidence': { ...command, verificationRef: 'x'.repeat(513) },
  'missing participant': { ...command, subjectObjectId: undefined }, 'named participant': { ...command, subjectObjectId: 'Speaker A' },
  'unknown action': { ...command, action: 'add_admin' }, 'negative revision': { ...command, expectedAccessRevision: -1 },
  'fractional revision': { ...command, expectedAccessRevision: 1.2 }, 'unsafe revision': { ...command, expectedAccessRevision: Number.MAX_SAFE_INTEGER + 1 },
  'enable with subject': { ...command, action: 'enable', verificationRef: undefined },
  'revoke with evidence': { ...command, action: 'revoke' }, 'owner injection': { ...command, ownerObjectId: member.objectId },
  'tenant injection': { ...command, tenantId: member.objectId }, 'empty source': { ...command, sourceId: '' },
})) {
  test(`rejects ${name} before invoking the database`, async () => {
    const store = createMeetingKnowledgeStore({ rpc: () => { assert.fail('invalid command reached database'); } });
    await assert.rejects(store.mutate(owner, value as MeetingKnowledgeMutation), isError('INVALID_MUTATION'));
  });
}
for (const [name, data] of Object.entries({
  'wrong tenant': { ...record(), tenantId: member.objectId }, 'wrong source': { ...record(), sourceId: 'another-source' },
  'missing denies': { ...record(), denies: undefined }, 'unverified owner': { ...record(), ownerIdentityVerified: false },
  'foreign share': { ...record(), directShares: [{ ...member, tenantId: member.objectId }] },
  'named share': { ...record(), directShares: [{ ...member, objectId: 'Speaker A' }] },
  'non-owner confirmation': { ...record(), confirmedParticipants: [{ identity: member, confirmedBy: member, verificationRef: 'synthetic' }] },
  'non-owner project': { ...record(), projects: [{ projectId: 'project', owner: member, sharedWith: [member] }] },
  'summary instead of hash': { ...record(), sourceHash: 'synthetic summary' },
  'bad revision': { ...record(), contentRevision: 0 },
})) {
  test(`malformed current record ${name} fails closed`, async () => {
    await assert.rejects(storeFor(data).loadCurrentSource(tenantId, sourceId), isError('STORE_UNAVAILABLE'));
  });
}
test('management rejects a reply with a different owner, even in the same tenant', async () => {
  await assert.rejects(storeFor({ ...record(), owner: member }).initialize(owner, sourceId), isError('STORE_UNAVAILABLE'));
});
test('caller and source validation occurs before RPC', async () => {
  const store = createMeetingKnowledgeStore({ rpc: () => { assert.fail('invalid identity reached database'); } });
  await assert.rejects(store.initialize({ ...owner, tenantId: 'guessed.example' }, sourceId), isError('INVALID_MUTATION'));
  await assert.rejects(store.loadCurrentSource(tenantId, 'x'.repeat(257)), isError('INVALID_MUTATION'));
});

const ownerStatus = () => ({ sourceId, enrolled: false, unsupportedTranscript: false, integrationEnabled: false,
  accessRevision: null, integrationGeneration: null, participants: [], denies: [], directShares: [], projectShares: [],
  delivery: { pending: 0, lastDeliveredAt: null, lastErrorCode: null } });
test('owner status is a read-only owner-scoped RPC and preserves unenrolled state', async () => {
  const store = createMeetingKnowledgeStore({ rpc: async (name, args) => {
    assert.equal(name, 'meeting_knowledge_owner_status');
    assert.deepEqual(args, { p_tenant_id: tenantId, p_source_id: sourceId, p_owner_object_id: owner.objectId });
    return { data: ownerStatus(), error: null };
  } });
  assert.deepEqual(await store.getOwnedStatus(owner, sourceId), ownerStatus());
});
for (const [name, data] of Object.entries({
  'different source': { ...ownerStatus(), sourceId: 'another-note' },
  'unenrolled enabled': { ...ownerStatus(), integrationEnabled: true },
  'unenrolled revision': { ...ownerStatus(), accessRevision: 1 },
  'missing enrolled revisions': { ...ownerStatus(), enrolled: true },
  'named audience': { ...ownerStatus(), participants: ['Speaker A'] },
  'duplicate audience': { ...ownerStatus(), directShares: [member.objectId, member.objectId] },
  'private error': { ...ownerStatus(), delivery: { pending: 0, lastDeliveredAt: null, lastErrorCode: 'private diagnostic' } },
  'negative queue': { ...ownerStatus(), delivery: { pending: -1, lastDeliveredAt: null, lastErrorCode: null } },
  'extra plaintext': { ...ownerStatus(), plaintext: 'synthetic sensitive content' },
})) {
  test(`owner status rejects ${name} without returning database details`, async () => {
    await assert.rejects(storeFor(data).getOwnedStatus(owner, sourceId), isError('STORE_UNAVAILABLE'));
  });
}
test('owner status maps owner denial to content-free failure', async () => {
  await assert.rejects(storeFor(null, { code: 'P0001', message: 'SOURCE_UNAVAILABLE' }).getOwnedStatus(owner, sourceId), isError('SOURCE_NOT_MANAGEABLE'));
  await assert.rejects(storeFor(null).getOwnedStatus(owner, sourceId), isError('SOURCE_NOT_MANAGEABLE'));
});
test('removed transcript can still be disabled using a minimal fenced acknowledgement', async () => {
  const ack = { sourceId, accessRevision: 2, integrationGeneration: 1, integrationEnabled: false };
  assert.deepEqual(await storeFor(ack).mutate(owner, { sourceId, expectedAccessRevision: 1, action: 'disable' }), ack);
  await assert.rejects(storeFor(ack).mutate(owner, { sourceId, expectedAccessRevision: 1, action: 'enable' }), isError('STORE_UNAVAILABLE'));
  await assert.rejects(storeFor({ ...ack, integrationEnabled: true }).mutate(owner, { sourceId, expectedAccessRevision: 1, action: 'disable' }), isError('STORE_UNAVAILABLE'));
  await assert.rejects(storeFor({ ...record(), integrationEnabled: true }).mutate(owner, { sourceId, expectedAccessRevision: 1, action: 'disable' }), isError('STORE_UNAVAILABLE'));
});
