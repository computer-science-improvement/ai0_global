// Pure logic of the agent page (spec 078 D6, B3): what the pause banners say, and how many of them to draw. The Overview's
// day list and counters (B3.3) are added to this file. No React, node-tested (agent-overview.test.ts).

import type { SeriesPauseCause } from '../api/agents';

// ── pause banners ────────────────────────────────────────────────────────────

/** The cause of a paused series, in words (the owner's own pause has no streak). */
export const PAUSE_CAUSE: Record<SeriesPauseCause, string> = {
  no_material:        'No material',
  source_unreachable: 'Source unreachable',
  owner:              'Paused by you',
};

/**
 * The headline of a paused-series banner. A pause key is `series:<id>` (one series of the plan), `rule:<id>` (one fixed-slot
 * rule; its label reads "fixed slot 09:00 …") or `resource:<ref>` (the whole resource: nothing is planned).
 */
export function pauseTitle(p: { key: string; label: string }): string {
  const label = p.label.trim();
  if (p.key.startsWith('series:')) return label ? `Series “${label}” paused` : 'A series is paused';
  if (p.key.startsWith('rule:')) {
    const slot = label.replace(/^fixed slot\s*/i, '').trim();
    return slot ? `Fixed slot ${slot} paused` : 'A fixed slot is paused';
  }
  return 'Planning paused';
}

/** "No material: 3 skips in a row" — the streak is only named when there is one (the owner's pause has none). */
export function pauseSummary(p: { cause: SeriesPauseCause | string; streak: number }): string {
  const cause = PAUSE_CAUSE[p.cause as SeriesPauseCause] ?? String(p.cause);
  return p.streak > 0 ? `${cause}: ${p.streak} skip${p.streak === 1 ? '' : 's'} in a row` : cause;
}

/** What the pause means for planning, one line under the headline. */
export function pauseEffect(key: string): string {
  if (key.startsWith('series:')) return 'The planner skips it, and its planned slots are skipped at no cost, until you resume it.';
  if (key.startsWith('rule:')) return 'This fixed slot is skipped until you resume it.';
  return 'Nothing is planned here until you resume it.';
}

/** "Europe/Kyiv" → "Kyiv", "America/New_York" → "New York", "UTC" → "UTC"; null when there is no zone. */
export function zoneLabel(tz: string | null | undefined): string | null {
  if (!tz) return null;
  const last = tz.slice(tz.lastIndexOf('/') + 1).replace(/_/g, ' ').trim();
  return last || null;
}

/** The first `max` pauses and how many are left behind a "Show all" button. */
export function capPauses<T>(items: readonly T[], showAll: boolean, max = 3): { shown: T[]; hidden: number } {
  if (showAll || items.length <= max) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, max), hidden: items.length - max };
}
