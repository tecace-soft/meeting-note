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
  deleteSpeaker,
  findSpeakerIdByName,
  findSpeakersByEmail,
  findSpeakersByMicrosoftId,
  getSpeakerProfile,
  insertContactSpeakerReturning,
  insertSpeaker,
  insertSpeakerNameReturning,
  listSpeakers,
  selectSpeakerIdentityRows,
  selectSpeakersByNames,
  updateSpeakerFields,
  updateSpeakerProfile,
  updateSpeakerProfileReturningId,
} from './repository';

const fake = () => fixture.fake as ReturnType<typeof createFakeSupabase>;
const calls = () => fake().queries.map((q) => [q.table, ...q.calls]);
const FULL = 'id, name, profile, email, microsoft_id';
beforeEach(() => {
  fake().queries.length = 0;
  fixture.result = {};
});

describe('speaker repository reads', () => {
  it('listSpeakers selects the full columns by owner ordered by name and defaults to []', async () => {
    expect(await listSpeakers('u1')).toEqual([]);
    expect(calls()).toEqual([['speaker', ['select', FULL], ['eq', 'user_id', 'u1'], ['order', 'name', { ascending: true }]]]);
  });
  it('listSpeakers throws the raw error', async () => {
    const error = { message: 'down' };
    fixture.result = { error };
    await expect(listSpeakers('u1')).rejects.toBe(error);
  });
  it('selectSpeakersByNames returns the raw result for both column sets', async () => {
    fixture.result = { data: [{ name: 'A', profile: null }] };
    expect(await selectSpeakersByNames('u1', ['A'], 'name, profile')).toEqual({ data: [{ name: 'A', profile: null }], error: null, count: null });
    await selectSpeakersByNames('u1', ['A'], 'id, name, profile');
    expect(calls()).toEqual([
      ['speaker', ['select', 'name, profile'], ['eq', 'user_id', 'u1'], ['in', 'name', ['A']]],
      ['speaker', ['select', 'id, name, profile'], ['eq', 'user_id', 'u1'], ['in', 'name', ['A']]],
    ]);
    const error = { message: 'bad' };
    fixture.result = { error };
    expect((await selectSpeakersByNames('u1', ['A'], 'id, name, profile')).error).toBe(error);
  });
  it('findSpeakerIdByName returns the id or null and ignores errors', async () => {
    fixture.result = { data: { id: 's1' } };
    expect(await findSpeakerIdByName('u1', 'A')).toBe('s1');
    expect(calls()).toEqual([['speaker', ['select', 'id'], ['eq', 'user_id', 'u1'], ['eq', 'name', 'A'], ['limit', 1], ['maybeSingle']]]);
    fixture.result = { error: { message: 'x' } };
    expect(await findSpeakerIdByName('u1', 'A')).toBeNull();
  });
  it('getSpeakerProfile returns the stored profile or null and ignores errors', async () => {
    fixture.result = { data: { profile: 'p' } };
    expect(await getSpeakerProfile({ speakerId: 's1', userId: 'u1' })).toBe('p');
    expect(calls()).toEqual([['speaker', ['select', 'profile'], ['eq', 'id', 's1'], ['eq', 'user_id', 'u1'], ['maybeSingle']]]);
    fixture.result = { error: { message: 'x' } };
    expect(await getSpeakerProfile({ speakerId: 's1', userId: 'u1' })).toBeNull();
  });
  it('findSpeakersByMicrosoftId and ByEmail filter by owner and throw the raw error', async () => {
    fixture.result = { data: [{ id: 's1' }] };
    expect(await findSpeakersByMicrosoftId('u1', 'ms')).toEqual([{ id: 's1' }]);
    expect(await findSpeakersByEmail('u1', 'a@example.test')).toEqual([{ id: 's1' }]);
    expect(calls()).toEqual([
      ['speaker', ['select', FULL], ['eq', 'user_id', 'u1'], ['eq', 'microsoft_id', 'ms']],
      ['speaker', ['select', FULL], ['eq', 'user_id', 'u1'], ['eq', 'email', 'a@example.test']],
    ]);
    const error = { message: 'bad' };
    fixture.result = { error };
    await expect(findSpeakersByMicrosoftId('u1', 'ms')).rejects.toBe(error);
    await expect(findSpeakersByEmail('u1', 'e')).rejects.toBe(error);
  });
  it('selectSpeakerIdentityRows selects identity columns by owner', async () => {
    await selectSpeakerIdentityRows('u1');
    expect(calls()).toEqual([['speaker', ['select', 'id, name, email, microsoft_id'], ['eq', 'user_id', 'u1']]]);
  });
});

