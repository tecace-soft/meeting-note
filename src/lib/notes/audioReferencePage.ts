import type { SupabaseClient } from '@supabase/supabase-js';

// Kept apart from repository.ts on purpose: this module only needs the injected client's type,
// so importing it never creates the app supabase client or reads env at import time.

/** One page of the owner's audio-referencing notes. Takes the client so callers can inject a fake and an abort signal. */
export function selectAudioReferencePage(
  client: SupabaseClient,
  input: { userId: string; from: number; to: number; signal: AbortSignal }
) {
  return client
    .from('note')
    .select('id, name, audio_file, audio_file_id', { count: 'exact' })
    .eq('user_id', input.userId)
    .or('audio_file_id.not.is.null,audio_file.not.is.null')
    .order('id', { ascending: true })
    .range(input.from, input.to)
    .abortSignal(input.signal);
}
