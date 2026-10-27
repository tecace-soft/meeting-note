import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { createFakeSupabase, FakeResult, RecordedQuery } from '../test/fakeSupabase';

const fixture = vi.hoisted(() => ({
  rows: [] as unknown[],
  selectError: null as { message: string } | null,
  writeError: null as { message: string } | null,
  fake: null as unknown,
}));
vi.mock('../config/supabaseConfig', async () => {
  const { createFakeSupabase } = await import('../test/fakeSupabase');
  const fake = createFakeSupabase((q: RecordedQuery): FakeResult => {
    const isWrite = q.calls.some((c) => c[0] === 'update' || c[0] === 'insert');
    if (isWrite) return { error: fixture.writeError };
    return { data: fixture.rows, error: fixture.selectError };
  });
  fixture.fake = fake;
  return { supabase: fake.client };
});
import { ensureSelfSpeakerRowForUser } from './ensureSelfSpeakerRow';

const fake = () => fixture.fake as ReturnType<typeof createFakeSupabase>;
const calls = () => fake().queries.map((q) => [q.table, ...q.calls]);
beforeEach(() => {
  fake().queries.length = 0;
  fixture.rows = [];
  fixture.selectError = null;
  fixture.writeError = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const LOAD = ['speaker', ['select', 'id, name, email, microsoft_id'], ['eq', 'user_id', 'u1']];

describe('ensureSelfSpeakerRowForUser call contract', () => {
  it('does nothing when no Latin name can be derived', async () => {
    await ensureSelfSpeakerRowForUser('u1', '홍길동');
    expect(calls()).toEqual([]);
  });
  it('inserts a new row with email and microsoft id when none matches', async () => {
    await ensureSelfSpeakerRowForUser('u1', 'Jane Doe', ' ms-1 ', ' jane@example.test ');
    expect(calls()).toEqual([LOAD, ['speaker', ['insert', { user_id: 'u1', name: 'Jane Doe', email: 'jane@example.test', microsoft_id: 'ms-1' }]]]);
  });
  it('inserts nulls when microsoft id and email are absent', async () => {
    await ensureSelfSpeakerRowForUser('u1', 'Jane Doe');
    expect(calls()[1]).toEqual(['speaker', ['insert', { user_id: 'u1', name: 'Jane Doe', email: null, microsoft_id: null }]]);
  });
  it('updates only the changed fields of an existing row, scoped to the owner', async () => {
    fixture.rows = [{ id: 's1', name: 'Old Name', email: null, microsoft_id: 'ms-1' }];
    await ensureSelfSpeakerRowForUser('u1', 'Jane Doe', 'ms-1', 'jane@example.test');
    expect(calls()).toEqual([LOAD, ['speaker', ['update', { name: 'Jane Doe', email: 'jane@example.test' }], ['eq', 'id', 's1'], ['eq', 'user_id', 'u1']]]);
  });
  it('writes nothing when the existing row is already current', async () => {
    fixture.rows = [{ id: 's1', name: 'Jane Doe', email: 'jane@example.test', microsoft_id: 'ms-1' }];
    await ensureSelfSpeakerRowForUser('u1', 'Jane Doe', 'ms-1', 'jane@example.test');
    expect(calls()).toEqual([LOAD]);
  });
  it('logs and returns when the speaker load fails', async () => {
    fixture.selectError = { message: 'down' };
    await expect(ensureSelfSpeakerRowForUser('u1', 'Jane Doe')).resolves.toBeUndefined();
    expect(calls()).toEqual([LOAD]);
  });
  it('swallows a duplicate insert error silently and logs other insert errors', async () => {
    const log = vi.spyOn(console, 'error');
    fixture.writeError = { message: 'duplicate key value violates unique constraint' };
    await ensureSelfSpeakerRowForUser('u1', 'Jane Doe');
    expect(log).not.toHaveBeenCalled();
    fixture.writeError = { message: 'permission denied' };
    await ensureSelfSpeakerRowForUser('u1', 'Jane Doe');
    expect(log).toHaveBeenCalled();
  });
  it('logs update failures without throwing', async () => {
    fixture.rows = [{ id: 's1', name: 'Old', email: null, microsoft_id: null }];
    fixture.writeError = { message: 'denied' };
    await expect(ensureSelfSpeakerRowForUser('u1', 'Jane Doe')).resolves.toBeUndefined();
  });
});
