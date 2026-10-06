// Pure view helpers for the AI spend card, the Agents card and the Spend page
// (spec 029). No React here, so node:test covers them.

export type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';
export type BudgetStateLike = 'none' | 'ok' | 'warning' | 'danger' | 'over' | 'blocked';

/** USD with precision that suits the size: $0.0042, $0.42, $4.20, $1,234. */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a === 0) return '$0.00';
  if (a < 0.01) return `$${n.toFixed(4)}`;
  if (a < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Compact token counts: 950, 12.3K, 4.1M. */
export function fmtTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** "+12%" / "−8%" / "new" (no previous spend) / "0%". */
export function fmtDelta(pct: number | null, prev = 0, cur = 0): string {
  if (pct == null) return cur > 0 && prev === 0 ? 'new' : '—';
  if (pct === 0) return '0%';
  const v = Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1);
  return `${pct > 0 ? '+' : '−'}${v}%`;
}

/** Spend going up is a cost signal (warning), going down is good (success). */
export function deltaTone(pct: number | null): Tone {
  if (pct == null || pct === 0) return 'neutral';
  return pct > 0 ? 'warning' : 'success';
}

/** Bar colour of a cap (BR-CORE-34: accent < 70 %, warning ≥ 70 %, danger ≥ 90 % and at the cap). */
export function budgetBarColor(state: BudgetStateLike): string {
  switch (state) {
    case 'blocked':
    case 'over':
    case 'danger':  return 'var(--color-danger)';
    case 'warning': return 'var(--color-warning)';
    case 'none':    return 'var(--color-ink-dim)';
    default:        return 'var(--color-accent)';
  }
}

export function budgetBadge(state: BudgetStateLike, enforce: boolean): { tone: Tone; label: string } | null {
  if (state === 'blocked') return { tone: 'danger', label: 'Blocked' };
  if (state === 'over') return { tone: 'warning', label: 'Over cap (alert only)' };
  if (state === 'danger') return { tone: 'danger', label: '≥ 90%' };
  if (state === 'warning') return { tone: 'warning', label: '≥ 70%' };
  if (!enforce) return { tone: 'neutral', label: 'Alert only' };
  return null;
}

/** Bar width in %, clamped. */
export function barPct(spent: number, cap: number | null): number {
  if (cap == null) return 0;
  if (cap <= 0) return spent > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (spent / cap) * 100));
}

/** Which body a card renders. */
export type CardView = 'loading' | 'error' | 'empty' | 'data';

export function cardView<T>(q: { isLoading?: boolean; error?: unknown; data?: T }, isEmpty: (d: T) => boolean): CardView {
  if (q.error && !q.data) return 'error';
  if (!q.data) return 'loading';
  return isEmpty(q.data) ? 'empty' : 'data';
}

/** The ledger has nothing in the last 30 days and no caps are blocking. */
export function spendIsEmpty(s: { periods: { '30d': { calls: number; usd: number } }; blocking: unknown[] }): boolean {
  return s.periods['30d'].calls === 0 && s.periods['30d'].usd === 0 && s.blocking.length === 0;
}

/** "% estimated" note text, or null when estimated and unpriced shares are both ≤ 10 %. */
export function estimatedNote(e: { estimatedPct: number; unpricedPct: number; unpricedCalls: number; note: boolean }): string | null {
  if (!e.note) return null;
  const parts: string[] = [];
  if (e.estimatedPct > 10) parts.push(`${Math.round(e.estimatedPct)}% of USD is estimated from the price table`);
  if (e.unpricedPct > 10) parts.push(`${e.unpricedCalls} call${e.unpricedCalls === 1 ? '' : 's'} (${Math.round(e.unpricedPct)}%) have no price`);
  return parts.join('; ') || null;
}

/** Success rate label: "92%" or "—". */
export function fmtRate(r: number | null): string {
  return r == null ? '—' : `${Math.round(r)}%`;
}

/** Categorical colours for the stacked chart (theme tokens; index.css defines --color-chart-5…8). */
export const SERIES_COLORS = [
  'var(--color-accent)', 'var(--color-warning)', 'var(--color-tg-link)', 'var(--color-danger)',
  'var(--color-chart-5)', 'var(--color-chart-6)', 'var(--color-chart-7)', 'var(--color-chart-8)',
];

export function seriesColor(key: string, index: number): string {
  return key === 'other' ? 'var(--color-ink-dim)' : SERIES_COLORS[index % SERIES_COLORS.length];
}

/** Today's Kyiv day as YYYY-MM-DD (the ledger's day boundary). */
export function kyivToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(now);
}

/** A custom range is valid when both days are set, ordered and at most 366 days long. */
export function customRangeError(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 'Pick both days';
  if (from > to) return 'The start is after the end';
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > 366) return 'At most 366 days';
  return null;
}

/** Parse a money field: '' → null, otherwise a non-negative number or NaN. */
export function parseUsd(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}
