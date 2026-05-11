import { supabase } from '../config/supabaseConfig';
import {
  deriveSelfSpeakerNameFromMsDisplayName,
  findBestSpeakerRowForMsAccount,
} from './matchSpeakerIdentity';

/**
 * If the user has no saved speaker that matches their Microsoft display name, insert one
 * using a Latin-only derived name (see deriveSelfSpeakerNameFromMsDisplayName).
 */
export async function ensureSelfSpeakerRowForUser(
  userId: string,
  microsoftDisplayNameForMatch: string
): Promise<void> {
  const derivedName = deriveSelfSpeakerNameFromMsDisplayName(microsoftDisplayNameForMatch);
  if (!derivedName) return;

  const { data: rows, error } = await supabase
    .from('speaker')
    .select('id, name')
    .eq('user_id', userId);

  if (error) {
    console.error('ensureSelfSpeakerRow: failed to load speakers', error);
    return;
  }

  const existing = findBestSpeakerRowForMsAccount(rows ?? [], microsoftDisplayNameForMatch);
  if (existing) return;

  const { error: insertError } = await supabase.from('speaker').insert({
    user_id: userId,
    name: derivedName,
  });

  if (!insertError) return;

  const msg = insertError.message?.toLowerCase() ?? '';
  if (!msg.includes('duplicate') && !msg.includes('unique')) {
    console.error('ensureSelfSpeakerRow: insert failed', insertError);
  }
}
