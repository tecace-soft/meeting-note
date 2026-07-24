import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRecorder } from '../context/RecorderContext';

const RecordingNavigationGuard: React.FC = () => {
  const navigate = useNavigate();
  const { isRecording, stopRecording } = useRecorder();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!isRecording || typeof document === 'undefined') return;
    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      if (target.target && target.target !== '_self') return;
      const href = target.href;
      if (!href || href.startsWith('blob:') || href.startsWith('data:')) return;
      const url = new URL(href);
      if (url.origin !== window.location.origin) {
        event.preventDefault();
        setPendingHref(href);
        return;
      }
      if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash === window.location.hash) return;
      event.preventDefault();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [isRecording]);

  if (!pendingHref) return null;

  const isExternal = /^https?:\/\//i.test(pendingHref);

  return (
    <div className="app-modal-backdrop" role="presentation" onClick={() => setPendingHref(null)}>
      <div className="app-modal-panel max-w-md" role="dialog" aria-modal="true" aria-labelledby="recording-nav-title" onClick={(event) => event.stopPropagation()}>
        <div className="app-modal-header">
          <h3 id="recording-nav-title" className="app-modal-title">Recording in progress</h3>
        </div>
        <div className="p-5">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            A recording is currently active. Stop and save the current audio before leaving this view.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm"
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
              onClick={() => setPendingHref(null)}
            >
              Stay
            </button>
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm font-medium"
              style={{ backgroundColor: 'var(--accent)', color: '#fff' }}
              onClick={() => {
                void stopRecording().then(() => {
                  const href = pendingHref;
                  setPendingHref(null);
                  if (isExternal) {
                    window.location.href = href;
                  } else {
                    navigate(href);
                  }
                });
              }}
            >
              Stop and continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RecordingNavigationGuard;
