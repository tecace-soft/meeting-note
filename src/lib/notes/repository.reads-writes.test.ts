import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { createFakeSupabase, FakeResult } from '../../test/fakeSupabase';

const fixture = vi.hoisted(() => ({ result: {} as FakeResult, fake: null as unknown }));
vi.mock('../../config/supabaseConfig', async () => {
  const { createFakeSupabase } = await import('../../test/fakeSupabase');
  const fake = createFakeSupabase(() => fixture.result);
  fixture.fake = fake;
  return { supabase: fake.client };
});
import {
  deleteOwnedNote,
  deleteOwnedNoteReturningId,
  getNoteSharing,
  listProjectNotes,
  listVisibleNotes,
  patchNoteReturningId,
  patchOwnedNoteReturningId,
  queryHistoryNotes,
  saveNoteTranslations,
  selectAudioReferencePage,
  setNoteSharedUsers,
  setNoteSharedUsersAsOwner,
} from './repository';

const fake = () => fixture.fake as ReturnType<typeof createFakeSupabase>;
const calls = () => fake().queries.map((q) => [q.table, ...q.calls]);
beforeEach(() => { fake().queries.length = 0; fixture.result = {}; });

describe('note repository reads', () => {
  it('listVisibleNotes reads owned and shared notes newest first and defaults to []', async () => {
    expect(await listVisibleNotes('u1')).toEqual([]);
    expect(calls()).toEqual([['note', ['select', '*'], ['or', 'user_id.eq.u1,shared_users.cs.{u1}'], ['order', 'created_at', { ascending: false }]]]);
  });
  it('listVisibleNotes throws the raw database error', async () => {
    const error = { message: 'down' };
    fixture.result = { error };
    await expect(listVisibleNotes('u1')).rejects.toBe(error);
  });
  it('listProjectNotes filters by project and throws the raw error', async () => {
    fixture.result = { data: [{ id: 'n1' }] };
    expect(await listProjectNotes('p1')).toEqual([{ id: 'n1' }]);
    expect(calls()).toEqual([['note', ['select', '*'], ['contains', 'projects', ['p1']], ['order', 'created_at', { ascending: false }]]]);
    const error = { message: 'down' };
    fixture.result = { error };
    await expect(listProjectNotes(7)).rejects.toBe(error);
  });
  it('getNoteSharing selects owner and share list with single()', async () => {
    fixture.result = { data: { user_id: 'o', shared_users: ['a'] } };
    expect(await getNoteSharing('n1')).toEqual({ user_id: 'o', shared_users: ['a'] });
    expect(calls()).toEqual([['note', ['select', 'user_id, shared_users'], ['eq', 'id', 'n1'], ['single']]]);
    const error = { message: 'gone' };
    fixture.result = { error };
    await expect(getNoteSharing('n1')).rejects.toBe(error);
  });
  it('selectAudioReferencePage pages by id with an exact count and abort signal', async () => {
    const signal = new AbortController().signal;
    await selectAudioReferencePage(fake().client as never, { userId: 'u1', from: 0, to: 99, signal });
    expect(calls()).toEqual([['note', ['select', 'id, name, audio_file, audio_file_id', { count: 'exact' }], ['eq', 'user_id', 'u1'], ['or', 'audio_file_id.not.is.null,audio_file.not.is.null'], ['order', 'id', { ascending: true }], ['range', 0, 99], ['abortSignal', signal]]]);
  });
});

