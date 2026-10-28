import { useState } from 'react';
import { getSupabaseAccessTokenForRequest } from '../../config/supabaseConfig';
import { isNonPersonSpeakerName } from '../../lib/identifySpeakers';
import { canonicalOntologyProfileString } from '../../lib/speakerOntology';
import { insertSpeaker, selectSpeakersByNames, updateSpeakerProfileReturningId } from '../../lib/speakers/repository';
import {
  getNoteDiarizationRaw,
  getSegmentText,
  hasUsableDiarization,
  normalizeTranscript,
  type TranscriptSegment,
} from '../../lib/transcriptSegments';
import { invokeGenerateProfile, type GeneratedHistoryProfile } from './generateProfile';
import type { Note } from './types';

export type ProfileGenStep = 'idle' | 'finding-speakers' | 'generating' | 'ready' | 'error';
export type SaveAllStatus = 'idle' | 'saving' | 'success' | 'error';

export interface UseNoteSpeakersOptions {
  /** Signed-in user id. */
  userId: string | undefined;
  /** Microsoft Graph token provider, used when no app token is available. */
  getAccessToken: () => Promise<string | null>;
  /** Closes the row action menu when the modal is opened from it. */
  closeNoteMenu: () => void;
}

/**
 * Sync Profile (speaker profile generation) for the history page: finds the note's speakers, asks the
 * generate-profile function for a draft per speaker, and saves drafts one by one or all at once. The modal
 * markup stays in the page; this owns its state machine and the speaker writes.
 */
