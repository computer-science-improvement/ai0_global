import { useEffect, useState } from 'react';
import { useChannelThemes, useThemes, useUpdateChannelThemes } from '../api/discovery';

interface Props {
  channelId: string;
  channelTitle: string;
  open: boolean;
  onClose: () => void;
}

export function EditThemesModal({ channelId, channelTitle, open, onClose }: Props) {
  const { data: vocab } = useThemes();
  const { data: current } = useChannelThemes(open ? channelId : null);
  const update = useUpdateChannelThemes(channelId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (open && current) setSelected(new Set(current));
  }, [open, current]);

  if (!open) return null;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold">Edit themes</h2>
        <p className="mb-4 text-sm text-gray-600">{channelTitle}</p>
        <input
          type="text"
          placeholder="Filter themes…"
          className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <div className="mb-4 max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
          {filtered.map(t => (
            <label
              key={t.slug}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-gray-100"
            >
              <input
                type="checkbox"
                checked={selected.has(t.slug)}
                onChange={() => toggle(t.slug)}
              />
              <span className="text-sm">{t.title}</span>
              <span className="ml-auto font-mono text-xs text-gray-400">{t.slug}</span>
            </label>
          ))}
          {filtered.length === 0 && (
            <p className="p-2 text-sm text-gray-500">No themes match "{filter}"</p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            disabled={update.isPending}
            onClick={async () => {
              await update.mutateAsync(Array.from(selected));
              onClose();
            }}
            className="rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
