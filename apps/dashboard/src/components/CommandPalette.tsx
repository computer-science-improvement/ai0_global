// Spec 027 FR-012: the ⌘K / Ctrl+K command palette. Every registry page
// (hidden ones marked), the owner's custom links, agent handles (loaded only
// once the palette opens) and a few actions. Fuzzy match on label, keywords and
// path; ↑/↓ + Enter; the last 5 picks come first. Built on Modal; on mobile it
// is a full-height sheet (CSS).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Modal } from './Modal';
import { Icon } from './ui/Icon';
import { useAgentHandles } from '../api/agents';
import { useResolvedNav } from '../nav/store';
import { routerSearch } from '../nav/model';
import { buildPaletteEntries, pushRecent, readRecent, searchPalette, type PaletteEntry, type PaletteTarget } from '../nav/palette';

type Action = Extract<PaletteTarget, { type: 'action' }>['action'];

const KIND_LABEL: Record<PaletteEntry['kind'], string> = { page: 'Page', link: 'Link', agent: 'Agent', action: 'Action' };

export function CommandPalette({ open, onClose, onAction }: {
  open: boolean;
  onClose: () => void;
  onAction: (a: Action) => void;
}) {
  const navigate = useNavigate();
  const nav = useResolvedNav();
  const handles = useAgentHandles({ enabled: open });
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setRecent(readRecent());
  }, [open]);

  const entries = useMemo(() => buildPaletteEntries(nav, handles.data?.agents ?? []), [nav, handles.data]);
  const results = useMemo(() => searchPalette(entries, query, recent), [entries, query, recent]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (e: PaletteEntry | undefined) => {
    if (!e) return;
    setRecent(pushRecent(e.key));
    onClose();
    if (e.target.type === 'action') { onAction(e.target.action); return; }
    void navigate({ to: e.target.to as any, search: routerSearch(e.target.search) as any, params: e.target.params as any });
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const n = results.length;
    if (ev.key === 'ArrowDown') { ev.preventDefault(); if (n) setActive((a) => (a + 1) % n); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (n) setActive((a) => (a - 1 + n) % n); }
    else if (ev.key === 'Home' && ev.ctrlKey) { ev.preventDefault(); setActive(0); }
    else if (ev.key === 'End' && ev.ctrlKey) { ev.preventDefault(); setActive(Math.max(0, n - 1)); }
    else if (ev.key === 'Enter') { ev.preventDefault(); pick(results[active]); }
  };

  // With no query the recent picks come first: label the two runs.
  const recentSet = new Set(recent);
  const recentCount = query.trim() ? 0 : results.filter((r) => recentSet.has(r.key)).length;

  return (
    <Modal open={open} onClose={onClose} size="lg">
      <div className="cmdk">
        <div className="cmdk-input-row">
          <Icon name="search" size={16} />
          <input
            autoFocus
            className="cmdk-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Go to a page, @agent or action…"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Go to a page or run an action"
            spellCheck={false}
          />
          <button type="button" className="btn-icon cmdk-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div ref={listRef} id={listId} role="listbox" className="cmdk-list" aria-label="Results">
          {results.length === 0 && (
            <div className="cmdk-empty">Nothing matches “{query}”. Try a page name, a path like /app/data, or @agent.</div>
          )}
          {results.map((e, i) => (
            <div key={e.key}>
              {recentCount > 0 && i === 0 && <div className="cmdk-section">Recent</div>}
              {recentCount > 0 && i === recentCount && <div className="cmdk-section">All</div>}
              <div
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                className={`cmdk-item${i === active ? ' is-active' : ''}`}
                onMouseMove={() => { if (i !== active) setActive(i); }}
                onClick={() => pick(e)}
              >
                <span className="cmdk-icon"><Icon name={e.icon} size={15} /></span>
                <span className="cmdk-text">
                  <span className="cmdk-label">{e.label}</span>
                  <span className="cmdk-detail">{e.detail}</span>
                </span>
                {e.hidden && <span className="cmdk-tag" title="Not in your menu; the page still works">hidden</span>}
                <span className="cmdk-kind">{KIND_LABEL[e.kind]}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="cmdk-foot" aria-hidden>
          <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move</span>
          <span><kbd className="kbd"><Icon name="enter" size={11} /></kbd> open</span>
          <span><kbd className="kbd">Esc</kbd> close</span>
        </div>
      </div>
    </Modal>
  );
}
