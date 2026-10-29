// Theme picker of a channel: a filter field over the theme vocabulary, one checkbox row per theme (hover and
// selected states are CSS, see channels.css), Save / Cancel in the dialog footer.

import { useEffect, useState } from 'react';
import { useChannelThemes, useThemes, useUpdateChannelThemes } from '../api/discovery';
import { Modal } from './Modal';
import './channels/channels.css';

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
        aria-label="Filter themes"
        className="input-field"
        style={{ width: '100%', marginBottom: 12 }}
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />

      <div className="ch-theme-list">
        {filtered.map(t => {
          const checked = selected.has(t.slug);
          return (
            <label key={t.slug} className={`ch-theme-row${checked ? ' is-on' : ''}`}>
              <input
                type="checkbox"
                className="ch-check"
                checked={checked}
                onChange={() => toggle(t.slug)}
              />
              <span className="text-body-sm">{t.title}</span>
              <span className="text-micro mono ch-theme-slug">{t.slug}</span>
            </label>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-body-sm ch-theme-none">
            No themes match "{filter}"
          </p>
        )}
      </div>

      <div className="modal-foot">
        <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
        <button
          type="button"
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
