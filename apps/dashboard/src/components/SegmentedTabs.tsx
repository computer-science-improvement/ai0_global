// The app's single segmented-tabs control. Two looks, both in index.css (.tabs-pill / .tabs-line):
//   variant="track" (default)  a rounded track; the selected option is a neutral raised chip. An option may carry a
//                              `count` (mono, after the label) and a `tone` that tints its selected state — for a state
//                              switch like the mode (Off · Shadow · In approval · Live) rather than a filter.
//   variant="underline"        section tabs: a hairline under the row, a 2px accent bar under the selected one.
// size: `sm` (30px) for toolbars, `md` (36px, default) for filters, `lg` (44px, equal columns, solid selected fill) for the
// big mode switch. Options may carry a leading icon and a disabled ("soon") state.

import type { CSSProperties } from 'react';
import { Icon, type IconName } from './ui/Icon';

/** Tint of an option's selected state: neutral (default), accent (green), warning (amber), danger (red). */
export type TabTone = 'neutral' | 'accent' | 'warning' | 'danger';

interface Option<T extends string> {
  key:       T;
  label:     string;
  icon?:     IconName;
  disabled?: boolean;
  /** A number shown after the label (open items in a filter). */
  count?:    number;
  /** Selected-state tint; omit for the neutral chip. */
  tone?:     TabTone;
}

interface Props<T extends string> {
  value:    T;
  onChange: (v: T) => void;
  options:  ReadonlyArray<Option<T>>;
  /** Visual size — `sm` for inline use in toolbars, `md` (default) for top-level filters, `lg` for the big mode switch. */
  size?:    'sm' | 'md' | 'lg';
  /** `track` (default) or `underline` (section tabs). `underline` ignores `size`. */
  variant?: 'track' | 'underline';
  /** Accessible name of the tab list ("Inbox filter"). */
  ariaLabel?: string;
}

export function SegmentedTabs<T extends string>({ value, onChange, options, size = 'md', variant = 'track', ariaLabel }: Props<T>) {
  const underline = variant === 'underline';
  const large = !underline && size === 'lg';
  return (
    <div
      className={underline ? 'tabs-line' : `tabs-pill${large ? ' is-lg' : ''}`}
      role="tablist"
      aria-label={ariaLabel}
      style={large ? ({ '--tabs-n': options.length } as CSSProperties) : undefined}
    >
      {options.map((o) => {
        const selected = value === o.key;
        const small = !underline && size === 'sm';
        return (
          <button
            key={o.key}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={o.disabled}
            title={o.disabled ? `${o.label} — soon` : undefined}
            onClick={() => { if (!o.disabled) onChange(o.key); }}
            className={`tabs-pill-item${selected ? ' is-selected' : ''}${small ? ' is-sm' : ''}${o.tone && o.tone !== 'neutral' ? ` tone-${o.tone}` : ''}`}
          >
            {o.icon && <Icon name={o.icon} size={small ? 12 : 13} />}
            {o.label}
            {o.count != null && <span className="tabs-count">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
