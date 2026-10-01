// Minimal app-wide toasts. A tiny module-level store so non-React code (the
// QueryClient's MutationCache.onError in main.tsx) can raise one; <Toaster/>
// renders the stack bottom-right. Click a toast to dismiss; errors stay 8 s.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { ApiError } from '../../api/client';

type ToastTone = 'danger' | 'success';
interface ToastItem { id: number; tone: ToastTone; text: string }

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<(t: ToastItem[]) => void>();
const emit = () => { for (const l of listeners) l(items); };

function push(tone: ToastTone, text: string, ttlMs: number) {
  const id = nextId++;
  // Collapse an identical message that is already showing (e.g. a retried mutation).
  items = [...items.filter((t) => t.text !== text), { id, tone, text }].slice(-4);
  emit();
  setTimeout(() => dismiss(id), ttlMs);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  error:   (text: string) => push('danger', text, 8_000),
  success: (text: string) => push('success', text, 4_000),
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
    const list = body.issues.slice(0, 3).map((i: any) => `${(i.path ?? []).join('.') || 'body'}: ${i.message}`).join('; ');
    return `${head}: ${list}`;
  }
  if (typeof body.details === 'string') return `${head}: ${body.details}`;
  if (typeof body.message === 'string') return body.message;
  if (Array.isArray(body.message)) return body.message.join('; ');
  return head;
}

const TONE: Record<ToastTone, { fg: string; icon: 'warning' | 'check' }> = {
  danger:  { fg: 'var(--color-danger)',  icon: 'warning' },
  success: { fg: 'var(--color-success)', icon: 'check' },
};

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => { listeners.delete(setList); };
  }, []);
  if (!list.length) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 70, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 'min(420px, calc(100vw - 32px))' }}
    >
      {list.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          title="Dismiss"
          className="compose-rise"
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', cursor: 'pointer',
            padding: '11px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface-2)', color: 'var(--color-ink)',
            border: '1px solid var(--color-hairline)', borderLeft: `3px solid ${TONE[t.tone].fg}`,
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)', fontSize: 13, lineHeight: 1.4,
          }}
        >
          <span style={{ color: TONE[t.tone].fg, display: 'inline-flex', marginTop: 1 }}><Icon name={TONE[t.tone].icon} size={15} /></span>
          <span style={{ wordBreak: 'break-word' }}>{t.text}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
