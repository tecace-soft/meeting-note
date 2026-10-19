import assert from 'node:assert/strict';
import test from 'node:test';
import { enableAll, EnableAllFailure, ENABLE_ALL_MAX_CONFLICT_RETRIES, type EnableAllStore } from './enable-all.js';
import type { MeetingOwnerStatus } from './management-status.js';
import type { MeetingSourceAccessRecord } from './source-access.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const objectId = '22222222-2222-4222-8222-222222222222';
const identity = { tenantId, objectId };
const sourceId = 'synthetic-note';

interface World { revision: number; enabled: boolean; enrolled: boolean; unsupported: boolean; oversized: boolean; oversizedAfterInit: boolean;
  mutateFailures: string[]; calls: string[]; staleOnce: boolean; notOwner: boolean }
const world = (patch: Partial<World> = {}): World => ({ revision: 1, enabled: false, enrolled: false, unsupported: false,
  oversized: false, oversizedAfterInit: false, mutateFailures: [], calls: [], staleOnce: false, notOwner: false, ...patch });
const failure = (code: string) => Object.assign(new Error(code), { code });
const record = (w: World, revision = w.revision) => ({ sourceId, accessRevision: revision, integrationGeneration: 1,
  integrationEnabled: w.enabled }) as unknown as MeetingSourceAccessRecord;

function store(w: World): EnableAllStore {
  return {
    async getOwnedStatus() {
      w.calls.push('status');
      if (w.notOwner) throw failure('SOURCE_NOT_MANAGEABLE');
      return { sourceId, enrolled: w.enrolled, unsupportedTranscript: w.unsupported, integrationEnabled: w.enabled,
        processing: { sizing: w.oversized || (w.oversizedAfterInit && w.enrolled) ? 'oversized' : 'ready' } } as unknown as MeetingOwnerStatus;
    },
    async initialize() {
      w.calls.push('initialize');
      if (w.notOwner) throw failure('SOURCE_NOT_MANAGEABLE');
      w.enrolled = true;
      return record(w);
    },
    async mutate(_actor, command) {
      w.calls.push(`enable@${command.expectedAccessRevision}`);
      const next = w.mutateFailures.shift();
      if (next) { if (next === 'REVISION_CONFLICT') w.revision++; throw failure(next); }
      if (command.expectedAccessRevision !== w.revision) throw failure('REVISION_CONFLICT');
      if (!w.enabled) { w.enabled = true; w.revision++; }
      return record(w);
    },
  };
}
async function failureOf(run: Promise<unknown>): Promise<EnableAllFailure> {
  try { await run; } catch (error) { assert.ok(error instanceof EnableAllFailure); return error; }
  assert.fail('expected EnableAllFailure');
}

test('happy path initializes then enables in order with the returned revision', async () => {
  const w = world();
  const result = await enableAll(store(w), identity, sourceId);
  assert.equal(result.integrationEnabled, true);
  assert.deepEqual(w.calls, ['status', 'initialize', 'status', 'enable@1']);
});
test('already enabled is a no-op without an enable write', async () => {
  const w = world({ enabled: true, enrolled: true, revision: 3 });
  const result = await enableAll(store(w), identity, sourceId);
  assert.equal(result.integrationEnabled, true); assert.equal(result.accessRevision, 3);
  assert.ok(!w.calls.some(call => call.startsWith('enable')));
});
test('initialize ok + enable failure reports the safe initialized state and a retry converges', async () => {
  const w = world({ mutateFailures: ['STORE_UNAVAILABLE'] });
  const error = await failureOf(enableAll(store(w), identity, sourceId));
  assert.equal(error.code, 'STORE_UNAVAILABLE'); assert.equal(error.initialized, true);
  assert.equal(w.enabled, false); assert.equal(w.enrolled, true);
  const retry = await enableAll(store(w), identity, sourceId);
  assert.equal(retry.integrationEnabled, true); assert.equal(w.enabled, true);
});
test('one revision conflict is re-read and retried once', async () => {
  const w = world({ mutateFailures: ['REVISION_CONFLICT'] });
  const result = await enableAll(store(w), identity, sourceId);
  assert.equal(result.integrationEnabled, true);
  assert.deepEqual(w.calls.filter(call => call.startsWith('enable')), ['enable@1', 'enable@2']);
});
test('repeated revision conflicts stop after the bounded retry', async () => {
  const w = world({ mutateFailures: ['REVISION_CONFLICT', 'REVISION_CONFLICT', 'REVISION_CONFLICT'] });
  const error = await failureOf(enableAll(store(w), identity, sourceId));
  assert.equal(error.code, 'REVISION_CONFLICT'); assert.equal(error.initialized, true);
  assert.equal(w.calls.filter(call => call.startsWith('enable')).length, ENABLE_ALL_MAX_CONFLICT_RETRIES + 1);
  assert.equal(w.enabled, false);
});
test('non-owner is rejected before any write', async () => {
  const w = world({ notOwner: true });
  const error = await failureOf(enableAll(store(w), identity, sourceId));
  assert.equal(error.code, 'SOURCE_NOT_MANAGEABLE'); assert.equal(error.initialized, false);
  assert.deepEqual(w.calls, ['status']);
});
test('unsupported transcript is blocked before creating settings', async () => {
  const w = world({ unsupported: true });
  const error = await failureOf(enableAll(store(w), identity, sourceId));
  assert.equal(error.code, 'SOURCE_BLOCKED'); assert.equal(error.initialized, false);
  assert.deepEqual(w.calls, ['status']);
});
test('oversized source is blocked before any write', async () => {
  const w = world({ oversized: true });
  const error = await failureOf(enableAll(store(w), identity, sourceId));
  assert.equal(error.code, 'SOURCE_BLOCKED'); assert.equal(error.initialized, false);
  assert.equal(w.enrolled, false); assert.deepEqual(w.calls, ['status']);
});
test('source that becomes oversized after initialize keeps settings but never switches delivery on', async () => {
  const w = world({ oversizedAfterInit: true });
  const error = await failureOf(enableAll(store(w), identity, sourceId));
  assert.equal(error.code, 'SOURCE_BLOCKED'); assert.equal(error.initialized, true);
  assert.equal(w.enabled, false);
  assert.ok(!w.calls.some(call => call.startsWith('enable')));
});
