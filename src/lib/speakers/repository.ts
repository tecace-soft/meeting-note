import { supabase } from '../../config/supabaseConfig';
import { requireOwnerId } from '../requireOwnerId';

// T2-3: every page-level `supabase.from('speaker')` call lives here.
// Each method keeps its call site's exact query and error semantics: raw PostgREST errors are
// thrown (or returned, where the caller inspects them) unchanged, and zero-row handling stays with
// the caller unless a method says otherwise. All methods are scoped to the signed-in owner, and
// owner-scoped ones refuse to run without a non-empty userId.

const SPEAKER_FULL_COLUMNS = 'id, name, profile, email, microsoft_id';

/** All of the user's saved speakers, by name. */
export async function listSpeakers<T>(userId: string): Promise<T[]> {
  requireOwnerId(userId);
  const { data, error } = await supabase
    .from('speaker')
    .select(SPEAKER_FULL_COLUMNS)
    .eq('user_id', userId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as T[];
}

/** Saved speakers whose name is in the list. Returns the raw result because callers differ on error handling. */
export function selectSpeakersByNames(userId: string, names: string[], columns: 'name, profile' | 'id, name, profile') {
  requireOwnerId(userId);
  return supabase.from('speaker').select(columns).eq('user_id', userId).in('name', names);
}

/** Speaker row id for an exact name, or null. Errors are ignored (best-effort background use). */
export async function findSpeakerIdByName(userId: string, name: string): Promise<string | null> {
  requireOwnerId(userId);
  const { data } = await supabase
    .from('speaker')
    .select('id')
    .eq('user_id', userId)
    .eq('name', name)
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

/** Stored profile text of one speaker, or null. Errors are ignored (best-effort background use). */
export async function getSpeakerProfile(input: { speakerId: string; userId: string }): Promise<string | null> {
  requireOwnerId(input.userId);
  const { data } = await supabase
    .from('speaker')
    .select('profile')
    .eq('id', input.speakerId)
    .eq('user_id', input.userId)
    .maybeSingle();
  return (data as { profile: string | null } | null)?.profile ?? null;
}

/** Owner-scoped profile write that does not confirm a changed row. Throws the raw error. */
export async function updateSpeakerProfile(input: { speakerId: string; userId: string; profile: string }): Promise<void> {
  requireOwnerId(input.userId);
  const { error } = await supabase
    .from('speaker')
    .update({ profile: input.profile })
    .eq('id', input.speakerId)
    .eq('user_id', input.userId);
  if (error) throw error;
}

/** Owner-scoped profile write returning the changed row id, or null when no row changed (caller decides the message). */
export async function updateSpeakerProfileReturningId(input: {
  speakerId: string;
  userId: string;
  profile: string;
}): Promise<{ id: string } | null> {
  requireOwnerId(input.userId);
  const { data, error } = await supabase
    .from('speaker')
    .update({ profile: input.profile })
    .eq('id', input.speakerId)
    .eq('user_id', input.userId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null) ?? null;
}

/** Owner-scoped partial update of identity fields. Returns the raw result so the caller can log instead of throw. */
export async function updateSpeakerFields(input: {
  speakerId: string;
  userId: string;
  patch: { name?: string; email?: string | null; microsoft_id?: string | null };
}) {
  requireOwnerId(input.userId);
  return supabase.from('speaker').update(input.patch).eq('id', input.speakerId).eq('user_id', input.userId);
}

/** Owner-scoped delete. Throws the raw error and does not confirm a deleted row. */
export async function deleteSpeaker(input: { speakerId: string; userId: string }): Promise<void> {
  requireOwnerId(input.userId);
  const { error } = await supabase.from('speaker').delete().eq('id', input.speakerId).eq('user_id', input.userId);
  if (error) throw error;
}

/**
 * Insert a speaker row. Only the provided optional fields are sent, matching the old call sites.
 * Returns the raw result because callers inspect the error (duplicate/unique means "already exists").
 */
export async function insertSpeaker(input: {
  userId: string;
  name: string;
  profile?: string;
  email?: string | null;
  microsoftId?: string | null;
}) {
  requireOwnerId(input.userId);
  const row: Record<string, unknown> = { user_id: input.userId, name: input.name };
  if (input.profile !== undefined) row.profile = input.profile;
  if (input.email !== undefined) row.email = input.email;
  if (input.microsoftId !== undefined) row.microsoft_id = input.microsoftId;
  return supabase.from('speaker').insert(row);
}

/** Insert a name-only speaker and read back `id, name`. Returns the raw result for duplicate handling. */
export async function insertSpeakerNameReturning(input: { userId: string; name: string }) {
  requireOwnerId(input.userId);
  return supabase.from('speaker').insert({ user_id: input.userId, name: input.name }).select('id, name').single();
}

/** Insert a Microsoft-contact speaker and read back the full row. Returns the raw result for duplicate handling. */
export async function insertContactSpeakerReturning(input: {
  userId: string;
  name: string;
  email: string;
  microsoftId: string;
}) {
  requireOwnerId(input.userId);
  return supabase
    .from('speaker')
    .insert({ user_id: input.userId, name: input.name, email: input.email, microsoft_id: input.microsoftId })
    .select(SPEAKER_FULL_COLUMNS)
    .single();
}

/** Speakers matching a Microsoft id. Throws the raw error. */
export async function findSpeakersByMicrosoftId<T>(userId: string, microsoftId: string): Promise<T[]> {
  requireOwnerId(userId);
  const { data, error } = await supabase
    .from('speaker')
    .select(SPEAKER_FULL_COLUMNS)
    .eq('user_id', userId)
    .eq('microsoft_id', microsoftId);
  if (error) throw error;
  return (data ?? []) as T[];
}

/** Speakers matching an email. Throws the raw error. */
export async function findSpeakersByEmail<T>(userId: string, email: string): Promise<T[]> {
  requireOwnerId(userId);
  const { data, error } = await supabase
    .from('speaker')
    .select(SPEAKER_FULL_COLUMNS)
    .eq('user_id', userId)
    .eq('email', email);
  if (error) throw error;
  return (data ?? []) as T[];
}

/** Identity columns of all the user's speakers (self-row sync). Returns the raw result so the caller can log. */
export function selectSpeakerIdentityRows(userId: string) {
  requireOwnerId(userId);
  return supabase.from('speaker').select('id, name, email, microsoft_id').eq('user_id', userId);
}
