import type { Pool } from 'pg';
import { resourceKeys } from './data-refs';
import { isSiteIndexUrl } from './source-tier';
import { reusableHosts, sourceRefOf, splitRef } from './ledger-anchor';

/**
 * The content ledger (spec 023 FR-010, migration 060): one dedup record per (resource, canonical source
 * ref, status) for every publish path — strategies, the editor, the chat, platform posts, sponsored posts.
 *
 * The rules live in SQL (`content_ledger_blocks`) so the publish guards here and the row filters of
 * query_data / library_catalog (`content_ledger_used`) can never disagree:
 *   • `error`     — the item is excluded everywhere;
 *   • `published` — never again on the same resource, or after `reuse_policy.days` for a dataset whose
 *                   data_schemas.reuse_policy is `after_days` (the dated datasets);
 *   • `shadowed`  — a shadow preview holds the item on the same resource for 7 days only.
 * Canonical refs: `data://<schema_key>/<id>` (a `library://` alias resolves through legacy_ref); a URL as
 * https, a lower-case host without `www.`, the root as "/" and no trailing slash on a path, without utm_* /
 * fbclid / gclid parameters or the fragment (migration 075, spec 037 T16); anything else as given.
 *
 * A site root or a section index (`https://store.steampowered.com/`, `/search`, `/new-and-popular`; spec 037 T4) is
 * never recorded or checked: it names a site, not an item, and one row of it would block every later post of the site.
 *
 * A reference document (a host in LEDGER_REUSABLE_HOSTS: a law, a standard) may be cited many times (spec 061 FR-002,
 * migration 094): its ref carries the cited clause as the `#fragment` (`ledger-anchor.ts`), the row is stored under
 * `<canonical url>#<anchor>` with the anchor in its own column, so the same clause is blocked once and other clauses are
 * not. A reusable-host ref without an anchor is never blocked by the ledger.
 *
 * Posts that wait for the owner (spec 031) are not in the ledger yet; `check(..., { waiting: true })` also
 * looks at waiting / approved slots and waiting platform posts (their refs canonicalised the same way), so
 * two waiting posts never share a source.
 */

export const LEDGER_ORIGINS = ['strategy', 'editor', 'chat', 'platform', 'manual', 'backfill'] as const;
export type LedgerOrigin = typeof LEDGER_ORIGINS[number];
export const LEDGER_STATUSES = ['published', 'shadowed', 'error'] as const;
export type LedgerStatus = typeof LEDGER_STATUSES[number];

/** How long a shadow preview holds its source on the same resource (mirrors content_ledger_blocks). */
export const SHADOW_HOLD_DAYS = 7;

export interface LedgerUse {
  /** Resource ref (`telegram:@x`, `instagram:<uuid>`) or a bare Telegram channel key. */
  resourceRef:      string;
  origin:           LedgerOrigin;
  status:           LedgerStatus;
  publishedPostId?: number | null;
  platformPostId?:  number | null;
  slotId?:          string | null;
  usedAt?:          Date | null;
  note?:            string | null;
}

export type LedgerVerdict =
  | { used: false }
  | { used: true; status: LedgerStatus | 'waiting'; resourceRef: string; ref: string; at: Date | null; slotId?: string | null; anchor?: string | null };

export interface LedgerCheckOptions {
  /** `network`: a publication on any resource counts (unposted network-wide). Default `resource`. */
  scope?:         'resource' | 'network';
  /** Also count posts that wait for approval or are approved (spec 031). */
  waiting?:       boolean;
  /** The slot being re-checked itself (approval re-checks, retries). */
  excludeSlotId?: string | null;
  /** Only real publications (the approval publisher's re-check after the wait). */
  publishedOnly?: boolean;
  now?:           Date;
}

type Q = Pick<Pool, 'query'>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The resource ref of a channel key or a ref (`@x` → `telegram:@x`). */
export function ledgerResource(refOrChannelKey: string): string {
  return resourceKeys(refOrChannelKey).resourceRef;
}

