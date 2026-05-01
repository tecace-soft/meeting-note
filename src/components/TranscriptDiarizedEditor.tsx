import React, { useId, useState, useEffect, useRef, useCallback, startTransition } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Pencil, Save, Trash2, User, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isOntologyProfile, parseOntology, type SpeakerOntology } from '../lib/speakerOntology';
import { supabase } from '../config/supabaseConfig';
import {
  applySpeakerReplacements,
  getTranscriptAvatarLabel,
  persistNoteDiarization,
  type ReplacementScope,
  type TranscriptSegment,
} from '../lib/transcriptSegments';

type DbSpeaker = { id: string; name: string; profile?: string | null };

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

export interface TranscriptDiarizedEditorProps {
  segments: TranscriptSegment[];
  onSegmentsChange: (next: TranscriptSegment[]) => void;
  noteId: string | null;
  /** Tailwind height/overflow classes for the segment list (default: max-h-96). */
  scrollContainerClassName?: string;
}

const TranscriptDiarizedEditor: React.FC<TranscriptDiarizedEditorProps> = ({
  segments,
  onSegmentsChange,
  noteId,
  scrollContainerClassName,
}) => {
  const scopeGroupId = useId();
  const { user } = useAuth();
  const [speakerMenu, setSpeakerMenu] = useState<SpeakerMenuState | null>(null);
  const [savedSpeakers, setSavedSpeakers] = useState<DbSpeaker[]>([]);
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
  const speakerMenuPanelRef = useRef<HTMLDivElement>(null);

  const closeSpeakerMenu = useCallback(() => {
    setSpeakerMenu(null);
    setSpeakerNameInput('');
    setPickedSpeakerId(null);
    setReplacementScope('single');
    setSpeakerMenuError(null);
    setSpeakersFetchError(null);
    setSpeakerDeleteConfirm(null);
    setSpeakerDeleteConfirmError(null);
    setSpeakerProfileView(null);
    setIsEditingProfile(false);
    setProfileDraft('');
    setProfileSaveError(null);
  }, []);

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
        .select('id, name, profile')
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
    void loadSpeakersForMenu();
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
      const { error } = await supabase
        .from('speaker')
        .update({ profile: profileDraft })
        .eq('id', speakerProfileView.id)
        .eq('user_id', user.id);
      if (error) throw error;
      setSpeakerProfileView((prev) => (prev ? { ...prev, profile: profileDraft } : prev));
      setSavedSpeakers((prev) =>
        prev.map((s) => (s.id === speakerProfileView.id ? { ...s, profile: profileDraft } : s))
      );
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
        await persistNoteDiarization(noteId, nextTranscript);
      }

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

  const filteredSavedSpeakers = savedSpeakers.filter((s) =>
    s.name.toLowerCase().includes(speakerNameInput.trim().toLowerCase())
  );

  return (
    <>
      <div
        className={`rounded-lg p-4 text-base leading-relaxed overflow-y-auto custom-scrollbar space-y-3 ${scrollContainerClassName ?? 'max-h-96'}`}
        style={{ backgroundColor: 'var(--bg-secondary)' }}
      >
        {segments.map((seg, idx) => (
          <div key={idx} className="flex min-h-[75px] items-center gap-3">
            <div
              className="flex h-9 w-9 min-w-[2.25rem] shrink-0 items-center justify-center self-center rounded-full text-sm font-semibold"
              style={{
                backgroundColor: 'color-mix(in srgb, var(--accent) 22%, var(--bg-secondary))',
                color: 'var(--text)',
              }}
            >
              {getTranscriptAvatarLabel(seg.speaker)}
            </div>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                data-transcript-speaker-trigger
                className="text-left text-base font-semibold transition-opacity hover:opacity-90"
                style={{ color: 'var(--accent)' }}
                onClick={(e) => {
                  e.stopPropagation();
                  openSpeakerMenuFromSegment(idx, e.currentTarget);
                }}
              >
                {seg.speaker.trim() || 'Speaker'}
              </button>
              <div
                className="mt-0.5 text-base font-normal leading-relaxed whitespace-pre-wrap"
                style={{ color: 'var(--text-secondary)' }}
              >
                {seg.text}
              </div>
            </div>
          </div>
        ))}
      </div>

      {speakerMenu &&
        createPortal(
          <div
            ref={speakerMenuPanelRef}
            className="fixed z-[70] max-h-[min(100vh-1rem,520px)] overflow-hidden rounded-xl border shadow-xl flex flex-col"
            style={{
              top: speakerMenu.top,
              left: speakerMenu.left,
              width: SPEAKER_MENU_WIDTH,
              backgroundColor: 'var(--bg)',
              borderColor: 'var(--border)',
              boxShadow: '0 16px 48px rgba(0,0,0,0.35)',
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
                <X className="h-4 w-4" />
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
                placeholder="Search or type a new name…"
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none ring-0 transition-shadow focus:border-transparent focus:ring-2"
                style={{
                  backgroundColor: 'var(--bg-secondary)',
                  color: 'var(--text)',
                  borderColor: 'var(--border)',
                  boxShadow: '0 0 0 0 transparent',
                }}
                onFocus={(e) => {
                  e.target.style.borderColor = 'var(--accent)';
                  e.target.style.boxShadow = '0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent)';
                }}
                onBlur={(e) => {
                  e.target.style.borderColor = 'var(--border)';
                  e.target.style.boxShadow = 'none';
                }}
              />
              <div
                className="mt-3 min-h-0 flex-1 overflow-hidden rounded-lg border"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}
              >
                {speakersLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--accent)' }} />
                  </div>
                ) : speakersFetchError ? (
                  <p className="p-3 text-xs" style={{ color: 'var(--error)' }}>
                    {speakersFetchError}
                  </p>
                ) : filteredSavedSpeakers.length === 0 ? (
                  <p className="p-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {savedSpeakers.length === 0
                      ? 'No saved speakers yet. Type a name below and apply to save it.'
                      : 'No matches. Type a new name to add one.'}
                  </p>
                ) : (
                  <ul className="max-h-[13.5rem] overflow-y-auto custom-scrollbar" style={{ maxHeight: '13.5rem' }}>
                    {filteredSavedSpeakers.map((row, i) => (
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
                          <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openSpeakerProfileView(row);
                          }}
                          className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-md text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-secondary)] hover:text-[var(--accent)]"
                          title={`View profile for "${row.name}"`}
                          aria-label={`View profile for ${row.name}`}
                        >
                          <User className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        </button>
                        <button
                          type="button"
                          disabled={speakerChangeSaving || deletingSpeakerId === row.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            openSpeakerDeleteConfirm(row);
                          }}
                          className="flex h-9 w-9 shrink-0 items-center justify-center self-center rounded-md text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-secondary)] hover:text-[var(--error)] disabled:opacity-40"
                          title={`Remove "${row.name}" from saved speakers`}
                          aria-label={`Delete saved speaker ${row.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        </button>
                      </li>
                    ))}
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
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Applying…
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
              className="w-full max-w-sm rounded-lg border p-4 shadow-xl sm:p-5"
              style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 id="delete-speaker-title" className="text-base font-semibold" style={{ color: 'var(--text)' }}>
                Delete saved speaker?
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
                  style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={Boolean(deletingSpeakerId)}
                  onClick={() => void confirmDeleteSavedSpeaker()}
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
                  style={{ backgroundColor: 'var(--error)', color: '#fff' }}
                >
                  {deletingSpeakerId ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Delete
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
              className="flex max-h-[min(90vh,720px)] w-full max-w-[1344px] flex-col overflow-hidden rounded-xl border shadow-xl"
              style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
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
                        style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={savingProfile}
                        onClick={() => void handleSaveProfileEdit()}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-opacity disabled:opacity-50"
                        style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                      >
                        {savingProfile ? (
                          <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Saving…</>
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
                      style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
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
                    <X className="h-4 w-4" aria-hidden />
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
                      backgroundColor: 'var(--bg-secondary)',
                      color: 'var(--text)',
                      borderColor: 'var(--border)',
                    }}
                    onFocus={(e) => { e.target.style.outline = '2px solid var(--accent)'; e.target.style.outlineOffset = '0'; }}
                    onBlur={(e) => { e.target.style.outline = 'none'; }}
                    placeholder="{}"
                    autoFocus
                  />
                ) : speakerProfileView.profile ? (
                  <OntologyView raw={speakerProfileView.profile} />
                ) : (
                  <div
                    className="flex flex-col items-center justify-center py-12 text-center"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <User className="mb-3 h-10 w-10 opacity-40" aria-hidden />
                    <p className="text-sm">No profile yet for this speaker.</p>
                    <button
                      type="button"
                      onClick={() => { setProfileDraft(''); setIsEditingProfile(true); }}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-opacity hover:opacity-80"
                      style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
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

/* ── Ontology view component ───────────────────────────────────────── */

function toReadableKey(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function renderPrimitive(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'None';
  return String(value);
}

function JsonLikeNode({
  label,
  value,
  depth = 0,
  innerFieldLabels = false,
}: {
  label: string;
  value: unknown;
  depth?: number;
  /** True for fields inside any object (including nested objects), same look as array item fields */
  innerFieldLabels?: boolean;
}) {
  const labelText = toReadableKey(label);
  const indentClass = depth > 0 ? 'ml-4' : '';
  const isArray = Array.isArray(value);
  const isObject = isObjectLike(value);
  const labelColor = innerFieldLabels ? 'var(--text-muted)' : 'var(--text-secondary)';

  if (!isArray && !isObject) {
    return (
      <div className={`grid grid-cols-[220px_1fr] items-start gap-3 py-1.5 ${indentClass}`}>
        <div className="text-[15px] font-semibold leading-7" style={{ color: labelColor }}>
          {labelText}
        </div>
        <div className="text-[17px] leading-7" style={{ color: 'var(--text)' }}>
          {renderPrimitive(value)}
        </div>
      </div>
    );
  }

  if (isArray) {
    const arr = value as unknown[];
    const allPrimitive = arr.every((item) => !Array.isArray(item) && !isObjectLike(item));
    if (!allPrimitive) {
      return (
        <div className={`py-1.5 ${indentClass}`}>
          <div className="text-[15px] font-semibold leading-7" style={{ color: labelColor }}>
            {labelText}
          </div>
          {arr.length === 0 ? (
            <div className="ml-4 text-[17px] leading-7" style={{ color: 'var(--text)' }}>None</div>
          ) : (
            <div className="ml-4 mt-2 space-y-3">
              {arr.map((item, idx) => (
                <div key={idx} className="rounded-md border p-3" style={{ borderColor: 'var(--border)' }}>
                  {isObjectLike(item) ? (
                    <div className="space-y-2">
                      {Object.entries(item).map(([k, v]) => (
                        <JsonLikeNode
                          key={k}
                          label={k}
                          value={v}
                          depth={depth + 1}
                          innerFieldLabels
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="text-[17px] leading-7" style={{ color: 'var(--text)' }}>
                      {renderPrimitive(item)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className={`grid grid-cols-[220px_1fr] items-start gap-3 py-1.5 ${indentClass}`}>
        <div className="text-[15px] font-semibold leading-7" style={{ color: labelColor }}>
          {labelText}
        </div>
        {arr.length === 0 ? (
          <div className="text-[17px] leading-7" style={{ color: 'var(--text)' }}>None</div>
        ) : allPrimitive ? (
          <div className="text-[17px] leading-7" style={{ color: 'var(--text)' }}>
            {arr.map((item) => renderPrimitive(item)).join(', ')}
          </div>
        ) : null}
      </div>
    );
  }

  const obj = value as Record<string, unknown>;
  return (
    <div className={indentClass}>
      <div className="text-[15px] font-semibold leading-7" style={{ color: labelColor }}>
        {labelText}
      </div>
      <div className="ml-4 mt-2 space-y-3">
        {Object.entries(obj).map(([k, v]) => (
          <JsonLikeNode
            key={k}
            label={k}
            value={v}
            depth={depth + 1}
            innerFieldLabels
          />
        ))}
      </div>
    </div>
  );
}

function OntologyView({ raw }: { raw: string }) {
  const baseClassName = 'custom-scrollbar overflow-x-auto rounded-lg border p-5';
  const baseStyle = {
    borderColor: 'var(--border)',
    backgroundColor: 'var(--bg-secondary)',
    color: 'var(--text)',
  } as const;

  if (!isOntologyProfile(raw)) {
    return (
      <div className={baseClassName} style={baseStyle}>
        <pre className="whitespace-pre-wrap text-[17px] leading-7" style={{ color: 'var(--text)' }}>{raw}</pre>
      </div>
    );
  }

  const o = parseOntology(raw);
  if (!o) {
    return (
      <div className={baseClassName} style={baseStyle}>
        <pre className="whitespace-pre-wrap text-[17px] leading-7" style={{ color: 'var(--text)' }}>{raw}</pre>
      </div>
    );
  }

  const entries = Object.entries(o as Record<string, unknown>);
  return (
    <div className={baseClassName} style={baseStyle}>
      <div className="space-y-0">
        {entries.map(([key, value], idx) => (
          <div
            key={key}
            className={idx === 0 ? '' : 'mt-5'}
          >
            <JsonLikeNode label={key} value={value} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default TranscriptDiarizedEditor;
