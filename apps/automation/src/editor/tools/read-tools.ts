import type { Pool } from 'pg';
import { z } from 'zod';
import { channelOf, defineTool, EditorTool, ToolContext } from '../harness/tool';
import type { ReadonlyQueryService } from '../db/readonly-query.service';
import type { SkillSource } from '../skills/skill-library';
import { safeGet, RawGet } from '../net/safe-http';
import type { Lookup } from '../net/ssrf-guard';
import { extractPage } from '../net/extract-page';
import { topMatches } from '../post/similarity';
import { EXTRA_MAX_CHARS, LIBRARY_EXTRA, LIBRARY_TABLE_NAMES } from './library-tables';
import { DataStore } from '../../data/data-store';
import { filterFresh, readFeed } from '../live/feed-items';
import { queryDataset } from '../../data/data-query';

export interface ReadToolDeps {
  pool:      Pool;
  readonly:  ReadonlyQueryService;
  skills:    SkillSource;
  /** Test seams for network tools. */
  http?:     { lookup?: Lookup; get?: RawGet };
  /** Kyiv-local month/day for "today" filters; injectable for tests. */
  today?:    () => { month: number; day: number };
  /** Clock for item ages (fetch_feed); injectable for tests. */
  now?:      () => Date;
}

const ALL_ROLES = ['planner', 'executor', 'reviewer', 'composer', 'orchestrator', 'idea_reviewer', 'manager', 'builder'] as const;

function kyivToday(): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
  return { month: Number(parts.find((p) => p.type === 'month')!.value), day: Number(parts.find((p) => p.type === 'day')!.value) };
}

function requireChannel(ctx: ToolContext): string {
  const channelKey = channelOf(ctx);
  if (!channelKey) throw new Error('this tool needs a channel context (in the chat: name the channel first, see list_my_channels)');
  return channelKey;
}

/** The resource a run writes for: a platform slot's target, else the channel (spec 034 live dedup). */
function slotResourceRef(ctx: ToolContext): string | null {
  const ps = ctx.extras?.platformSlot as { resourceRef?: string } | undefined;
  if (ps?.resourceRef) return ps.resourceRef;
  const ch = channelOf(ctx);
  return ch ? `telegram:${ch}` : null;
}

const clip = (s: unknown, n: number) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

