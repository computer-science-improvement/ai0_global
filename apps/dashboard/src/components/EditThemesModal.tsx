// Dark-canvas rewrite. Uses the shared Modal shell, .input-field for filter,
// .chip recipe for theme rows (no bg-white, no text-gray-*, no rounded-md
// borders). The Save button is .btn-primary (white pill on dark canvas) —
// the previous `bg-black text-white` was a black pill on black canvas,
// invisible against the surface.

import { useEffect, useState } from 'react';
import { useChannelThemes, useThemes, useUpdateChannelThemes } from '../api/discovery';
import { Modal } from './Modal';

interface Props {
  channelId:    string;
  channelTitle: string;
  open:         boolean;
  onClose:      () => void;
}

export function EditThemesModal({ channelId, channelTitle, open, onClose }: Props) {
  const { data: vocab }   = useThemes();
  const { data: current } = useChannelThemes(open ? channelId : null);
  const update            = useUpdateChannelThemes(channelId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (open && current) setSelected(new Set(current));
  }, [open, current]);

  const filtered = (vocab ?? []).filter(t =>
    !filter ||
    t.title.toLowerCase().includes(filter.toLowerCase()) ||
    t.slug.includes(filter),
  );

  const toggle = (slug: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit themes" subtitle={channelTitle} icon="recommendations">
      <input
        type="text"
        placeholder="Filter themes…"
        className="input-field"
        style={{ width: '100%', marginBottom: 12 }}
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />

      <div
        style={{
          maxHeight: 320,
          overflowY: 'auto',
          background: 'var(--color-surface-1)',
          borderRadius: 'var(--radius-md)',
          padding: 6,
          marginBottom: 20,
        }}
      >
        {filtered.map(t => {
          const checked = selected.has(t.slug);
          return (
            <label
              key={t.slug}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 10px', borderRadius: 8,
                cursor: 'pointer',
                background: checked ? 'var(--color-surface-2)' : 'transparent',
                transition: 'background 0.12s ease',
              }}
              onMouseEnter={e => { if (!checked) (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-2)'; }}
              onMouseLeave={e => { if (!checked) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(t.slug)}
                style={{ accentColor: 'var(--color-accent)' }}
              />
              <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{t.title}</span>
              <span className="text-micro" style={{ marginLeft: 'auto', color: 'var(--color-ink-dim)', fontVariantNumeric: 'tabular-nums' }}>
                {t.slug}
              </span>
            </label>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-body-sm" style={{ padding: 12, color: 'var(--color-ink-muted)' }}>
            No themes match "{filter}"
          </p>
        )}
      </div>

      <div className="modal-foot">
        <button onClick={onClose} className="btn-secondary">Cancel</button>
        <button
          disabled={update.isPending}
          onClick={async () => {
            await update.mutateAsync(Array.from(selected));
            onClose();
          }}
          className="btn-primary"
        >
          {update.isPending ? 'Saving…' : `Save (${selected.size})`}
        </button>
      </div>
    </Modal>
  );
}