export class ContentLedger {
  constructor(
    private readonly pool: Q,
    private readonly log?: (msg: string) => void,
    /** The reusable hosts (spec 061); the setting, read on every use. */
    private readonly hosts: () => readonly string[] = () => reusableHosts(),
  ) {}

  /** Record one use of one source. True when a new ledger row was written. */
  async record(sourceRef: string | null | undefined, u: LedgerUse): Promise<boolean> {
    if (!sourceRef?.trim() || !u.resourceRef?.trim()) return false;
    const sp = splitRef(sourceRef.trim(), this.hosts());
    if (isSiteIndexUrl(sp.reusable ? sp.url : sourceRef)) {
      this.log?.(`content_ledger: ${sourceRef} is a site root / section index — not recorded`);
      return false;
    }
    const common = [u.origin, u.status, u.publishedPostId ?? null, u.platformPostId ?? null,
      u.slotId && UUID_RE.test(u.slotId) ? u.slotId : null, u.usedAt ?? null, u.note ?? null];
    // Spec 061: a source on a reusable host is recorded under URL + anchor (migration 094).
    const { rows } = sp.reusable && sp.anchor
      ? await this.pool.query(`SELECT content_ledger_record_anchored($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS added`, [ledgerResource(u.resourceRef), sp.url, sp.anchor, ...common])
      : await this.pool.query(`SELECT content_ledger_record($1, $2, $3, $4, $5, $6, $7, $8, $9) AS added`, [ledgerResource(u.resourceRef), sourceRef, ...common]);
    return rows[0]?.added === true;
  }

  /**
   * Record every ref of one post (a PostSpec names a library item and a source URL). Best-effort: the post
   * is already out, so a ledger failure is logged and never thrown. Returns how many refs were recorded.
   */
  async recordRefs(refs: Array<string | null | undefined>, u: LedgerUse): Promise<number> {
    let n = 0;
    const all = [...new Set(refs.filter((r): r is string => !!r && !!r.trim()))];
    // Spec 061: a reusable-host URL given both plain and with its anchor is recorded once, under the anchor.
    const hosts = this.hosts();
    const anchored = new Set(all.map((r) => splitRef(r.trim(), hosts)).filter((x) => x.reusable && x.anchor).map((x) => x.url));
    for (const ref of all.filter((r) => { const x = splitRef(r.trim(), hosts); return !(x.reusable && !x.anchor && anchored.has(x.url)); })) {
      try {
        await this.record(ref, u);
        n++;
      } catch (err: any) {
        this.log?.(`content_ledger: ${u.status} ${ref} on ${u.resourceRef} not recorded: ${err?.message ?? err}`);
      }
    }
    return n;
  }

  /** The canonical form of a ref (null for blank). */
  async canonical(ref: string): Promise<string | null> {
    const { rows } = await this.pool.query(`SELECT content_ref_canonical($1) AS c`, [ref]);
    return rows[0]?.c ?? null;
  }