export function buildReadTools(d: ReadToolDeps): EditorTool[] {
  const today = d.today ?? kyivToday;
  const now = d.now ?? (() => new Date());

  const getChannelStats = defineTool({
    name: 'get_channel_stats',
    description: 'Статистика каналу за N днів: підписники (зараз і зміна), кількість постів, медіана переглядів/год, найкращі години публікації (у часовому поясі каналу).',
    kind: 'read', roles: [...ALL_ROLES],
    input: z.object({ days: z.number().int().min(1).max(90).default(14) }),
    execute: async ({ days }, ctx) => {
      const ch = requireChannel(ctx);
      const [subs, posts, hours] = await Promise.all([
        d.pool.query(
          `SELECT (SELECT subscribers FROM channel_stats_snapshots WHERE channel_id = $1 ORDER BY captured_at DESC LIMIT 1) AS now,
                  (SELECT subscribers FROM channel_stats_snapshots WHERE channel_id = $1 AND captured_at >= now() - ($2 || ' days')::interval
                    ORDER BY captured_at ASC LIMIT 1) AS then`, [ch, days]),
        d.pool.query(
          `SELECT COUNT(*)::int AS n, ROUND(AVG(views))::int AS avg_views,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY views_per_hour) AS median_vph
             FROM editor_v_post_performance WHERE channel_id = $1 AND posted_at >= now() - ($2 || ' days')::interval`, [ch, days]),
        d.pool.query(
          `SELECT EXTRACT(HOUR FROM posted_at AT TIME ZONE resource_tz('telegram:' || $1))::int AS hour, COUNT(*)::int AS posts,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY views_per_hour) AS median_vph
             FROM editor_v_post_performance
            WHERE channel_id = $1 AND posted_at >= now() - ($2 || ' days')::interval AND views_per_hour IS NOT NULL
            GROUP BY 1 HAVING COUNT(*) >= 2 ORDER BY median_vph DESC NULLS LAST LIMIT 6`, [ch, days]),
      ]);
      const s = subs.rows[0] ?? {};
      const p = posts.rows[0] ?? {};
      return {
        days,
        subscribers: { now: s.now ?? null, delta: s.now != null && s.then != null ? s.now - s.then : null },
        posts: { count: p.n ?? 0, perDay: Math.round(((p.n ?? 0) / days) * 10) / 10, avgViews: p.avg_views ?? null, medianViewsPerHour: p.median_vph != null ? Number(p.median_vph) : null },
        bestHours: hours.rows.map((r) => ({ hour: r.hour, posts: r.posts, medianViewsPerHour: Number(r.median_vph) })),
      };
    },
  });

  const getRecentPosts = defineTool({
    name: 'get_recent_posts',
    description: 'Останні пости каналу (від нових до старих) з форматом, тегами, джерелом і переглядами. Використовуй, щоб не повторюватись.',
    kind: 'read', roles: [...ALL_ROLES],
    input: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    execute: async ({ limit }, ctx) => {
      const { rows } = await d.pool.query(
        `SELECT title, format, strategy_type, tags, source_url, posted_at, views, views_per_hour
           FROM editor_v_post_performance WHERE channel_id = $1 ORDER BY posted_at DESC LIMIT $2`,
        [requireChannel(ctx), limit]);
      return { posts: rows };
    },
  });

  const getTopPosts = defineTool({
    name: 'get_top_posts',
    description: 'Найкращі пости каналу за метрикою за останні N днів. Показує, які теми й формати заходять аудиторії.',
    kind: 'read', roles: [...ALL_ROLES],
    input: z.object({
      days:   z.number().int().min(1).max(180).default(30),
      limit:  z.number().int().min(1).max(30).default(10),
      metric: z.enum(['views_per_hour', 'views', 'forwards', 'reactions_total']).default('views_per_hour'),
    }),
    execute: async ({ days, limit, metric }, ctx) => {
      const { rows } = await d.pool.query(
        `SELECT title, format, tags, posted_at, views, forwards, reactions_total, views_per_hour
           FROM editor_v_post_performance
          WHERE channel_id = $1 AND posted_at >= now() - ($2 || ' days')::interval
          ORDER BY ${metric} DESC NULLS LAST LIMIT $3`,
        [requireChannel(ctx), days, limit]);
      return { metric, posts: rows };
    },
  });

  const sqlReadonly = defineTool({
    name: 'sql_readonly',
    description: 'Довільний SELECT/WITH по БД (тільки читання, ≤50 рядків, 3с). Корисні таблиці/вʼю: editor_v_post_performance, editor_v_channel_daily, published_posts, post_stats_snapshots, channel_stats_snapshots, tracked_channels, tracked_posts, editor_slots. Контент: data_schemas (датасети: key, title, description, fields), data_items (рядки: schema_id, data jsonb, title, body, category, event_month, event_day, status, legacy_ref), data_schema_stats. Для вибору матеріалу краще library_catalog + query_data. Секретні таблиці недоступні.',
    kind: 'read', roles: [...ALL_ROLES],
    input: z.object({ query: z.string().min(1).max(4000), limit: z.number().int().min(1).max(50).default(50) }),
    execute: async ({ query, limit }) => d.readonly.run(query, limit),
  });

  const searchLibrary = defineTool({
    name: 'search_library',
    description: 'Застарілий пошук у бібліотеці (12 старих датасетів: рецепти, факти, цитати, промпти, події дня, статті, ПДР, дні народження…), повертає всі поля записів. Краще: library_catalog → query_data лише з потрібними полями. За замовчуванням виключає те, що вже публікувалось у цьому каналі. Якщо публікуєш на основі запису — передай library_ref у PostSpec.',
    kind: 'read', roles: [...ALL_ROLES],
    input: z.object({
      table:        z.enum(LIBRARY_TABLE_NAMES),
      query:        z.string().max(200).optional().describe('Пошук у заголовку/тексті (ILIKE). Без нього — випадкові записи.'),
      category:     z.string().max(100).optional(),
      today_only:   z.boolean().default(false).describe('Лише записи про сьогоднішню дату (on_this_day, birthdays, name_days).'),
      include_used: z.boolean().default(false),
      limit:        z.number().int().min(1).max(20).default(8),
    }),
    // Spec 032: a wrapper over the data store query (same answer shape as before the store); kept one release.
    execute: async (i, ctx) => {
      const schema = await new DataStore(d.pool).getSchema(i.table);
      if (!schema || schema.status !== 'active') return { error: 'unknown_table', details: `no active dataset "${i.table}"` };
      if (i.today_only && !(['date', 'month_day', 'month', 'day'] as const).some((r) => schema.roles?.[r])) {
        return { error: 'today_only_not_supported', details: `table ${i.table} has no date` };
      }
      const extra = LIBRARY_EXTRA[i.table] ?? {};
      const names = new Set(schema.fields.map((f) => f.name));
      const extraFields = [...new Set(Object.values(extra).flat())].filter((n) => names.has(n));
      const channelKey = channelOf(ctx);
      const r = await queryDataset(d.pool, schema, {
        audience: 'owner', fields: extraFields,
        search: i.query, categoryLike: i.category, todayOnly: i.today_only,
        unpostedOn: !i.include_used && channelKey ? channelKey : null,
        order: i.query ? 'newest' : 'random', limit: i.limit, today: today(), bodyChars: 800,
      });
      const pickExtra = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(extra).map(([k, src]) => {
        let v: unknown = null;
        for (const f of Array.isArray(src) ? src : [src]) {
          const x = data[f];
          if (x !== undefined && x !== null && x !== '') { v = x; break; }
        }
        return [k, typeof v === 'string' && v.length > EXTRA_MAX_CHARS ? v.slice(0, EXTRA_MAX_CHARS) : v];
      }));
      return {
        table: i.table,
        items: r.rows.map((row: any) => {
          const legacyId = typeof row.legacy_ref === 'string' ? row.legacy_ref.slice(`library://${i.table}/`.length) : null;
          return {
            id: legacyId ?? row.id, title: row.title, text: row.body, image_url: row.image_url, url: row.url, category: row.category,
            extra: pickExtra(row.data ?? {}), library_ref: row.legacy_ref ?? row.ref,
          };
        }),
      };
    },
  });

  const webFetch = defineTool({
    name: 'web_fetch',
    description: 'Завантажити публічну веб-сторінку і отримати її читабельний текст, заголовок, опис та зображення. Для фактчеку й першоджерел.',
    kind: 'read', roles: [...ALL_ROLES],
    input: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      const res = await safeGet(url, { lookup: d.http?.lookup, get: d.http?.get });
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        return { error: 'http_error', details: `status ${res.status}: сайт не дає завантажити сторінку. Не пробуй його знову — візьми snippet зі стрічки, інше джерело або пропусти слот` };
      }
      if (res.status >= 400) return { error: 'http_error', details: `status ${res.status}` };
      if (!/html|xml|text/i.test(res.contentType) && res.contentType) return { error: 'unsupported_content', details: res.contentType };
      return { url: res.url, ...extractPage(res.body, res.url) };
    },
  });

  const fetchFeed = defineTool({
    name: 'fetch_feed',
    description: 'Прочитати RSS/Atom-стрічку: останні записи з заголовком, посиланням, датою, віком (age_hours), коротким описом і зображенням. since_hours — лише записи, не старші за N год; exclude_posted — відкинути вже використане на твоєму ресурсі і схоже на його пости за 7 днів (для live-слотів).',
    kind: 'read', roles: [...ALL_ROLES],
    input: z.object({
      url:            z.string().url(),
      limit:          z.number().int().min(1).max(30).default(10),
      since_hours:    z.number().min(0.5).max(720).optional().describe('Лише записи, не старші за стільки годин (записи без дати відкидаються)'),
      exclude_posted: z.boolean().default(false).describe('Відкинути вже опубліковане/зайняте на ресурсі й схоже на пости останніх 7 днів'),
    }),
    execute: async ({ url, limit, since_hours, exclude_posted }, ctx) => {
      const t = now();
      let feed: Awaited<ReturnType<typeof readFeed>>;
      try {
        feed = await readFeed(url, t, d.http);
      } catch (err: any) {
        const m = /^status (\d+)/.exec(err?.message ?? '');
        if (m) return { error: 'http_error', details: `status ${m[1]}` };
        throw err;
      }
      // Spec 034 FR-010: freshness and (live slots) the ledger + 7-day repeat check, in code.
      const resourceRef = exclude_posted ? slotResourceRef(ctx) : null;
      if (exclude_posted && !resourceRef) return { error: 'no_resource', details: 'exclude_posted потребує каналу (контексту слота)' };
      const r = since_hours != null || resourceRef
        ? await filterFresh(feed.items, { sinceHours: since_hours ?? null, pool: resourceRef ? d.pool : undefined, resourceRef, now: t, excludeSlotId: ctx.slotId ?? null })
        : null;
      const items = (r ? r.kept : feed.items).slice(0, limit).map((it) => ({
        title: it.title, link: it.link, date: it.date, age_hours: it.age_hours != null && it.age_hours >= 0 ? it.age_hours : null,
        snippet: it.snippet, image: it.image,
      }));
      return { title: feed.title, items, ...(r ? { dropped: r.dropped } : {}) };
    },
  });

  const checkSimilarity = defineTool({
    name: 'check_similarity',
    description: 'Перевірити, чи чернетка не повторює нещодавні пости каналу (останні 60). score ≥ 0.6 — майже дубль, обери інший кут або тему.',
    kind: 'read', roles: ['executor', 'planner', 'composer'],
    input: z.object({ text: z.string().min(1).max(8000) }),
    execute: async ({ text }, ctx) => {
      const ch = requireChannel(ctx);
      const { rows } = await d.pool.query(
        `(SELECT COALESCE(rendered_preview, topic) AS text, updated_at AS at FROM editor_slots
           WHERE channel_key = $1 AND status IN ('published','shadowed','awaiting_approval','approved') ORDER BY updated_at DESC LIMIT 60)
         UNION ALL
         (SELECT title AS text, posted_at AS at FROM published_posts
           WHERE channel_id = $1 AND title IS NOT NULL AND editor_slot_id IS NULL ORDER BY posted_at DESC LIMIT 60)`,
        [ch]);
      const matches = topMatches(text, rows.map((r) => ({ text: String(r.text ?? ''), at: r.at })), 5)
        .map((m) => ({ score: m.score, at: m.at, excerpt: clip(m.text, 160) }));
      return { maxScore: matches[0]?.score ?? 0, matches };
    },
  });

  // An agent run carries its resolved DB skill view (spec 017); otherwise the file library.
  const skillsOf = (ctx: ToolContext): SkillSource => (ctx.extras?.skills as SkillSource | undefined) ?? d.skills;

  const listSkills = defineTool({
    name: 'list_skills',
    description: 'Перелік доступних скілів (інструкцій) для твоєї ролі.',
    kind: 'read', roles: [...ALL_ROLES],
    input: z.object({}),
    execute: async (_i, ctx) => ({ skills: skillsOf(ctx).list(ctx.role).map(({ name, description }) => ({ name, description })) }),
  });

  const loadSkill = defineTool({
    name: 'load_skill',
    description: 'Завантажити повний текст скіла за назвою (правила форматування, голосу, фактчеку тощо). Завантажуй перед тим, як використовувати відповідний формат.',
    kind: 'read', roles: [...ALL_ROLES],
    input: z.object({ name: z.string().min(1).max(100) }),
    execute: async ({ name }, ctx) => {
      const s = skillsOf(ctx).get(name);
      return s ? { name: s.name, body: s.body } : { error: 'unknown_skill', details: `no skill "${name}" — call list_skills` };
    },
  });

  return [getChannelStats, getRecentPosts, getTopPosts, sqlReadonly, searchLibrary, webFetch, fetchFeed, checkSimilarity, listSkills, loadSkill];
}