describe('queryHistoryNotes chain', () => {
  const base = { userId: 'u1', ownership: 'all' as const, sortKey: 'meeting_desc' as const };
  const run = async (extra: object = {}) => {
    fake().queries.length = 0;
    await queryHistoryNotes({ ...base, ...extra });
    return fake().queries[0].calls;
  };
  const sel: unknown[] = ['select', '*', { count: 'exact' }];
  const own: unknown[] = ['or', 'user_id.eq.u1,shared_users.cs.{u1}'];
  it('default view: everything visible, meeting date desc, ranged', async () => {
    expect(await run({ range: { from: 0, to: 9 } })).toEqual([sel, own, ['order', 'meeting_at', { ascending: false, nullsFirst: false }], ['order', 'created_at', { ascending: false }], ['range', 0, 9]]);
  });
  it('omits range when none given (calendar and search read all rows)', async () => {
    expect((await run()).some((c) => c[0] === 'range')).toBe(false);
  });
  it('chat filter comes first, then mine filter', async () => {
    expect((await run({ chatId: 'c1', ownership: 'mine' })).slice(0, 3)).toEqual([sel, ['eq', 'chat_id', 'c1'], ['eq', 'user_id', 'u1']]);
  });
  it('shared filter excludes own notes', async () => {
    expect((await run({ ownership: 'shared' })).slice(0, 3)).toEqual([sel, ['neq', 'user_id', 'u1'], ['filter', 'shared_users', 'cs', '{u1}']]);
  });
  it('calendar window adds the dual meeting/created bounds filter after ownership', async () => {
    const calls = await run({ calendarWindow: { startIso: 'S', endIso: 'E' } });
    expect(calls[1]).toEqual(own);
    expect(calls[2]).toEqual(['or', 'and(meeting_at.gte.S,meeting_at.lt.E),and(meeting_at.is.null,created_at.gte.S,created_at.lt.E)']);
  });
  const orders: Array<[string, unknown[][]]> = [
    ['title_asc', [['order', 'name', { ascending: true, nullsFirst: false }], ['order', 'created_at', { ascending: false }]]],
    ['title_desc', [['order', 'name', { ascending: false, nullsFirst: false }], ['order', 'created_at', { ascending: false }]]],
    ['created_asc', [['order', 'created_at', { ascending: true }]]],
    ['created_desc', [['order', 'created_at', { ascending: false }]]],
    ['meeting_asc', [['order', 'meeting_at', { ascending: true, nullsFirst: false }], ['order', 'created_at', { ascending: true }]]],
    ['meeting_desc', [['order', 'meeting_at', { ascending: false, nullsFirst: false }], ['order', 'created_at', { ascending: false }]]],
  ];
  for (const [sortKey, expected] of orders) {
    it(`sort ${sortKey}`, async () => {
      expect((await run({ sortKey })).slice(2)).toEqual(expected);
    });
  }
  it('returns the raw result without throwing on error', async () => {
    const error = { message: 'bad' };
    fixture.result = { error, count: 3 };
    expect(await queryHistoryNotes(base)).toEqual({ data: null, error, count: 3 });
  });
});

