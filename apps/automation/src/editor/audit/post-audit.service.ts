import type { Pool, PoolClient } from 'pg';
import type { EditorCard } from '../card';
import { PostSpecSchema } from '../post/post-spec';
import { auditPostFromSpec } from '../post/integrity/from-post-spec';
import type { AuditCard, AuditPost } from '../post/integrity/types';
import { PlatformPostSpecSchema } from '../platform/platform-spec';
import { resourceStyleOf } from '../post/style/style-store';
import {
  AUDIT_DAYS, HISTORY_DAYS, KEEP_DAYS, auditFindings, auditPostFromPlatformSpec, parseSources, rulesHash, telegramPostUrl,
  type AuditRenderCard, type AuditRow, type AuditTarget,
} from './post-audit';
import { AUDIT_FLAGS, catalogueEntry, type AuditFlag, type FindingSection } from './code-catalogue';

/**
 * Spec 037 FR-014 (T14): the post audit against the DB. Daily (from the editor scheduler's minute tick, throttled)
 * and on demand (`POST /api/editor/audit/run`), every resource with posts out in the last 7 days is audited: its
 * Telegram slots with a post spec (published or shadowed) and its native platform posts, with every registered
 * check. Findings are upserted into `editor_post_audit` (idempotent: the same finding keeps its row); a finding the
 * rules no longer give, or of a post no longer in the window, is deleted. `editor_post_audit_runs` records the run
 * and the rules hash: a resource is audited again after 24 h, or at once when the registered checks changed.
 * Read-only towards everything else; no LLM.
 */

export const AUDIT_EVERY_MS = 24 * 3600_000;
export const AUDIT_CHECK_EVERY_MS = 10 * 60_000;
/** Items listed per code in the dashboard view. */
export const MAX_ITEMS_PER_CODE = 10;
/** Codes listed in the digest summary of a resource. */
export const MAX_DIGEST_CODES = 8;

const DAY = 86_400_000;
const OUT = `('published','shadowed')`;
const SLOT_REF = `COALESCE(s.resource_ref, 'telegram:' || s.channel_key)`;

/** The card a resource's posts are checked against, and how its source line / footer render (Telegram). */
export interface ResourceAuditCard { card: AuditCard; render?: AuditRenderCard }

export interface PostAuditDeps {
  pool:     Pick<Pool, 'query'> & { connect?: () => Promise<PoolClient> };
  /** The resource card (Telegram: the editor card with its style); default: the style sheet and zone from the profile. */
  cardOf?:  (ref: string) => Promise<ResourceAuditCard | null>;
  everyMs?: number;
  log?:     (m: string) => void;
}

export interface AuditRunResult { resource: string; posts: number; findings: number; rulesHash: string; error?: string }

export interface AuditIssueItem {
  postKind:    'slot' | 'platform';
  postId:      string;
  slotId:      string | null;
  publishedAt: string;
  url:         string | null;
  postExcerpt: string;
  format:      string | null;
  level:       'error' | 'warning';
  /** The check's own words (the agents' language; the dashboard shows the catalogue text instead). */
  message:     string;
  excerpt:     string | null;
  extra:       Record<string, unknown> | null;
}

export interface AuditCodeGroup {
  code:    string;
  title:   string;
  explain: string;
  fix:     string;
  group:   AuditFlag | null;
  section: FindingSection;
  /** `error` when any finding of the code is an error. */
  level:   'error' | 'warning';
  /** Findings of the code in the window, and the distinct posts they are on. */
  count:   number;
  posts:   number;
  /** Newest first, at most MAX_ITEMS_PER_CODE. */
  items:   AuditIssueItem[];
}

export interface ResourceAuditView {
  resource:  string;
  days:      number;
  auditedAt: string | null;
  rulesHash: string | null;
  /** The last run used the current rules. */
  current:   boolean;
  /** Posts the last run audited, and findings in the window. */
  posts:     number;
  findings:  number;
  error:     string | null;
  groups:    AuditCodeGroup[];
}

/** The audit block of a resource in the MANAGER's quality digest (counts only, bounded). */
export interface AuditSummary {
  audited_at: string | null;
  posts:      number;
  findings:   number;
  groups:     Partial<Record<AuditFlag, number>>;
  codes:      Array<{ code: string; level: 'error' | 'warning'; n: number }>;
}

