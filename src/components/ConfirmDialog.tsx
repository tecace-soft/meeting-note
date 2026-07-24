import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button in the error color for destructive actions. */
  destructive?: boolean;
}

/** Promise-based replacement for window.confirm(): resolves true on confirm, false on cancel/dismiss. */
type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export const useConfirm = (): ConfirmFn => {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm must be used within a ConfirmProvider');
  return confirm;
};

interface PendingConfirm extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Hold the resolver in a ref so we settle the promise outside the state
  // updater (no double-resolve under StrictMode's double-invoked updaters).
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    const opts = typeof options === 'string' ? { message: options } : options;
    return new Promise<boolean>((resolve) => {
      const next = { ...opts, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const close = useCallback((value: boolean) => {
    pendingRef.current?.resolve(value);
    pendingRef.current = null;
    setPending(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="app-modal-backdrop" role="presentation" onClick={() => close(false)}>
          <div
            className="app-modal-panel max-w-md"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="app-modal-header">
              <h3 id="confirm-dialog-title" className="app-modal-title">
                {pending.title ?? 'Please confirm'}
              </h3>
            </div>
            <div className="p-5">
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {pending.message}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg px-3 py-2 text-sm"
                  style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                  onClick={() => close(false)}
                >
                  {pending.cancelLabel ?? 'Cancel'}
                </button>
                <button
                  type="button"
                  className="rounded-lg px-3 py-2 text-sm font-medium"
                  style={{
                    backgroundColor: pending.destructive ? 'var(--error)' : 'var(--accent)',
                    color: '#fff',
                  }}
                  onClick={() => close(true)}
                >
                  {pending.confirmLabel ?? 'Continue'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
};
