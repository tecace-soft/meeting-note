// F2: new-issue notification recipients (RCPT-3..8). Admin edits, others view only.

import { useEffect, useMemo, useRef, useState } from 'react';
import { CloseMd } from 'react-coolicons';
import { LEGACY_NOTIFY_EMAIL, personLabel } from '../../lib/issues/constants';
import { fetchRecipients, saveRecipients, type RecipientsResult } from '../../lib/issues/service';
import { operationError, type IssueStrings } from '../../lib/issues/strings';
import type { DirectoryUser } from '../../lib/issues/types';
import { useDialogFocus } from './hooks';

const MAX_SUGGESTIONS = 6;

export function RecipientsDialog({
  open, onClose, onSaved, s, canNotify, directory,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (result: RecipientsResult) => void;
  s: IssueStrings;
  canNotify: boolean;
  directory: DirectoryUser[];
}) {
  const panelRef = useDialogFocus<HTMLDivElement>(open, onClose);
  const [loaded, setLoaded] = useState<RecipientsResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setQuery('');
    void fetchRecipients().then((r) => {
      if (cancelled) return;
      setLoaded(r);
      setSelected(r.status === 'ok' ? r.recipients.map((x) => x.email) : []);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const original = useMemo(() => (loaded?.status === 'ok' ? loaded.recipients.map((x) => x.email) : []), [loaded]);
  const added = selected.filter((e) => !original.includes(e));
  const removed = original.filter((e) => !selected.includes(e));
  const byEmail = (email: string) => directory.find((d) => d.email === email.toLowerCase());
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return directory
      .filter((d) => !selected.includes(d.email))
      .filter((d) => d.email.includes(q) || (d.displayName ?? '').toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);
  }, [directory, query, selected]);
  const allPicked = directory.length > 0 && directory.every((d) => selected.includes(d.email));

  if (!open) return null;

  const add = (email: string) => {
    setSelected((prev) => (prev.includes(email) ? prev : [...prev, email]));
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveRecipients({ added, removed });
      const fresh = await fetchRecipients();
      onSaved(fresh);
      onClose();
    } catch (e) {
      setError(operationError(s, s.opRecipients, e));
    } finally {
      setSaving(false);
    }
  };

  const editable = canNotify && loaded?.status === 'ok';

  return (
    <>
      <div className="iss-backdrop iss-modal-backdrop" aria-hidden onClick={onClose} />
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="iss-r-title" className="iss-modal">
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border-light)' }}>
          <div>
            <h2 id="iss-r-title" className="text-base font-semibold">{s.rTitle}</h2>
            <p className="text-sm iss-text-2">{s.rSubtitle}</p>
          </div>
          <button type="button" className="iss-btn flex h-11 w-11 items-center justify-center p-0" aria-label={s.close} onClick={onClose}>
            <CloseMd width={20} height={20} aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {!loaded ? (
            <div className="iss-skeleton" aria-hidden />
          ) : loaded.status === 'missing_table' ? (
            <p className="iss-warn-box px-3 py-2 text-sm">{s.rNoTable(LEGACY_NOTIFY_EMAIL)}</p>
          ) : loaded.status === 'error' ? (
            <p role="alert" className="text-sm iss-danger">{s.rLoadFailed(loaded.message)}</p>
          ) : (
            <>
              <p className="text-sm font-medium">{s.rCount(selected.length)}</p>
              {selected.length === 0 ? <p className="iss-warn-box px-3 py-2 text-sm">{s.rEmpty}</p> : null}
              <ul className="flex flex-col gap-2">
                {selected.map((email) => {
                  const person = byEmail(email);
                  const label = personLabel(person?.displayName ?? null, email);
                  return (
                    <li key={email} className="flex items-center gap-3">
                      <span aria-hidden className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold" style={{ background: 'var(--bg-secondary)' }}>
                        {label.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {label}
                          {person?.isAdmin ? <span className="iss-badge iss-s-OPEN">{s.rAdmin}</span> : null}
                          {added.includes(email) ? <span className="iss-badge iss-needs">{s.rPending}</span> : null}
                        </span>
                        <span className="truncate text-xs iss-text-2">{email}</span>
                        {!person ? <span className="text-xs iss-danger">{s.rUnknown}</span> : null}
                      </span>
                      {editable ? (
                        <button type="button" className="iss-btn px-2 py-1 text-xs" aria-label={s.rRemoveLabel(label)}
                          onClick={() => setSelected((prev) => prev.filter((x) => x !== email))}>
                          {s.rRemove}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              {editable ? (
                <div className="flex flex-col gap-1">
                  <label htmlFor="iss-r-search" className="text-sm font-medium">{s.rAdd}</label>
                  <input
                    ref={inputRef}
                    id="iss-r-search"
                    className="iss-input"
                    role="combobox"
                    aria-expanded={candidates.length > 0}
                    aria-controls="iss-r-options"
                    aria-activedescendant={candidates[active] ? `iss-r-opt-${active}` : undefined}
                    autoComplete="off"
                    placeholder={s.rSearchPlaceholder}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActive(0);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setActive((i) => Math.min(i + 1, Math.max(candidates.length - 1, 0)));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setActive((i) => Math.max(i - 1, 0));
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        if (candidates[active]) add(candidates[active].email);
                      } else if (e.key === 'Escape' && query) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.nativeEvent.stopImmediatePropagation();
                        setQuery('');
                      }
                    }}
                  />
                  {query.trim() ? (
                    candidates.length ? (
                      <ul id="iss-r-options" role="listbox" className="rounded-lg border" style={{ borderColor: 'var(--border-light)' }}>
                        {candidates.map((c, idx) => (
                          <li
                            key={c.email}
                            id={`iss-r-opt-${idx}`}
                            role="option"
                            aria-selected={idx === active}
                            className="cursor-pointer px-3 py-2 text-sm"
                            style={idx === active ? { background: 'var(--surface-hover)' } : undefined}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              add(c.email);
                            }}
                          >
                            {personLabel(c.displayName, c.email)} <span className="text-xs iss-text-2">{c.email}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs iss-text-2">{allPicked ? s.rAllPicked : s.rNoMatch}</p>
                    )
                  ) : null}
                </div>
              ) : (
                <p className="iss-warn-box px-3 py-2 text-sm">{s.rNoPermission}</p>
              )}

              {editable && (added.length > 0 || removed.length > 0) ? (
                <p className="text-sm" role="status">{s.rSummary(added.length, removed.length)}</p>
              ) : null}
              {error ? <p role="alert" className="text-sm iss-danger">{error}</p> : null}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: 'var(--border-light)' }}>
          {editable ? (
            <>
              <button type="button" className="iss-btn" onClick={onClose}>{s.cancel}</button>
              <button type="button" className="iss-btn-primary" disabled={saving} onClick={() => void save()}>{saving ? s.saving : s.save}</button>
            </>
          ) : (
            <button type="button" className="iss-btn" onClick={onClose}>{s.close}</button>
          )}
        </div>
      </div>
    </>
  );
}
