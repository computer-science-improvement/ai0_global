// Formatting of approval stats and the approve ⇄ live switch (spec 031 T5/T6).
// Pure functions: the switch dialog, the agent page stats and their tests share them.

/** 0.857 → "86%"; null → "—". */
export function fmtRate(rate: number | null | undefined): string {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`;
}

/** Median time to approve: "45s", "12 min", "3.5 h", "2.1 d"; null → "—". */
export function fmtWait(sec: number | null | undefined): string {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(1).replace(/\.0$/, '')} h`;
  return `${(sec / 86_400).toFixed(1).replace(/\.0$/, '')} d`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The confirm label of the switch dialog: what will happen to the waiting posts. */
export function waitingChoiceLabel(waiting: number, withWarnings: number): string {
  const clean = Math.max(0, waiting - withWarnings);
  const base = `Also approve the ${plural(clean, 'waiting post')}`;
  return withWarnings ? `${base} (${plural(withWarnings, 'post')} with warnings stay for a manual look)` : base;
}

/** The toast after a switch. */
export function switchSummary(r: { to: 'live' | 'approve'; changed: boolean; approved: number; skippedWithWarnings: number; conflicts: number; leftWaiting: number }, title: string): string {
  if (!r.changed && r.approved === 0) return `${title} is already ${r.to === 'live' ? 'Live' : 'in approval mode'}`;
  if (r.to === 'approve') return `${title} is back in approval mode — the next written post waits for you`;
  const parts = [`${title} is Live — agents publish without approval`];
  if (r.approved) parts.push(`${plural(r.approved, 'waiting post')} approved`);
  if (r.skippedWithWarnings) parts.push(`${plural(r.skippedWithWarnings, 'post')} with warnings left waiting`);
  if (r.conflicts) parts.push(`${r.conflicts} already decided`);
  if (r.leftWaiting && !r.skippedWithWarnings) parts.push(`${plural(r.leftWaiting, 'post')} left waiting`);
  return parts.join('; ');
}