/** Rows of `editor_post_audit` → the dashboard's grouped view (errors first, then by count). */
export function groupFindings(rows: AuditRow[]): AuditCodeGroup[] {
  const by = new Map<string, AuditRow[]>();
  for (const r of rows) by.set(r.code, [...(by.get(r.code) ?? []), r]);
  const groups: AuditCodeGroup[] = [];
  for (const [code, list] of by) {
    const e = catalogueEntry(code);
    list.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.postId.localeCompare(b.postId));
    groups.push({
      code, title: e.title, explain: e.explain, fix: e.fix, group: e.group, section: e.section,
      level: list.some((r) => r.level === 'error') ? 'error' : 'warning',
      count: list.length, posts: new Set(list.map((r) => `${r.postKind}:${r.postId}`)).size,
      items: list.slice(0, MAX_ITEMS_PER_CODE).map((r) => ({
        postKind: r.postKind, postId: r.postId, slotId: r.slotId, publishedAt: r.publishedAt, url: r.postUrl, postExcerpt: r.postExcerpt,
        format: r.format, level: r.level, message: r.message, excerpt: r.excerpt, extra: r.extra,
      })),
    });
  }
  return groups.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1) || b.count - a.count || a.code.localeCompare(b.code));
}

/** The digest summary from the grouped findings. */
export function summarise(groups: AuditCodeGroup[], run: { auditedAt: string | null; posts: number }): AuditSummary {
  const flags: Partial<Record<AuditFlag, number>> = {};
  for (const g of groups) if (g.group) flags[g.group] = (flags[g.group] ?? 0) + g.count;
  const ordered = Object.fromEntries(AUDIT_FLAGS.filter((f) => flags[f]).map((f) => [f, flags[f]!])) as Partial<Record<AuditFlag, number>>;
  return {
    audited_at: run.auditedAt, posts: run.posts, findings: groups.reduce((s, g) => s + g.count, 0), groups: ordered,
    codes: groups.slice(0, MAX_DIGEST_CODES).map((g) => ({ code: g.code, level: g.level, n: g.count })),
  };
}

const iso = (d: unknown) => new Date(d as string).toISOString();

function rowOf(r: any): AuditRow {
  return {
    resourceRef: r.resource_ref, channelKey: r.channel_key ?? null, postKind: r.post_kind, postId: r.post_id, slotId: r.slot_id ?? null,
    messageId: r.message_id == null ? null : Number(r.message_id), postUrl: r.post_url ?? null, postExcerpt: r.post_excerpt ?? '',
    format: r.format ?? null, code: r.code, level: r.level, message: r.message, excerpt: r.excerpt ?? null, extra: r.extra ?? null,
    fingerprint: r.fingerprint, publishedAt: iso(r.published_at),
  };
}

export class PostAuditService {
  private lastCheck = 0;
  private running = false;
  readonly hash = rulesHash();

  constructor(private readonly d: PostAuditDeps) {}

  // ── reading the posts ──────────────────────────────────────────────────────

  private async card(ref: string): Promise<ResourceAuditCard> {
    const own = this.d.cardOf ? await this.d.cardOf(ref).catch(() => null) : null;
    if (own?.card.timezone) return own;
    const { rows } = await this.d.pool.query(`SELECT resource_tz($1) AS tz`, [ref]).catch(() => ({ rows: [] as any[] }));
    const tz: string = rows[0]?.tz || 'Europe/Kyiv';
    if (own) return { ...own, card: { ...own.card, timezone: tz } };
    const style = await resourceStyleOf(this.d.pool, ref).then((v) => v.effective).catch(() => undefined);
    return { card: { timezone: tz, ...(style ? { style } : {}) } };
  }

