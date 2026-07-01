// The app's single segmented-tabs control — the green-accent style from the
// Strategies platform filter, used everywhere (Connections, Logs, Settings,
// Graph, Analytics, Channels, Strategies). Selected tab = soft-green fill +
// accent text + green hairline. Options may carry a leading icon and a disabled
// ("soon") state. Styling lives in index.css (.tabs-pill / .tabs-pill-item).

import { Icon, type IconName } from './ui/Icon';

interface Option<T extends string> {
  key:       T;
  label:     string;
  icon?:     IconName;
  disabled?: boolean;
}

interface Props<T extends string> {
  value:    T;
  onChange: (v: T) => void;
  options:  ReadonlyArray<Option<T>>;
  /** Visual size — `sm` for inline use in toolbars, `md` (default) for top-level filters. */
  size?:    'sm' | 'md';
}

export function SegmentedTabs<T extends string>({ value, onChange, options, size = 'md' }: Props<T>) {
  return (
    <div className="tabs-pill" role="tablist">
      {options.map((o) => {
        const selected = value === o.key;
        return (
          <button
            key={o.key}
            role="tab"
            aria-selected={selected}
            disabled={o.disabled}
            title={o.disabled ? `${o.label} — soon` : undefined}
            onClick={() => { if (!o.disabled) onChange(o.key); }}
            className={`tabs-pill-item${selected ? ' is-selected' : ''}${size === 'sm' ? ' is-sm' : ''}`}
          >
            {o.icon && <Icon name={o.icon} size={size === 'sm' ? 12 : 13} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
