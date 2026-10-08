// Searchable model picker (spec 035), shared by the Models page and the agent
// profile form. The list is the tool-capable OpenRouter catalog (GET /api/models).
// An optional "Default (…)" entry comes first and stands for "no own model"
// (onChange(null)). A value missing from the catalog stays selectable and is
// marked "not in catalog". The popover is portaled with fixed positioning so a
// scrolling table wrapper or a modal never clips it; ↑/↓, Enter and Esc work.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { useModelCatalog, type CatalogModel } from '../../api/models';
import { filterModels, fmtContext, fmtPerM } from '../../lib/models';

const LIMIT = 80;

interface Option { key: string; value: string | null; model: CatalogModel | null; label: string; note?: string }

export function ModelSelect({
  value, onChange, defaultLabel, disabled, ariaLabel = 'Model', style, compact = false,
}: {
  value: string | null;
  onChange: (model: string | null) => void;
  /** When set, a first entry "Default (<model>)" maps to null (follow the default). */
  defaultLabel?: string;
  disabled?: boolean;
  ariaLabel?: string;
  style?: CSSProperties;
  compact?: boolean;
}) {
  const catalog = useModelCatalog();
  const models = useMemo(() => catalog.data?.models ?? [], [catalog.data]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  const current = value ? models.find((m) => m.id === value) ?? null : null;

  const options: Option[] = useMemo(() => {
    const out: Option[] = [];
    const q = query.trim();
    if (defaultLabel !== undefined && (!q || defaultLabel.toLowerCase().includes(q.toLowerCase()) || 'default'.includes(q.toLowerCase()))) {
      out.push({ key: '__default', value: null, model: null, label: defaultLabel });
    }
    if (value && !current && (!q || value.toLowerCase().includes(q.toLowerCase()))) {
      out.push({ key: `__current:${value}`, value, model: null, label: value, note: 'not in catalog' });
    }
    // Without a query the current choice comes right after "Default", so it is visible on open.
    if (!q && current) out.push({ key: current.id, value: current.id, model: current, label: current.id });
    for (const m of filterModels(models, q).filter((m) => q || m.id !== current?.id).slice(0, LIMIT)) {
      out.push({ key: m.id, value: m.id, model: m, label: m.id });
    }
    return out;
  }, [models, query, defaultLabel, value, current]);
  const total = useMemo(() => filterModels(models, query.trim()).length, [models, query]);

  const place = () => {
    const el = trigger.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 340), vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 260 && above > below;
    setPos({ left, width, up, top: up ? r.top - 4 : r.bottom + 4, maxHeight: Math.max(180, Math.min(420, (up ? above : below) - 8)) });
  };

  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    const onMove = () => place();
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);
  // Reset only when the search or the open state changes: the selected entry when opening, else the first match.
  useEffect(() => { setHi(query ? 0 : Math.max(0, options.findIndex((o) => o.value === value))); }, [query, open]);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-idx="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const choose = (o: Option) => {
    setOpen(false);
    setQuery('');
    trigger.current?.focus();
    if (o.value !== value) onChange(o.value);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(i + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (options[hi]) choose(options[hi]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  };

  const shown = value ?? defaultLabel ?? 'Choose a model';
  const sub = current ? `${fmtPerM(current.inPerM)} in · ${fmtPerM(current.outPerM)} out / 1M` : null;

  return (
    <>
      <button
        ref={trigger} type="button" className="input-field" disabled={disabled}
        aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(true); } }}
        style={{
          width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
          minWidth: 0, ...(compact ? { padding: '6px 10px', fontSize: 13 } : null), ...style,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: value ? 'var(--color-ink)' : 'var(--color-ink-muted)' }}>
          {shown}
          {!compact && sub && <span className="text-micro" style={{ marginLeft: 8, color: 'var(--color-ink-dim)' }}>{sub}</span>}
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && pos && createPortal(
        <div
          ref={pop}
          style={{
            position: 'fixed', zIndex: 60, left: pos.left, width: pos.width,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-md)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid var(--color-hairline-soft)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="search" size={14} />
            <input
              autoFocus className="input-field" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
              placeholder="Search models…" aria-label="Search models" role="combobox" aria-expanded aria-controls={listId}
              aria-activedescendant={options[hi] ? `${listId}-${hi}` : undefined} spellCheck={false} autoCapitalize="none"
              style={{ flex: 1, minWidth: 0, padding: '6px 10px', fontSize: 13 }}
            />
          </div>
          <div ref={list} id={listId} role="listbox" aria-label={ariaLabel} style={{ overflowY: 'auto', maxHeight: pos.maxHeight - 60, padding: 4 }}>
            {catalog.isLoading && <div className="text-micro" style={{ padding: 10, color: 'var(--color-ink-muted)' }}>Loading the model list…</div>}
            {!catalog.isLoading && options.length === 0 && <div className="text-micro" style={{ padding: 10, color: 'var(--color-ink-muted)' }}>No model matches “{query}”.</div>}
            {options.map((o, i) => {
              const selected = o.value === value;
              return (
                <div
                  key={o.key} id={`${listId}-${i}`} data-idx={i} role="option" aria-selected={selected}
                  onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    background: i === hi ? 'var(--color-surface-3)' : 'transparent',
                  }}
                >
                  <span style={{ width: 14, display: 'inline-flex', color: 'var(--color-accent)' }}>{selected && <Icon name="check" size={14} />}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 13, color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{o.label}</span>
                    {o.model && o.model.name !== o.model.id && (
                      <span className="text-micro" style={{ display: 'block', color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }}>{o.model.name}</span>
                    )}
                    {o.value === null && <span className="text-micro" style={{ display: 'block', color: 'var(--color-ink-dim)' }}>No own model</span>}
                  </span>
                  {o.note && <Badge tone="warning">{o.note}</Badge>}
                  {o.model && (
                    <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {fmtPerM(o.model.inPerM)} / {fmtPerM(o.model.outPerM)}
                      <span style={{ display: 'block', color: 'var(--color-ink-dim)' }}>
                        {[fmtContext(o.model.contextLength), o.model.supportsReasoning ? 'reasoning' : ''].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  )}
                </div>
              );
            })}
            {total > LIMIT && (
              <div className="text-micro" style={{ padding: '6px 10px', color: 'var(--color-ink-dim)' }}>
                Showing {LIMIT} of {total}. Type to narrow the list.
              </div>
            )}
          </div>
          <div className="text-micro" style={{ padding: '6px 10px', borderTop: '1px solid var(--color-hairline-soft)', color: 'var(--color-ink-dim)' }}>
            USD per 1M tokens in / out{catalog.data?.source === 'fallback' ? ' · OpenRouter list unavailable, showing priced models only' : catalog.data?.stale ? ' · list may be outdated' : ''}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
