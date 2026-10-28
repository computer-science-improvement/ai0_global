// Minimal app-wide toasts. A tiny module-level store so non-React code (the
// QueryClient's MutationCache.onError in main.tsx) can raise one; <Toaster/>
// renders the stack bottom-right. Click a toast (or its X) to dismiss; errors stay 8 s.
//
//   toast.success('Saved');
//   toast.success('Post canceled', { action: { label: 'Undo', onClick: () => undo() } });   // stays 8 s, Undo dismisses it
//   toast.error('Could not publish', { ttlMs: 15_000 });

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { ApiError } from '../../api/client';

type ToastTone = 'danger' | 'success';

/** A button inside the toast ("Undo"). It runs, then the toast closes. */
export interface ToastAction { label: string; onClick: () => void }
export interface ToastOptions {
  action?: ToastAction;
  /** How long it stays, ms. Default 4 s (success) / 8 s (error); 8 s at least when it carries an action. */
  ttlMs?: number;
}
interface ToastItem { id: number; tone: ToastTone; text: string; action?: ToastAction }

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<(t: ToastItem[]) => void>();
const emit = () => { for (const l of listeners) l(items); };

function push(tone: ToastTone, text: string, defaultTtlMs: number, opts?: ToastOptions) {
  const id = nextId++;
  const ttlMs = opts?.ttlMs ?? (opts?.action ? Math.max(defaultTtlMs, 8_000) : defaultTtlMs);
  // Collapse an identical message that is already showing (e.g. a retried mutation).
  items = [...items.filter((t) => t.text !== text), { id, tone, text, action: opts?.action }].slice(-4);
  emit();
  setTimeout(() => dismiss(id), ttlMs);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  error:   (text: string, opts?: ToastOptions) => push('danger', text, 8_000, opts),
  success: (text: string, opts?: ToastOptions) => push('success', text, 4_000, opts),
};

/**
 * Human-readable message for a failed request. The API answers with JSON
 * bodies like {error, details?, issues?} or Nest's {message, error, statusCode}.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);
  let body: any = null;
  try { body = JSON.parse(err.message); } catch { /* plain text */ }
  if (!body || typeof body !== 'object') return err.message || `Request failed (${err.status})`;
  const head = typeof body.error === 'string' ? body.error : `Request failed (${err.status})`;
  if (Array.isArray(body.issues) && body.issues.length) {
    const list = body.issues.slice(0, 3).map((i: any) => `${(Array.isArray(i.path) ? i.path.join('.') : i.path) || 'body'}: ${i.message}`).join('; ');
    return `${head}: ${list}`;
  }
  if (typeof body.details === 'string') return `${head}: ${body.details}`;
  if (typeof body.message === 'string') return body.message;
  if (Array.isArray(body.message)) return body.message.join('; ');
  return head;
}

const ICON: Record<ToastTone, 'warning' | 'check'> = { danger: 'warning', success: 'check' };

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => { listeners.delete(setList); };
  }, []);
  // The live region stays mounted (even when empty) so a screen reader announces what is added to it.
  return createPortal(
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} role="status" className={`toast${t.tone === 'danger' ? ' is-danger' : ''}`} onClick={() => dismiss(t.id)}>
          <span className="toast-icon"><Icon name={ICON[t.tone]} size={15} /></span>
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button type="button" className="toast-action" onClick={(e) => { e.stopPropagation(); t.action!.onClick(); dismiss(t.id); }}>
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-x" aria-label="Dismiss" onClick={(e) => { e.stopPropagation(); dismiss(t.id); }}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
