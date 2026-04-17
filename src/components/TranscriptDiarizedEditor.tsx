import React, { useId, useState, useEffect, useRef, useCallback, startTransition } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../config/supabaseConfig';
import {
  applySpeakerReplacements,
  getTranscriptAvatarLabel,
  persistNoteDiarization,
  type ReplacementScope,
  type TranscriptSegment,
} from '../lib/transcriptSegments';

type DbSpeaker = { id: string; name: string };

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
  const speakerMenuPanelRef = useRef<HTMLDivElement>(null);

  const closeSpeakerMenu = useCallback(() => {
    setSpeakerMenu(null);
    setSpeakerNameInput('');
    setPickedSpeakerId(null);
    setReplacementScope('single');
    setSpeakerMenuError(null);
    setSpeakersFetchError(null);
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
        .select('id, name')
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
      if (e.key === 'Escape') closeSpeakerMenu();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [speakerMenu, closeSpeakerMenu]);

  useEffect(() => {
    if (!speakerMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-transcript-speaker-trigger]')) return;
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
        className={`rounded-lg p-4 text-sm leading-relaxed overflow-y-auto custom-scrollbar space-y-3 ${scrollContainerClassName ?? 'max-h-96'}`}
        style={{ backgroundColor: 'var(--bg-secondary)' }}
      >
        {segments.map((seg, idx) => (
          <div key={idx} className="flex items-start gap-3">
            <div
              className="flex h-9 w-9 min-w-[2.25rem] shrink-0 items-center justify-center rounded-full text-xs font-semibold"
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
                className="text-left text-sm font-semibold transition-opacity hover:opacity-90"
                style={{ color: 'var(--accent)' }}
                onClick={(e) => {
                  e.stopPropagation();
                  openSpeakerMenuFromSegment(idx, e.currentTarget);
                }}
              >
                {seg.speaker.trim() || 'Speaker'}
              </button>
              <div
                className="mt-0.5 text-sm font-normal leading-relaxed whitespace-pre-wrap"
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
                        className="border-b last:border-b-0"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSpeakerNameInput(row.name);
                            setPickedSpeakerId(row.id);
                          }}
                          className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors"
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
    </>
  );
};

export default TranscriptDiarizedEditor;