  /** A Telegram resource's slots out in [from, to) as integrity posts (published time: the publication, else the slot). */
  private async slotPosts(refs: string[], from: Date, to: Date, tzOf: (ref: string) => string, render: (ref: string) => AuditRenderCard | undefined): Promise<AuditTarget[]> {
    if (!refs.length) return [];
    const { rows } = await this.d.pool.query(
      `SELECT ${SLOT_REF} AS ref, s.id::text AS id, s.channel_key, s.post_spec, s.topic, s.topic_mode,
              COALESCE(pp.posted_at, s.scheduled_at) AS at, pp.message_id, pp.channel_id,
              COALESCE(to_jsonb(s) -> 'sources', s.critic -> 'sources') AS sources
         FROM editor_slots s
         LEFT JOIN published_posts pp ON pp.id = s.published_post_id
        WHERE s.kind = 'content' AND s.post_spec IS NOT NULL AND s.status IN ${OUT}
          AND (s.resource_ref IS NULL OR s.resource_ref = 'telegram:' || s.channel_key)
          AND ${SLOT_REF} = ANY($1::text[]) AND COALESCE(pp.posted_at, s.scheduled_at) >= $2 AND COALESCE(pp.posted_at, s.scheduled_at) < $3
        ORDER BY 7 LIMIT 5000`, [refs, from, to]);
    const out: AuditTarget[] = [];
    for (const r of rows) {
      const spec = PostSpecSchema.safeParse(r.post_spec);
      if (!spec.success) continue;
      const post = auditPostFromSpec(spec.data, {
        id: r.id, channel: r.ref, publishedAt: iso(r.at), timezone: tzOf(r.ref), card: render(r.ref),
        ...(r.topic_mode !== 'live' && typeof r.topic === 'string' && r.topic.trim() ? { topic: r.topic } : {}),
      });
      const messageId = r.message_id == null ? null : Number(r.message_id);
      out.push({
        post, kind: 'slot', postId: r.id, slotId: r.id, channelKey: r.channel_key, messageId,
        url: telegramPostUrl(r.channel_id ?? r.channel_key, messageId), sources: parseSources(r.sources),
      });
    }
    return out;
  }

  /** A resource's native platform posts out in [from, to). */
  private async platformPosts(ref: string, from: Date, to: Date, tz: string): Promise<AuditTarget[]> {
    if (ref.startsWith('telegram:')) return [];
    const { rows } = await this.d.pool.query(
      `SELECT id::text AS id, slot_id::text AS slot_id, url, spec, posted_at
         FROM platform_posts
        WHERE resource_ref = $1 AND platform <> 'telegram' AND status IN ${OUT} AND posted_at >= $2 AND posted_at < $3
        ORDER BY posted_at LIMIT 2000`, [ref, from, to]);
    const out: AuditTarget[] = [];
    for (const r of rows) {
      const spec = PlatformPostSpecSchema.safeParse(r.spec);
      if (!spec.success) continue;
      out.push({
        post: auditPostFromPlatformSpec(spec.data, { id: `platform:${r.id}`, channel: ref, publishedAt: iso(r.posted_at), timezone: tz }),
        kind: 'platform', postId: r.id, slotId: r.slot_id ?? null, url: r.url ?? null,
      });
    }
    return out;
  }

  /**
   * Telegram network siblings of a channel, as the story registry (T2, StoryRegistry.scopeOf) defines them: a brand
   * group holds at most one Telegram channel, so the siblings are the other channels the editor runs (mode not off).
   */
  private async siblings(ref: string): Promise<string[]> {
    if (!ref.startsWith('telegram:')) return [];
    const { rows } = await this.d.pool.query(
      `SELECT 'telegram:' || channel_key AS ref FROM editor_channels WHERE channel_key <> $1 AND mode <> 'off' ORDER BY channel_key`,
      [ref.slice('telegram:'.length)]);
    return rows.map((r: any) => r.ref);
  }

  /** Resources with posts out in the window. */
  async activeRefs(now: Date): Promise<string[]> {
    const from = new Date(now.getTime() - AUDIT_DAYS * DAY);
    const { rows } = await this.d.pool.query(
      `SELECT DISTINCT ${SLOT_REF} AS ref FROM editor_slots s
        WHERE s.kind = 'content' AND s.post_spec IS NOT NULL AND s.status IN ${OUT} AND s.scheduled_at >= $1 AND s.scheduled_at <= $2
          AND (s.resource_ref IS NULL OR s.resource_ref = 'telegram:' || s.channel_key)
       UNION
       SELECT DISTINCT resource_ref FROM platform_posts WHERE platform <> 'telegram' AND status IN ${OUT} AND posted_at >= $1 AND posted_at <= $2`,
      [from, now]);
    return rows.map((r: any) => r.ref).sort();
  }

  /** Active resources whose last audit is older than a day, missing, or ran with other rules. */
  async dueRefs(now: Date): Promise<string[]> {
    const refs = await this.activeRefs(now);
    if (!refs.length) return [];
    const { rows } = await this.d.pool.query(
      `SELECT resource_ref, rules_hash, audited_at FROM editor_post_audit_runs WHERE resource_ref = ANY($1::text[])`, [refs]);
    const runs = new Map<string, any>(rows.map((r: any) => [r.resource_ref, r]));
    const every = this.d.everyMs ?? AUDIT_EVERY_MS;
    return refs.filter((ref) => {
      const r = runs.get(ref);
      return !r || r.rules_hash !== this.hash || now.getTime() - new Date(r.audited_at).getTime() >= every;
    });
  }

