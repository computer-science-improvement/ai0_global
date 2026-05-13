interface Props {
  from: string; to: string; minWeight: number; kinds: string[]; includeMine: boolean;
  onChange: (patch: Partial<{ from: string; to: string; minWeight: number; kinds: string[]; includeMine: boolean }>) => void;
}

const ALL_KINDS = ['tg_channel', 'tg_user', 'instagram', 'web'];

export function GraphFilters({ from, to, minWeight, kinds, includeMine, onChange }: Props) {
  const toggleKind = (k: string) => {
    onChange({ kinds: kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k] });
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2">From
        <input type="date" value={from} onChange={(e) => onChange({ from: e.target.value })}
          className="rounded bg-neutral-900 px-2 py-1 ring-1 ring-neutral-800" />
      </label>
      <label className="flex items-center gap-2">To
        <input type="date" value={to} onChange={(e) => onChange({ to: e.target.value })}
          className="rounded bg-neutral-900 px-2 py-1 ring-1 ring-neutral-800" />
      </label>
      <label className="flex items-center gap-2">Min weight
        <input type="range" min={1} max={10} value={minWeight}
          onChange={(e) => onChange({ minWeight: parseInt(e.target.value, 10) })} />
        <span className="w-6 text-center">{minWeight}</span>
      </label>
      <div className="flex gap-1">
        {ALL_KINDS.map((k) => (
          <button key={k} onClick={() => toggleKind(k)}
            className={`rounded px-2 py-1 ${kinds.length === 0 || kinds.includes(k) ? 'bg-neutral-700' : 'bg-neutral-900 text-neutral-500'}`}>
            {k}
          </button>
        ))}
      </div>
      <label className="ml-auto flex items-center gap-2">
        <input type="checkbox" checked={includeMine} onChange={(e) => onChange({ includeMine: e.target.checked })} />
        Include mine
      </label>
    </div>
  );
}
