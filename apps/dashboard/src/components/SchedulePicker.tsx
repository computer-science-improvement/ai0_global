// apps/dashboard/src/components/SchedulePicker.tsx
//
// Cron expression editor: a free-text input plus one-click preset chips.
// Used both inside the strategy edit page (full strategy edit) and inside
// InlineScheduleEditor (per-row inline edit on the channel detail page).
// Kept here as a single source of truth so both call-sites stay in sync
// on the preset list and look identical.

export const COMMON_SCHEDULES: ReadonlyArray<{ readonly label: string; readonly expr: string }> = [
  { label: 'Every hour (top of hour)', expr: '0 * * * *' },
  { label: 'Every 30 minutes',         expr: '*/30 * * * *' },
  { label: 'Daily at 09:00',           expr: '0 9 * * *' },
  { label: 'Daily at 18:00',           expr: '0 18 * * *' },
  { label: 'Weekdays at 09:00',        expr: '0 9 * * 1-5' },
  { label: 'Every 4 hours',            expr: '0 */4 * * *' },
];

interface Props {
  value:    string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Tighter top margin between input and chips (6 px instead of 8 px). */
  compact?:  boolean;
  /** Optional input id for label-for wiring in the modal. */
  inputId?:  string;
  /** Placeholder shown when the input is empty (e.g. for create forms). */
  placeholder?: string;
}

export function SchedulePicker({ value, onChange, disabled, compact, inputId, placeholder }: Props) {
  return (
    <>
      <input
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="input-field"
        style={{ width: '100%', fontVariantNumeric: 'tabular-nums' }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: compact ? 6 : 8 }}>
        {COMMON_SCHEDULES.map((s) => (
          <button
            key={s.expr}
            type="button"
            onClick={() => onChange(s.expr)}
            disabled={disabled}
            className={value === s.expr ? 'chip is-active' : 'chip'}
            style={{ cursor: disabled ? 'default' : 'pointer', border: 'none' }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </>
  );
}