  // ── running ────────────────────────────────────────────────────────────────

  /** Audit one resource's last 7 days up to `now` and store the findings. */
  async auditResource(ref: string, now: Date): Promise<AuditRunResult> {
    const from = new Date(now.getTime() - AUDIT_DAYS * DAY);
    const histFrom = new Date(from.getTime() - HISTORY_DAYS * DAY);
    const to = new Date(now.getTime() + 1);
    const { card, render } = await this.card(ref);
    const tz = card.timezone ?? 'Europe/Kyiv';
    const telegram = ref.startsWith('telegram:');
    const own = telegram
      ? await this.slotPosts([ref], histFrom, to, () => tz, () => render)
      : await this.platformPosts(ref, histFrom, to, tz);
    const inWindow = (t: AuditTarget) => Date.parse(t.post.publishedAt) >= from.getTime();
    const targets = own.filter(inWindow);
    const history = own.filter((t) => !inWindow(t)).map((t) => t.post);
    let network: AuditPost[] = [];
    if (telegram) {
      try {
        const sib = await this.siblings(ref);
        network = (await this.slotPosts(sib, histFrom, to, () => tz, () => undefined)).map((t) => t.post);
      } catch { /* the network is optional context */ }
    }
    const rows = auditFindings({ resourceRef: ref, targets, history, network, card });
    await this.store(ref, rows, { from, runAt: now, posts: targets.length });
    return { resource: ref, posts: targets.length, findings: rows.length, rulesHash: this.hash };
  }

