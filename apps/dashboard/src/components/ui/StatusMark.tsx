// The status mark of timelines, calendar chips and legends (spec 078 D2). `--color-accent` and `--color-success` are one
// green, so a status is told apart by the SHAPE of its mark and only then by colour. `Badge` stays the component for
// status cells in tables; the tone and label maps both read are in lib/status-tone.ts.
//
//   <StatusMark status={slotMark(slot)} />                      published = filled green dot, failed = red square, ...
//   <StatusMark status="missed" label="Missed 09:30 · Daily fact" />
//   <StatusMark status={upcoming.status} decorative />          null = "not planned"; decorative when text sits beside it

import type { CSSProperties, ReactNode } from 'react';
import { MARK_LABEL, type MarkKind } from '../../lib/status-tone';

/** The shapes, drawn on a 14 x 14 grid in `currentColor`; the colour per status is set by `.status-mark.is-<status>`. */
const SHAPE: Record<MarkKind, ReactNode> = {
  planned:           <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" />,
  running:           <circle cx="7" cy="7" r="5" fill="currentColor" />,
  awaiting_approval: <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" />,
  approved: (
    <>
      <circle cx="7" cy="7" r="6" fill="currentColor" />
      <path d="M4.3 7.3l2 2 3.5-4" fill="none" stroke="var(--color-on-accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  shadowed:          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="2.6 2.6" />,
  published: (
    <>
      <circle cx="7" cy="7" r="6.5" fill="currentColor" opacity="0.18" />
      <circle cx="7" cy="7" r="4.5" fill="currentColor" />
    </>
  ),
  skipped:           <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="2" />,
  failed:            <rect x="2.5" y="2.5" width="9" height="9" rx="2" fill="currentColor" />,
  expired:           <rect x="3.2" y="3.2" width="7.6" height="7.6" rx="1.4" transform="rotate(45 7 7)" fill="currentColor" />,
  missed:            <rect x="3.2" y="3.2" width="7.6" height="7.6" rx="1.4" transform="rotate(45 7 7)" fill="currentColor" />,
  // A dashed square, not a dashed circle: "shadowed" is already the dashed circle and the two must not look alike.
  not_planned:       <rect x="2" y="2" width="10" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.4 2" />,
  // The owner's own post: a target, so it is no slot status at a glance.
  yours: (
    <>
      <circle cx="7" cy="7" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="7" cy="7" r="3.5" fill="currentColor" />
    </>
  ),
};

export function StatusMark({ status, label, size = 14, decorative = false }: {
  /** A slot status, a computed state (`missed`, `not_planned`, `yours`); `null` / `undefined` = not planned. */
  status: MarkKind | null | undefined;
  /** Accessible name and tooltip; defaults to the status name ("Awaiting approval"). */
  label?: string;
  /** Pixel size of the mark (the grid is 14). */
  size?: number;
  /** Text next to the mark already says it: hide the mark from assistive tech and drop the tooltip. */
  decorative?: boolean;
}) {
  const kind: MarkKind = status ?? 'not_planned';
  const name = label ?? MARK_LABEL[kind];
  return (
    <span
      className={`status-mark is-${kind.replace(/_/g, '-')}${kind === 'running' ? ' is-pulse' : ''}`}
      style={size === 14 ? undefined : ({ '--mark-size': `${size}px` } as CSSProperties)}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name, title: name })}
    >
      <svg viewBox="0 0 14 14" focusable="false" aria-hidden="true">{SHAPE[kind]}</svg>
    </span>
  );
}
