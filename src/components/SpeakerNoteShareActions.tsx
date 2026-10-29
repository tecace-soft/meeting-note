import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { getNoteSharing, setNoteSharedUsersAsOwner, NoteSharingChangedError, type NoteSharedUsersSnapshot } from '../lib/notes/repository';

export interface SpeakerShareAssignment {
  speakerKey: string;
  name: string;
  microsoftId: string | null;
  noteId: string;
  userId: string;
}

interface Props {
  noteId: string;
  userId: string;
  assignments: SpeakerShareAssignment[];
  onDismiss: (assignment: SpeakerShareAssignment) => void;
  onNoteShared?: (sharedUserIds: string[]) => void;
  onSelectSharingTarget?: () => void;
}

function sharedIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())) : [];
}

/** Name assignment only offers sharing. This component writes shares exclusively after a click. */
export function SpeakerNoteShareActions({ noteId, userId, assignments, onDismiss, onNoteShared, onSelectSharingTarget }: Props) {
  const { t } = useLanguage();
  const [sharing, setSharing] = useState<{ owner: boolean; users: string[] } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const currentAssignments = useRef(assignments);
  currentAssignments.current = assignments;
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const readOwnerSharing = useCallback(async () => {
    const row = await getNoteSharing(noteId);
    if (!row || row.user_id !== userId) throw new Error('Only the note owner can share this note.');
    const raw = row.shared_users;
    if (raw !== null && (!Array.isArray(raw) || !raw.every((id) => id === null || typeof id === 'string'))) {
      throw new Error('Could not read note sharing. Refresh and try again.');
    }
    const snapshot: NoteSharedUsersSnapshot = raw === null ? null : [...raw];
    return { users: sharedIds(raw), snapshot };
  }, [noteId, userId]);

  useEffect(() => {
    let cancelled = false;
    setSharing(null);
    setReadError(null);
    void readOwnerSharing().then(({ users }) => {
      if (!cancelled) setSharing({ owner: true, users });
    }).catch((error: unknown) => {
      if (!cancelled) setReadError(error instanceof Error ? error.message : 'Could not read note sharing.');
    });
    return () => { cancelled = true; };
  }, [readOwnerSharing, assignments, attempt]);

  const share = async (assignment: SpeakerShareAssignment) => {
    if (inFlight.current || !sharing?.owner) return;
    inFlight.current = true;
    setBusy(true);
    setErrors((prev) => ({ ...prev, [assignment.speakerKey]: '' }));
    try {
      // A failed conditional UPDATE never overwrites another tab's changes. Re-read at most
      // three times, and add only this explicitly chosen recipient to the latest list.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { users, snapshot } = await readOwnerSharing();
        if (!alive.current || !currentAssignments.current.includes(assignment)) return;
        if (!assignment.microsoftId) {
          onNoteShared?.(users);
          onSelectSharingTarget?.();
          return;
        }
        const next = users.includes(assignment.microsoftId) ? users : [...users, assignment.microsoftId];
        if (next !== users) {
          try {
            await setNoteSharedUsersAsOwner({ noteId, userId, sharedUsers: next, expectedSharedUsers: snapshot });
          } catch (error: unknown) {
            if (error instanceof NoteSharingChangedError && attempt < 2) continue;
            throw error;
          }
        }
        if (!alive.current) return;
        setSharing({ owner: true, users: next });
        onNoteShared?.(next);
        return;
      }
    } catch (error: unknown) {
      if (alive.current) setErrors((prev) => ({ ...prev, [assignment.speakerKey]: error instanceof Error ? error.message : 'Could not share this note.' }));
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="mb-3 space-y-2" aria-label={t('speakerNoteSharing')}>
      {readError ? (
        <div role="alert" className="text-xs" style={{ color: 'var(--error)' }}>
          {readError}{' '}
          <button type="button" className="underline" onClick={() => setAttempt((n) => n + 1)}>{t('retryNoteSharing')}</button>
        </div>
      ) : null}
      {assignments.map((assignment) => (
        <div key={assignment.speakerKey} className="rounded-lg border p-2 text-sm" style={{ borderColor: 'var(--border)', color: 'var(--text)' }}>
          <div className="flex flex-wrap items-center gap-2">
            <span>{assignment.name} · {t('speakerNameSaved')}</span>
            {sharing?.owner ? assignment.microsoftId && sharing.users.includes(assignment.microsoftId) ? (
              <span role="status" className="text-xs">{t('noteAlreadyShared')}</span>
            ) : (
              <button type="button" className="rounded border px-2 py-1 text-xs font-medium disabled:opacity-50"
                disabled={busy || (!assignment.microsoftId && !onSelectSharingTarget)}
                onClick={() => void share(assignment)}>
                {assignment.microsoftId ? t('shareNoteWithThisPerson') : t('selectNoteSharingTarget')}
              </button>
            ) : null}
            <button type="button" className="text-xs underline" disabled={busy} onClick={() => onDismiss(assignment)}>{t('close')}</button>
          </div>
          {errors[assignment.speakerKey] ? <p role="alert" className="mt-1 text-xs" style={{ color: 'var(--error)' }}>{errors[assignment.speakerKey]}</p> : null}
        </div>
      ))}
    </div>
  );
}
