// Shared table conventions — the ONE place that defines how data tables look
// and how row actions are labelled/iconed across the dashboard. See
// apps/dashboard/CLAUDE.md ("Tables") for the documented standard.
//
// Tables use `.table-wrap > table.table`; numeric columns get `.num`; the last
// column is always "Actions" (right-aligned, ACTIONS_COL_WIDTH). Status cells
// use the <Badge> component. Row actions use <TableAction> so every page shows
// the same icon + label for the same semantic action.
import type { ReactNode, CSSProperties } from 'react';
import { Icon, type IconName } from './Icon';

/** Canonical action vocabulary: one icon + default label per semantic action. */
export const ACTION = {
  add:    { icon: 'plus'    as IconName, label: 'Add',    danger: false },
  edit:   { icon: 'pencil'  as IconName, label: 'Edit',   danger: false },
  delete: { icon: 'trash'   as IconName, label: 'Delete', danger: true  },
  verify: { icon: 'refresh' as IconName, label: 'Verify', danger: false },
  pause:  { icon: 'pause'   as IconName, label: 'Pause',  danger: false },
  enable: { icon: 'play'    as IconName, label: 'Enable', danger: false },
} as const;

export type ActionKey = keyof typeof ACTION;

/** Fixed width of the right-aligned "Actions" column header. */
export const ACTIONS_COL_WIDTH = 240;

/** Standard "Actions" column header — right-aligned, fixed width. */
export function ActionsTh() {
  return <th style={{ width: ACTIONS_COL_WIDTH, textAlign: 'right' }}>Actions</th>;
}

/**
 * The standard row / card action control — a bordered square ICON button
 * (`.btn-act`), with the label as a hover tooltip. Pass a canonical `action`
 * (sets icon + tooltip + danger) or override with `icon`/`title`/`danger`.
 * Set `label` to also render the text beside the icon (rare; tables stay
 * icon-only for density). Destructive actions use the `.btn-act-danger` variant.
 */
export function TableAction({
  action, icon, danger, title, disabled, onClick, label, style,
}: {
  action?:   ActionKey;
  icon?:     IconName;
  danger?:   boolean;
  title?:    string;
  disabled?: boolean;
  onClick?:  () => void;
  /** Render the text label beside the icon (default: tooltip only). */
  label?:    ReactNode;
  style?:    CSSProperties;
}) {
  const a = action ? ACTION[action] : undefined;
  const useIcon = icon ?? a?.icon;
  const isDanger = danger ?? a?.danger ?? false;
  const tip = title ?? (typeof a?.label === 'string' ? a.label : undefined);
  const labelled = label !== undefined;
  return (
    <button
      type="button"
      className={isDanger ? 'btn-act btn-act-danger' : 'btn-act'}
      title={tip}
      aria-label={tip}
      disabled={disabled}
      onClick={onClick}
      style={labelled ? { width: 'auto', gap: 6, padding: '0 10px', ...style } : style}
    >
      {useIcon && <Icon name={useIcon} size={14} />}
      {labelled && (label ?? a?.label)}
    </button>
  );
}

/**
 * Right-aligned container for an Actions cell. Put the destructive action in the
 * `danger` slot — it's rendered after a divider so it can't be misclicked next
 * to Enable/Pause.
 */
export function RowActions({ children, danger }: { children?: ReactNode; danger?: ReactNode }) {
  return (
    <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
      {children}
      {danger != null && <><span className="row-actions-sep" aria-hidden />{danger}</>}
    </div>
  );
}
