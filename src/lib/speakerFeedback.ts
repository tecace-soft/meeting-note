import { supabase } from '../config/supabaseConfig';
import { isAnonymousSpeakerLabel, type SpeakerSuggestion } from './identifySpeakers';

// Speaker-suggestion feedback loop (Stage 0): every time a human confirms who an anonymous
// speaker is, record what the model SUGGESTED vs what the human CHOSE. This is the ground
// truth the F8 harness measures suggestion accuracy against over time, and (Stage 2) the
// signal that feeds confirmed identities back into the roster. See the
// `speaker_suggestion_feedback` migration.

export type FeedbackOutcome = 'accepted' | 'overridden' | 'manual';
export type FeedbackSource = 'suggest_sheet' | 'manual_rename';

/** accepted = human kept the suggestion; overridden = human chose a different name than
 *  suggested; manual = no suggestion was shown for this label. */
export function classifyOutcome(suggestedName: string | null, chosenName: string): FeedbackOutcome {
  const s = (suggestedName ?? '').trim().toLowerCase();
  const c = chosenName.trim().toLowerCase();
  if (!s) return 'manual';
  return s === c ? 'accepted' : 'overridden';
}

/** Fire-and-forget: records ONE human speaker decision. Never throws — a logging failure
 *  must not affect the rename the user just made. Only logs decisions on ANONYMOUS labels
 *  (the actual identification task); renaming an already-named speaker is skipped. */
export async function logSpeakerFeedback(input: {
  userId: string | null | undefined;
  noteId: string | null;
  label: string;
  chosenName: string;
  chosenSpeakerId: string | null;
  source: FeedbackSource;
  suggestion: SpeakerSuggestion | null;
  client?: 'web' | 'mobile';
}): Promise<void> {
  try {
    if (!input.userId || !input.chosenName.trim()) return;
    if (!isAnonymousSpeakerLabel(input.label)) return;
    const suggestedName = input.suggestion?.name ?? null;
    const { error } = await supabase.from('speaker_suggestion_feedback').insert({
      user_id: input.userId,
      note_id: input.noteId,
      label: input.label,
      suggested_name: suggestedName,
      suggested_speaker_id: input.suggestion?.speakerId ?? null,
      suggested_confidence: input.suggestion?.confidence ?? null,
      suggested_is_self: input.suggestion?.isSelf ?? null,
      chosen_name: input.chosenName.trim(),
      chosen_speaker_id: input.chosenSpeakerId,
      outcome: classifyOutcome(suggestedName, input.chosenName),
      source: input.source,
      client: input.client ?? 'web',
    });
    if (error) console.warn('speaker feedback log failed:', error.message);
  } catch (err) {
    console.warn('speaker feedback log threw:', err);
  }
}
