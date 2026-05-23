interface Props {
  /** Budget in kopecks (internal). */
  value:    number;
  /** Called with new kopecks value. */
  onChange: (kopecks: number) => void;
}

export function BudgetInput({ value, onChange }: Props) {
  const uah = value / 100;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        type="number"
        min={1}
        step={10}
        value={uah || ''}
        onChange={e => {
          const n = parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? Math.round(n * 100) : 0);
        }}
        className="input-field"
        style={{ width: 128, textAlign: 'right' }}
      />
      <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>UAH</span>
    </div>
  );
}
