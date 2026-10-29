import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { getNoteSharing, setNoteSharedUsersAsOwner } from '../lib/notes/repository';

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
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const readOwnerSharing = useCallback(async () => {
    const row = await getNoteSharing(noteId);
    if (!row || row.user_id !== userId) throw new Error('Only the note owner can share this note.');
    return sharedIds(row.shared_users);
  }, [noteId, userId]);

  useEffect(() => {
    let cancelled = false;
    setSharing(null);
    setReadError(null);
    void readOwnerSharing().then((users) => {
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
      // A recipient may have been added since naming; preserve the current list, not a UI snapshot.
      const users = await readOwnerSharing();
      if (!alive.current) return;
      if (!assignment.microsoftId) {
        onNoteShared?.(users);
        onSelectSharingTarget?.();
        return;
      }
      const next = users.includes(assignment.microsoftId) ? users : [...users, assignment.microsoftId];
      if (next !== users) await setNoteSharedUsersAsOwner({ noteId, userId, sharedUsers: next });
      if (!alive.current) return;
      setSharing({ owner: true, users: next });
      onNoteShared?.(next);
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
