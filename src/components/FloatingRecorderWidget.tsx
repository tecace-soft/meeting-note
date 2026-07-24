import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CloseMd, Stop, UserVoice } from 'react-coolicons';
import { useRecorder } from '../context/RecorderContext';
import { useConfirm } from './ConfirmDialog';

function formatRecordingTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

const FloatingRecorderWidget: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    isRecording,
    recordingTime,
    wakeLockWarning,
    recoverabilityStatus,
    recoveryWarning,
    stopRecording,
    discardRecording,
  } = useRecorder();
  const confirm = useConfirm();

  if (!isRecording || location.pathname === '/transcription-summary') return null;

  return (
    <div
      className="fixed z-50 w-[min(calc(100vw-1.5rem),22rem)] rounded-lg border p-3 shadow-lg"
      style={{
        right: 'max(0.75rem, env(safe-area-inset-right))',
        bottom: 'max(0.75rem, env(safe-area-inset-bottom))',
        backgroundColor: 'var(--card)',
        borderColor: 'var(--border)',
        color: 'var(--text)',
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <span
          className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--error-light)', color: 'var(--error)' }}
        >
          <span className="absolute inset-0 animate-ping rounded-full opacity-20" style={{ backgroundColor: 'var(--error)' }} />
          <UserVoice className="relative h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
            Recording
          </p>
          <p className="font-mono text-lg font-semibold" style={{ color: 'var(--error)' }}>
            {formatRecordingTime(recordingTime)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void stopRecording().then(() => navigate('/transcription-summary'));
          }}
          className="flex h-9 w-9 items-center justify-center rounded-md transition-opacity hover:opacity-80"
          style={{ backgroundColor: 'var(--error)', color: '#fff' }}
          aria-label="Stop recording"
          title="Stop recording"
        >
          <Stop className="h-4 w-4" fill="currentColor" aria-hidden />
        </button>
        <button
          type="button"
          onClick={async () => {
            if (
              await confirm({
                title: 'Discard recording',
                message: 'This will permanently discard the saved recording backup. Continue?',
                confirmLabel: 'Discard',
                destructive: true,
              })
            ) {
              discardRecording();
            }
          }}
          className="flex h-9 w-9 items-center justify-center rounded-md transition-opacity hover:opacity-80"
          style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
          aria-label="Discard recording"
          title="Discard recording"
        >
          <CloseMd className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {wakeLockWarning ? (
        <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          {wakeLockWarning}
        </p>
      ) : null}
      {recoveryWarning || recoverabilityStatus === 'protected' ? (
        <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          {recoveryWarning ?? 'Recovery protected'}
        </p>
      ) : null}
    </div>
  );
};

export default FloatingRecorderWidget;