  private async store(ref: string, rows: AuditRow[], o: { from: Date; runAt: Date; posts: number }): Promise<void> {
    const client = this.d.pool.connect ? await this.d.pool.connect() : null;
    const q = client ?? this.d.pool;
    try {
      if (client) await client.query('BEGIN');
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const params: unknown[] = [];
        const tuples = chunk.map((r, j) => {
          params.push(r.resourceRef, r.channelKey, r.postKind, r.postId, r.slotId, r.messageId, r.postUrl, r.postExcerpt, r.format,
            r.code, r.level, r.message, r.excerpt, r.extra ? JSON.stringify(r.extra) : null, r.fingerprint, r.publishedAt, o.runAt, this.hash);
          return `(${Array.from({ length: 18 }, (_, k) => `$${j * 18 + k + 1}`).join(', ')})`;
        });
        await q.query(
          `INSERT INTO editor_post_audit AS a (resource_ref, channel_key, post_kind, post_id, slot_id, message_id, post_url, post_excerpt, format,
                                              code, level, message, excerpt, extra, fingerprint, published_at, audited_at, rules_hash)
           VALUES ${tuples.join(', ')}
           ON CONFLICT (resource_ref, post_kind, post_id, code, fingerprint) DO UPDATE SET
             channel_key = EXCLUDED.channel_key, slot_id = EXCLUDED.slot_id, message_id = EXCLUDED.message_id, post_url = EXCLUDED.post_url,
             post_excerpt = EXCLUDED.post_excerpt, format = EXCLUDED.format, level = EXCLUDED.level, message = EXCLUDED.message,
             excerpt = EXCLUDED.excerpt, extra = EXCLUDED.extra, published_at = EXCLUDED.published_at,
             audited_at = EXCLUDED.audited_at, rules_hash = EXCLUDED.rules_hash`,
          params);
      }
      // Findings in the window this run did not give (the rules changed, the post was edited or is no longer out); old rows.
      await q.query(`DELETE FROM editor_post_audit WHERE resource_ref = $1 AND published_at >= $2 AND audited_at <> $3`, [ref, o.from, o.runAt]);
      await q.query(`DELETE FROM editor_post_audit WHERE resource_ref = $1 AND published_at < $2`, [ref, new Date(o.runAt.getTime() - KEEP_DAYS * DAY)]);
      await q.query(
        `INSERT INTO editor_post_audit_runs (resource_ref, rules_hash, audited_at, window_from, posts, findings, error)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)
         ON CONFLICT (resource_ref) DO UPDATE SET rules_hash = EXCLUDED.rules_hash, audited_at = EXCLUDED.audited_at,
           window_from = EXCLUDED.window_from, posts = EXCLUDED.posts, findings = EXCLUDED.findings, error = NULL`,
        [ref, this.hash, o.runAt, o.from, o.posts, rows.length]);
      if (client) await client.query('COMMIT');
    } catch (e) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client?.release();
    }
  }

  private async recordError(ref: string, now: Date, error: string): Promise<void> {
    await this.d.pool.query(
      `INSERT INTO editor_post_audit_runs (resource_ref, rules_hash, audited_at, window_from, error)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (resource_ref) DO UPDATE SET audited_at = EXCLUDED.audited_at, error = EXCLUDED.error`,
      [ref, `error:${this.hash}`, now, new Date(now.getTime() - AUDIT_DAYS * DAY), error.slice(0, 500)]).catch(() => {});
  }

  /** Audit the given resources (default: every active one); a failing resource is recorded and the rest go on. */
  async run(now: Date, refs?: string[]): Promise<AuditRunResult[]> {
    const list = refs ?? await this.activeRefs(now);
    const out: AuditRunResult[] = [];
    for (const ref of list) {
      try {
        out.push(await this.auditResource(ref, now));
      } catch (e: any) {
        const error = String(e?.message ?? e);
        this.d.log?.(`post audit of ${ref} failed: ${error}`);
        await this.recordError(ref, now, error);
        out.push({ resource: ref, posts: 0, findings: 0, rulesHash: this.hash, error });
      }
    }
    return out;
  }

  /** The scheduler hook: every AUDIT_CHECK_EVERY_MS, the resources whose audit is due (daily, or new rules). */
  async tick(now: Date): Promise<number> {
    if (this.running || now.getTime() - this.lastCheck < AUDIT_CHECK_EVERY_MS) return 0;
    this.lastCheck = now.getTime();
    this.running = true;
    try {
      const due = await this.dueRefs(now);
      if (!due.length) return 0;
      const r = await this.run(now, due);
      return r.filter((x) => !x.error).length;
    } finally {
      this.running = false;
    }
  }

  // ── reading the findings ───────────────────────────────────────────────────

  private async rows(refs: string[], from: Date): Promise<AuditRow[]> {
    if (!refs.length) return [];
    const { rows } = await this.d.pool.query(
      `SELECT * FROM editor_post_audit WHERE resource_ref = ANY($1::text[]) AND published_at >= $2 ORDER BY published_at DESC, id LIMIT 5000`,
      [refs, from]);
    return rows.map(rowOf);
  }

  private async runs(refs: string[]): Promise<Map<string, any>> {
    if (!refs.length) return new Map();
    const { rows } = await this.d.pool.query(`SELECT * FROM editor_post_audit_runs WHERE resource_ref = ANY($1::text[])`, [refs]);
    return new Map(rows.map((r: any) => [r.resource_ref, r]));
  }

  /** One resource's findings of the last `days` days, grouped by code, for the dashboard. */
  async view(ref: string, now: Date, days = AUDIT_DAYS): Promise<ResourceAuditView> {
    const span = Math.min(Math.max(1, Math.round(days)), KEEP_DAYS);
    const [rows, runs] = await Promise.all([this.rows([ref], new Date(now.getTime() - span * DAY)), this.runs([ref])]);
    const run = runs.get(ref);
    const groups = groupFindings(rows);
    return {
      resource: ref, days: span, auditedAt: run ? iso(run.audited_at) : null, rulesHash: run?.rules_hash ?? null,
      current: !!run && run.rules_hash === this.hash, posts: run ? Number(run.posts ?? 0) : 0, findings: rows.length,
      error: run?.error ?? null, groups,
    };
  }

  /** The digest summary of every resource with an audit (7 days up to `now`). */
  async summaries(refs: string[], now: Date): Promise<Map<string, AuditSummary>> {
    const [rows, runs] = await Promise.all([this.rows(refs, new Date(now.getTime() - AUDIT_DAYS * DAY)), this.runs(refs)]);
    const out = new Map<string, AuditSummary>();
    for (const ref of refs) {
      const run = runs.get(ref);
      if (!run) continue;
      out.set(ref, summarise(groupFindings(rows.filter((r) => r.resourceRef === ref)), { auditedAt: iso(run.audited_at), posts: Number(run.posts ?? 0) }));
    }
    return out;
  }
}

/**
 * The audit card of a Telegram resource from its editor card (the card read fills the style sheet), with the
 * render settings of its source line; other resources fall back to the profile's style sheet (null here).
 */
export function editorCardAudit(get: (channelKey: string) => Promise<EditorCard | null>) {
  return async (ref: string): Promise<ResourceAuditCard | null> => {
    if (!ref.startsWith('telegram:')) return null;
    const c = await get(ref.slice('telegram:'.length));
    return c ? { card: c, render: { linkStyle: c.linkStyle, footer: c.footer } } : null;
  };
}