  /** May `sourceRef` go out on `resourceRef`? `{used: false}` = yes. */
  async check(resourceRef: string, sourceRef: string | null | undefined, o: LedgerCheckOptions = {}): Promise<LedgerVerdict> {
    if (!sourceRef?.trim() || isSiteIndexUrl(sourceRef)) return { used: false };
    const rr = ledgerResource(resourceRef);
    const now = o.now ?? new Date();
    // Spec 061 FR-002: a reference document is keyed by URL + anchor; without an anchor the ledger does not stop it.
    const sp = splitRef(sourceRef.trim(), this.hosts());
    let refs: string[];
    if (sp.reusable) {
      if (!sp.anchor) return { used: false };
      const { rows: an } = await this.pool.query(`SELECT content_ref_anchored($1, $2) AS r`, [sp.url, sp.anchor]);
      refs = an[0]?.r ? [an[0].r] : [];
    } else {
      const { rows: a } = await this.pool.query(`SELECT content_ref_aliases($1) AS refs`, [sourceRef]);
      refs = a[0]?.refs ?? [sourceRef];
    }
    if (!refs.length) return { used: false };

    const ex = o.excludeSlotId && UUID_RE.test(o.excludeSlotId) ? o.excludeSlotId : null;
    const { rows } = await this.pool.query(
      `SELECT status, resource_ref, source_ref, used_at, slot_id FROM content_ledger_blocking($1, $2::text[], $3, $4)
        WHERE (NOT $5 OR (status = 'published' AND resource_ref = $1))
          AND ($6::uuid IS NULL OR slot_id IS DISTINCT FROM $6)
        LIMIT 1`,
      [rr, refs, o.scope ?? 'resource', now, !!o.publishedOnly, ex]);
    if (rows[0]) {
      return {
        used: true, status: rows[0].status, resourceRef: rows[0].resource_ref, ref: rows[0].source_ref, at: rows[0].used_at ? new Date(rows[0].used_at) : null,
        ...(rows[0].slot_id ? { slotId: rows[0].slot_id } : {}), ...(sp.reusable ? { anchor: sp.anchor } : {}),
      };
    }
    if (!o.waiting || o.publishedOnly) return { used: false };

    // Only a reusable-host check looks at anchored refs (and needs migration 094's functions).
    const anchoredSlot = sp.reusable ? `
               OR content_ref_anchored(post_spec->'source'->>'url', post_spec->'source'->>'anchor') = ANY($2::text[])
               OR content_ref_anchored(platform_spec->'source'->>'url', platform_spec->'source'->>'anchor') = ANY($2::text[])` : '';
    const anchoredPost = sp.reusable ? ` OR content_ref_anchored(source_ref) = ANY($2::text[])` : '';
    const { rows: w } = await this.pool.query(
      `SELECT COALESCE(resource_ref, 'telegram:' || channel_key) AS rr, updated_at AS at, id::text AS slot FROM editor_slots
        WHERE status IN ('awaiting_approval', 'approved') AND ($3::uuid IS NULL OR id <> $3)
          AND COALESCE(resource_ref, 'telegram:' || channel_key) = $1
          AND (content_ref_canonical(post_spec->>'library_ref') = ANY($2::text[])
               OR content_ref_canonical(post_spec->'source'->>'url') = ANY($2::text[])
               OR content_ref_canonical(platform_spec->>'library_ref') = ANY($2::text[])
               OR content_ref_canonical(platform_spec->'source'->>'url') = ANY($2::text[])
${anchoredSlot})
       UNION ALL
       SELECT resource_ref, posted_at, slot_id::text FROM platform_posts
        WHERE resource_ref = $1 AND status = 'awaiting_approval'
          AND (content_ref_canonical(source_ref) = ANY($2::text[])${anchoredPost})
          AND ($3::uuid IS NULL OR slot_id IS DISTINCT FROM $3)
       LIMIT 1`, [rr, refs, ex]);
    if (w[0]) return { used: true, status: 'waiting', resourceRef: w[0].rr, ref: sourceRef, at: w[0].at ? new Date(w[0].at) : null, ...(w[0].slot ? { slotId: w[0].slot } : {}), ...(sp.reusable ? { anchor: sp.anchor } : {}) };
    return { used: false };
  }

  /** Has the source been used on the resource (same rules as check)? */
  async used(resourceRef: string, sourceRef: string | null | undefined, o: LedgerCheckOptions = {}): Promise<boolean> {
    return (await this.check(resourceRef, sourceRef, o)).used;
  }

  /** Re-run the idempotent backfill from the legacy ledgers (migration 060); returns per-source counts. */
  async backfill(): Promise<Record<string, number>> {
    const { rows } = await this.pool.query(`SELECT content_ledger_backfill() AS r`);
    return rows[0]?.r ?? {};
  }
}

/**
 * The source refs of a PostSpec or platform spec (library item and source URL). A source with an `anchor` (a clause of a
 * reference document, spec 061) comes with it as the ref's #fragment.
 */
export function specRefs(spec: { library_ref?: string | null; source?: { url?: string | null; anchor?: string | null } | null } | null | undefined): string[] {
  if (!spec) return [];
  const src = spec.source?.url ? sourceRefOf({ url: spec.source.url, anchor: spec.source.anchor }) : null;
  return [spec.library_ref, src].filter((r): r is string => typeof r === 'string' && !!r.trim());
}
