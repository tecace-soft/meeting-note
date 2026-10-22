import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  result: { data: { id: 'fixture-note' } as { id: string } | null, error: null as { message: string } | null },
  calls: [] as unknown[][],
}));
vi.mock('../../config/supabaseConfig', () => ({
  supabase: { from(table: string) {
    fixture.calls.push(['from', table]);
    const query = {
      update(patch: unknown) { fixture.calls.push(['update', patch]); return query; },
      eq(key: string, value: unknown) { fixture.calls.push(['eq', key, value]); return query; },
      select(columns: string) { fixture.calls.push(['select', columns]); return query; },
      async maybeSingle() { fixture.calls.push(['maybeSingle']); return fixture.result; },
    };
    return query;
  } },
}));
import { updateOwnedNote } from './repository';
beforeEach(() => { fixture.calls.length = 0; fixture.result = { data: { id: 'fixture-note' }, error: null }; });
describe('updateOwnedNote owner write contract', () => {
  for (const patch of [{ name: 'Changed title' }, { summary_edit: 'Changed summary' }]) {
    it(`confirms one returned id for ${Object.keys(patch)[0]}`, async () => {
      await updateOwnedNote({ noteId: 'fixture-note', userId: 'fixture-owner', patch });
      expect(fixture.calls).toEqual([['from', 'note'], ['update', patch], ['eq', 'id', 'fixture-note'], ['eq', 'user_id', 'fixture-owner'], ['select', 'id'], ['maybeSingle']]);
    });
    it(`rejects zero rows for ${Object.keys(patch)[0]}`, async () => {
      fixture.result.data = null;
      await expect(updateOwnedNote({ noteId: 'fixture-note', userId: 'fixture-owner', patch })).rejects.toThrow(/권한이 없을 수/);
    });
  }
  for (const userId of [null, undefined, '', ' ']) it(`rejects missing identity (${String(userId)}) before querying`, async () => {
    await expect(updateOwnedNote({ noteId: 'fixture-note', userId, patch: { name: 'Changed title' } })).rejects.toThrow(/인증/);
    expect(fixture.calls).toEqual([]);
  });
  it('preserves a PostgREST error as a displayed Error', async () => {
    fixture.result.error = { message: 'Fixture database unavailable' };
    await expect(updateOwnedNote({ noteId: 'fixture-note', userId: 'fixture-owner', patch: { name: 'Changed title' } })).rejects.toThrow('Fixture database unavailable');
  });
  it('rejects a response that does not confirm this note', async () => {
    fixture.result.data = { id: 'unrelated-note' };
    await expect(updateOwnedNote({ noteId: 'fixture-note', userId: 'fixture-owner', patch: { name: 'Changed title' } })).rejects.toThrow(/권한이 없을 수/);
  });
});
