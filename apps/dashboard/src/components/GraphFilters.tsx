// The filter bar of the channel graph: a date range, the minimum edge weight, the link kinds (an on/off chip each) and
// whether my own channels are included. Controlled by the page; the graph is re-queried when a filter changes.

import './channels/channels.css';

interface Props {
  from: string; to: string; minWeight: number; kinds: string[]; includeMine: boolean;
  onChange: (patch: Partial<{ from: string; to: string; minWeight: number; kinds: string[]; includeMine: boolean }>) => void;
}

const ALL_KINDS = ['tg_channel', 'tg_invite', 'tg_user', 'instagram', 'web'];

export function GraphFilters({ from, to, minWeight, kinds, includeMine, onChange }: Props) {
  const toggleKind = (k: string) => {
    onChange({ kinds: kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k] });
  };
  return (
    <div className="panel gr-filters compose-rise" role="group" aria-label="Graph filters">
      <label className="gr-field">
        <span className="text-eyebrow">From</span>
        <input
          type="date"
          value={from}
          onChange={(e) => onChange({ from: e.target.value })}
          className="input-field"
        />
      </label>
      <label className="gr-field">
        <span className="text-eyebrow">To</span>
        <input
          type="date"
          value={to}
          onChange={(e) => onChange({ to: e.target.value })}
          className="input-field"
        />
      </label>
      <label className="gr-field gr-wide">
        <span className="text-eyebrow">Min weight</span>
        <span className="gr-range">
          <input
            type="range"
            min={1}
            max={10}
            value={minWeight}
            onChange={(e) => onChange({ minWeight: parseInt(e.target.value, 10) })}
          />
          <span className="mono gr-range-value">{minWeight}</span>
        </span>
      </label>
      <div className="gr-field gr-wide">
        <span className="text-eyebrow">Link kinds</span>
        <div className="gr-kinds" role="group" aria-label="Link kinds">
          {ALL_KINDS.map((k) => {
            // No kind picked = every kind shown.
            const active = kinds.length === 0 || kinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                className="chip-toggle mono"
                aria-pressed={active}
                onClick={() => toggleKind(k)}
              >
                {k}
              </button>
            );
          })}
        </div>
      </div>
      <button
        type="button"
        className="chip-toggle gr-mine gr-wide"
        aria-pressed={includeMine}
        onClick={() => onChange({ includeMine: !includeMine })}
      >
        Include mine
      </button>
    </div>
  );
}