export function useNoteSpeakers(options: UseNoteSpeakersOptions) {
  const { userId, getAccessToken, closeNoteMenu } = options;

  const [profileModalNoteId, setProfileModalNoteId] = useState<string | null>(null);
  const [profileGenStep, setProfileGenStep] = useState<ProfileGenStep>('idle');
  const [profileGenError, setProfileGenError] = useState<string | null>(null);
  const [generatedProfiles, setGeneratedProfiles] = useState<GeneratedHistoryProfile[]>([]);
  const [isSaveAllConfirmOpen, setIsSaveAllConfirmOpen] = useState(false);
  const [saveAllStatus, setSaveAllStatus] = useState<SaveAllStatus>('idle');
  const [saveAllErrorDetails, setSaveAllErrorDetails] = useState<string[]>([]);

  const openProfileModal = async (note: Note) => {
    closeNoteMenu();
    setProfileModalNoteId(note.id);
    setProfileGenStep('finding-speakers');
    setProfileGenError(null);
    setGeneratedProfiles([]);
    try {
      const diarRaw = getNoteDiarizationRaw(note);
      const segments: TranscriptSegment[] = hasUsableDiarization(diarRaw) ? normalizeTranscript(diarRaw) : [];
      if (segments.length === 0) throw new Error('No diarized transcription found for this note.');
      const uniqueSpeakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
      const { data: speakerRows, error: speakerErr } = await selectSpeakersByNames(userId!, uniqueSpeakers, 'id, name, profile');
      if (speakerErr) throw speakerErr;
      const speakerMap = new Map<string, { id: string; profile: string | null }>();
      ((speakerRows ?? []) as { id: string; name: string; profile: string | null }[]).forEach((s) => {
        speakerMap.set(s.name.toLowerCase(), { id: s.id, profile: s.profile });
      });
      const transcriptText = segments.map((s) => `${s.speaker}: ${getSegmentText(s, 'en')}`).join('\n\n');
      setProfileGenStep('generating');
      const appToken = await getSupabaseAccessTokenForRequest();
      const msToken = appToken ? null : await getAccessToken();
      if (!appToken && !msToken) throw new Error('Could not get access. Please sign in again.');
      const auth = { appToken, msToken };
      const results = await Promise.all(
        uniqueSpeakers.map(async (speakerName): Promise<GeneratedHistoryProfile> => {
          const record = speakerMap.get(speakerName.toLowerCase()) ?? null;
          const existingProfile = record?.profile?.trim() || null;
          const data = await invokeGenerateProfile({
            speakerName,
            speakerId: record?.id ?? '',
            transcriptText,
            existingProfile,
          }, auth).catch((error: unknown) => {
            console.error(`generate-profile failed for "${speakerName}"`, error);
            throw new Error(`Edge function error for "${speakerName}": ${error instanceof Error ? error.message : String(error)}`);
          });
          if (data?.error) throw new Error(`Profile error for "${speakerName}": ${data.error}`);
          const draft = canonicalOntologyProfileString(data?.profile ?? '');
          return { speakerId: record?.id ?? null, speakerName, draft, isNew: !existingProfile, saving: false, saved: false, saveError: null };
        })
      );
      setGeneratedProfiles(results);
      setProfileGenStep('ready');
    } catch (err: unknown) {
      setProfileGenError(err instanceof Error ? err.message : 'Profile generation failed');
      setProfileGenStep('error');
    }
  };

  const saveHistoryProfile = async (speakerName: string): Promise<{ ok: boolean; error?: string }> => {
    if (!userId) return { ok: false, error: 'Missing authenticated user.' };
    // Never create a speaker row for a non-person name (an anonymous label like "Speaker A" or the
    // product name "meeting note") — these polluted the roster and re-surfaced as suggestions.
    if (isNonPersonSpeakerName(speakerName)) return { ok: false, error: `"${speakerName}" is not a person name and was not saved as a speaker.` };
    const profile = generatedProfiles.find((p) => p.speakerName === speakerName);
    if (!profile) return { ok: false, error: `Profile "${speakerName}" not found.` };
    setGeneratedProfiles((prev) => prev.map((p) => p.speakerName === speakerName ? { ...p, saving: true, saveError: null } : p));
    try {
      const toSave = canonicalOntologyProfileString(profile.draft);
      if (profile.speakerId) {
        const data = await updateSpeakerProfileReturningId({ speakerId: profile.speakerId, userId, profile: toSave });
        // 0 rows updated (RLS denied / row gone): don't mark it saved.
        if (!data) throw new Error('Could not save the speaker profile. Please refresh and try again.');
      } else {
        const { error } = await insertSpeaker({ userId, name: speakerName, profile: toSave });
        if (error) throw error;
      }
      setGeneratedProfiles((prev) =>
        prev.map((p) => (p.speakerName === speakerName ? { ...p, draft: toSave, saving: false, saved: true } : p))
      );
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Save failed';
      setGeneratedProfiles((prev) => prev.map((p) => p.speakerName === speakerName ? { ...p, saving: false, saveError: message } : p));
      return { ok: false, error: message };
    }
  };

  const confirmSaveAllProfiles = async () => {
    const unsaved = generatedProfiles.filter((p) => !p.saved);
    if (unsaved.length === 0) {
      setSaveAllStatus('success');
      setSaveAllErrorDetails([]);
      setProfileModalNoteId(null);
      return;
    }
    setSaveAllStatus('saving');
    setSaveAllErrorDetails([]);
    const failures: string[] = [];
    for (const profile of unsaved) {
      const result = await saveHistoryProfile(profile.speakerName);
      if (!result.ok) failures.push(`${profile.speakerName}: ${result.error || 'Save failed'}`);
    }
    if (failures.length === 0) {
      setSaveAllStatus('success');
      setProfileModalNoteId(null);
      return;
    }
    setSaveAllErrorDetails(failures);
    setSaveAllStatus('error');
  };

  return {
    profileModalNoteId,
    setProfileModalNoteId,
    profileGenStep,
    profileGenError,
    generatedProfiles,
    setGeneratedProfiles,
    isSaveAllConfirmOpen,
    setIsSaveAllConfirmOpen,
    saveAllStatus,
    setSaveAllStatus,
    saveAllErrorDetails,
    setSaveAllErrorDetails,
    openProfileModal,
    saveHistoryProfile,
    confirmSaveAllProfiles,
  };
}
