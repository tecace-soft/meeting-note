import { Check, CloseMd, FileAdd, Loading } from 'react-coolicons';
import { getNoteDisplayTitle } from '../noteDisplay';
import type { Note } from '../types';
import type { ProjectOption } from './useAddToProject';

export interface AddToProjectDialogProps {
  note: Note;
  projectOptions: ProjectOption[];
  loading: boolean;
  savingId: string | null;
  error: string | null;
  t: (key: 'addToProject' | 'close' | 'noProjectsFound' | 'alreadyInProject') => string;
  onClose: () => void;
  onSelect: (project: ProjectOption) => void;
}

/** "Add note to project" picker. */
export function AddToProjectDialog({ note, projectOptions, loading, savingId, error, t, onClose, onSelect }: AddToProjectDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
      role="presentation"
      onClick={() => {
        if (!savingId) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-note-to-project-title"
        className="flex max-h-[min(80vh,34rem)] w-full max-w-md flex-col overflow-hidden rounded-xl app-surface-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex shrink-0 items-start justify-between gap-3 px-4 py-4 sm:px-5"
          style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 45%, transparent)' }}
        >
          <div className="min-w-0">
            <h2 id="add-note-to-project-title" className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
              {t('addToProject')}
            </h2>
            <p
              className="mt-1 truncate text-sm"
              style={{ color: 'var(--text-secondary)' }}
              title={getNoteDisplayTitle(note)}
            >
              {getNoteDisplayTitle(note)}
            </p>
          </div>
          <button
            type="button"
            disabled={Boolean(savingId)}
            onClick={onClose}
            className="rounded-md p-2 transition-opacity disabled:opacity-50 hover:opacity-70"
            style={{ color: 'var(--text-muted)' }}
            aria-label={t('close')}
          >
            <CloseMd className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loading className="h-5 w-5 animate-spin" style={{ color: 'var(--text-muted)' }} aria-hidden />
            </div>
          ) : projectOptions.length === 0 ? (
            <div className="py-8 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('noProjectsFound')}
            </div>
          ) : (
            <div className="summary-note-list">
              {projectOptions.map((project) => {
                const alreadyInProject = (note.projects || []).some((id) => String(id) === String(project.id));
                const isSaving = savingId === project.id;
                return (
                  <button
                    key={project.id}
                    type="button"
                    disabled={alreadyInProject || Boolean(savingId)}
                    onClick={() => onSelect(project)}
                    className={`summary-note-row-content flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-all disabled:cursor-default ${
                      alreadyInProject ? 'opacity-60' : 'hover:opacity-85'
                    }`}
                    style={{ color: 'var(--text)' }}
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                      style={{
                        backgroundColor: alreadyInProject ? 'var(--bg-secondary)' : 'var(--accent-light)',
                        color: alreadyInProject ? 'var(--text-muted)' : 'var(--accent)',
                      }}
                      aria-hidden
                    >
                      {alreadyInProject ? <Check className="h-4 w-4" /> : <FileAdd className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{project.name}</span>
                      <span className="mt-0.5 block text-xs" style={{ color: 'var(--text-muted)' }}>
                        {alreadyInProject ? t('alreadyInProject') : t('addToProject')}
                      </span>
                    </span>
                    {isSaving ? (
                      <Loading className="h-4 w-4 shrink-0 animate-spin" style={{ color: 'var(--text-muted)' }} aria-hidden />
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {error ? (
          <p className="shrink-0 px-4 pb-3 text-xs sm:px-5" style={{ color: 'var(--error)' }}>
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
