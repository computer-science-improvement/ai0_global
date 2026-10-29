import './channels/channels.css';

interface Props {
  /** Budget in kopecks (internal). */
  value:    number;
  /** Called with new kopecks value. */
  onChange: (kopecks: number) => void;
}

export function BudgetInput({ value, onChange }: Props) {
  const uah = value / 100;
  return (
    <div className="rec-budget">
      <input
        type="number"
        min={1}
        step={10}
        value={uah || ''}
        onChange={e => {
          const n = parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? Math.round(n * 100) : 0);
        }}
        aria-label="Budget in UAH"
        className="input-field mono"
      />
      <span className="text-body-sm ch-muted">UAH</span>
    </div>
  );
}
