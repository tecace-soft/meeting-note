import { insertSpeaker, selectSpeakerIdentityRows, updateSpeakerFields } from './speakers/repository';
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
  microsoftDisplayNameForMatch: string,
  microsoftId?: string | null,
  microsoftEmail?: string | null
): Promise<void> {
  const derivedName = deriveSelfSpeakerNameFromMsDisplayName(microsoftDisplayNameForMatch);
  if (!derivedName) return;
  const normalizedMicrosoftId = microsoftId?.trim() || null;
  const normalizedMicrosoftEmail = microsoftEmail?.trim() || null;

  const { data: rows, error } = await selectSpeakerIdentityRows(userId);

  if (error) {
    console.error('ensureSelfSpeakerRow: failed to load speakers', error);
    return;
  }

  const speakerRows = rows ?? [];
  const existingByMicrosoftId = normalizedMicrosoftId
    ? speakerRows.find((row) => row.microsoft_id === normalizedMicrosoftId)
    : null;
  const existing = existingByMicrosoftId ?? findBestSpeakerRowForMsAccount(speakerRows, microsoftDisplayNameForMatch);

  if (existing) {
    const patch: { name?: string; email?: string | null; microsoft_id?: string | null } = {};
    if (existing.name !== derivedName) patch.name = derivedName;
    if (normalizedMicrosoftEmail && existing.email !== normalizedMicrosoftEmail) patch.email = normalizedMicrosoftEmail;
    if (normalizedMicrosoftId && existing.microsoft_id !== normalizedMicrosoftId) patch.microsoft_id = normalizedMicrosoftId;

    if (Object.keys(patch).length === 0) return;

    const { error: updateError } = await updateSpeakerFields({ speakerId: existing.id, userId, patch });

    if (updateError) {
      console.error('ensureSelfSpeakerRow: update failed', updateError);
    }
    return;
  }

  const { error: insertError } = await insertSpeaker({
    userId,
    name: derivedName,
    email: normalizedMicrosoftEmail,
    microsoftId: normalizedMicrosoftId,
  });

  if (!insertError) return;

  const msg = insertError.message?.toLowerCase() ?? '';
  if (!msg.includes('duplicate') && !msg.includes('unique')) {
    console.error('ensureSelfSpeakerRow: insert failed', insertError);
  }
}