describe('speaker repository writes', () => {
  it('updateSpeakerProfile is owner-scoped, unconfirmed, and throws the raw error', async () => {
    await updateSpeakerProfile({ speakerId: 's1', userId: 'u1', profile: 'p' });
    expect(calls()).toEqual([['speaker', ['update', { profile: 'p' }], ['eq', 'id', 's1'], ['eq', 'user_id', 'u1']]]);
    const error = { message: 'no' };
    fixture.result = { error };
    await expect(updateSpeakerProfile({ speakerId: 's1', userId: 'u1', profile: 'p' })).rejects.toBe(error);
  });
  it('updateSpeakerProfileReturningId confirms the row or returns null', async () => {
    fixture.result = { data: { id: 's1' } };
    expect(await updateSpeakerProfileReturningId({ speakerId: 's1', userId: 'u1', profile: 'p' })).toEqual({ id: 's1' });
    expect(calls()).toEqual([['speaker', ['update', { profile: 'p' }], ['eq', 'id', 's1'], ['eq', 'user_id', 'u1'], ['select', 'id'], ['maybeSingle']]]);
    fixture.result = { data: null };
    expect(await updateSpeakerProfileReturningId({ speakerId: 's1', userId: 'u1', profile: 'p' })).toBeNull();
    const error = { message: 'no' };
    fixture.result = { error };
    await expect(updateSpeakerProfileReturningId({ speakerId: 's1', userId: 'u1', profile: 'p' })).rejects.toBe(error);
  });
  it('updateSpeakerFields returns the raw result', async () => {
    const error = { message: 'no' };
    fixture.result = { error };
    const res = await updateSpeakerFields({ speakerId: 's1', userId: 'u1', patch: { name: 'N' } });
    expect(res.error).toBe(error);
    expect(calls()).toEqual([['speaker', ['update', { name: 'N' }], ['eq', 'id', 's1'], ['eq', 'user_id', 'u1']]]);
  });
  it('deleteSpeaker is owner-scoped and throws the raw error', async () => {
    await deleteSpeaker({ speakerId: 's1', userId: 'u1' });
    expect(calls()).toEqual([['speaker', ['delete'], ['eq', 'id', 's1'], ['eq', 'user_id', 'u1']]]);
    const error = { message: 'no' };
    fixture.result = { error };
    await expect(deleteSpeaker({ speakerId: 's1', userId: 'u1' })).rejects.toBe(error);
  });
  it('insertSpeaker sends only the provided fields', async () => {
    await insertSpeaker({ userId: 'u1', name: 'N', profile: 'p' });
    await insertSpeaker({ userId: 'u1', name: 'N', email: null, microsoftId: null });
    await insertSpeaker({ userId: 'u1', name: 'N', email: 'e', microsoftId: 'ms' });
    expect(calls()).toEqual([
      ['speaker', ['insert', { user_id: 'u1', name: 'N', profile: 'p' }]],
      ['speaker', ['insert', { user_id: 'u1', name: 'N', email: null, microsoft_id: null }]],
      ['speaker', ['insert', { user_id: 'u1', name: 'N', email: 'e', microsoft_id: 'ms' }]],
    ]);
  });
  it('insertSpeaker returns the raw error result', async () => {
    const error = { message: 'duplicate key' };
    fixture.result = { error };
    expect((await insertSpeaker({ userId: 'u1', name: 'N' })).error).toBe(error);
  });
  it('insert-and-read-back variants select the same columns as before and end in single()', async () => {
    await insertSpeakerNameReturning({ userId: 'u1', name: 'N' });
    await insertContactSpeakerReturning({ userId: 'u1', name: 'N', email: 'e', microsoftId: 'ms' });
    expect(calls()).toEqual([
      ['speaker', ['insert', { user_id: 'u1', name: 'N' }], ['select', 'id, name'], ['single']],
      ['speaker', ['insert', { user_id: 'u1', name: 'N', email: 'e', microsoft_id: 'ms' }], ['select', FULL], ['single']],
    ]);
  });
});

describe('speaker repository owner id guard', () => {
  for (const userId of [undefined, null, '', '  ']) {
    it(`rejects or throws on a missing owner id (${String(userId)}) before querying`, async () => {
      const id = userId as unknown as string;
      await expect(listSpeakers(id)).rejects.toThrow(/Owner id is required/);
      await expect(findSpeakerIdByName(id, 'A')).rejects.toThrow(/Owner id is required/);
      await expect(getSpeakerProfile({ speakerId: 's', userId: id })).rejects.toThrow(/Owner id is required/);
      await expect(updateSpeakerProfile({ speakerId: 's', userId: id, profile: 'p' })).rejects.toThrow(/Owner id is required/);
      await expect(updateSpeakerProfileReturningId({ speakerId: 's', userId: id, profile: 'p' })).rejects.toThrow(/Owner id is required/);
      await expect(updateSpeakerFields({ speakerId: 's', userId: id, patch: {} })).rejects.toThrow(/Owner id is required/);
      await expect(deleteSpeaker({ speakerId: 's', userId: id })).rejects.toThrow(/Owner id is required/);
      await expect(insertSpeaker({ userId: id, name: 'N' })).rejects.toThrow(/Owner id is required/);
      await expect(insertSpeakerNameReturning({ userId: id, name: 'N' })).rejects.toThrow(/Owner id is required/);
      await expect(insertContactSpeakerReturning({ userId: id, name: 'N', email: 'e', microsoftId: 'm' })).rejects.toThrow(/Owner id is required/);
      await expect(findSpeakersByMicrosoftId(id, 'm')).rejects.toThrow(/Owner id is required/);
      await expect(findSpeakersByEmail(id, 'e')).rejects.toThrow(/Owner id is required/);
      expect(() => selectSpeakersByNames(id, [], 'name, profile')).toThrow(/Owner id is required/);
      expect(() => selectSpeakerIdentityRows(id)).toThrow(/Owner id is required/);
      expect(fake().queries).toEqual([]);
    });
  }
});
