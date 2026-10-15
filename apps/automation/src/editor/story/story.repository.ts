import type { Pool } from 'pg';
import type { Entity, PostEntities } from '../post/entities';
import { entityOverlap, mergeEntities } from '../post/entities';
import type { PostSpec } from '../post/post-spec';
import { htmlToPlain } from '../post/inline-markup';
import { auditPostFromSpec } from '../post/integrity/from-post-spec';
import type { AuditPost } from '../post/integrity/types';
import { assessStory, CROSS_CHANNEL_HOURS, EVERGREEN_WINDOW_DAYS, isStoryOverlap, STORY_WINDOW_DAYS, storyView, type StoryAssessment } from './story-match';
import type { ActiveStory } from './story-context';
import { recentAuditPosts } from '../post/variety/recent-posts';
import { StoryEventRepository } from './story-event.repository';
import type { RecapItem } from './story-event';

/**
 * Spec 037 T2: the story registry (migration 073). One story per scope — the owner's network (`network`, shared by
 * its channels) or the channel itself (`telegram:<key>`) — with its posts on every resource of the scope. The
 * publish guard reads the history (the slots of 14 / 30 days, built as AuditPosts) and the registry after a post is
 * stored or sent; the prompts read the active stories; request_story_repost reads the sibling's post and the limits.
 */

/** The slot statuses a story counts: what readers saw or will see. */
export const STORY_SLOT_STATUSES = ['published', 'shadowed', 'awaiting_approval', 'approved'] as const;
export const STORY_ROLES = ['original', 'followup', 'reminder', 'roundup', 'repost', 'evergreen'] as const;
export type StoryRole = typeof STORY_ROLES[number];

const ENTITIES_MAX = 40;
const STEMS_MAX = 80;
const KEY_FACTS_MAX = 20;
const HISTORY_LIMIT = 500;
/** The owner's network (one instance, own channels only): every channel's stories in one registry. */
export const STORY_SCOPE = 'network';
const SIBLING_LIMIT = 60;

export interface StoryHistory {
  scope:    string;
  /** Sibling channels of the network (channel keys). */
  siblings: string[];
  /** The channel's posts of the window around `at` (newest first). */
  previous: AuditPost[];
  /** The sibling channels' posts within 24 h of `at`. */
  network:  AuditPost[];
}

export interface RecordStoryPost {
  channelKey:       string;
  slotId:           string | null;
  publishedPostId?: number | null;
  messageId?:       number | null;
  postedAt:         Date;
  title:            string;
  post:             AuditPost;
  assessment:       Pick<StoryAssessment, 'role' | 'original' | 'matches' | 'siblings'>;
  story?:           { key?: string; kind?: string; newFacts?: string[]; decision?: string; reason?: string } | null;
  /** Backfill: a note on the post row. */
  reason?:          string | null;
}

export interface RepostSource {
  storyId:     string;
  storyKey:    string;
  storyPostId: number;
  fromKey:     string;
  messageId:   number;
  postedAt:    Date;
}

/** `{entities: Entity[], stems: string[]}` (the strongest first, capped). */
export function entitiesToJson(e: PostEntities): { entities: Entity[]; stems: string[] } {
  const list = [...e.entities.values()].filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, ENTITIES_MAX);
  return { entities: list, stems: [...e.stems].slice(0, STEMS_MAX) };
}

export function entitiesFromJson(j: unknown): PostEntities {
  const o = (j ?? {}) as { entities?: Entity[]; stems?: string[] };
  const entities = new Map<string, Entity>();
  for (const e of Array.isArray(o.entities) ? o.entities : []) if (e && typeof e.key === 'string') entities.set(e.key, e);
  return { entities, stems: new Set(Array.isArray(o.stems) ? o.stems.filter((s) => typeof s === 'string') : []) };
}

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '',
  ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'io', ъ: '',
};

