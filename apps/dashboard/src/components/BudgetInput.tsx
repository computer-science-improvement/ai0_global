interface Props {
  /** Budget in kopecks (internal). */
  value:    number;
  /** Called with new kopecks value. */
  onChange: (kopecks: number) => void;
}

export function BudgetInput({ value, onChange }: Props) {
  const uah = value / 100;
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={1}
        step={10}
        value={uah || ''}
        onChange={e => {
          const n = parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? Math.round(n * 100) : 0);
        }}
        className="w-32 rounded-md border px-3 py-2 text-right text-sm"
      />
      <span className="text-sm text-gray-600">UAH</span>
    </div>
  );
}
