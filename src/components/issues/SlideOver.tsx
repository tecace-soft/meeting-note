// F2: triage slide-over (UI-2): dialog semantics, focus moves in, Tab stays inside,
// Esc / backdrop close, focus returns to the opener.

import type { ReactNode } from 'react';
import { CloseMd } from 'react-coolicons';
import type { IssueStrings } from '../../lib/issues/strings';
import { useDialogFocus } from './hooks';

export function SlideOver({ open, onClose, s, children }: { open: boolean; onClose: () => void; s: IssueStrings; children: ReactNode }) {
  const panelRef = useDialogFocus<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="iss-backdrop" aria-hidden onClick={onClose} />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={s.slideTitle} className="iss-slideover">
        <div className="flex items-center justify-between border-b px-4 py-2" style={{ borderColor: 'var(--border-light)' }}>
          <span className="text-sm font-semibold">{s.slideTitle}</span>
          <button type="button" className="iss-btn flex h-11 w-11 items-center justify-center p-0" aria-label={s.close} onClick={onClose}>
            <CloseMd width={20} height={20} aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </>
  );
}
