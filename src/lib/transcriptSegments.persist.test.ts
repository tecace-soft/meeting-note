import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase, type FakeResult } from '../test/fakeSupabase';

const fixture = vi.hoisted(() => ({ result: {} as unknown, fake: null as unknown }));
vi.mock('../config/supabaseConfig', async () => {
  const { createFakeSupabase } = await import('../test/fakeSupabase');
  const fake = createFakeSupabase(() => fixture.result as FakeResult);
  fixture.fake = fake;
  return { supabase: fake.client };
});
import { persistNoteDiarization } from './transcriptSegments';

const fake = () => fixture.fake as ReturnType<typeof createFakeSupabase>;
const segments = [{ speaker: 'A', text: 'hello', start: 0, end: 1 }] as never;
beforeEach(() => { fake().queries.length = 0; fixture.result = { data: { id: 'n1' } }; });

describe('persistNoteDiarization call contract', () => {
  it('updates diarization by id and confirms one returned row', async () => {
    await persistNoteDiarization('n1', segments);
    expect(fake().queries).toEqual([{ table: 'note', calls: [['update', { diarization: segments }], ['eq', 'id', 'n1'], ['select', 'id'], ['maybeSingle']] }]);
  });
  it('does nothing without a note id', async () => {
    await persistNoteDiarization('', segments);
    expect(fake().queries).toEqual([]);
  });
  it('throws the database error unchanged', async () => {
    const error = { message: 'boom' };
    fixture.result = { error };
    await expect(persistNoteDiarization('n1', segments)).rejects.toBe(error);
  });
  it('throws a permission message on zero rows', async () => {
    fixture.result = { data: null };
    await expect(persistNoteDiarization('n1', segments)).rejects.toThrow('Diarization save did not update the note. You may not have permission to edit this note.');
  });
});
