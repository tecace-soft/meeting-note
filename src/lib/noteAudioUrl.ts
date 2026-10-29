import { getSupabaseAccessTokenForRequest, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/supabaseConfig';

/** Owner/access-checked signing through the existing note-audio-url function. */
export async function requestNoteAudioUrl(noteId: string, getAccessToken: () => Promise<string | null>, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const appToken = await getSupabaseAccessTokenForRequest();
  const msToken = appToken ? null : await getAccessToken();
  signal?.throwIfAborted();
  if (!appToken && !msToken) throw new Error('Could not get access. Please sign in again.');
  const response = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/note-audio-url`, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${appToken ?? SUPABASE_ANON_KEY}`,
      ...(msToken ? { 'x-ms-access-token': msToken } : {}),
    },
    body: JSON.stringify({ noteId: noteId }),
  });
  const raw = await response.text();
  let parsed: { url?: unknown; error?: unknown };
  try {
    parsed = raw ? JSON.parse(raw) as { url?: unknown; error?: unknown } : {};
  } catch {
    parsed = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    throw new Error(typeof parsed.error === 'string' ? parsed.error : `Audio request failed (${response.status}).`);
  }
  if (typeof parsed.url !== 'string' || !parsed.url.trim()) {
    throw new Error('Audio URL was not returned.');
  }
  return parsed.url;
}
