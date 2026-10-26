// Recording fake of the supabase query builder for call-chain characterization tests.
// Every builder method is recorded in order; awaiting or terminal calls resolve with the queued result.
export type FakeResult = { data?: unknown; error?: { message: string } | null; count?: number | null };
export type RecordedQuery = { table: string; calls: unknown[][] };

export function createFakeSupabase(resolve: (query: RecordedQuery) => FakeResult) {
  const queries: RecordedQuery[] = [];
  const rpcs: Array<{ name: string; args: unknown }> = [];
  const finish = (query: RecordedQuery) => {
    const r = resolve(query);
    return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
  };
  const client = {
    from(table: string) {
      const query: RecordedQuery = { table, calls: [] };
      queries.push(query);
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'or', 'filter', 'contains', 'order', 'range', 'abortSignal']) {
        builder[method] = (...args: unknown[]) => {
          query.calls.push([method, ...args]);
          return builder;
        };
      }
      for (const method of ['single', 'maybeSingle']) {
        builder[method] = async () => {
          query.calls.push([method]);
          return finish(query);
        };
      }
      builder.then = (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
        Promise.resolve(finish(query)).then(onOk, onErr);
      return builder;
    },
    rpc(name: string, args: unknown) {
      rpcs.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { client, queries, rpcs };
}