describe('note repository writes', () => {
  it('setNoteSharedUsersAsOwner scopes to owner and does not select a row', async () => {
    await setNoteSharedUsersAsOwner({ noteId: 'n1', userId: 'o', sharedUsers: ['a'] });
    expect(calls()).toEqual([['note', ['update', { shared_users: ['a'] }], ['eq', 'id', 'n1'], ['eq', 'user_id', 'o']]]);
    const error = { message: 'no' };
    fixture.result = { error };
    await expect(setNoteSharedUsersAsOwner({ noteId: 'n1', userId: 'o', sharedUsers: [] })).rejects.toBe(error);
  });
  it('setNoteSharedUsers is unscoped (unchanged editor behavior) and throws the raw error', async () => {
    await setNoteSharedUsers({ noteId: 'n1', sharedUsers: ['a'] });
    expect(calls()).toEqual([['note', ['update', { shared_users: ['a'] }], ['eq', 'id', 'n1']]]);
    const error = { message: 'no' };
    fixture.result = { error };
    await expect(setNoteSharedUsers({ noteId: 'n1', sharedUsers: [] })).rejects.toBe(error);
  });
  it('patchNoteReturningId is id-only and returns the row or null', async () => {
    fixture.result = { data: { id: 'n1' } };
    expect(await patchNoteReturningId({ noteId: 'n1', patch: { name: 'x' } })).toEqual({ id: 'n1' });
    expect(calls()).toEqual([['note', ['update', { name: 'x' }], ['eq', 'id', 'n1'], ['select', 'id'], ['maybeSingle']]]);
    fixture.result = { data: null };
    expect(await patchNoteReturningId({ noteId: 'n1', patch: { name: 'x' } })).toBeNull();
  });
  it('patchOwnedNoteReturningId adds the owner filter after the id filter', async () => {
    fixture.result = { data: { id: 'n1' } };
    await patchOwnedNoteReturningId({ noteId: 'n1', userId: 'o', patch: { summary_edit: 's' } });
    expect(calls()).toEqual([['note', ['update', { summary_edit: 's' }], ['eq', 'id', 'n1'], ['eq', 'user_id', 'o'], ['select', 'id'], ['maybeSingle']]]);
  });
  it('patchNoteReturningId throws the raw error', async () => {
    const error = { message: 'bad' };
    fixture.result = { error };
    await expect(patchNoteReturningId({ noteId: 'n1', patch: { name: 'x' } })).rejects.toBe(error);
  });
  it('saveNoteTranslations writes both translation columns and rejects zero rows with the editors message', async () => {
    fixture.result = { data: { id: 'n1' } };
    await saveNoteTranslations({ noteId: 'n1', diarizationTranslations: { ko: [] }, transcriptionTranslations: { ko: 't' } });
    expect(calls()).toEqual([['note', ['update', { diarization_translations: { ko: [] }, transcription_translations: { ko: 't' } }], ['eq', 'id', 'n1'], ['select', 'id'], ['maybeSingle']]]);
    fixture.result = { data: null };
    await expect(saveNoteTranslations({ noteId: 'n1', diarizationTranslations: {}, transcriptionTranslations: {} })).rejects.toThrow('Transcript translation save did not update the note.');
  });
  it('deleteOwnedNote is owner-scoped with no row check', async () => {
    await deleteOwnedNote({ noteId: 'n1', userId: 'o' });
    expect(calls()).toEqual([['note', ['delete'], ['eq', 'id', 'n1'], ['eq', 'user_id', 'o']]]);
    const error = { message: 'no' };
    fixture.result = { error };
    await expect(deleteOwnedNote({ noteId: 'n1', userId: 'o' })).rejects.toBe(error);
  });
  it('deleteOwnedNoteReturningId returns the deleted id or null', async () => {
    fixture.result = { data: { id: 'n1' } };
    expect(await deleteOwnedNoteReturningId({ noteId: 'n1', userId: 'o' })).toEqual({ id: 'n1' });
    expect(calls()).toEqual([['note', ['delete'], ['eq', 'id', 'n1'], ['eq', 'user_id', 'o'], ['select', 'id'], ['maybeSingle']]]);
    fixture.result = { data: null };
    expect(await deleteOwnedNoteReturningId({ noteId: 'n1', userId: 'o' })).toBeNull();
  });
  for (const userId of [undefined, '', '  ', null]) {
    it(`owner-scoped methods reject a missing owner id (${String(userId)}) before querying`, async () => {
      const id = userId as unknown as string;
      await expect(patchOwnedNoteReturningId({ noteId: 'n1', userId: id, patch: { name: 'x' } })).rejects.toThrow(/Owner id is required/);
      await expect(setNoteSharedUsersAsOwner({ noteId: 'n1', userId: id, sharedUsers: [] })).rejects.toThrow(/Owner id is required/);
      await expect(deleteOwnedNote({ noteId: 'n1', userId: id })).rejects.toThrow(/Owner id is required/);
      await expect(deleteOwnedNoteReturningId({ noteId: 'n1', userId: id })).rejects.toThrow(/Owner id is required/);
      expect(fake().queries).toEqual([]);
    });
  }
});
