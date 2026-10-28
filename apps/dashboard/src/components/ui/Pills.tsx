// Small status pills shared by Today, Inbox and the shell: the severity of a note and the "N agents live" pill.

import type { ReactNode } from 'react';

/** The severity of an inbox note / attention item (matches the API: `info` | `action` | `critical`). */
export type Severity = 'info' | 'action' | 'critical';

/** Owner-facing severity names. `info` reads "FYI". */
export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', action: 'Action', info: 'FYI' };

const known = (s: string): s is Severity => s === 'info' || s === 'action' || s === 'critical';

/** A mono, uppercase pill: critical (red), action (amber), FYI (grey). An unknown severity renders as FYI. */
export function SeverityPill({ severity, label }: { severity: Severity | string; label?: string }) {
  const s: Severity = known(severity) ? severity : 'info';
  return <span className={`sev sev-${s}`}>{label ?? SEVERITY_LABEL[s]}</span>;
}

/** The 8px mark that leads a list row: a dot (critical), a diamond (action), a ring (FYI). Decorative, pair it with text. */
export function SeverityMark({ severity }: { severity: Severity | string }) {
  const s: Severity = known(severity) ? severity : 'info';
  return <span className={`severity-mark is-${s}`} aria-hidden="true" />;
}

/** A green pill with a pulsing dot: "5 agents live". */
export function LivePill({ children }: { children: ReactNode }) {
  return (
    <span className="pill-live">
      <span className="status-dot is-live" aria-hidden="true" />
      {children}
    </span>
  );
}
