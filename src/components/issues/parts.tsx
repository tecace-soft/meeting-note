// F2: small presentational pieces shared by the issue screen.

import { useEffect, useRef } from 'react';
import { FileBlank } from 'react-coolicons';
import type { AppLanguage } from '../../context/LanguageContext';
import { priorityLabel, statusLabel } from '../../lib/issues/constants';
import type { IssueAttachment, IssueStatus, PriorityId } from '../../lib/issues/types';
import type { IssueStrings } from '../../lib/issues/strings';
import { useDialogFocus } from './hooks';

export function PriorityBadge({ priority, lang, strong }: { priority: PriorityId; lang: AppLanguage; strong?: boolean }) {
  return <span className={`iss-badge iss-p-${priority}${strong ? ' font-bold' : ''}`}>{priorityLabel(priority, lang)}</span>;
}

export function StatusBadge({ status, lang }: { status: IssueStatus; lang: AppLanguage }) {
  return <span className={`iss-badge iss-s-${status}`}>{statusLabel(status, lang)}</span>;
}

export function NeedsTriageBadge({ s }: { s: IssueStrings }) {
  return <span className="iss-badge iss-needs">{s.needsTriage}</span>;
}

/** ATT-6: thumbnails; click opens the original in a new tab; unsigned/non-image -> file icon. */
export function AttachmentThumbs({
  attachments, urls, layout, onRemove, removeLabel, removeText,
}: {
  attachments: IssueAttachment[];
  urls: Record<string, string>;
  layout: 'grid' | 'row';
  onRemove?: (a: IssueAttachment) => void;
  removeLabel?: (name: string) => string;
  removeText?: string;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className={layout === 'grid' ? 'grid grid-cols-3 gap-2' : 'flex flex-wrap gap-2'}>
      {attachments.map((a) => {
        const url = urls[a.path];
        const isImage = a.type.startsWith('image/');
        const tile = url && isImage ? (
          <img src={url} alt={a.name} className="h-20 w-full rounded-md object-cover" />
        ) : (
          <span className="flex h-20 w-full flex-col items-center justify-center gap-1 rounded-md px-1 text-center text-xs iss-text-2" style={{ background: 'var(--bg-secondary)' }}>
            <FileBlank width={20} height={20} aria-hidden />
            <span className="w-full truncate">{a.name}</span>
          </span>
        );
        return (
          <li key={a.path} className={layout === 'grid' ? 'flex flex-col gap-1' : 'flex w-24 flex-col gap-1'}>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer" title={a.name} className="block overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-light)' }}>
                {tile}
              </a>
            ) : (
              <span className="block overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-light)' }}>{tile}</span>
            )}
            {onRemove && removeLabel ? (
              <button
                type="button"
                className="iss-btn min-h-[28px] px-2 py-1 text-xs"
                aria-label={removeLabel(a.name)}
                onClick={() => onRemove(a)}
              >
                {removeText}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Accessible confirm dialog (the app-wide one uses a sub-4.5:1 destructive button). */
export function ConfirmDialog({
  open, title, message, confirmLabel, cancelLabel, onConfirm, onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panelRef = useDialogFocus<HTMLDivElement>(open, onCancel);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <>
      <div className="iss-backdrop iss-modal-backdrop" aria-hidden onClick={onCancel} />
      <div ref={panelRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="iss-confirm-title" aria-describedby="iss-confirm-msg" className="iss-modal p-5">
        <h2 id="iss-confirm-title" className="text-base font-semibold">{title}</h2>
        <p id="iss-confirm-msg" className="mt-2 text-sm iss-text-2">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className="iss-btn" onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className="iss-btn iss-btn-danger font-semibold" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </>
  );
}
