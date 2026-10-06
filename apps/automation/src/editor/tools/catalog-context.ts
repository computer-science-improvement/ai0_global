import type { Pool } from 'pg';
import type { CardSource } from '../card';
import type { OwnerInbox } from '../agents/owner-inbox';
import { API_KEY_ENV, API_SOURCE_NAMES } from './api-adapters/names';
import { API_ADAPTERS } from './api-adapters';
import { buildCatalog, CatalogSummary, summarize } from '../../data/data-catalog';
import { resourceKeys } from '../../data/data-refs';
import { kyivMonthDay } from '../../data/data-query';
import { normalizePlaybook } from '../network/series-edit';
import { instancesPerDay, parseCadence } from '../network/series';

/**
 * What library_catalog adds on top of the data store catalog (spec 023 FR-008, after 032 T6):
 *   • `apis` (name, what it returns, `configured` — never a key value) and the card's feeds;
 *   • per dataset on the asking resource: `last_used_here` and `runway_days` (unposted here ÷ expected daily
 *     use = the larger of the active series that name the dataset and the 28-day ledger usage);
 *   • a ≤ 1,500-character summary for the orchestrator and planner prompts, cached 10 minutes;
 *   • `low_runway` Inbox items when a dataset an active series uses runs out within 14 days.
 */

type Q = Pick<Pool, 'query'>;

export const RUNWAY_ALERT_DAYS = 14;
export const RUNWAY_ALERT_EVERY_DAYS = 7;
export const CATALOG_CACHE_MS = 10 * 60_000;
export const PROMPT_SUMMARY_MAX = 1500;

export interface ApiEntry { name: string; description: string; configured: boolean }
export interface FeedEntry { id: string; kind: string; ref: string; note?: string }

/** Adapter list with `configured` from the presence of its key (the value is never read out). */
export function apiCatalog(env: (k: string) => string | undefined): ApiEntry[] {
  return API_SOURCE_NAMES.map((name) => {
    const key = API_KEY_ENV[name];
    const desc = API_ADAPTERS[name].description;
    return { name, description: desc.replace(/^\S+ — /, '').split(' params:')[0].slice(0, 160), configured: !key || !key.required || !!env(key.env)?.trim() };
  });
}

/** The card's feeds (rss / url sources). */
export function cardFeeds(sources: CardSource[] | undefined | null): FeedEntry[] {
  return (sources ?? []).filter((s) => s.kind === 'rss' || s.kind === 'url')
    .map((s) => ({ id: s.id, kind: s.kind, ref: s.ref, ...(s.note ? { note: s.note } : {}) }));
}

/** Daily instances of active series that name a library dataset as their source, on one resource. */
export async function seriesLibraryUse(pool: Q, resourceRef: string): Promise<Record<string, number>> {
  const rr = resourceKeys(resourceRef).resourceRef;
  const { rows } = await pool.query(
    `SELECT body FROM playbooks WHERE status = 'active' AND body->'series' @> jsonb_build_array(jsonb_build_object('resource_ref', $1::text))`, [rr]);
  const out: Record<string, number> = {};
  for (const r of rows) {
    for (const s of normalizePlaybook(r.body).series ?? []) {
      if (s.active === false || s.resource_ref !== rr || s.source?.kind !== 'library') continue;
      const c = parseCadence(s.cadence);
      if (c) out[s.source.table] = (out[s.source.table] ?? 0) + instancesPerDay(c);
    }
  }
  return out;
}

/** Publications per dataset on one resource from the ledger: last use and the 28-day count. */
export async function ledgerUsage(pool: Q, resourceRef: string): Promise<Record<string, { used28: number; last: Date | null }>> {
  const rr = resourceKeys(resourceRef).resourceRef;
  const { rows } = await pool.query(
    `SELECT split_part(substr(source_ref, 8), '/', 1) AS key,
            count(*) FILTER (WHERE used_at > now() - interval '28 days')::int AS used28, max(used_at) AS last
       FROM content_ledger WHERE resource_ref = $1 AND status = 'published' AND source_ref LIKE 'data://%'
      GROUP BY 1`, [rr]);
  return Object.fromEntries(rows.map((r: any) => [r.key, { used28: Number(r.used28), last: r.last ? new Date(r.last) : null }]));
}

/** Days of material left: unposted ÷ max(series per day, 28-day usage per day); null when nothing uses it. */
export function runwayDays(unposted: number | undefined, seriesPerDay: number, used28: number): number | null {
  const perDay = Math.max(seriesPerDay, used28 / 28);
  if (unposted === undefined || perDay <= 0) return null;
  return Math.round((unposted / perDay) * 10) / 10;
}

export type CatalogOverviewRow = CatalogSummary & { last_used_here?: string | null; runway_days?: number | null };

/** The catalog overview for a resource with the 023 additions (no cache). */
export async function catalogOverview(pool: Q, o: { resource: string | null; env?: (k: string) => string | undefined; feeds?: CardSource[] | null; today?: { month: number; day: number } }) {
  const entries = await buildCatalog(pool, { resource: o.resource, today: o.today ?? kyivMonthDay() });
  const [use, series] = o.resource ? await Promise.all([ledgerUsage(pool, o.resource), seriesLibraryUse(pool, o.resource)]) : [{}, {}];
  const datasets: CatalogOverviewRow[] = entries.map((e) => {
    const u = (use as Record<string, { used28: number; last: Date | null }>)[e.dataset];
    const perDay = (series as Record<string, number>)[e.dataset] ?? 0;
    return {
      ...summarize(e),
      ...(o.resource ? { last_used_here: u?.last ? u.last.toISOString() : null, runway_days: runwayDays(e.unposted_here, perDay, u?.used28 ?? 0) } : {}),
    };
  });
  return { datasets, apis: o.env ? apiCatalog(o.env) : [], feeds: cardFeeds(o.feeds) };
}

