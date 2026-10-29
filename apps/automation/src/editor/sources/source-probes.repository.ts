import type { Pool } from 'pg';
import { canonicalUrl } from '../docs/doc-store';
import { hostOf } from '../net/host-failures';
import type { ProbeResult, SourceProbeStore } from './probe';

/**
 * Spec 076 FR-001: the last probe of a source address (`source_probes`, migration 100), one row per canonical URL. It is the
 * 6-hour cache of `probeSource` and what source health, the Sources panel and the doctor read. An `invalid` result (a bad or
 * private address) is never stored.
 */
export class PgSourceProbes implements SourceProbeStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async get(url: string): Promise<ProbeResult | null> {
    const { rows } = await this.pool.query(`SELECT * FROM source_probes WHERE url = $1`, [canonicalUrl(url)]);
    return rows[0] ? toResult(rows[0]) : null;
  }

  async put(r: ProbeResult): Promise<void> {
    if (r.failure_class === 'invalid') return;
    await this.pool.query(
      `INSERT INTO source_probes (url, host, ok, failure_class, status, kind, feed_url, items, newest_at, sample_titles, detail, ms, via_proxy, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
       ON CONFLICT (url) DO UPDATE SET
         host = EXCLUDED.host, ok = EXCLUDED.ok, failure_class = EXCLUDED.failure_class, status = EXCLUDED.status, kind = EXCLUDED.kind,
         feed_url = EXCLUDED.feed_url, items = EXCLUDED.items, newest_at = EXCLUDED.newest_at, sample_titles = EXCLUDED.sample_titles,
         detail = EXCLUDED.detail, ms = EXCLUDED.ms, via_proxy = EXCLUDED.via_proxy, checked_at = EXCLUDED.checked_at`,
      [canonicalUrl(r.url), hostOf(r.url) ?? '', r.ok, r.failure_class, r.status, r.kind, r.feed_url, r.items, r.newest_at,
        JSON.stringify(r.sample_titles), r.detail, r.ms, r.via_proxy, r.checked_at]);
  }

  /** The stored probe of each address, keyed by the address as the caller wrote it (addresses without a probe are absent). Never throws: no table yet = no probes. */
  async latest(urls: string[]): Promise<Map<string, ProbeResult>> {
    const out = new Map<string, ProbeResult>();
    if (!urls.length) return out;
    try {
      const { rows } = await this.pool.query(`SELECT * FROM source_probes WHERE url = ANY($1)`, [[...new Set(urls.map(canonicalUrl))]]);
      const byUrl = new Map<string, ProbeResult>(rows.map((r: any) => [r.url as string, toResult(r)]));
      for (const u of urls) {
        const hit = byUrl.get(canonicalUrl(u));
        if (hit) out.set(u, hit);
      }
    } catch {
      /* before migration 100 */
    }
    return out;
  }

  /** The checked_at of each address that has a probe (what the 6-hourly job uses to skip a URL probed a moment ago). */
  async checkedAt(urls: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    for (const [u, r] of await this.latest(urls)) out.set(u, new Date(r.checked_at));
    return out;
  }
}

const iso = (v: unknown): string => new Date(v as string).toISOString();

function toResult(r: any): ProbeResult {
  return {
    ok: r.ok === true,
    failure_class: r.failure_class ?? null,
    status: r.status === null || r.status === undefined ? null : Number(r.status),
    kind: r.kind,
    feed_url: r.feed_url ?? null,
    items: Number(r.items ?? 0),
    newest_at: r.newest_at ? iso(r.newest_at) : null,
    sample_titles: Array.isArray(r.sample_titles) ? r.sample_titles.map(String) : [],
    checked_at: iso(r.checked_at),
    via_proxy: r.via_proxy === true,
    url: r.url,
    detail: r.detail ?? '',
    ms: r.ms === null || r.ms === undefined ? null : Number(r.ms),
    cached: false,
    blocked_until: null,
  };
}
