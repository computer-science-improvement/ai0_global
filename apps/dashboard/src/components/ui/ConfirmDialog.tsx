// App-wide confirmation dialog. Replaces native window.confirm() with a
// styled modal that matches the Supabase-dark system.
//
// Usage:
//   const confirm = useConfirm();
//   onClick={async () => { if (await confirm('delete bot @foo', { danger: true })) remove(); }}
//
// The dialog renders title "Confirm" and subtitle "Are you sure you want to
// <action>?". `confirm()` returns a Promise<boolean> that resolves true when
// the user confirms, false on cancel / Escape / backdrop.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Modal } from '../Modal';

interface ConfirmOptions {
  /** Styles the confirm button as destructive. Defaults to true (most
   *  callers confirm a delete); pass false for benign changes. */
  danger?: boolean;
  /** Label on the confirm button. Defaults to "Delete" (danger) / "Confirm". */
  confirmLabel?: string;
  /** Optional rich content rendered above the buttons — e.g. an old → new diff. */
  details?: ReactNode;
}

type ConfirmFn = (action: string, opts?: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface DialogState {
  open:    boolean;
  action:  string;
  danger:  boolean;
  label:   string;
  details?: ReactNode;
}

const CLOSED: DialogState = { open: false, action: '', danger: true, label: 'Delete' };

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(CLOSED);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((action, opts) => {
    const danger = opts?.danger ?? true;
    setState({
      open: true,
      action,
      danger,
      label: opts?.confirmLabel ?? (danger ? 'Delete' : 'Confirm'),
      details: opts?.details,
    });
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);

  const settle = (value: boolean) => {
    setState((s) => ({ ...s, open: false }));
    resolver.current?.(value);
    resolver.current = null;
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={state.open}
        onClose={() => settle(false)}
        title="Confirm"
        subtitle={`Are you sure you want to ${state.action}?`}
      >
        {state.details && <div style={{ marginBottom: 16 }}>{state.details}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" onClick={() => settle(false)} className="btn-secondary">
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => settle(true)}
            className={state.danger ? 'btn-danger' : 'btn-primary'}
          >
            {state.label}
          </button>
        </div>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within <ConfirmProvider>');
  return ctx;
}
