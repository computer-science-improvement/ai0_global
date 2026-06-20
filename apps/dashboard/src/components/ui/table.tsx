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
 * A standard table row-action button (icon + label). Pass a canonical `action`
 * (which sets icon + label + danger) — or override with `icon`/`children`/
 * `danger`. Destructive actions render the `.btn-tiny-danger` variant.
 */
export function TableAction({
  action, icon, danger, title, disabled, onClick, children, style,
}: {
  action?:   ActionKey;
  icon?:     IconName;
  danger?:   boolean;
  title?:    string;
  disabled?: boolean;
  onClick?:  () => void;
  /** Override the label; defaults to the canonical action label. */
  children?: ReactNode;
  style?:    CSSProperties;
}) {
  const a = action ? ACTION[action] : undefined;
  const useIcon = icon ?? a?.icon;
  const isDanger = danger ?? a?.danger ?? false;
  const label = children !== undefined ? children : a?.label;
  return (
    <button
      type="button"
      className={isDanger ? 'btn-tiny-danger' : 'btn-tiny'}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...style }}
    >
      {useIcon && <Icon name={useIcon} size={12} />}
      {label}
    </button>
  );
}

/** Right-aligned container for an Actions cell — consistent gap + wrapping. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center' }}>
      {children}
    </div>
  );
}