/** ≤ 1,500 characters for the orchestrator and planner prompts. */
export function catalogPromptSummary(c: { datasets: CatalogOverviewRow[]; apis: ApiEntry[]; feeds: FeedEntry[] }): string {
  const lines: string[] = ['Джерела (деталі — library_catalog; усе необовʼязкове, обирай під пост):'];
  const ds = [...c.datasets].sort((a, b) => (b.unposted_here ?? b.rows) - (a.unposted_here ?? a.rows));
  for (const d of ds) {
    const runway = d.runway_days != null ? `, запас ${d.runway_days} дн.` : '';
    const today = d.today_items ? `, сьогодні ${d.today_items}` : '';
    lines.push(`• ${d.dataset}: ${d.title} — невикористаних тут ${d.unposted_here ?? '?'} з ${d.rows}${today}${runway}`);
  }
  const apis = c.apis.filter((a) => a.configured).map((a) => a.name);
  if (apis.length) lines.push(`• API (fetch_api): ${apis.join(', ')}`);
  if (c.feeds.length) lines.push(`• Фіди картки (fetch_feed): ${c.feeds.map((f) => f.id).join(', ')}`);
  lines.push('• Дайджест мережі: get_network_highlights');
  let out = '';
  for (const l of lines) {
    if ((out ? out.length + 1 : 0) + l.length > PROMPT_SUMMARY_MAX - 2) { out += '\n…'; break; }
    out = out ? `${out}\n${l}` : l;
  }
  return out;
}

/** A 10-minute cache of computed values by key (the catalog overview per resource). */
export class TtlCache<T> {
  private readonly m = new Map<string, { at: number; v: T }>();
  constructor(private readonly ttlMs = CATALOG_CACHE_MS, private readonly now: () => number = () => Date.now()) {}
  async get(key: string, make: () => Promise<T>): Promise<T> {
    const hit = this.m.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.v;
    const v = await make();
    this.m.set(key, { at: this.now(), v });
    if (this.m.size > 200) this.m.delete(this.m.keys().next().value!);
    return v;
  }
}

/** The prompt summary of a channel's sources, cached 10 minutes per channel (orchestrator and planner runs). */
export function catalogSummaryOf(pool: Q, env: (k: string) => string | undefined): (card: { channelKey: string; sources?: CardSource[] }) => Promise<string | null> {
  const cache = new TtlCache<string>();
  return (card) => cache.get(card.channelKey, async () =>
    catalogPromptSummary(await catalogOverview(pool, { resource: `telegram:${card.channelKey}`, env, feeds: card.sources ?? null })));
}

/**
 * `low_runway` (FR-008): for every active series of an orchestrator that names a library dataset, the
 * dataset's runway on that series' resource; below 14 days → one Inbox item per dataset per 7 days.
 * Returns the datasets it reported.
 */
export async function checkLowRunway(d: { pool: Q; inbox: Pick<OwnerInbox, 'post'> }, agent: { id: string; handle: string }, playbook: unknown): Promise<string[]> {
  const pb = playbook ? normalizePlaybook(playbook) : null;
  const pairs = new Map<string, { resource: string; table: string }>();
  for (const s of pb?.series ?? []) {
    if (s.active === false || s.source?.kind !== 'library') continue;
    pairs.set(`${s.resource_ref}|${s.source.table}`, { resource: s.resource_ref, table: s.source.table });
  }
  const reported: string[] = [];
  for (const { resource, table } of pairs.values()) {
    if (reported.includes(table)) continue;
    const [entry] = await buildCatalog(d.pool, { dataset: table, resource, today: kyivMonthDay() });
    if (!entry) continue;
    const use = (await ledgerUsage(d.pool, resource))[table];
    const perDay = (await seriesLibraryUse(d.pool, resource))[table] ?? 0;
    const days = runwayDays(entry.unposted_here, perDay, use?.used28 ?? 0);
    if (days === null || days >= RUNWAY_ALERT_DAYS) continue;
    const { rows } = await d.pool.query(
      `SELECT 1 FROM agent_inbox WHERE kind = 'low_runway' AND ref_type = 'dataset' AND ref_id = $1
          AND created_at > now() - make_interval(days => $2) LIMIT 1`, [table, RUNWAY_ALERT_EVERY_DAYS]);
    if (rows.length) continue;
    await d.inbox.post({
      agentId: agent.id, kind: 'low_runway', severity: 'action', refType: 'dataset', refId: table,
      title: `📉 ${table}: about ${days} days of material left on ${resource}`,
      body: `@${agent.handle} has a series that uses the "${table}" dataset on ${resource}. ${entry.unposted_here ?? 0} rows are still unused there; at the current pace that lasts about ${days} days. Import more rows on /app/data/${table}, or let the series use another source.`,
      alert: {
        title: `📉 ${table}: матеріалу приблизно на ${days} дн. (${resource})`,
        body: `Серія @${agent.handle} бере «${table}»; невикористаних рядків ${entry.unposted_here ?? 0}. Додайте дані на /app/data/${table} або дайте серії інше джерело.`,
      },
    });
    reported.push(table);
  }
  return reported;
}
