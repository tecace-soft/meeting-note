import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { createFakeSupabase, FakeResult } from '../../test/fakeSupabase';

const fixture = vi.hoisted(() => ({ result: {} as FakeResult, fake: null as unknown }));
vi.mock('../../config/supabaseConfig', async () => {
  const { createFakeSupabase } = await import('../../test/fakeSupabase');
  const fake = createFakeSupabase(() => fixture.result);
  fixture.fake = fake;
  return { supabase: fake.client };
});
import { readOwnedNoteSummaryEdit } from './repository';

const fake = () => fixture.fake as ReturnType<typeof createFakeSupabase>;
const calls = () => fake().queries.map((q) => [q.table, ...q.calls]);
beforeEach(() => {
  fake().queries.length = 0;
  fixture.result = {};
});

// U1/U9 (DEC-0024): the name-aware refresh reads the saved summary_edit before it may replace the
// summary, so an edit made in another tab or device is never overwritten silently.
describe('readOwnedNoteSummaryEdit', () => {
  it('reads only summary_edit, scoped to the owner', async () => {
    fixture.result = { data: { summary_edit: 'Edited by hand' } };
    expect(await readOwnedNoteSummaryEdit({ noteId: 'n1', userId: 'o' })).toBe('Edited by hand');
    expect(calls()).toEqual([['note', ['select', 'summary_edit'], ['eq', 'id', 'n1'], ['eq', 'user_id', 'o'], ['maybeSingle']]]);
  });

  it('returns null when the note has no saved edit', async () => {
    fixture.result = { data: { summary_edit: null } };
    expect(await readOwnedNoteSummaryEdit({ noteId: 'n1', userId: 'o' })).toBeNull();
  });

  it('throws when the owner cannot see the note, so the caller never treats it as unedited', async () => {
    fixture.result = { data: null };
    await expect(readOwnedNoteSummaryEdit({ noteId: 'n1', userId: 'o' })).rejects.toThrow(/not found/i);
  });

  it('throws the raw database error', async () => {
    const error = { message: 'down' };
    fixture.result = { error };
    await expect(readOwnedNoteSummaryEdit({ noteId: 'n1', userId: 'o' })).rejects.toBe(error);
  });

  it('rejects a missing owner id before querying', async () => {
    await expect(readOwnedNoteSummaryEdit({ noteId: 'n1', userId: '' })).rejects.toThrow(/Owner id is required/);
    expect(fake().queries).toEqual([]);
  });
});
