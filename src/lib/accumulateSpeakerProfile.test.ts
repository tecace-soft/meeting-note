import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { createFakeSupabase, FakeResult, RecordedQuery } from '../test/fakeSupabase';

const fixture = vi.hoisted(() => ({
  idRow: { id: 'sp1' } as { id: string } | null,
  profileRow: { profile: null } as { profile: string | null } | null,
  updateError: null as { message: string } | null,
  fake: null as unknown,
}));
vi.mock('../config/supabaseConfig', async () => {
  const { createFakeSupabase } = await import('../test/fakeSupabase');
  const fake = createFakeSupabase((q: RecordedQuery): FakeResult => {
    if (q.calls.some((c) => c[0] === 'update')) return { error: fixture.updateError };
    if (q.calls.some((c) => c[0] === 'select' && c[1] === 'id')) return { data: fixture.idRow };
    return { data: fixture.profileRow };
  });
  fixture.fake = fake;
  return { supabase: fake.client, SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'anon' };
});
import { accumulateSpeakerProfile } from './accumulateSpeakerProfile';

const fake = () => fixture.fake as ReturnType<typeof createFakeSupabase>;
const calls = () => fake().queries.map((q) => [q.table, ...q.calls]);
const segments = [{ speaker: 'Jane Doe', text: 'hello', start: 0, end: 1 }] as never;
const auth = { appToken: 't', msToken: null };
const mockProfile = (profile: string, ok = true) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(ok ? { profile } : { error: 'nope' }) })));

beforeEach(() => {
  fake().queries.length = 0;
  fixture.idRow = { id: 'sp1' };
  fixture.profileRow = { profile: null };
  fixture.updateError = null;
});
afterEach(() => vi.unstubAllGlobals());

describe('accumulateSpeakerProfile call contract', () => {
  it('skips anonymous labels and speakers without lines before querying', async () => {
    expect(await accumulateSpeakerProfile({ speakerName: 'Speaker A', speakerId: null, userId: 'u1', segments, auth })).toBeNull();
    expect(await accumulateSpeakerProfile({ speakerName: 'Bob Roe', speakerId: null, userId: 'u1', segments, auth })).toBeNull();
    expect(calls()).toEqual([]);
  });
  it('resolves the speaker id by name, reads the profile, and saves the merge owner-scoped', async () => {
    mockProfile('{"x":1}');
    const out = await accumulateSpeakerProfile({ speakerName: 'Jane Doe', speakerId: null, userId: 'u1', segments, auth });
    expect(out).not.toBeNull();
    expect(calls()).toEqual([
      ['speaker', ['select', 'id'], ['eq', 'user_id', 'u1'], ['eq', 'name', 'Jane Doe'], ['limit', 1], ['maybeSingle']],
      ['speaker', ['select', 'profile'], ['eq', 'id', 'sp1'], ['eq', 'user_id', 'u1'], ['maybeSingle']],
      ['speaker', ['update', { profile: out }], ['eq', 'id', 'sp1'], ['eq', 'user_id', 'u1']],
    ]);
  });
  it('uses a given speaker id without the name lookup', async () => {
    mockProfile('{"x":1}');
    await accumulateSpeakerProfile({ speakerName: 'Jane Doe', speakerId: 'sp9', userId: 'u1', segments, auth });
    expect(calls()[0]).toEqual(['speaker', ['select', 'profile'], ['eq', 'id', 'sp9'], ['eq', 'user_id', 'u1'], ['maybeSingle']]);
  });
  it('returns null when no speaker row exists', async () => {
    fixture.idRow = null;
    expect(await accumulateSpeakerProfile({ speakerName: 'Jane Doe', speakerId: null, userId: 'u1', segments, auth })).toBeNull();
    expect(calls()).toHaveLength(1);
  });
  it('throws the raw database error when the save fails', async () => {
    mockProfile('{"x":1}');
    fixture.updateError = { message: 'denied' };
    await expect(accumulateSpeakerProfile({ speakerName: 'Jane Doe', speakerId: 'sp9', userId: 'u1', segments, auth })).rejects.toBe(fixture.updateError);
  });
  it('does not save when generation fails', async () => {
    mockProfile('', false);
    await expect(accumulateSpeakerProfile({ speakerName: 'Jane Doe', speakerId: 'sp9', userId: 'u1', segments, auth })).rejects.toThrow('nope');
    expect(calls().some((c) => c.some((x) => Array.isArray(x) && x[0] === 'update'))).toBe(false);
  });
});
