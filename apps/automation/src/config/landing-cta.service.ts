// apps/automation/src/config/landing-cta.service.ts
// Spec 026 FR-009 / FR-015: anonymous CTA click counters and the owner's CTA stats.
//
// A click on a landing CTA sends a beacon {cta, placement, lang}; the server adds 1
// to landing_cta_daily(day, cta, placement, lang). Nothing about the visitor is
// stored: no IP, no hash, no user agent, no timestamp finer than the day. The
// per-client rate limit (60/min) lives in memory under a salted hash.
//
// CTA stats set those clicks against DM threads the triage attributed to the landing
// (agent_dm_threads.fields.source = 'landing', FR-016) and against form leads, per
// placement, so the owner sees where people click and where they actually write.
import type { Pool } from 'pg';
import { LANDING_PLACEMENTS, isLandingPlacement, type LandingPlacement } from './landing-dm';

/** What a CTA does: open the Telegram DM, open the lead form, or go to the white-label offer. */
export const LANDING_CTAS = ['ad_dm', 'ad_form', 'white_label'] as const;
export type LandingCta = (typeof LANDING_CTAS)[number];

export interface CtaClick { cta: LandingCta; placement: LandingPlacement; lang: 'en' }

/** Validate a beacon body; null when it is not a known CTA/placement (the click is dropped). */
export function parseCtaClick(body: unknown): CtaClick | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.cta !== 'string' || !(LANDING_CTAS as readonly string[]).includes(b.cta)) return null;
  if (!isLandingPlacement(b.placement)) return null;
  // English only (owner decision 2026-10-06): whatever the client says, the row is 'en'.
  return { cta: b.cta as LandingCta, placement: b.placement, lang: 'en' };
}

export interface CtaStatsRow {
  placement:        string;
  dmClicks:         number;
  formClicks:       number;
  whiteLabelClicks: number;
  /** DM threads whose first tagged message came from this placement. */
  dmThreads:        number;
  /** Form leads (not spam) sent from this placement. */
  leads:            number;
}

export interface CtaStats {
  days:  number;
  since: string;          // YYYY-MM-DD (UTC), inclusive
  rows:  CtaStatsRow[];   // known placements first (in page order), then any others
  totals: Omit<CtaStatsRow, 'placement'>;
  /** Ad DM threads in the window with no landing tag: the client dropped `?text=` or the visitor deleted the tag. */
  untaggedAdThreads: number;
}

type Q = Pick<Pool, 'query'>;

const emptyRow = (placement: string): CtaStatsRow =>
  ({ placement, dmClicks: 0, formClicks: 0, whiteLabelClicks: 0, dmThreads: 0, leads: 0 });

export class LandingCtaService {
  constructor(private readonly pool: Q) {}

  /** +1 for today's (UTC) counter of this CTA. */
  async record(c: CtaClick): Promise<void> {
    await this.pool.query(
      `INSERT INTO landing_cta_daily (day, cta, placement, lang, clicks)
       VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, $3, 1)
       ON CONFLICT (day, cta, placement, lang) DO UPDATE SET clicks = landing_cta_daily.clicks + 1`,
      [c.cta, c.placement, c.lang]);
  }

  /** GET /api/landing/admin/cta-stats — clicks per placement vs. tagged DM threads and leads. */
  async stats(daysRaw: unknown = 30): Promise<CtaStats> {
    const n = Number(daysRaw);
    const days = Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30;
    const [clicks, threads, untagged, leads, since] = await Promise.all([
      this.pool.query<{ placement: string; cta: string; clicks: number }>(
        `SELECT placement, cta, SUM(clicks)::int AS clicks FROM landing_cta_daily
          WHERE day >= (now() AT TIME ZONE 'UTC')::date - ($1::int - 1)
          GROUP BY placement, cta`, [days]),
      this.pool.query<{ placement: string; threads: number }>(
        `SELECT COALESCE(NULLIF(fields->>'placement', ''), 'unknown') AS placement, count(*)::int AS threads
           FROM agent_dm_threads
          WHERE fields->>'source' = 'landing' AND created_at >= now() - make_interval(days => $1)
          GROUP BY 1`, [days]),
      this.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agent_dm_threads
          WHERE category = 'ad' AND (fields->>'source') IS DISTINCT FROM 'landing'
            AND created_at >= now() - make_interval(days => $1)`, [days]),
      this.pool.query<{ placement: string; leads: number }>(
        `SELECT COALESCE(placement, 'unknown') AS placement, count(*)::int AS leads FROM landing_leads
          WHERE status <> 'spam' AND created_at >= now() - make_interval(days => $1)
          GROUP BY 1`, [days]),
      this.pool.query<{ since: string }>(
        `SELECT to_char((now() AT TIME ZONE 'UTC')::date - ($1::int - 1), 'YYYY-MM-DD') AS since`, [days]),
    ]);

    const byPlacement = new Map<string, CtaStatsRow>();
    const row = (p: string) => {
      let r = byPlacement.get(p);
      if (!r) { r = emptyRow(p); byPlacement.set(p, r); }
      return r;
    };
    for (const c of clicks.rows) {
      const r = row(c.placement);
      const k = Number(c.clicks);
      if (c.cta === 'ad_dm') r.dmClicks += k;
      else if (c.cta === 'ad_form') r.formClicks += k;
      else if (c.cta === 'white_label') r.whiteLabelClicks += k;
    }
    for (const t of threads.rows) row(t.placement).dmThreads += Number(t.threads);
    for (const l of leads.rows) row(l.placement).leads += Number(l.leads);

    const order = (p: string) => {
      const i = (LANDING_PLACEMENTS as readonly string[]).indexOf(p);
      return i < 0 ? LANDING_PLACEMENTS.length : i;
    };
    const rows = [...byPlacement.values()].sort((a, b) => order(a.placement) - order(b.placement) || a.placement.localeCompare(b.placement));
    const totals = rows.reduce((acc, r) => ({
      dmClicks: acc.dmClicks + r.dmClicks, formClicks: acc.formClicks + r.formClicks,
      whiteLabelClicks: acc.whiteLabelClicks + r.whiteLabelClicks, dmThreads: acc.dmThreads + r.dmThreads, leads: acc.leads + r.leads,
    }), { dmClicks: 0, formClicks: 0, whiteLabelClicks: 0, dmThreads: 0, leads: 0 });
    return { days, since: since.rows[0]?.since ?? '', rows, totals, untaggedAdThreads: Number(untagged.rows[0]?.n ?? 0) };
  }
}
