// `@` autocomplete of the chat composer (spec 018 FR-009): typing `@` at the
// start or after whitespace lists the mentionable agents (/api/agents/handles)
// filtered by the typed prefix. ↑/↓ move, Enter/Tab insert, Esc closes; a click
// inserts too. The menu sits above the composer, full width on mobile.

import { useEffect, useState, type KeyboardEvent } from 'react';
import { AgentGlyph, KIND_LABEL } from '../agents/AgentsUi';
import { Badge } from '../ui/Badge';
import { MODE_TONE } from '../editor/EditorUi';
import type { AgentHandle } from '../../api/agents';

export interface MentionToken { start: number; query: string }

/** The `@query` being typed right before the caret, or null. */
export function mentionToken(text: string, caret: number): MentionToken | null {
  const m = /(^|\s)@([A-Za-z0-9_]{0,40})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

/** Handle-prefix matches first, then handle / name substring matches. */
export function filterHandles(all: AgentHandle[], query: string): AgentHandle[] {
  const q = query.toLowerCase();
  if (!q) return all.slice(0, 8);
  const rank = (a: AgentHandle) => (a.handle.startsWith(q) ? 0 : a.handle.includes(q) ? 1 : a.name.toLowerCase().includes(q) ? 2 : 9);
  return all.filter((a) => rank(a) < 9).sort((x, y) => rank(x) - rank(y)).slice(0, 8);
}

/** The scope hint under a handle: system / network / the resource ref. */
export function scopeHint(a: Pick<AgentHandle, 'scope' | 'scopeId'>): string {
  if (a.scope === 'system') return 'system';
  if (a.scope === 'network') return a.scopeId ? `network:${a.scopeId.slice(0, 8)}` : 'network';
  return a.scopeId ?? 'resource';
}

/**
 * State of the menu for a textarea. `onKeyDown` returns true when it consumed
 * the key (the composer then must not send on Enter).
 */
export function useMentionMenu(opts: {
  value: string; onChange: (v: string) => void; handles: AgentHandle[]; disabled?: boolean;
  textarea: () => HTMLTextAreaElement | null;
}) {
  const { value, onChange, handles, disabled, textarea } = opts;
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [hi, setHi] = useState(0);
  const token = mentionToken(value, Math.min(caret, value.length));
  const matches = token ? filterHandles(handles, token.query) : [];
  const open = !!token && !disabled && token.start !== dismissed && matches.length > 0;

  useEffect(() => { setHi(0); }, [token?.query, token?.start]);
  useEffect(() => { if (!token && dismissed !== null) setDismissed(null); }, [token, dismissed]);

  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  const insert = (a: AgentHandle) => {
    if (!token) return;
    const end = Math.min(caret, value.length);
    const after = value.slice(end).replace(/^[A-Za-z0-9_]*/, '');
    const head = `${value.slice(0, token.start)}@${a.handle} `;
    const next = head + after.replace(/^ /, '');
    onChange(next);
    setCaret(head.length);
    requestAnimationFrame(() => {
      const el = textarea();
      if (!el) return;
      el.focus();
      el.setSelectionRange(head.length, head.length);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setHi((i) => (i + d + matches.length) % matches.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      insert(matches[Math.min(hi, matches.length - 1)]);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(token!.start);
      return true;
    }
    return false;
  };

  return { open, matches, hi, setHi, insert, onKeyDown, track };
}

export const MENTION_LIST_ID = 'chat-mention-list';

export function MentionMenu({ matches, hi, onHover, onPick, isMobile }: {
  matches: AgentHandle[]; hi: number; onHover: (i: number) => void; onPick: (a: AgentHandle) => void; isMobile: boolean;
}) {
  return (
    <div id={MENTION_LIST_ID} role="listbox" aria-label="Agents" className="compose-rise"
      style={{
        position: 'absolute', left: 0, right: isMobile ? 0 : undefined, bottom: 'calc(100% + 6px)', zIndex: 30,
        width: isMobile ? 'auto' : 'min(420px, 100%)', maxHeight: 300, overflowY: 'auto', padding: 4,
        background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-lg)',
        boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
      }}>
      <div className="text-micro" style={{ padding: '4px 8px 6px', color: 'var(--color-ink-dim)' }}>
        Talk to an agent{isMobile ? '' : ' · ↑↓ to move, Enter to pick, Esc to close'}
      </div>
      {matches.map((a, i) => (
        <div key={a.handle} id={`mention-${a.handle}`} role="option" aria-selected={i === hi}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(a)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            background: i === hi ? 'var(--color-surface-3)' : 'transparent',
          }}>
          <AgentGlyph agent={a} size={28} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
              <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
              <span className="text-micro" style={{ color: 'var(--color-accent)', flexShrink: 0 }}>@{a.handle}</span>
            </div>
            <div className="text-micro" style={{ color: 'var(--color-ink-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {KIND_LABEL[a.kind] ?? a.kind} · {scopeHint(a)}
            </div>
          </div>
          <Badge tone={MODE_TONE[a.mode]}>{a.mode}</Badge>
        </div>
      ))}
    </div>
  );
}
