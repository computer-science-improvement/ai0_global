// Pill-segmented control. The shape of Framer's pricing-tab recipe:
// canvas → surface-1 holder, surface-2 lift for the selected pill,
// ink-muted → ink for selected text. Replaces two hand-rolled copies
// (channels.tsx filter + graph.tsx direction toggle).

interface Option<T extends string> {
  key:    T;
  label:  string;
}

interface Props<T extends string> {
  value:    T;
  onChange: (v: T) => void;
  options:  ReadonlyArray<Option<T>>;
  /** Visual size — `sm` for inline use in toolbars (12px), `md` for top-level filters (13px). */
  size?:    'sm' | 'md';
}

export function SegmentedTabs<T extends string>({ value, onChange, options, size = 'md' }: Props<T>) {
  const itemStyle = size === 'sm'
    ? { padding: '5px 12px', fontSize: 12 }
    : undefined;
  return (
    <div className="tabs-pill" role="tablist">
      {options.map((o) => (
        <button
          key={o.key}
          role="tab"
          aria-selected={value === o.key}
          onClick={() => onChange(o.key)}
          className={`tabs-pill-item${value === o.key ? ' is-selected' : ''}`}
          style={itemStyle}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
