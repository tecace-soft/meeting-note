import { describe, expect, it, vi } from 'vitest';
import { fetchRecentAudioFiles, type RecentAudioClient } from './recentAudioFilesQuery';

function makeClient(results: Array<{ data: unknown[] | null; error: { message: string } | null }>) {
  const orders: Array<[string, { ascending: boolean }]> = [];
  const selects: string[] = [];
  let call = 0;
  const makeQuery = (result: (typeof results)[number]) => {
    const q: Record<string, unknown> = {};
    q.eq = vi.fn(() => q);
    q.order = vi.fn((c: string, o: { ascending: boolean }) => {
      orders.push([c, o]);
      return q;
    });
    q.limit = vi.fn(() => q);
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej);
    return q;
  };
  const client = {
    from: () => ({
      select: (cols: string) => {
        selects.push(cols);
        return makeQuery(results[call++]);
      },
    }),
  } as unknown as RecentAudioClient;
  return { client, orders, selects };
}

describe('fetchRecentAudioFiles', () => {
  it('orders by created_at desc only and still selects recorded_at', async () => {
    const { client, orders, selects } = makeClient([{ data: [{ id: 'a' }], error: null }]);
    const res = await fetchRecentAudioFiles(client, 'u1');
    expect(orders).toEqual([['created_at', { ascending: false }]]);
    expect(selects[0]).toContain('recorded_at');
    expect(res.data).toEqual([{ id: 'a' }]);
  });

  it('falls back without recorded_at, keeping created_at desc', async () => {
    const { client, orders, selects } = makeClient([
      { data: null, error: { message: 'column file.recorded_at does not exist' } },
      { data: [{ id: 'b' }], error: null },
    ]);
    const res = await fetchRecentAudioFiles(client, 'u1');
    expect(selects[1]).not.toContain('recorded_at');
    expect(orders).toEqual([
      ['created_at', { ascending: false }],
      ['created_at', { ascending: false }],
    ]);
    expect(res.data).toEqual([{ id: 'b' }]);
  });
});
