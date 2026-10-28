import { Check, CloseMd, Copy, Loading, Save } from 'react-coolicons';
import type { GeneratedHistoryProfile } from '../generateProfile';
import type { ProfileGenStep, SaveAllStatus } from '../useNoteSpeakers';

type SyncProfileKey =
  | 'syncProfile'
  | 'close'
  | 'lookingUpSpeakerData'
  | 'generatingProfilesAi'
  | 'newProfile'
  | 'updatedProfile'
  | 'copy'
  | 'saved'
  | 'saving'
  | 'saveProfile'
  | 'saveAll';

export interface SyncProfileDialogProps {
  step: ProfileGenStep;
  error: string | null;
  profiles: GeneratedHistoryProfile[];
  copiedKey: string | null;
  t: (key: SyncProfileKey) => string;
  onClose: () => void;
  onCopy: (text: string, key: string) => void;
  onSave: (speakerName: string) => void;
  onDraftChange: (speakerName: string, draft: string) => void;
  /** Opens the save-all confirmation. */
  onSaveAll: () => void;
}

/** Sync Profile (speaker profile generation) dialog. */
export function SyncProfileDialog({
  step,
  error,
  profiles,
  copiedKey,
  t,
  onClose,
  onCopy,
  onSave,
  onDraftChange,
  onSaveAll,
}: SyncProfileDialogProps) {
  const working = step === 'finding-speakers' || step === 'generating';
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
      role="presentation"
      onClick={() => { if (!working) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[min(92vh,860px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl app-surface-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex shrink-0 items-center justify-between gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 45%, transparent)' }}
        >
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('syncProfile')}</h2>
            <p className="mt-0.5 text-sm" style={{ color: 'var(--text-secondary)' }}>AI-generated speaker profiles from the meeting transcript</p>
          </div>
          <button type="button" disabled={working} onClick={onClose} className="rounded-md p-2 transition-opacity disabled:opacity-40 hover:opacity-70" style={{ color: 'var(--text-muted)' }} aria-label={t('close')}><CloseMd className="h-5 w-5" aria-hidden /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
          {working && (
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-5 h-10 w-10 animate-spin rounded-full border-4 border-t-transparent" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--accent)' }} aria-hidden />
              <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{step === 'finding-speakers' ? t('lookingUpSpeakerData') : t('generatingProfilesAi')}</p>
            </div>
          )}
          {step === 'error' && <div className="rounded-lg border p-4" style={{ borderColor: 'var(--error)', backgroundColor: 'var(--error-light)' }}><p className="text-sm font-medium" style={{ color: 'var(--error)' }}>{error}</p></div>}
          {step === 'ready' && (
            <div className="space-y-4">
              {profiles.map((profile) => (
                <div key={profile.speakerName} className="overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                  <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--bg-secondary)' }}>
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold" style={{ backgroundColor: 'color-mix(in srgb, var(--accent) 20%, var(--bg-secondary))', color: 'var(--accent)' }}>{profile.speakerName.slice(0, 2).toUpperCase()}</div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold" style={{ color: 'var(--text)' }}>{profile.speakerName}</p>
                        <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: profile.isNew ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'color-mix(in srgb, var(--success) 15%, transparent)', color: profile.isNew ? 'var(--accent)' : 'var(--success)' }}>{profile.isNew ? t('newProfile') : t('updatedProfile')}</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onCopy(profile.draft, `history-profile-${profile.speakerName}`)}
                        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-opacity"
                        style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                        title={`Copy profile for ${profile.speakerName}`}
                        aria-label={`Copy profile for ${profile.speakerName}`}
                      >
                        {copiedKey === `history-profile-${profile.speakerName}` ? (
                          <Check className="h-3.5 w-3.5" aria-hidden />
                        ) : (
                          <Copy className="h-3.5 w-3.5" aria-hidden />
                        )}
                        {t('copy')}
                      </button>
                      {profile.saved ? <span className="flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--success)' }}><Check className="h-3.5 w-3.5" />{t('saved')}</span> : null}
                      {profile.saveError ? <span className="text-xs" style={{ color: 'var(--error)' }}>{profile.saveError}</span> : null}
                      {!profile.saved && (
                        <button type="button" disabled={profile.saving} onClick={() => onSave(profile.speakerName)} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-opacity disabled:opacity-50" style={{ backgroundColor: 'var(--accent)', color: '#fff' }}>
                          {profile.saving ? <><Loading className="h-3.5 w-3.5 animate-spin" />{t('saving')}</> : <><Save className="h-3.5 w-3.5" />{t('saveProfile')}</>}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="p-4">
                    <textarea
                      value={profile.draft}
                      disabled={profile.saved}
                      onChange={(e) => onDraftChange(profile.speakerName, e.target.value)}
                      className="custom-scrollbar w-full resize-y rounded-lg border p-3 font-mono text-xs leading-relaxed outline-none disabled:opacity-70"
                      style={{ minHeight: '12rem', backgroundColor: 'var(--bg-secondary)', color: 'var(--text)', borderColor: 'var(--border)' }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {step === 'ready' && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3" style={{ borderColor: 'var(--border)' }}>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{profiles.filter((p) => p.saved).length} of {profiles.length} profile{profiles.length !== 1 ? 's' : ''} saved</p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{t('close')}</button>
              <button
                type="button"
                disabled={profiles.some((p) => p.saving)}
                onClick={onSaveAll}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-50"
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
              >
                {profiles.some((p) => p.saving) ? <><Loading className="h-4 w-4 animate-spin" />{t('saving')}</> : t('saveAll')}
              </button>
            </div>
          </div>
        )}
        {step === 'error' && (
          <div className="flex shrink-0 justify-end border-t px-5 py-3" style={{ borderColor: 'var(--border)' }}>
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium" style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{t('close')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export interface SaveAllConfirmDialogProps {
  status: SaveAllStatus;
  errorDetails: string[];
  t: (
    key:
      | 'saveAllProfiles'
      | 'confirmSaveAllDescription'
      | 'cancel'
      | 'confirmSaveAll'
      | 'savingProfiles'
      | 'profilesSaved'
      | 'profilesSavedDescription'
      | 'close'
      | 'failedSaveAllProfiles'
      | 'failedSaveAllProfilesDescription'
  ) => string;
  /** Close button, Cancel and the backdrop (ignored by the backdrop while saving). */
  onClose: () => void;
  onConfirm: () => void;
}

/** Save-all confirmation, progress and result. */
export function SaveAllConfirmDialog({ status, errorDetails, t, onClose, onConfirm }: SaveAllConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
      role="presentation"
      onClick={() => {
        if (status !== 'saving') onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-xl border p-5 shadow-xl"
        style={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {status === 'idle' && (
          <>
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('saveAllProfiles')}</h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('confirmSaveAllDescription')}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm font-medium"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                {t('cancel')}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="rounded-lg px-4 py-2 text-sm font-medium"
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
              >
                {t('confirmSaveAll')}
              </button>
            </div>
          </>
        )}
        {status === 'saving' && (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            <Loading className="h-4 w-4 animate-spin" aria-hidden />
            {t('savingProfiles')}
          </div>
        )}
        {status === 'success' && (
          <>
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('profilesSaved')}</h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--success)' }}>
              {t('profilesSavedDescription')}
            </p>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm font-medium"
                style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
              >
                {t('close')}
              </button>
            </div>
          </>
        )}
        {status === 'error' && (
          <>
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{t('failedSaveAllProfiles')}</h3>
            <p className="mt-2 text-sm" style={{ color: 'var(--error)' }}>
              {t('failedSaveAllProfilesDescription')}
            </p>
            <ul className="mt-2 max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {errorDetails.map((detail, idx) => (
                <li key={`${detail}-${idx}`}>{detail}</li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-4 py-2 text-sm font-medium"
                style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              >
                {t('close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
