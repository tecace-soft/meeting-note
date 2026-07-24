import React, { useId, useState, useEffect, useRef, useCallback, useMemo, startTransition } from 'react';
import { createPortal } from 'react-dom';
import { CloseMd, EditPencilLine01, Loading, Save, Stop, TrashFull, User01, VolumeMax } from 'react-coolicons';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { canonicalOntologyProfileString, isOntologyProfile } from '../lib/speakerOntology';
import { SpeakerOntologyView } from './SpeakerOntologyView';
import { supabase } from '../config/supabaseConfig';
import { findBestSpeakerRowForMsAccount } from '../lib/matchSpeakerIdentity';
import { fetchTecAceContacts, type MicrosoftContact } from '../services/microsoftContacts';
import {
  applySpeakerReplacements,
  getSegmentText,
  getTranscriptAvatarLabel,
  persistNoteDiarization,
  type ReplacementScope,
  type TranscriptLanguage,
  type TranscriptSegment,
} from '../lib/transcriptSegments';

type DbSpeaker = { id: string; name: string; profile?: string | null; email?: string | null; microsoft_id?: string | null };

type SpeakerMenuState = {
  segmentIndex: number;
  originalSpeaker: string;
  top: number;
  left: number;
};

const SPEAKER_MENU_WIDTH = 320;

const SPEAKER_LIST_AVATAR_BACKGROUNDS = [
  'color-mix(in srgb, #a78bfa 45%, var(--bg-secondary))',
  'color-mix(in srgb, #f472b6 45%, var(--bg-secondary))',
  'color-mix(in srgb, var(--accent) 40%, var(--bg-secondary))',
] as const;

function getTextOffsetFromPoint(container: HTMLElement, clientX: number, clientY: number): number | null {
  const doc = container.ownerDocument;
  const pointDocument = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };

  let targetNode: Node | null = null;
  let targetOffset = 0;
  const position = pointDocument.caretPositionFromPoint?.(clientX, clientY);
  if (position) {
    targetNode = position.offsetNode;
    targetOffset = position.offset;
  } else {
    const range = pointDocument.caretRangeFromPoint?.(clientX, clientY);
    if (range) {
      targetNode = range.startContainer;
      targetOffset = range.startOffset;
    }
  }

  if (!targetNode || !container.contains(targetNode)) return null;

  let textOffset = 0;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const length = current.textContent?.length ?? 0;
    if (current === targetNode) {
      return textOffset + Math.min(targetOffset, length);
    }
    textOffset += length;
    current = walker.nextNode();
  }

  return null;
}

