import { Loading } from 'react-coolicons';
import type { Note } from '../types';

export interface DeleteNoteDialogProps {
  /** The note being deleted; null renders the generic wording (the dialog is only shown while one is chosen). */
  note: Note | null;
  /** The note is only shared with the current user: the action removes their access instead of deleting it. */
  isSharedWithCurrentUser: boolean;
  deleting: boolean;
  error: string | null;
  t: (key: 'deleteNote' | 'cancel' | 'delete') => string;
  /** Called by Cancel and the backdrop; ignored by the backdrop while a delete is running. */
  onCancel: () => void;
  onConfirm: () => void;
}

/** Delete / remove-shared-note confirmation. */
export function DeleteNoteDialog({ note, isSharedWithCurrentUser, deleting, error, t, onCancel, onConfirm }: DeleteNoteDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
      onClick={() => {
        if (!deleting) onCancel();
      }}
    >
      <div
        className="w-full max-w-sm rounded-lg border p-4 sm:p-5"
        style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
          {isSharedWithCurrentUser ? 'Remove shared note?' : `${t('deleteNote')}?`}
        </h3>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {isSharedWithCurrentUser ? (
            <>
              This will remove{' '}
              <span className="font-medium" style={{ color: 'var(--text)' }}>
                {note?.name?.trim() || 'Untitled note'}
              </span>{' '}
              from your shared notes. The owner and other shared users will still have access.
            </>
          ) : (
            <>
              This will permanently delete{' '}
              <span className="font-medium" style={{ color: 'var(--text)' }}>
                {note?.name?.trim() || 'Untitled note'}
              </span>
              .
            </>
          )}
        </p>
        {error ? (
          <p className="mt-2 text-xs" style={{ color: 'var(--error)' }}>
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm"
            style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
            disabled={deleting}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-60"
            style={{ backgroundColor: 'var(--error)', color: '#fff' }}
            disabled={deleting}
          >
            {deleting ? <Loading className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {isSharedWithCurrentUser ? 'Remove' : t('delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
