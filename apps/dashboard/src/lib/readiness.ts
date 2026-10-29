// Spec 072 FR-008/FR-010, A11, A13, A23: the words of the Readiness panel and of the "Start anyway" confirms. Pure: no React.
// A finding's label comes from the reason mirror (lib/reasons.ts, spec 073 FR-014: labels are read from there only), with the
// server's title for a code the mirror does not hold; the details and the fix labels are the server's.

import type { ReadinessFinding, ReadinessFixResult, ReadinessLast24h, ReadinessView } from '../api/readiness';
import { reasonView } from './reasons';

/** After a successful change the next reads ask the server for a fresh look for this long (A11). */
export const FRESH_WINDOW_MS = 5_000;

/** The code of the info rows the server writes when it applied a fix by itself. */
export const AUTO_FIXED_CODE = 'auto_fixed';

/** `GET …/readiness`, with `?fresh=1` when the stored row must not be trusted. */
export const readinessPath = (channelKey: string, fresh = false): string =>
  `/api/editor/channels/${encodeURIComponent(channelKey)}/readiness${fresh ? '?fresh=1' : ''}`;

/** Is `now` inside the window that follows the mutation at `staleAt`? (`null` = nothing changed yet.) */
export function isFreshWindow(now: number, staleAt: number | null | undefined): boolean {
  if (staleAt == null) return false;
  const d = now - staleAt;
  return d >= 0 && d < FRESH_WINDOW_MS;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Tone = 'danger' | 'warning' | 'success';

/** The badges on the card: blockers (danger), warnings (warning), or "Ready" when neither is open. */
export function badgesOf(v: Pick<ReadinessView, 'blockers' | 'warnings'>): Array<{ tone: Tone; label: string }> {
  const out: Array<{ tone: Tone; label: string }> = [];
  if (v.blockers > 0) out.push({ tone: 'danger', label: plural(v.blockers, 'blocker', 'blockers') });
  if (v.warnings > 0) out.push({ tone: 'warning', label: plural(v.warnings, 'warning', 'warnings') });
  return out.length ? out : [{ tone: 'success', label: 'Ready' }];
}

const isOpen = (f: Pick<ReadinessFinding, 'code'>) => f.code !== AUTO_FIXED_CODE;

/** The label of a finding: the mirror's `en` for its code, else the server's title. */
export const findingTitle = (f: Pick<ReadinessFinding, 'code' | 'title'>): string => reasonView(f.code)?.en ?? f.title;

/** What to change, from the mirror, for an open row without a Fix button; null otherwise. */
export const findingHint = (f: Pick<ReadinessFinding, 'code' | 'fix'>): string | null =>
  (isOpen(f) && !f.fix ? reasonView(f.code)?.fix?.en ?? null : null);

/** The first open blocker's title, or the all-clear line. */
export function bodyLine(v: Pick<ReadinessView, 'findings'>): string {
  const first = v.findings.find((f) => f.severity === 'error' && isOpen(f));
  return first ? findingTitle(first) : 'Nothing blocks this channel.';
}

/** "Last 24 h: 6 planned · 2 published · 1 waiting · 3 skipped (2 lint, 1 config)". */
export function last24hLine(l: ReadinessLast24h): string {
  if (!l.planned) return 'Last 24 h: nothing planned';
  const groups = Object.entries(l.byGroup ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const why = l.skipped > 0 && groups.length ? ` (${groups.map(([g, n]) => `${n} ${g.replace(/_/g, ' ')}`).join(', ')})` : '';
  return `Last 24 h: ${l.planned} planned · ${l.published} published · ${l.awaiting} waiting · ${l.skipped} skipped${why}`;
}

/** The card's attention line: how many findings Fix all would resolve; null when none. */
export const fixAllNote = (v: Pick<ReadinessView, 'fixable'>): string | null => (v.fixable > 0 ? `Fix all can resolve ${v.fixable}` : null);

export interface ReadinessSections { blockers: ReadinessFinding[]; warnings: ReadinessFinding[]; info: ReadinessFinding[]; fixed: ReadinessFinding[] }

/** The dialog's sections: errors, warnings, info, and what code fixed by itself (the server's order is kept inside each). */
export function sectionsOf(findings: readonly ReadinessFinding[]): ReadinessSections {
  const s: ReadinessSections = { blockers: [], warnings: [], info: [], fixed: [] };
  for (const f of findings) {
    if (!isOpen(f)) s.fixed.push(f);
    else if (f.severity === 'error') s.blockers.push(f);
    else if (f.severity === 'warn') s.warnings.push(f);
    else s.info.push(f);
  }
  return s;
}

/** Can this row's own Fix button do something? (Info rows keep one; the server decides whether the kind is allowed.) */
export const hasFix = (f: ReadinessFinding): boolean => isOpen(f) && !!f.fix;

/** Fix all's confirm: `Are you sure you want to apply 2 fixes?` */
export const fixAllPhrase = (n: number): string => `apply ${plural(n, 'fix', 'fixes')}`;

/**
 * The distinct fix labels of the open errors and warnings Fix all applies, for its confirm (up to `max`, then "…and N more").
 * A kind Fix all skips (`inFixAll: false`: binding a dataset, a dataset patch, dropping a source) keeps its own button only.
 */
export function fixLabels(findings: readonly ReadinessFinding[], max = 8): string[] {
  const labels = [...new Set(findings.filter((f) => isOpen(f) && f.severity !== 'info' && f.fix && f.fix.inFixAll !== false).map((f) => f.fix!.label))];
  return labels.length > max ? [...labels.slice(0, max), `…and ${labels.length - max} more`] : labels;
}

/** What the owner is told after a fix request: what was applied, then what was refused (the server's own words). */
export function fixToasts(r: Pick<ReadinessFixResult, 'applied' | 'failed'>): Array<{ kind: 'success' | 'error'; text: string }> {
  const out: Array<{ kind: 'success' | 'error'; text: string }> = [];
  if (r.applied.length) out.push({ kind: 'success', text: r.applied.length === 1 ? `Fixed: ${r.applied[0]}` : `Fixed ${r.applied.length} things` });
  if (r.failed.length) out.push({ kind: 'error', text: `${plural(r.failed.length, 'fix', 'fixes')} failed: ${r.failed[0].error}` });
  return out.length ? out : [{ kind: 'success', text: 'Nothing to fix' }];
}

// ── links ────────────────────────────────────────────────────────────────────

/** A deep link to the agent's Overview with the Readiness dialog open. */
export const readinessLink = (handle: string): string => `/app/agents/${encodeURIComponent(handle.replace(/^@+/, ''))}?tab=overview&readiness=1`;

/** `?readiness=1` as the router hands it over (a number, a string or a boolean). */
export function parseReadinessFlag(v: unknown): boolean {
  return v === 1 || v === true || v === '1' || v === 'true';
}

/** A server-resolved link (`/app/agents/x?tab=skills`) as a router target. */
export function splitLink(link: string): { to: string; search: Record<string, string> } {
  const i = link.indexOf('?');
  const to = i < 0 ? link : link.slice(0, i);
  const search: Record<string, string> = {};
  if (i >= 0) new URLSearchParams(link.slice(i + 1)).forEach((value, key) => { search[key] = value; });
  return { to, search };
}

// ── Start anyway (FR-010, A23) ───────────────────────────────────────────────

export const START_ANYWAY = 'Start anyway';

/** Is this mode change the channel starting to post? Only off or shadow to approve or live; approve to live is a step up, not a start. */
export const isStartMove = (from: string, to: string): boolean => (from === 'off' || from === 'shadow') && (to === 'approve' || to === 'live');

/**
 * The result worth a "Start anyway": the fresh view when it has open blockers; null when it has none or the look failed
 * (a check that cannot be read must never stop the owner, so a failure asks nothing extra).
 */
export async function blockedView(load: () => Promise<ReadinessView>): Promise<ReadinessView | null> {
  try {
    const view = await load();
    return view && view.blockers > 0 ? view : null;
  } catch {
    return null;
  }
}

/** The one line above the list when a confirm has its own text (the launch Start): "The readiness check found 2 open blockers:". */
export const blockerIntro = (n: number): string => `The readiness check found ${plural(n, 'open blocker', 'open blockers')}:`;

/** The confirm's action: `start @x with 2 open blockers` (the dialog says "Are you sure you want to …?"). */
export const startPhrase = (target: string, n: number): string => `start ${target} with ${plural(n, 'open blocker', 'open blockers')}`;

/** The open blockers as lines for the confirm: up to `max`, then "…and N more". */
export function blockerLines(v: Pick<ReadinessView, 'findings'>, max = 5): string[] {
  const open = v.findings.filter((f) => f.severity === 'error' && isOpen(f));
  const lines = open.slice(0, max).map((f) => {
    const title = findingTitle(f);
    const label = (f.subject?.label ?? '').trim();
    return label && label !== title && label !== f.code ? `${title} — ${label}` : title;
  });
  return open.length > max ? [...lines, `…and ${open.length - max} more`] : lines;
}
