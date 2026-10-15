// "Recent recordings" list query. Ordered by upload time (created_at desc) so a
// just-uploaded old file stays on top; recorded_at (File.lastModified) is only
// selected for display and must not drive the ordering.

const BASE_COLUMNS = 'id, name, bucket, storage_path, public_url, mime_type, size_bytes, source';
export const RECENT_AUDIO_LIMIT = 10;

interface OrderedQuery extends PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> {
  eq(column: string, value: string): OrderedQuery;
  order(column: string, options: { ascending: boolean }): OrderedQuery;
  limit(count: number): OrderedQuery;
}

export interface RecentAudioClient {
  from(table: 'file'): { select(columns: string): OrderedQuery };
}

function buildQuery(client: RecentAudioClient, userId: string, columns: string): OrderedQuery {
  return client
    .from('file')
    .select(columns)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(RECENT_AUDIO_LIMIT);
}

export async function fetchRecentAudioFiles(client: RecentAudioClient, userId: string) {
  const result = await buildQuery(client, userId, `${BASE_COLUMNS}, recorded_at, created_at`);
  if (result.error && /recorded_at/i.test(result.error.message)) {
    // Older DBs without the recorded_at column: same ordering, no meeting date.
    return buildQuery(client, userId, `${BASE_COLUMNS}, created_at`);
  }
  return result;
}