function setEditableCaretOffset(editable: HTMLElement, offset: number | null): void {
  editable.focus();
  const doc = editable.ownerDocument;
  const range = doc.createRange();
  const selection = window.getSelection();
  const targetOffset = Math.max(0, offset ?? editable.innerText.length);
  let remaining = targetOffset;
  const walker = doc.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();

  while (current) {
    const length = current.textContent?.length ?? 0;
    if (remaining <= length) {
      range.setStart(current, remaining);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    remaining -= length;
    current = walker.nextNode();
  }

  range.selectNodeContents(editable);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export interface TranscriptDiarizedEditorProps {
  segments: TranscriptSegment[];
  onSegmentsChange: (next: TranscriptSegment[]) => void;
  noteId: string | null;
  /** Tailwind height/overflow classes for the segment list (default: max-h-96). */
  scrollContainerClassName?: string;
  selectedSpeakerFilters?: string[];
  onSelectedSpeakerFiltersChange?: (next: string[]) => void;
  activePlaybackSegmentIndex?: number | null;
  isPlaybackActive?: boolean;
  loadingPlaybackSegmentIndex?: number | null;
  playbackTimeLabel?: string | null;
  canPlaySegment?: (segment: TranscriptSegment, index: number) => boolean;
  onPlaySegment?: (segment: TranscriptSegment, index: number) => void;
  transcriptLanguage?: TranscriptLanguage;
  onPersistSegments?: (next: TranscriptSegment[]) => Promise<void>;
  onNoteShared?: (sharedUserIds: string[]) => void;
}

export function getTranscriptSpeakerFilters(segments: TranscriptSegment[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const seg of segments) {
    const speaker = seg.speaker.trim() || 'Speaker';
    if (seen.has(speaker)) continue;
    seen.add(speaker);
    ordered.push(speaker);
  }
  return ordered;
}

interface TranscriptSpeakerFilterControlsProps {
  speakers: string[];
  selectedSpeakers: string[];
  onSelectedSpeakersChange: (next: string[]) => void;
}

export const TranscriptSpeakerFilterControls: React.FC<TranscriptSpeakerFilterControlsProps> = ({
  speakers,
  selectedSpeakers,
  onSelectedSpeakersChange,
}) => {
  const { t } = useLanguage();
  if (speakers.length <= 1) return null;

  const toggleSpeaker = (speaker: string) => {
    onSelectedSpeakersChange(
      selectedSpeakers.includes(speaker)
        ? selectedSpeakers.filter((value) => value !== speaker)
        : [...selectedSpeakers, speaker]
    );
  };

  return (
    <div className="transcript-speaker-filter-row flex min-w-0 items-center gap-1.5">
      <label className="sr-only" htmlFor="transcript-speaker-filter-select">
        {t('filterTranscriptBySpeaker')}
      </label>
      <select
        id="transcript-speaker-filter-select"
        className="transcript-speaker-filter-select sm:hidden"
        value={selectedSpeakers[0] ?? ''}
        onChange={(e) => onSelectedSpeakersChange(e.target.value ? [e.target.value] : [])}
        aria-label={t('filterTranscriptBySpeaker')}
      >
        <option value="">{t('allSpeakers')}</option>
        {speakers.map((speaker) => (
          <option key={speaker} value={speaker}>
            {speaker}
          </option>
        ))}
      </select>
      <div className="hidden flex-wrap items-center gap-1.5 sm:flex">
        <button
          type="button"
          className={`transcript-speaker-filter-chip ${selectedSpeakers.length === 0 ? 'transcript-speaker-filter-chip-active' : ''}`}
          aria-pressed={selectedSpeakers.length === 0}
          onClick={() => onSelectedSpeakersChange([])}
        >
          {t('allSpeakers')}
        </button>
        {speakers.map((speaker) => {
          const isActive = selectedSpeakers.includes(speaker);
          return (
            <button
              key={speaker}
              type="button"
              className={`transcript-speaker-filter-chip ${isActive ? 'transcript-speaker-filter-chip-active' : ''}`}
              aria-pressed={isActive}
              title={`Filter by ${speaker}`}
              onClick={() => toggleSpeaker(speaker)}
            >
              <span className="transcript-speaker-filter-chip-label">{speaker}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

const TranscriptDiarizedEditor: React.FC<TranscriptDiarizedEditorProps> = ({
  segments,
  onSegmentsChange,
  noteId,
  scrollContainerClassName,
  selectedSpeakerFilters = [],
  onSelectedSpeakerFiltersChange,
  activePlaybackSegmentIndex = null,
  isPlaybackActive = false,
  loadingPlaybackSegmentIndex = null,
  playbackTimeLabel = null,
  canPlaySegment,
  onPlaySegment,
  transcriptLanguage = 'original',
  onPersistSegments,
  onNoteShared,
}) => {
  const scopeGroupId = useId();
  const { user, getAccessToken } = useAuth();
  const { t } = useLanguage();
  const [speakerMenu, setSpeakerMenu] = useState<SpeakerMenuState | null>(null);
  const [savedSpeakers, setSavedSpeakers] = useState<DbSpeaker[]>([]);
  const [microsoftContacts, setMicrosoftContacts] = useState<MicrosoftContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsFetchError, setContactsFetchError] = useState<string | null>(null);
  const [speakersLoading, setSpeakersLoading] = useState(false);
  const [speakersFetchError, setSpeakersFetchError] = useState<string | null>(null);
  const [speakerNameInput, setSpeakerNameInput] = useState('');
  const [pickedSpeakerId, setPickedSpeakerId] = useState<string | null>(null);
  const [replacementScope, setReplacementScope] = useState<ReplacementScope>('single');
  const [speakerMenuError, setSpeakerMenuError] = useState<string | null>(null);
  const [speakerChangeSaving, setSpeakerChangeSaving] = useState(false);
  const [deletingSpeakerId, setDeletingSpeakerId] = useState<string | null>(null);
  const [speakerDeleteConfirm, setSpeakerDeleteConfirm] = useState<{ id: string; name: string } | null>(null);
  const [speakerDeleteConfirmError, setSpeakerDeleteConfirmError] = useState<string | null>(null);
  const [speakerProfileView, setSpeakerProfileView] = useState<{ id: string; name: string; profile: string | null } | null>(null);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [profileDraft, setProfileDraft] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [editingSegment, setEditingSegment] = useState<{ index: number; text: string } | null>(null);
  const [segmentEditSavingIndex, setSegmentEditSavingIndex] = useState<number | null>(null);
  const [segmentEditError, setSegmentEditError] = useState<string | null>(null);
  const speakerMenuPanelRef = useRef<HTMLDivElement>(null);
  const segmentEditTextRef = useRef<HTMLDivElement | null>(null);
  const pendingSegmentCaretOffsetRef = useRef<number | null>(null);
  const segmentEditDraftRef = useRef('');
  const segmentEditSaveTimeoutRef = useRef<number | null>(null);

  const closeSpeakerMenu = useCallback(() => {
    setSpeakerMenu(null);
    setSpeakerNameInput('');
    setPickedSpeakerId(null);
    setReplacementScope('single');
    setSpeakerMenuError(null);
    setSpeakersFetchError(null);
    setContactsFetchError(null);
    setMicrosoftContacts([]);
    setSpeakerDeleteConfirm(null);
    setSpeakerDeleteConfirmError(null);
    setSpeakerProfileView(null);
    setIsEditingProfile(false);
    setProfileDraft('');
    setProfileSaveError(null);
  }, []);

  useEffect(() => {
    if (!editingSegment) return;
    segmentEditDraftRef.current = editingSegment.text;
    const frameId = window.requestAnimationFrame(() => {
      const editable = segmentEditTextRef.current;
      if (!editable) return;
      setEditableCaretOffset(editable, pendingSegmentCaretOffsetRef.current);
      pendingSegmentCaretOffsetRef.current = null;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [editingSegment?.index]);

  useEffect(() => {
    return () => {
      if (segmentEditSaveTimeoutRef.current != null) {
        window.clearTimeout(segmentEditSaveTimeoutRef.current);
      }
    };
  }, []);

  const startSegmentTextEdit = useCallback(
    (segmentIndex: number, segment: TranscriptSegment, caretOffset: number | null = null) => {
      setSegmentEditError(null);
      pendingSegmentCaretOffsetRef.current = caretOffset;
      setEditingSegment({
        index: segmentIndex,
        text: getSegmentText(segment, transcriptLanguage),
      });
    },
    [transcriptLanguage]
  );

  const cancelSegmentTextEdit = useCallback(() => {
    setEditingSegment(null);
    setSegmentEditError(null);
  }, []);

  const saveSegmentTextEdit = useCallback(async (options: { close?: boolean } = {}) => {
    if (!editingSegment) return;
    const shouldClose = options.close ?? true;
    const targetSegment = segments[editingSegment.index];
    if (!targetSegment) {
      setEditingSegment(null);
      return;
    }

    const nextText = (segmentEditTextRef.current?.innerText ?? segmentEditDraftRef.current ?? editingSegment.text).trim();
    const currentText = getSegmentText(targetSegment, transcriptLanguage).trim();
    if (nextText === currentText) {
      if (shouldClose) setEditingSegment(null);
      setSegmentEditError(null);
      return;
    }

    const nextTranscript = segments.map((segment, index) => {
      if (index !== editingSegment.index) return segment;
      if (transcriptLanguage === 'original') {
        return { ...segment, text: nextText };
      }
      return {
        ...segment,
        translations: {
          ...(segment.translations ?? {}),
          [transcriptLanguage]: nextText,
        },
      };
    });

      setSegmentEditSavingIndex(editingSegment.index);
      setSegmentEditError(null);
    try {
      if (noteId) {
        if (onPersistSegments) {
          await onPersistSegments(nextTranscript);
        } else {
          await persistNoteDiarization(noteId, nextTranscript);
        }
      }
      startTransition(() => {
        onSegmentsChange(nextTranscript);
      });
      if (shouldClose) {
        setEditingSegment(null);
      }
    } catch (err) {
      console.error('Failed to save transcript segment edit:', err);
      setSegmentEditError(err instanceof Error ? err.message : t('failedSaveSegmentEdit'));
    } finally {
      setSegmentEditSavingIndex(null);
    }
  }, [editingSegment, noteId, onPersistSegments, onSegmentsChange, segments, t, transcriptLanguage]);

  const scheduleSegmentTextAutosave = useCallback(() => {
    if (segmentEditSaveTimeoutRef.current != null) {
      window.clearTimeout(segmentEditSaveTimeoutRef.current);
    }
    segmentEditSaveTimeoutRef.current = window.setTimeout(() => {
      segmentEditSaveTimeoutRef.current = null;
      void saveSegmentTextEdit({ close: false });
    }, 700);
  }, [saveSegmentTextEdit]);

  const loadSpeakersForMenu = useCallback(async () => {
    if (!user?.id) {
      setSpeakersFetchError('You must be signed in to load speakers.');
      setSavedSpeakers([]);
      return;
    }
    setSpeakersLoading(true);
    setSpeakersFetchError(null);
    try {
      const { data, error } = await supabase
        .from('speaker')
        .select('id, name, profile, email, microsoft_id')
        .eq('user_id', user.id)
        .order('name', { ascending: true });
      if (error) throw error;
      setSavedSpeakers((data as DbSpeaker[]) ?? []);
    } catch (err: unknown) {
      console.error('Failed to load speakers:', err);
      setSpeakersFetchError(err instanceof Error ? err.message : 'Failed to load speakers');
      setSavedSpeakers([]);
    } finally {
      setSpeakersLoading(false);
    }
  }, [user?.id]);

  const loadMicrosoftContactsForMenu = useCallback(async () => {
    setContactsLoading(true);
    setContactsFetchError(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Could not get Microsoft Graph access. Please sign in again.');
      const contacts = await fetchTecAceContacts(token);
      setMicrosoftContacts(contacts);
    } catch (err: unknown) {
      console.error('Failed to load Microsoft contacts:', err);
      setContactsFetchError(err instanceof Error ? err.message : 'Failed to load Microsoft contacts');
      setMicrosoftContacts([]);
    } finally {
      setContactsLoading(false);
    }
  }, [getAccessToken]);

  useEffect(() => {
    if (!speakerMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (speakerDeleteConfirm && !deletingSpeakerId) {
        setSpeakerDeleteConfirm(null);
        setSpeakerDeleteConfirmError(null);
        return;
      }
      closeSpeakerMenu();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [speakerMenu, speakerDeleteConfirm, deletingSpeakerId, closeSpeakerMenu]);

  useEffect(() => {
    if (!speakerMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-transcript-speaker-trigger]')) return;
      // Delete confirm is portaled outside the speaker panel; ignore so we don't close the menu
      // (and clear confirm state) before the confirm button's click runs.
      if (t?.closest('[data-speaker-delete-confirm]')) return;
      if (t?.closest('[data-speaker-profile-modal]')) return;
      const el = speakerMenuPanelRef.current;
      if (el && !el.contains(e.target as Node)) closeSpeakerMenu();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [speakerMenu, closeSpeakerMenu]);

  const openSpeakerMenuFromSegment = (segmentIndex: number, anchorEl: HTMLElement) => {
    if (!user?.id) return;
    const seg = segments[segmentIndex];
    if (!seg) return;
    const rect = anchorEl.getBoundingClientRect();
    const w = SPEAKER_MENU_WIDTH;
    let left = Math.min(rect.left, window.innerWidth - w - 8);
    left = Math.max(8, left);
    const estH = 420;
    let top = rect.bottom + 8;
    if (top + estH > window.innerHeight - 8) {
      top = Math.max(8, rect.top - estH - 8);
    }
    setSpeakerMenu({
      segmentIndex,
      originalSpeaker: seg.speaker,
      top,
      left,
    });
    setSpeakerNameInput('');
    setPickedSpeakerId(null);
    setReplacementScope('single');
    setSpeakerMenuError(null);
    setSpeakersFetchError(null);
    setContactsFetchError(null);
    void loadSpeakersForMenu();
    void loadMicrosoftContactsForMenu();
  };

  const openSpeakerProfileView = (row: DbSpeaker) => {
    const profile = row.profile?.trim() || null;
    setSpeakerProfileView({ id: row.id, name: row.name, profile });
    setIsEditingProfile(false);
    // Pretty-print JSON draft if it's an ontology, otherwise keep as-is
    if (profile && isOntologyProfile(profile)) {
      try {
        setProfileDraft(JSON.stringify(JSON.parse(profile), null, 2));
      } catch {
        setProfileDraft(profile);
      }
    } else {
      setProfileDraft(profile ?? '');
    }
    setProfileSaveError(null);
  };

  const handleSaveProfileEdit = async () => {
    if (!speakerProfileView || !user?.id) return;
    setSavingProfile(true);
    setProfileSaveError(null);
    try {
      const toSave = canonicalOntologyProfileString(profileDraft);
      const { error } = await supabase
        .from('speaker')
        .update({ profile: toSave })
        .eq('id', speakerProfileView.id)
        .eq('user_id', user.id);
      if (error) throw error;
      setSpeakerProfileView((prev) => (prev ? { ...prev, profile: toSave } : prev));
      setSavedSpeakers((prev) =>
        prev.map((s) => (s.id === speakerProfileView.id ? { ...s, profile: toSave } : s))
      );
      setProfileDraft(toSave);
      setIsEditingProfile(false);
    } catch (err: unknown) {
      setProfileSaveError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSavingProfile(false);
    }
  };

  const openSpeakerDeleteConfirm = (row: DbSpeaker) => {
    setSpeakerDeleteConfirmError(null);
    setSpeakerDeleteConfirm({ id: row.id, name: row.name });
  };

  const confirmDeleteSavedSpeaker = async () => {
    if (!speakerDeleteConfirm || !user?.id) return;
    const speakerId = speakerDeleteConfirm.id;
    setSpeakerDeleteConfirmError(null);
    setDeletingSpeakerId(speakerId);
    try {
      const { error } = await supabase
        .from('speaker')
        .delete()
        .eq('id', speakerId)
        .eq('user_id', user.id);
      if (error) throw error;
      setSavedSpeakers((prev) => prev.filter((s) => s.id !== speakerId));
      if (pickedSpeakerId === speakerId) {
        setPickedSpeakerId(null);
        setSpeakerNameInput('');
      }
      setSpeakerDeleteConfirm(null);
    } catch (err: unknown) {
      console.error('Failed to delete speaker:', err);
      setSpeakerDeleteConfirmError(err instanceof Error ? err.message : 'Could not delete speaker');
    } finally {
      setDeletingSpeakerId(null);
    }
  };

  const shareCurrentNoteWithMicrosoftUser = async (microsoftUserId: string | null | undefined) => {
    const targetUserId = microsoftUserId?.trim();
    if (!noteId || !targetUserId) return;

    const { data, error: fetchError } = await supabase
      .from('note')
      .select('user_id, shared_users')
      .eq('id', noteId)
      .single();
    if (fetchError) throw fetchError;

    const noteRow = data as { user_id?: string | null; shared_users?: unknown } | null;
    if (!noteRow) return;

    const rawSharedUsers = noteRow.shared_users;
    const sharedUsers = Array.isArray(rawSharedUsers)
      ? rawSharedUsers.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
      : [];
    if (noteRow.user_id === targetUserId || sharedUsers.includes(targetUserId)) {
      onNoteShared?.(sharedUsers);
      return;
    }

    const nextSharedUsers = [...sharedUsers, targetUserId];
    const { error: updateError } = await supabase
      .from('note')
      .update({ shared_users: nextSharedUsers })
      .eq('id', noteId);
    if (updateError) throw updateError;
    onNoteShared?.(nextSharedUsers);
  };

  const handleApplySpeakerChange = async () => {
    if (!speakerMenu || !user?.id) return;
    const chosenName = speakerNameInput.trim();
    if (!chosenName) {
      setSpeakerMenuError('Enter or select a speaker name.');
      return;
    }
    setSpeakerMenuError(null);
    setSpeakerChangeSaving(true);
    try {
      const exists = savedSpeakers.some((s) => s.name.toLowerCase() === chosenName.toLowerCase());
      if (!exists) {
        const { data: inserted, error: insertError } = await supabase
          .from('speaker')
          .insert({ user_id: user.id, name: chosenName })
          .select('id, name')
          .single();
        if (insertError) {
          const msg = insertError.message?.toLowerCase() ?? '';
          if (!msg.includes('duplicate') && !msg.includes('unique')) {
            throw insertError;
          }
          await loadSpeakersForMenu();
        } else if (inserted) {
          setSavedSpeakers((prev) => {
            const next = [...prev, inserted as DbSpeaker];
            next.sort((a, b) => a.name.localeCompare(b.name));
            return next;
          });
        }
      }

      const nextTranscript = applySpeakerReplacements(
        segments,
        speakerMenu.segmentIndex,
        speakerMenu.originalSpeaker,
        chosenName,
        replacementScope
      );

      if (noteId) {
        if (onPersistSegments) {
          await onPersistSegments(nextTranscript);
        } else {
          await persistNoteDiarization(noteId, nextTranscript);
        }
      }

      const selectedSpeaker =
        (pickedSpeakerId ? savedSpeakers.find((s) => s.id === pickedSpeakerId) : null) ??
        savedSpeakers.find((s) => s.name.toLowerCase() === chosenName.toLowerCase()) ??
        null;
      await shareCurrentNoteWithMicrosoftUser(selectedSpeaker?.microsoft_id);

      startTransition(() => {
        onSegmentsChange(nextTranscript);
      });
      closeSpeakerMenu();
    } catch (err: unknown) {
      console.error('Speaker change failed:', err);
      setSpeakerMenuError(err instanceof Error ? err.message : 'Could not save or apply speaker change');
    } finally {
      setSpeakerChangeSaving(false);
    }
  };

  const handleSelectMicrosoftContact = async (contact: MicrosoftContact) => {
    if (!speakerMenu || !user?.id) return;
    setSpeakerMenuError(null);
    setSpeakerChangeSaving(true);
    try {
      const contactEmail = contact.email.trim().toLowerCase();
      const existing =
        savedSpeakers.find((s) => s.microsoft_id && s.microsoft_id === contact.id) ??
        savedSpeakers.find((s) => (s.email ?? '').trim().toLowerCase() === contactEmail);

      let speakerRow = existing ?? null;
      if (!speakerRow) {
        const { data, error } = await supabase
          .from('speaker')
          .insert({
            user_id: user.id,
            name: contact.displayName,
            email: contact.email,
            microsoft_id: contact.id,
          })
          .select('id, name, profile, email, microsoft_id')
          .single();

        if (error) {
          const msg = error.message?.toLowerCase() ?? '';
          if (!msg.includes('duplicate') && !msg.includes('unique')) throw error;

          const { data: microsoftRows, error: microsoftLookupError } = await supabase
            .from('speaker')
            .select('id, name, profile, email, microsoft_id')
            .eq('user_id', user.id)
            .eq('microsoft_id', contact.id);
          if (microsoftLookupError) throw microsoftLookupError;

          speakerRow = ((microsoftRows ?? []) as DbSpeaker[])[0] ?? null;
          if (!speakerRow) {
            const { data: emailRows, error: emailLookupError } = await supabase
              .from('speaker')
              .select('id, name, profile, email, microsoft_id')
              .eq('user_id', user.id)
              .eq('email', contact.email);
            if (emailLookupError) throw emailLookupError;
            speakerRow = ((emailRows ?? []) as DbSpeaker[])[0] ?? null;
          }
        } else {
          speakerRow = data as DbSpeaker;
        }
      }

      if (!speakerRow) throw new Error(`Could not create or find speaker for ${contact.displayName}.`);

      setSavedSpeakers((prev) => {
        const withoutDuplicate = prev.filter((s) => s.id !== speakerRow!.id);
        const next = [...withoutDuplicate, speakerRow!];
        next.sort((a, b) => a.name.localeCompare(b.name));
        return next;
      });

      const nextTranscript = applySpeakerReplacements(
        segments,
        speakerMenu.segmentIndex,
        speakerMenu.originalSpeaker,
        speakerRow.name,
        replacementScope
      );

      if (noteId) {
        if (onPersistSegments) {
          await onPersistSegments(nextTranscript);
        } else {
          await persistNoteDiarization(noteId, nextTranscript);
        }
      }
      await shareCurrentNoteWithMicrosoftUser(speakerRow.microsoft_id);

      startTransition(() => {
        onSegmentsChange(nextTranscript);
      });
      closeSpeakerMenu();
    } catch (err: unknown) {
      console.error('Microsoft contact speaker change failed:', err);
      setSpeakerMenuError(err instanceof Error ? err.message : 'Could not apply Microsoft contact');
    } finally {
      setSpeakerChangeSaving(false);
    }
  };

  const filteredSavedSpeakers = savedSpeakers.filter((s) =>
    s.name.toLowerCase().includes(speakerNameInput.trim().toLowerCase())
  );

  const filteredMicrosoftContacts = microsoftContacts.filter((contact) => {
    const query = speakerNameInput.trim().toLowerCase();
    if (!query) return true;
    return (
      contact.displayName.toLowerCase().includes(query) ||
      contact.email.toLowerCase().includes(query) ||
      contact.userPrincipalName.toLowerCase().includes(query)
    );
  });

  const matchedSelfSpeaker = useMemo(
    () => findBestSpeakerRowForMsAccount(savedSpeakers, user?.displayName ?? ''),
    [savedSpeakers, user?.displayName]
  );

  const displayOrderedSpeakers = useMemo(() => {
    if (!matchedSelfSpeaker) return filteredSavedSpeakers;
    const selfRow = filteredSavedSpeakers.find((s) => s.id === matchedSelfSpeaker.id);
    if (!selfRow) return filteredSavedSpeakers;
    return [selfRow, ...filteredSavedSpeakers.filter((s) => s.id !== matchedSelfSpeaker.id)];
  }, [filteredSavedSpeakers, matchedSelfSpeaker]);

  const transcriptSpeakers = useMemo(() => getTranscriptSpeakerFilters(segments), [segments]);

  useEffect(() => {
    if (!onSelectedSpeakerFiltersChange) return;
    const next = selectedSpeakerFilters.filter((speaker) => transcriptSpeakers.includes(speaker));
    if (next.length !== selectedSpeakerFilters.length) onSelectedSpeakerFiltersChange(next);
  }, [onSelectedSpeakerFiltersChange, selectedSpeakerFilters, transcriptSpeakers]);

  const visibleSegments = useMemo(() => {
    const selected = new Set(selectedSpeakerFilters);
    return segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => selected.size === 0 || selected.has(segment.speaker.trim() || 'Speaker'));
  }, [segments, selectedSpeakerFilters]);

  return (
    <>
      <div
        className={`rounded-lg p-4 text-base leading-relaxed overflow-y-auto custom-scrollbar ${scrollContainerClassName ?? 'max-h-96'}`}
        style={{ backgroundColor: 'transparent' }}
      >
        <div className="space-y-3">
          {visibleSegments.map(({ segment: seg, index: segmentIndex }) => {
            const segmentPlayable = Boolean(canPlaySegment?.(seg, segmentIndex));
            const segmentIsPlaying = segmentPlayable && activePlaybackSegmentIndex === segmentIndex && isPlaybackActive;
            const segmentIsLoading = segmentPlayable && loadingPlaybackSegmentIndex === segmentIndex;
            return (
            <div key={segmentIndex} className="transcript-segment flex min-h-[75px] items-center gap-3">
              <div
                className="transcript-speaker-avatar flex h-9 w-9 min-w-[2.25rem] shrink-0 items-center justify-center self-center rounded-full text-sm font-semibold"
                style={{
                  backgroundColor: 'color-mix(in srgb, var(--accent) 22%, var(--bg-secondary))',
                  color: 'var(--text)',
                }}
              >
                {getTranscriptAvatarLabel(seg.speaker)}
              </div>
              <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                <button
                  type="button"
                  data-transcript-speaker-trigger
                  className={`transcript-speaker-trigger text-left text-base font-semibold ${
                    speakerMenu?.segmentIndex === segmentIndex ? 'transcript-speaker-trigger-active' : ''
                  }`}
                  style={{ color: 'var(--accent)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    openSpeakerMenuFromSegment(segmentIndex, e.currentTarget);
                  }}
                >
                  {seg.speaker.trim() || 'Speaker'}
                </button>
                {segmentPlayable ? (
                  <span className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlaySegment?.(seg, segmentIndex);
                      }}
                      className={`transcript-segment-audio-btn ${segmentIsPlaying ? 'transcript-segment-audio-btn-active' : ''}`}
                      title={`${segmentIsPlaying ? 'Stop' : 'Play'} segment from ${seg.speaker.trim() || 'Speaker'}`}
                      aria-label={`${segmentIsPlaying ? 'Stop' : 'Play'} segment from ${seg.speaker.trim() || 'Speaker'}`}
                    >
                      {segmentIsLoading ? (
                        <Loading className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : segmentIsPlaying ? (
                        <Stop className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <VolumeMax className="h-3.5 w-3.5" aria-hidden />
                      )}
                    </button>
                    {segmentIsPlaying && playbackTimeLabel ? (
                      <span className="transcript-segment-audio-time">{playbackTimeLabel}</span>
                    ) : null}
                  </span>
                ) : null}
              </div>
              {editingSegment?.index === segmentIndex ? (
                <div className="mt-0.5">
                  <div
                    ref={segmentEditTextRef}
                    contentEditable={segmentEditSavingIndex !== segmentIndex}
                    suppressContentEditableWarning
                    className="transcript-segment-edit-text"
                    role="textbox"
                    aria-label={t('editTranscriptSegment')}
                    onBlur={() => {
                      if (editingSegment?.index === segmentIndex && segmentEditSavingIndex !== segmentIndex) {
                        if (segmentEditSaveTimeoutRef.current != null) {
                          window.clearTimeout(segmentEditSaveTimeoutRef.current);
                          segmentEditSaveTimeoutRef.current = null;
                        }
                        void saveSegmentTextEdit();
                      }
                    }}
                    onInput={(e) => {
                      segmentEditDraftRef.current = e.currentTarget.innerText;
                      scheduleSegmentTextAutosave();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        if (segmentEditSaveTimeoutRef.current != null) {
                          window.clearTimeout(segmentEditSaveTimeoutRef.current);
                          segmentEditSaveTimeoutRef.current = null;
                        }
                        cancelSegmentTextEdit();
                        return;
                      }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (segmentEditSaveTimeoutRef.current != null) {
                          window.clearTimeout(segmentEditSaveTimeoutRef.current);
                          segmentEditSaveTimeoutRef.current = null;
                        }
                        void saveSegmentTextEdit();
                      }
                    }}
                  >
                    {editingSegment.text}
                  </div>
                  {segmentEditError ? (
                    <p className="mt-1 text-xs" style={{ color: 'var(--error)' }}>
                      {segmentEditError}
                    </p>
                  ) : null}
                </div>
              ) : (
                <button
                  type="button"
                  className="transcript-segment-text-button mt-0.5 text-base font-normal leading-relaxed whitespace-pre-wrap"
                  style={{ color: 'var(--text-secondary)' }}
                  title={t('editTranscriptSegment')}
                  onClick={(e) => {
                    e.stopPropagation();
                    const caretOffset = getTextOffsetFromPoint(e.currentTarget, e.clientX, e.clientY);
                    startSegmentTextEdit(segmentIndex, seg, caretOffset);
                  }}
                >
                  {getSegmentText(seg, transcriptLanguage)}
                </button>
              )}
            </div>
          </div>
            );
          })}
        </div>
      </div>

      {speakerMenu &&
        createPortal(
          <div
            ref={speakerMenuPanelRef}
            className="fixed z-[70] max-h-[min(100vh-1rem,520px)] overflow-hidden rounded-xl app-surface-elevated flex flex-col"
            style={{
              top: speakerMenu.top,
              left: speakerMenu.left,
              width: SPEAKER_MENU_WIDTH,
              backgroundColor: 'var(--surface)',
            }}
            role="dialog"
            aria-labelledby="change-speaker-title"
          >
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
              <h2 id="change-speaker-title" className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                Change Speaker
              </h2>
              <button
                type="button"
                onClick={closeSpeakerMenu}
                className="rounded-md p-1 transition-colors hover:opacity-80"
                style={{ color: 'var(--text-muted)' }}
                aria-label="Close"
              >
                <CloseMd className="h-4 w-4" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
              <input
                type="text"
                value={speakerNameInput}
                onChange={(e) => {
                  setSpeakerNameInput(e.target.value);
                  setPickedSpeakerId(null);
                }}
                placeholder={t('searchOrTypeSpeaker')}
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
                style={{
                  backgroundColor: 'var(--surface-subtle)',
                  color: 'var(--text)',
                  borderColor: 'var(--border)',
                }}
              />
              <div
                className="mt-3 min-h-0 flex-1 overflow-hidden rounded-lg"
                style={{ backgroundColor: 'var(--surface-subtle)' }}
              >
                {speakersLoading || contactsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loading className="h-6 w-6 animate-spin" style={{ color: 'var(--accent)' }} />
                  </div>
                ) : speakersFetchError || contactsFetchError ? (
                  <div className="space-y-2 p-3">
                    {speakersFetchError ? (
                      <p className="text-xs" style={{ color: 'var(--error)' }}>
                        {speakersFetchError}
                      </p>
                    ) : null}
                    {contactsFetchError ? (
                      <p className="text-xs" style={{ color: 'var(--error)' }}>
                        {contactsFetchError}
                      </p>
                    ) : null}
                  </div>
                ) : filteredSavedSpeakers.length === 0 && filteredMicrosoftContacts.length === 0 ? (
                  <p className="p-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                    No matches. Type a new name to add one.
                  </p>
                ) : (
                  <ul className="max-h-[13.5rem] overflow-y-auto custom-scrollbar" style={{ maxHeight: '13.5rem' }}>
                    {displayOrderedSpeakers.length > 0 ? (
                      <li
                        className="border-b px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-wide"
                        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                      >
                        {t('savedSpeakers')}
                      </li>
                    ) : null}
                    {displayOrderedSpeakers.map((row, i) => {
                      const isMe = matchedSelfSpeaker?.id === row.id;
                      const labelText = isMe ? `${row.name} (me)` : row.name;
                      return (
                      <li
                        key={row.id}
                        className="flex items-center border-b last:border-b-0"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSpeakerNameInput(row.name);
                            setPickedSpeakerId(row.id);
                          }}
                          className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors"
                          style={{
                            backgroundColor:
                              pickedSpeakerId === row.id ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                            color: 'var(--text)',
                          }}
                        >
                          <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                            style={{
                              backgroundColor: SPEAKER_LIST_AVATAR_BACKGROUNDS[i % SPEAKER_LIST_AVATAR_BACKGROUNDS.length],
                              color: 'var(--text)',
                            }}
                          >
                            {getTranscriptAvatarLabel(row.name)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {row.name}
                              {isMe ? (
                                <span className="font-normal" style={{ color: 'var(--text-muted)' }}>
                                  {' '}
                                  (me)
                                </span>
                              ) : null}
                            </span>
                            {row.microsoft_id && row.email ? (
                              <span className="block truncate text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                                {row.email}
                              </span>
                            ) : null}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openSpeakerProfileView(row);
                          }}
                          className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-md text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-secondary)] hover:text-[var(--accent)]"
                          title={`View profile for "${labelText}"`}
                          aria-label={`View profile for ${labelText}`}
                        >
                          <User01 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        </button>
                        <button
                          type="button"
                          disabled={speakerChangeSaving || deletingSpeakerId === row.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            openSpeakerDeleteConfirm(row);
                          }}
                          className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-md text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-secondary)] hover:text-[var(--error)] disabled:opacity-40"
                          title={`Remove "${labelText}" from saved speakers`}
                          aria-label={`Delete saved speaker ${labelText}`}
                        >
                          <TrashFull className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        </button>
                      </li>
                    );
                    })}
                    {filteredMicrosoftContacts.length > 0 ? (
                      <li
                        className="border-b px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-wide"
                        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                      >
                        TecAce contacts
                      </li>
                    ) : null}
                    {filteredMicrosoftContacts.map((contact, i) => {
                      const existing =
                        savedSpeakers.find((s) => s.microsoft_id && s.microsoft_id === contact.id) ??
                        savedSpeakers.find((s) => (s.email ?? '').trim().toLowerCase() === contact.email.toLowerCase());
                      return (
                        <li
                          key={contact.id}
                          className="flex items-center border-b last:border-b-0"
                          style={{ borderColor: 'var(--border)' }}
                        >
                          <button
                            type="button"
                            disabled={speakerChangeSaving}
                            onClick={() => void handleSelectMicrosoftContact(contact)}
                            className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-50"
                            style={{ color: 'var(--text)' }}
                          >
                            <span
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
                              style={{
                                backgroundColor: SPEAKER_LIST_AVATAR_BACKGROUNDS[
                                  (displayOrderedSpeakers.length + i) % SPEAKER_LIST_AVATAR_BACKGROUNDS.length
                                ],
                                color: 'var(--text)',
                              }}
                            >
                              {getTranscriptAvatarLabel(contact.displayName)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">{contact.displayName}</span>
                              <span className="block truncate text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                                {existing ? 'Saved speaker' : contact.email}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <div className="my-3 h-px shrink-0" style={{ backgroundColor: 'var(--border)' }} />
              <fieldset className="space-y-2.5">
                <legend className="sr-only">Replacement scope</legend>
                {(
                  [
                    { value: 'single' as const, label: 'Only this instance' },
                    { value: 'from_here' as const, label: 'This and all following instances' },
                    { value: 'all' as const, label: 'All instances' },
                  ] as const
                ).map((opt) => (
                  <label
                    key={opt.value}
                    className="flex cursor-pointer items-start gap-2.5 text-xs leading-snug sm:text-sm"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <input
                      type="radio"
                      name={scopeGroupId}
                      checked={replacementScope === opt.value}
                      onChange={() => setReplacementScope(opt.value)}
                      className="mt-0.5 h-4 w-4 shrink-0"
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    <span style={{ color: 'var(--text)' }}>{opt.label}</span>
                  </label>
                ))}
              </fieldset>
              {speakerMenuError ? (
                <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                  {speakerMenuError}
                </p>
              ) : null}
              <button
                type="button"
                disabled={speakerChangeSaving}
                onClick={() => void handleApplySpeakerChange()}
                className="mt-3 w-full shrink-0 rounded-lg py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                style={{ backgroundColor: 'var(--accent)' }}
              >
                {speakerChangeSaving ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Loading className="h-4 w-4 animate-spin" />
                    {t('applying')}
                  </span>
                ) : (
                  'Change'
                )}
              </button>
            </div>
          </div>,
          document.body
        )}

      {speakerDeleteConfirm &&
        createPortal(
          <div
            data-speaker-delete-confirm
            className="fixed inset-0 z-[80] flex items-center justify-center p-4"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
            role="presentation"
            onClick={() => {
              if (!deletingSpeakerId) {
                setSpeakerDeleteConfirm(null);
                setSpeakerDeleteConfirmError(null);
              }
            }}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-speaker-title"
              className="w-full max-w-sm rounded-lg app-surface-elevated p-4 sm:p-5"
              style={{ backgroundColor: 'var(--surface)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="delete-speaker-title" className="text-base font-semibold" style={{ color: 'var(--text)' }}>
                {t('deleteSavedSpeaker')}
              </h3>
              <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                Remove{' '}
                <span className="font-medium" style={{ color: 'var(--text)' }}>
                  {speakerDeleteConfirm.name}
                </span>{' '}
                from your saved speakers. This cannot be undone.
              </p>
              {speakerDeleteConfirmError ? (
                <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
                  {speakerDeleteConfirmError}
                </p>
              ) : null}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={Boolean(deletingSpeakerId)}
                  onClick={() => {
                    if (!deletingSpeakerId) {
                      setSpeakerDeleteConfirm(null);
                      setSpeakerDeleteConfirmError(null);
                    }
                  }}
                  className="rounded-lg px-3 py-2 text-sm transition-opacity disabled:opacity-50"
                  style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  disabled={Boolean(deletingSpeakerId)}
                  onClick={() => void confirmDeleteSavedSpeaker()}
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
                  style={{ backgroundColor: 'var(--error)', color: '#fff' }}
                >
                  {deletingSpeakerId ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  {t('delete')}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      {speakerProfileView &&
        createPortal(
          <div
            data-speaker-profile-modal
            className="fixed inset-0 z-[90] flex items-center justify-center p-4"
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
            role="presentation"
            onClick={() => {
              if (!savingProfile) {
                setSpeakerProfileView(null);
                setIsEditingProfile(false);
              }
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="speaker-profile-title"
              className="flex max-h-[min(90vh,720px)] w-full max-w-[1344px] flex-col overflow-hidden rounded-xl app-surface-elevated"
              style={{ backgroundColor: 'var(--surface)' }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div
                className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-5"
                style={{ borderColor: 'var(--border)' }}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                    style={{
                      backgroundColor: 'color-mix(in srgb, var(--accent) 18%, var(--bg-secondary))',
                      color: 'var(--accent)',
                    }}
                  >
                    {getTranscriptAvatarLabel(speakerProfileView.name)}
                  </div>
                  <h2 id="speaker-profile-title" className="truncate text-base font-semibold" style={{ color: 'var(--text)' }}>
                    {speakerProfileView.name}
                  </h2>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {isEditingProfile ? (
                    <>
                      <button
                        type="button"
                        disabled={savingProfile}
                        onClick={() => {
                          setIsEditingProfile(false);
                          setProfileDraft(speakerProfileView.profile ?? '');
                          setProfileSaveError(null);
                        }}
                        className="rounded-lg px-3 py-1.5 text-sm transition-opacity disabled:opacity-50"
                        style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}
                      >
                        {t('cancel')}
                      </button>
                      <button
                        type="button"
                        disabled={savingProfile}
                        onClick={() => void handleSaveProfileEdit()}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-50"
                        style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                      >
                        {savingProfile ? (
                          <><Loading className="h-3.5 w-3.5 animate-spin" aria-hidden />Saving…</>
                        ) : (
                          <><Save className="h-3.5 w-3.5" aria-hidden />Save</>
                        )}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setProfileDraft(speakerProfileView.profile ?? '');
                        setIsEditingProfile(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-opacity hover:opacity-80"
                      style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)' }}
                    >
                      <EditPencilLine01 className="h-3.5 w-3.5" aria-hidden />
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={savingProfile}
                    onClick={() => { setSpeakerProfileView(null); setIsEditingProfile(false); }}
                    className="rounded-md p-2 transition-opacity disabled:opacity-40 hover:opacity-70"
                    style={{ color: 'var(--text-muted)' }}
                    aria-label="Close"
                  >
                    <CloseMd className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-4 py-4 sm:px-5">
                {profileSaveError ? (
                  <p className="mb-3 text-xs" style={{ color: 'var(--error)' }}>
                    {profileSaveError}
                  </p>
                ) : null}

                {isEditingProfile ? (
                  <textarea
                    value={profileDraft}
                    onChange={(e) => setProfileDraft(e.target.value)}
                    className="custom-scrollbar w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed outline-none"
                    style={{
                      minHeight: '24rem',
                      backgroundColor: 'var(--surface-subtle)',
                      color: 'var(--text)',
                      borderColor: 'var(--border)',
                    }}
                    placeholder="{}"
                    autoFocus
                  />
                ) : speakerProfileView.profile ? (
                  <SpeakerOntologyView raw={speakerProfileView.profile} />
                ) : (
                  <div
                    className="flex flex-col items-center justify-center py-12 text-center"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <User01 className="mb-3 h-10 w-10 opacity-40" aria-hidden />
                    <p className="text-sm">{t('noProfileYet')}</p>
                    <button
                      type="button"
                      onClick={() => { setProfileDraft(''); setIsEditingProfile(true); }}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-opacity hover:opacity-80"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      <EditPencilLine01 className="h-3.5 w-3.5" aria-hidden />
                      Create profile
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

export default TranscriptDiarizedEditor;