/** A story key from a title: transliterated, lowercase, hyphens, ≤ 60 chars (PostSpec story.key format). */
export function storySlug(title: string): string {
  const t = [...title.toLowerCase()].map((c) => CYR[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return t.length >= 2 ? t : `story-${Date.now().toString(36)}`;
}

/** The AuditPost id of a story post: the slot id, else `pp:<published post id>`. */
export const storyPostRef = (r: { slot_id?: string | null; published_post_id?: number | string | null }): string | null =>
  r.slot_id ? String(r.slot_id) : r.published_post_id != null ? `pp:${r.published_post_id}` : null;

interface SlotRow {
  id: string; channel_key: string; post_spec: unknown; rendered_preview: string | null; topic: string | null;
  at: Date | string; pp_id: string | number | null; message_id: string | number | null; timezone: string | null;
}

/** A slot row → the AuditPost the story checks read (from its spec; else the rendered preview). */
export function auditPostOfSlot(r: SlotRow): AuditPost {
  const publishedAt = new Date(r.at).toISOString();
  const timezone = r.timezone || 'Europe/Kyiv';
  const messageIds = r.message_id != null ? [Number(r.message_id)] : undefined;
  const spec = r.post_spec as PostSpec | null;
  if (spec && Array.isArray((spec as any).body)) {
    try {
      const p = auditPostFromSpec({ ...spec, hashtags: spec.hashtags ?? [], buttons: spec.buttons ?? [], media: spec.media ?? [] } as PostSpec,
        { id: r.id, channel: r.channel_key, publishedAt, timezone });
      return messageIds ? { ...p, messageIds } : p;
    } catch { /* an old spec shape: fall back to the preview */ }
  }
  const text = r.rendered_preview ? htmlToPlain(r.rendered_preview) : (r.topic ?? '');
  return { id: r.id, channel: r.channel_key, publishedAt, timezone, text, links: [], buttons: [], hashtags: [], media: null, story: {}, ...(messageIds ? { messageIds } : {}) };
}

export class StoryRegistry {
  private backfilling = false;
  constructor(private readonly pool: Pick<Pool, 'query'>, private readonly log: (m: string) => void = () => {}) {}

  /**
   * The story scope of a channel and its sibling Telegram channels. A brand group (meta_account_groups) holds at most
   * one Telegram channel (migration 034), so the Telegram siblings of the owner's network are the other channels the
   * editor runs (editor_channels, not off): one network, one registry (`network`). The group's other platforms post
   * adaptations of the same story by design (spec 024) and stay out.
   */
  async scopeOf(channelKey: string): Promise<{ scope: string; siblings: string[] }> {
    const { rows } = await this.pool.query(
      `SELECT channel_key FROM editor_channels WHERE channel_key <> $1 AND mode <> 'off' ORDER BY channel_key`, [channelKey]);
    return { scope: STORY_SCOPE, siblings: rows.map((r: any) => String(r.channel_key)) };
  }

  /** Backfill only: the published slots of several channels in a window (oldest registered first by the caller). */
  private async slots(keys: string[], excludeSlotId: string | null, from: Date, to: Date, statuses: readonly string[] = STORY_SLOT_STATUSES): Promise<AuditPost[]> {
    if (!keys.length) return [];
    const { rows } = await this.pool.query(
      `SELECT s.id, s.channel_key, s.post_spec, s.rendered_preview, s.topic, COALESCE(p.posted_at, s.scheduled_at) AS at,
              p.id AS pp_id, p.message_id, c.timezone
         FROM editor_slots s
         LEFT JOIN published_posts p ON p.id = s.published_post_id
         LEFT JOIN editor_channels c ON c.channel_key = s.channel_key
        WHERE s.channel_key = ANY($1::text[]) AND s.status = ANY($2::text[]) AND s.promo IS NULL AND s.resource_ref IS NULL
          AND ($3::uuid IS NULL OR s.id <> $3::uuid)
          AND COALESCE(p.posted_at, s.scheduled_at) BETWEEN $4 AND $5
        ORDER BY COALESCE(p.posted_at, s.scheduled_at) DESC LIMIT ${HISTORY_LIMIT}`,
      [keys, [...statuses], excludeSlotId, from, to]);
    return rows.map((r: SlotRow) => auditPostOfSlot(r));
  }

  /**
   * The history a post is checked against, read by the same loader as T9's variety history (recentAuditPosts, the
   * written Telegram slots with their spec): the channel's slots of 30 days on either side of `at` (evergreen needs
   * 30; the check narrows news to 14; a slot scheduled later counts) and the siblings' slots within 24 h of it.
   */
  async history(channelKey: string, excludeSlotId: string | null, at: Date): Promise<StoryHistory> {
    const { scope, siblings } = await this.scopeOf(channelKey);
    const span = Math.max(STORY_WINDOW_DAYS, EVERGREEN_WINDOW_DAYS) * 86_400_000;
    const near = CROSS_CHANNEL_HOURS * 3_600_000;
    const { rows } = await this.pool.query(`SELECT channel_key, timezone FROM editor_channels WHERE channel_key = ANY($1::text[])`, [[channelKey, ...siblings]]);
    const tz = new Map<string, string>(rows.map((r: any) => [String(r.channel_key), String(r.timezone || 'Europe/Kyiv')]));
    const load = (key: string, ms: number, limit: number) => recentAuditPosts(this.pool, {
      channelKey: key, timezone: tz.get(key) ?? 'Europe/Kyiv', excludeSlotId, limit,
      since: new Date(at.getTime() - ms), until: new Date(at.getTime() + ms),
    });
    const [previous, ...network] = await Promise.all([load(channelKey, span, HISTORY_LIMIT), ...siblings.map((k) => load(k, near, SIBLING_LIMIT))]);
    return { scope, siblings, previous, network: network.flat() };
  }

  /** The story a post belongs to: its declared key, else the story of a matched post; null for a new story. */
  private async storyOf(scope: string, i: RecordStoryPost): Promise<string | null> {
    if (i.story?.key) {
      const { rows } = await this.pool.query(`SELECT id FROM editor_stories WHERE scope_ref = $1 AND story_key = $2`, [scope, i.story.key]);
      if (rows[0]) return rows[0].id;
    }
    const posts = [i.assessment.original, ...i.assessment.matches.map((m) => m.post), ...i.assessment.siblings.map((m) => m.post)].filter(Boolean) as AuditPost[];
    const slotIds = posts.map((p) => p.id).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    const ppIds = posts.map((p) => p.id.match(/^pp:(\d+)$/)?.[1]).filter(Boolean).map(Number);
    if (!slotIds.length && !ppIds.length) return null;
    const { rows } = await this.pool.query(
      `SELECT sp.story_id FROM editor_story_posts sp JOIN editor_stories st ON st.id = sp.story_id
        WHERE st.scope_ref = $1 AND (sp.slot_id = ANY($2::uuid[]) OR sp.published_post_id = ANY($3::bigint[]))
        ORDER BY sp.posted_at LIMIT 1`, [scope, slotIds, ppIds]);
    return rows[0]?.story_id ?? null;
  }

  /**
   * A post that matched no post of the history (another channel's post of the story older than 24 h) still joins the
   * story: the best active story of the scope (14 days) whose entities pass the story thresholds and that this
   * channel has not told yet (the channel's own repeats are the guard's business, not the registry's).
   */
  private async storyByEntities(scope: string, channelKey: string, mine: PostEntities, at: Date): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT st.id, st.entities FROM editor_stories st
        WHERE st.scope_ref = $1 AND st.status = 'active' AND st.kind = 'news'
          AND st.last_post_at BETWEEN $2::timestamptz - interval '${STORY_WINDOW_DAYS} days' AND $2::timestamptz + interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM editor_story_posts sp WHERE sp.story_id = st.id AND sp.resource_ref = $3)
        ORDER BY st.last_post_at DESC LIMIT 200`, [scope, at, `telegram:${channelKey}`]);
    let best: { id: string; score: number } | null = null;
    for (const r of rows) {
      const o = entityOverlap(mine, entitiesFromJson(r.entities));
      if (isStoryOverlap(o) && (!best || o.score > best.score)) best = { id: r.id, score: o.score };
    }
    return best?.id ?? null;
  }

  private async createStory(scope: string, i: RecordStoryPost, kind: 'news' | 'evergreen', entities: PostEntities): Promise<string> {
    const base = i.story?.key ?? storySlug(i.title);
    for (let n = 1; n <= 20; n++) {
      const key = n === 1 ? base : `${base.slice(0, 74)}-${n}`;
      const { rows } = await this.pool.query(
        `INSERT INTO editor_stories (scope_ref, story_key, title, kind, entities, key_facts, first_post_at, last_post_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (scope_ref, story_key) DO NOTHING RETURNING id`,
        [scope, key, i.title.slice(0, 300), kind, JSON.stringify(entitiesToJson(entities)), JSON.stringify((i.story?.newFacts ?? []).slice(0, KEY_FACTS_MAX)), i.postedAt]);
      if (rows[0]) return rows[0].id;
    }
    throw new Error(`story key taken: ${base}`);
  }

  /**
   * Spec 037 T2: register a stored / sent post in its story (idempotent per slot). Returns the story id and key, or
   * null when nothing could be registered (never throws on a missing story: the publish already happened).
   */
  async record(i: RecordStoryPost): Promise<{ storyId: string; storyKey: string } | null> {
    const { scope } = await this.scopeOf(i.channelKey);
    const role: StoryRole = i.assessment.role === 'repeat' ? 'followup' : i.assessment.role;
    const mine = storyView(i.post).entities;
    let storyId = await this.storyOf(scope, i) ?? await this.storyByEntities(scope, i.channelKey, mine, i.postedAt);
    if (!storyId) storyId = await this.createStory(scope, i, role === 'evergreen' ? 'evergreen' : 'news', mine);
    const facts = i.story?.newFacts ?? [];
    const decision = i.story?.decision === 'own_angle' ? 'own_angle' : null;
    const ins = await this.pool.query(
      i.slotId
        ? `INSERT INTO editor_story_posts (story_id, resource_ref, role, slot_id, published_post_id, message_id, posted_at, lead, facts, decision, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (story_id, slot_id) WHERE slot_id IS NOT NULL
           DO UPDATE SET published_post_id = COALESCE(EXCLUDED.published_post_id, editor_story_posts.published_post_id),
                         message_id = COALESCE(EXCLUDED.message_id, editor_story_posts.message_id), posted_at = EXCLUDED.posted_at
           RETURNING id`
        : `INSERT INTO editor_story_posts (story_id, resource_ref, role, slot_id, published_post_id, message_id, posted_at, lead, facts, decision, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (story_id, published_post_id) WHERE published_post_id IS NOT NULL AND slot_id IS NULL DO NOTHING RETURNING id`,
      [storyId, `telegram:${i.channelKey}`, role, i.slotId, i.publishedPostId ?? null, i.messageId ?? null, i.postedAt,
        (i.post.lead ?? i.post.text.split('\n')[0] ?? '').slice(0, 300), JSON.stringify(facts), decision, i.story?.reason ?? i.reason ?? null]);
    void ins;
    // The story: last post, entities (the original's and the follow-ups'), key facts.
    const { rows } = await this.pool.query(`SELECT story_key, entities, key_facts FROM editor_stories WHERE id = $1`, [storyId]);
    const cur = rows[0];
    if (!cur) return null;
    const merged = role === 'original' || role === 'followup' || role === 'evergreen' || role === 'reminder'
      ? entitiesToJson(mergeEntities([entitiesFromJson(cur.entities), mine])) : entitiesToJson(entitiesFromJson(cur.entities));
    const keyFacts = [...new Set([...(Array.isArray(cur.key_facts) ? cur.key_facts : []), ...facts])].slice(-KEY_FACTS_MAX);
    await this.pool.query(
      `UPDATE editor_stories SET last_post_at = GREATEST(last_post_at, $2), first_post_at = LEAST(first_post_at, $2),
              entities = $3::jsonb || CASE WHEN entities ? 'event' THEN jsonb_build_object('event', entities->'event') ELSE '{}'::jsonb END,
              key_facts = $4, updated_at = now() WHERE id = $1`,
      [storyId, i.postedAt, JSON.stringify(merged), JSON.stringify(keyFacts)]);
    // Spec 037 T3: the event the post announces (event_at + name), kept apart from the entities above.
    await new StoryEventRepository(this.pool).noteEvent(storyId, i.post, role, i.postedAt);
    return { storyId, storyKey: cur.story_key };
  }

  /** The active stories of the channel's scope (14 days; evergreen 30), the channel's own posts and the siblings'. */
  async activeStories(channelKey: string, now: Date): Promise<ActiveStory[]> {
    const { scope } = await this.scopeOf(channelKey);
    const own = `telegram:${channelKey}`;
    const { rows } = await this.pool.query(
      `SELECT st.id, st.story_key, st.title, st.kind, st.entities, st.key_facts, st.event_at, st.first_post_at, st.last_post_at,
              sp.resource_ref, sp.role, sp.posted_at, sp.slot_id, sp.published_post_id, COALESCE(sp.message_id, p.message_id) AS message_id
         FROM editor_stories st
         JOIN editor_story_posts sp ON sp.story_id = st.id
         LEFT JOIN editor_slots s ON s.id = sp.slot_id
         LEFT JOIN published_posts p ON p.id = COALESCE(sp.published_post_id, s.published_post_id)
        WHERE st.scope_ref = $1 AND st.status = 'active' AND st.last_post_at >= $2::timestamptz - interval '${EVERGREEN_WINDOW_DAYS} days'
          AND (sp.slot_id IS NULL OR s.status = ANY($3::text[]))
        ORDER BY st.last_post_at DESC, sp.posted_at`, [scope, now, [...STORY_SLOT_STATUSES]]);
    const byId = new Map<string, ActiveStory & { last: number }>();
    for (const r of rows) {
      const windowDays = r.kind === 'evergreen' ? EVERGREEN_WINDOW_DAYS : STORY_WINDOW_DAYS;
      if (now.getTime() - new Date(r.last_post_at).getTime() > windowDays * 86_400_000) continue;
      let s = byId.get(r.id);
      if (!s) {
        s = {
          key: r.story_key, title: r.title, kind: r.kind, firstPostAt: new Date(r.first_post_at).toISOString(),
          lastPostAt: new Date(r.last_post_at).toISOString(), posts: 0, originalRef: null,
          keyFacts: Array.isArray(r.key_facts) ? r.key_facts.map(String) : [], eventAt: r.event_at ? new Date(r.event_at).toISOString() : null,
          siblings: [], entities: entitiesFromJson(r.entities), last: 0,
        };
        byId.set(r.id, s);
      }
      const at = new Date(r.posted_at).toISOString();
      if (r.resource_ref === own) {
        if (r.role !== 'repost' && !s.originalRef) s.originalRef = storyPostRef(r);
        s.posts++;
        s.lastPostAt = s.posts === 1 ? at : (at > s.lastPostAt ? at : s.lastPostAt);
      } else if (typeof r.resource_ref === 'string' && r.resource_ref.startsWith('telegram:') && r.role !== 'repost') {
        const key = r.resource_ref.slice('telegram:'.length);
        const prev = s.siblings.find((x) => x.channelKey === key);
        const postRef = r.message_id != null ? `telegram:${key}/${r.message_id}` : null;
        if (!prev) s.siblings.push({ channelKey: key, at, postRef });
        else if (at > prev.at) { prev.at = at; prev.postRef = postRef ?? prev.postRef; }
      }
    }
    return [...byId.values()].map(({ last: _l, ...s }) => s);
  }

  /** Spec 037 T3: the events the channel announced that need a recap now ("recap needed" in the prompts). */
  async recapItems(channelKey: string, now: Date): Promise<RecapItem[]> {
    return new StoryEventRepository(this.pool).recapItems(channelKey, now);
  }

  /**
   * The message a follow-up slot replies to (approval mode sends later): the oldest earlier post of its story on the
   * same channel within 14 days that has a message id; null when the slot is not a follow-up.
   */
  async replyTargetOf(slotId: string): Promise<number | null> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(o.message_id, p.message_id) AS message_id
         FROM editor_story_posts f
         JOIN editor_story_posts o ON o.story_id = f.story_id AND o.resource_ref = f.resource_ref AND o.id <> f.id AND o.role <> 'repost'
         LEFT JOIN editor_slots s ON s.id = o.slot_id
         LEFT JOIN published_posts p ON p.id = COALESCE(o.published_post_id, s.published_post_id)
        WHERE f.slot_id = $1 AND f.role = 'followup' AND o.posted_at < f.posted_at
          AND o.posted_at >= f.posted_at - interval '${STORY_WINDOW_DAYS} days'
          AND COALESCE(o.message_id, p.message_id) IS NOT NULL
        ORDER BY o.posted_at LIMIT 1`, [slotId]);
    return rows[0]?.message_id != null ? Number(rows[0].message_id) : null;
  }

  /** A sibling's published post of a story (`telegram:<key>/<message id>`), the source of a story repost; null if none. */
  async repostSource(channelKey: string, storyKey: string, postRef: string): Promise<RepostSource | null> {
    const m = postRef.match(/^(?:telegram:)?(@?[A-Za-z0-9_]+)\/(\d+)$/);
    if (!m) return null;
    const { scope, siblings } = await this.scopeOf(channelKey);
    const key = siblings.find((k) => k === m[1] || k.replace(/^@/, '') === m[1].replace(/^@/, ''));
    if (!key) return null;
    const { rows } = await this.pool.query(
      `SELECT st.id AS story_id, st.story_key, sp.id AS story_post_id, sp.posted_at
         FROM editor_stories st
         JOIN editor_story_posts sp ON sp.story_id = st.id
         LEFT JOIN editor_slots s ON s.id = sp.slot_id
         LEFT JOIN published_posts p ON p.id = COALESCE(sp.published_post_id, s.published_post_id)
        WHERE st.scope_ref = $1 AND st.story_key = $2 AND sp.resource_ref = $3 AND sp.role <> 'repost'
          AND COALESCE(sp.message_id, p.message_id) = $4
        ORDER BY sp.posted_at DESC LIMIT 1`, [scope, storyKey, `telegram:${key}`, Number(m[2])]);
    const r = rows[0];
    return r ? { storyId: r.story_id, storyKey: r.story_key, storyPostId: Number(r.story_post_id), fromKey: key, messageId: Number(m[2]), postedAt: new Date(r.posted_at) } : null;
  }

  /** Story reposts of the channel: of this story, and since `dayStart` (the limits of request_story_repost). */
  async repostCounts(channelKey: string, storyId: string, dayStart: Date): Promise<{ story: number; day: number }> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*) FILTER (WHERE sp.story_id = $2)::int AS story, COUNT(*) FILTER (WHERE sp.posted_at >= $3)::int AS day
         FROM editor_story_posts sp LEFT JOIN editor_slots s ON s.id = sp.slot_id
        WHERE sp.resource_ref = $1 AND sp.role = 'repost' AND (sp.slot_id IS NULL OR s.status = ANY($4::text[]))`,
      [`telegram:${channelKey}`, storyId, dayStart, [...STORY_SLOT_STATUSES]]);
    return { story: Number(rows[0]?.story ?? 0), day: Number(rows[0]?.day ?? 0) };
  }

  /** The repost of a story by the channel: the decision, its reason and the sibling's post it forwards. */
  async recordRepost(i: { channelKey: string; slotId: string; source: RepostSource; reason: string; postedAt: Date }): Promise<void> {
    await this.pool.query(
      `INSERT INTO editor_story_posts (story_id, resource_ref, role, slot_id, posted_at, lead, decision, reason, repost_of)
       VALUES ($1, $2, 'repost', $3, $4, $5, 'repost', $6, $7)
       ON CONFLICT (story_id, slot_id) WHERE slot_id IS NOT NULL DO UPDATE SET reason = EXCLUDED.reason, repost_of = EXCLUDED.repost_of`,
      [i.source.storyId, `telegram:${i.channelKey}`, i.slotId, i.postedAt, `Repost from @${i.source.fromKey.replace(/^@/, '')}`, i.reason.slice(0, 300), i.source.storyPostId]);
  }

  /**
   * A native forward went out (spec 022 repost or T2 story_repost): a published_posts row with strategy_type
   * 'repost' (counted apart from own posts, out of the KPI samples), linked to the slot and its story post.
   */
  async recordForward(i: { channelKey: string; slotId: string; fromKey: string; fromMessageId: number; messageId: number }): Promise<number> {
    const { rows } = await this.pool.query(
      `INSERT INTO published_posts (channel_id, message_id, source_url, title, strategy_type, tags, format, editor_slot_id)
       VALUES ($1, $2, $3, $4, 'repost', '{}', 'repost', $5)
       ON CONFLICT (channel_id, message_id) DO UPDATE SET strategy_type = 'repost', editor_slot_id = EXCLUDED.editor_slot_id
       RETURNING id`,
      [i.channelKey, i.messageId, `https://t.me/${i.fromKey.replace(/^@/, '')}/${i.fromMessageId}`, `Repost from @${i.fromKey.replace(/^@/, '')}`, i.slotId]);
    const id = Number(rows[0].id);
    await this.pool.query(`UPDATE editor_slots SET published_post_id = $2, updated_at = now() WHERE id = $1`, [i.slotId, id]);
    await this.pool.query(`UPDATE editor_story_posts SET published_post_id = $2, message_id = $3 WHERE slot_id = $1`, [i.slotId, id, i.messageId]);
    return id;
  }

  /**
   * Spec 037 T2: fill the registry from the published slots of `days` (30) days, oldest first, so a later post
   * finds the story of an earlier one. Idempotent: a slot already in the registry is skipped, so a restart (or a
   * second call) only adds what is missing. Startup-safe: one run at a time per process (the service is single
   * instance), errors per post are logged and skipped. Returns how many posts it registered.
   */
  async backfill(now: Date, days = 30, o: { channels?: string[] } = {}): Promise<number> {
    if (this.backfilling) return 0;
    this.backfilling = true;
    try {
      const { rows: chans } = await this.pool.query(
        `SELECT DISTINCT channel_key FROM editor_slots WHERE status = 'published' AND promo IS NULL AND resource_ref IS NULL
            AND updated_at >= $1::timestamptz - ($2 || ' days')::interval`, [now, days]);
      const keys = chans.map((r) => String(r.channel_key)).filter((k) => !o.channels || o.channels.includes(k));
      if (!keys.length) return 0;
      const all = (await this.slots(keys, null, new Date(now.getTime() - days * 86_400_000), now, ['published'])).reverse();
      const { rows: done } = await this.pool.query(`SELECT slot_id FROM editor_story_posts WHERE slot_id = ANY($1::uuid[])`, [all.map((p) => p.id)]);
      const registered = new Set(done.map((r) => String(r.slot_id)));
      const scopes = new Map<string, { scope: string; siblings: string[] }>();
      for (const k of keys) scopes.set(k, await this.scopeOf(k));
      let n = 0;
      for (let idx = 0; idx < all.length; idx++) {
        const post = all[idx];
        if (registered.has(post.id)) continue;
        try {
          const before = all.slice(0, idx).reverse();
          const sc = scopes.get(post.channel)!;
          const a = assessStory(post, {
            previous: before.filter((p) => p.channel === post.channel),
            network: before.filter((p) => sc.siblings.includes(p.channel)),
            now: post.publishedAt,
          });
          const title = post.lead ?? post.text.split('\n')[0] ?? post.id;
          await this.record({
            channelKey: post.channel, slotId: post.id, messageId: post.messageIds?.[0] ?? null, postedAt: new Date(post.publishedAt),
            title, post, assessment: a, story: post.story ?? null, reason: a.role === 'repeat' ? 'backfill: a repeat of the story' : null,
          });
          n++;
        } catch (e) {
          this.log(`story backfill: slot ${post.id}: ${(e as Error).message}`);
        }
      }
      return n;
    } finally {
      this.backfilling = false;
    }
  }
}
