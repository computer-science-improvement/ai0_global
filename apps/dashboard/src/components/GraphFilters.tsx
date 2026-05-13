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
    <div style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, fontSize: 14 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-ink-muted)' }}>
        From
        <input
          type="date"
          value={from}
          onChange={(e) => onChange({ from: e.target.value })}
          className="input-field"
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-ink-muted)' }}>
        To
        <input
          type="date"
          value={to}
          onChange={(e) => onChange({ to: e.target.value })}
          className="input-field"
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-ink-muted)' }}>
        Min weight
        <input
          type="range"
          min={1}
          max={10}
          value={minWeight}
          onChange={(e) => onChange({ minWeight: parseInt(e.target.value, 10) })}
        />
        <span style={{ width: 24, textAlign: 'center', color: 'var(--color-ink)' }}>{minWeight}</span>
      </label>
      <div style={{ display: 'flex', gap: 4 }}>
        {ALL_KINDS.map((k) => {
          const active = kinds.length === 0 || kinds.includes(k);
          return (
            <button
              key={k}
              onClick={() => toggleKind(k)}
              style={{
                borderRadius: 'var(--radius-pill)',
                padding: '4px 12px',
                fontSize: 13,
                cursor: 'pointer',
                border: active ? 'none' : '1px solid var(--color-hairline)',
                background: active ? 'var(--color-surface-2)' : 'transparent',
                color: active ? 'var(--color-ink)' : 'var(--color-ink-muted)',
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {k}
            </button>
          );
        })}
      </div>
      <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-ink-muted)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={includeMine}
          onChange={(e) => onChange({ includeMine: e.target.checked })}
        />
        Include mine
      </label>
    </div>
  );
}
