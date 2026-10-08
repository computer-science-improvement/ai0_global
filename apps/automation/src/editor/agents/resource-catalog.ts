import type { Pool } from 'pg';
import { parseResourceRef, Platform, resourceRef } from './agent.types';
import type { HealthState } from './resource-profile';

export interface ResourceListItem {
  ref:       string;
  platform:  Platform;
  title:     string | null;
  username:  string | null;
  followers: number | null;
  /** Account group (network) it belongs to. */
  groupId:   string | null;
  groupName: string | null;
  /** @handle of the top-level agent that runs it (resource orchestrator, or the network's). */
  agent:     string | null;
}

export interface AccessCheck {
  state:  HealthState;
  detail: string;
}

export interface ResourceInspection {
  resource:   ResourceListItem;
  about:      string | null;
  themes:     string[];
  stats:      { posts28d: number; avgViews28d: number | null; postsPerDay: number | null; followers: number | null };
  recentPosts: Array<{ at: string; text: string; views: number | null }>;
  access:     AccessCheck;
  profileExists: boolean;
}

export interface CatalogDeps {
  pool: Pick<Pool, 'query'>;
  /** Live access check of a Telegram channel (bot is admin with post rights). Optional: unknown without it. */
  telegramAccess?: (channelKey: string) => Promise<AccessCheck>;
  now?: () => Date;
}

const DAY = 86_400_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Every publishable resource the owner has connected (spec 018 FR-004). */
export class ResourceCatalog {
  constructor(private readonly d: CatalogDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async list(): Promise<ResourceListItem[]> {
    const out: ResourceListItem[] = [];
    const { rows: tg } = await this.d.pool.query(
      `SELECT k.channel_key, t.title, t.username, t.subs_count, t.group_id, g.name AS group_name
         FROM (SELECT channel_key FROM tracked_channels WHERE is_mine AND channel_key IS NOT NULL
               UNION SELECT channel_key FROM editor_channels) k
         LEFT JOIN LATERAL (SELECT * FROM tracked_channels x WHERE x.channel_key = k.channel_key ORDER BY x.is_mine DESC LIMIT 1) t ON true
         LEFT JOIN meta_account_groups g ON g.id = t.group_id
        ORDER BY k.channel_key`);
    for (const r of tg) {
      out.push({
        ref: resourceRef('telegram', r.channel_key), platform: 'telegram', title: r.title ?? null, username: r.username ?? null,
        followers: r.subs_count == null ? null : Number(r.subs_count), groupId: r.group_id ?? null, groupName: r.group_name ?? null, agent: null,
      });
    }
    const { rows: meta } = await this.d.pool.query(
      `SELECT m.id, m.platform, m.username, m.display_name, m.followers, m.group_id, g.name AS group_name
         FROM meta_accounts m LEFT JOIN meta_account_groups g ON g.id = m.group_id WHERE m.active ORDER BY m.platform, m.username`);
    for (const r of meta) {
      out.push({
        ref: resourceRef(r.platform, r.id), platform: r.platform, title: r.display_name ?? r.username ?? null, username: r.username ?? null,
        followers: r.followers == null ? null : Number(r.followers), groupId: r.group_id ?? null, groupName: r.group_name ?? null, agent: null,
      });
    }
    // TikTok and YouTube accounts belong to a network like Meta accounts (051 group_id).
    const { rows: tt } = await this.d.pool.query(
      `SELECT t.id, t.username, t.display_name, t.group_id, g.name AS group_name
         FROM tiktok_accounts t LEFT JOIN meta_account_groups g ON g.id = t.group_id WHERE t.active ORDER BY t.username`);
    for (const r of tt) {
      out.push({ ref: resourceRef('tiktok', r.id), platform: 'tiktok', title: r.display_name ?? r.username ?? null, username: r.username ?? null, followers: null, groupId: r.group_id ?? null, groupName: r.group_name ?? null, agent: null });
    }
    const { rows: hasYt } = await this.d.pool.query(`SELECT to_regclass('public.youtube_accounts') IS NOT NULL AS ok`);
    if (hasYt[0]?.ok) {
      const { rows: yt } = await this.d.pool.query(
        `SELECT y.id, y.title, y.group_id, g.name AS group_name
           FROM youtube_accounts y LEFT JOIN meta_account_groups g ON g.id = y.group_id WHERE y.active ORDER BY y.title`);
      for (const r of yt) out.push({ ref: resourceRef('youtube', r.id), platform: 'youtube', title: r.title ?? null, username: null, followers: null, groupId: r.group_id ?? null, groupName: r.group_name ?? null, agent: null });
    }

    // Which agent runs each resource: its own orchestrator, else — in an independent
    // network — the orchestrator of the network's Telegram channel (spec 020).
    const { rows: ag } = await this.d.pool.query(
      `SELECT scope, scope_id, handle FROM agents WHERE parent_id IS NULL AND kind = 'orchestrator'`);
    const byScope = new Map(ag.map((a) => [`${a.scope}:${a.scope_id}`, a.handle as string]));
    const { rows: groups } = await this.d.pool.query(
      `SELECT g.id, g.mode, (SELECT channel_key FROM tracked_channels t WHERE t.group_id = g.id AND t.channel_key IS NOT NULL LIMIT 1) AS anchor
         FROM meta_account_groups g`).catch(() => ({ rows: [] as any[] }));
    const anchorOf = new Map(groups.filter((g) => (g.mode === 'independent' || g.mode === 'orchestrated') && g.anchor).map((g) => [g.id as string, `telegram:${g.anchor}`]));
    for (const r of out) {
      const anchor = r.groupId ? anchorOf.get(r.groupId) : undefined;
      r.agent = byScope.get(`resource:${r.ref}`) ?? (anchor ? byScope.get(`resource:${anchor}`) ?? null : null)
        ?? (r.groupId ? byScope.get(`network:${r.groupId}`) ?? null : null);
    }
    return out;
  }

  async get(ref: string): Promise<ResourceListItem | null> {
    return (await this.list()).find((r) => r.ref === ref) ?? null;
  }

  /** Can we publish there right now (spec 019 FR-011)? Never throws. */
  async access(ref: string): Promise<AccessCheck> {
    const parsed = parseResourceRef(ref);
    if (!parsed) return { state: 'unknown', detail: 'invalid ref' };
    try {
      if (parsed.platform === 'telegram') {
        return this.d.telegramAccess
          ? await this.d.telegramAccess(parsed.id).catch((e: any) => ({ state: 'unknown' as const, detail: String(e?.message ?? e) }))
          : { state: 'unknown', detail: 'access check unavailable' };
      }
      if (parsed.platform === 'instagram' || parsed.platform === 'facebook' || parsed.platform === 'threads') {
        const { rows } = await this.d.pool.query(`SELECT active, last_verified_at, verify_error FROM meta_accounts WHERE id::text = $1`, [parsed.id]);
        const r = rows[0];
        return !r ? { state: 'no_access', detail: 'account not found' }
          : !r.active ? { state: 'no_access', detail: 'account disabled' }
          : r.verify_error ? { state: 'token_invalid', detail: String(r.verify_error) }
          : r.last_verified_at ? { state: 'ok', detail: `verified ${new Date(r.last_verified_at).toISOString().slice(0, 10)}` }
          : { state: 'unknown', detail: 'not verified yet' };
      }
      if (parsed.platform === 'tiktok') {
        const { rows } = await this.d.pool.query(`SELECT active, refresh_token_expires_at, refresh_error FROM tiktok_accounts WHERE id::text = $1`, [parsed.id]);
        const r = rows[0];
        const refreshLeft = r ? new Date(r.refresh_token_expires_at).getTime() - this.now().getTime() : -1;
        return !r ? { state: 'no_access', detail: 'account not found' }
          : !r.active ? { state: 'no_access', detail: 'account disabled' }
          : r.refresh_error ? { state: 'token_invalid', detail: String(r.refresh_error) }
          : refreshLeft < 0 ? { state: 'token_invalid', detail: 'refresh token expired' }
          : refreshLeft < 7 * DAY ? { state: 'token_expiring', detail: `refresh token expires ${new Date(r.refresh_token_expires_at).toISOString().slice(0, 10)}` }
          : { state: 'ok', detail: 'token valid' };
      }
      const { rows } = await this.d.pool.query(`SELECT active, expires_at FROM youtube_accounts WHERE id::text = $1`, [parsed.id]);
      return !rows[0] ? { state: 'no_access', detail: 'account not found' } : { state: 'unknown', detail: 'YouTube — 019b' };
    } catch (err: any) {
      return { state: 'unknown', detail: String(err?.message ?? err) };
    }
  }


  async inspect(ref: string): Promise<ResourceInspection | { error: string; details?: string }> {
    const parsed = parseResourceRef(ref);
    if (!parsed) return { error: 'invalid_ref', details: 'format <platform>:<id>, e.g. telegram:@my_channel' };
    const resource = await this.get(ref);
    if (!resource) return { error: 'resource_not_connected', details: 'the resource is not connected — connect it in /app/connections' };
    const { rows: prof } = await this.d.pool.query(`SELECT 1 FROM resource_profiles WHERE resource_ref = $1 AND profile <> '{}'::jsonb`, [ref]);
    const since = new Date(this.now().getTime() - 28 * DAY);

    if (parsed.platform === 'telegram') {
      const key = parsed.id;
      const { rows: tc } = await this.d.pool.query(
        `SELECT id, about, themes FROM tracked_channels WHERE channel_key = $1 ORDER BY is_mine DESC LIMIT 1`, [key]);
      const { rows: own } = await this.d.pool.query(
        `SELECT posted_at, COALESCE(title, '') AS text, views FROM editor_v_post_performance
          WHERE channel_id = $1 AND posted_at >= $2 ORDER BY posted_at DESC LIMIT 200`, [key, since]);
      let posts = own.map((r) => ({ at: new Date(r.posted_at).toISOString(), text: clip(String(r.text), 200), views: r.views == null ? null : Number(r.views) }));
      if (!posts.length && tc[0]) {
        const { rows: tp } = await this.d.pool.query(
          `SELECT posted_at, COALESCE(text, '') AS text, views FROM tracked_posts WHERE channel_id = $1 AND posted_at >= $2 ORDER BY posted_at DESC LIMIT 200`,
          [tc[0].id, since]);
        posts = tp.map((r) => ({ at: new Date(r.posted_at).toISOString(), text: clip(String(r.text), 200), views: r.views == null ? null : Number(r.views) }));
      }
      const viewed = posts.filter((p) => p.views != null);
      const access = await this.access(ref);
      return {
        resource, about: tc[0]?.about ?? null, themes: tc[0]?.themes ?? [],
        stats: {
          posts28d: posts.length,
          avgViews28d: viewed.length ? Math.round(viewed.reduce((s, p) => s + (p.views ?? 0), 0) / viewed.length) : null,
          postsPerDay: posts.length ? Math.round((posts.length / 28) * 10) / 10 : null,
          followers: resource.followers,
        },
        recentPosts: posts.slice(0, 30), access, profileExists: prof.length > 0,
      };
    }

    // Meta / TikTok / YouTube: account state from the connection tables; posts from platform_posts (019).
    const access = await this.access(ref);
    const { rows: hasPp } = await this.d.pool.query(`SELECT to_regclass('public.platform_posts') IS NOT NULL AS ok`);
    let posts: Array<{ at: string; text: string; views: number | null }> = [];
    if (hasPp[0]?.ok) {
      const { rows } = await this.d.pool.query(
        `SELECT p.posted_at, COALESCE(p.caption, '') AS text,
                (SELECT m.views FROM platform_post_metrics m WHERE m.post_id = p.id ORDER BY m.captured_at DESC LIMIT 1) AS views
           FROM platform_posts p WHERE p.resource_ref = $1 AND p.status = 'published' AND p.posted_at >= $2 ORDER BY p.posted_at DESC LIMIT 100`,
        [ref, since]);
      posts = rows.map((r) => ({ at: new Date(r.posted_at).toISOString(), text: clip(String(r.text), 200), views: r.views == null ? null : Number(r.views) }));
    }
    const viewed = posts.filter((p) => p.views != null);
    return {
      resource, about: null, themes: [],
      stats: {
        posts28d: posts.length, avgViews28d: viewed.length ? Math.round(viewed.reduce((s, p) => s + (p.views ?? 0), 0) / viewed.length) : null,
        postsPerDay: posts.length ? Math.round((posts.length / 28) * 10) / 10 : null, followers: resource.followers,
      },
      recentPosts: posts.slice(0, 30), access, profileExists: prof.length > 0,
    };
  }
}

/** Bot API check: our bot is an administrator of the channel and may post. */
export function makeTelegramAccessCheck(resolve: (key: string) => { chatId: string | number; botToken: string }, fetchImpl: typeof fetch = fetch) {
  return async (channelKey: string): Promise<AccessCheck> => {
    let ch: { chatId: string | number; botToken: string };
    try { ch = resolve(channelKey); } catch (err: any) { return { state: 'no_access', detail: `channel not configured: ${err?.message ?? err}` }; }
    const call = async (method: string, params: Record<string, unknown>) => {
      const res = await fetchImpl(`https://api.telegram.org/bot${ch.botToken}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(10_000),
      });
      return res.json() as Promise<any>;
    };
    try {
      const me = await call('getMe', {});
      if (!me?.ok) return { state: 'token_invalid', detail: 'bot token invalid' };
      const member = await call('getChatMember', { chat_id: ch.chatId, user_id: me.result.id });
      if (!member?.ok) return { state: 'no_access', detail: member?.description ?? 'the bot cannot see the channel' };
      const m = member.result;
      if (m.status === 'creator') return { state: 'ok', detail: 'the bot is the owner' };
      if (m.status !== 'administrator') return { state: 'no_access', detail: `the bot is not an administrator (${m.status})` };
      if (m.can_post_messages === false) return { state: 'no_access', detail: 'the bot is an admin without the right to post' };
      return { state: 'ok', detail: `bot @${me.result.username} is an admin with the right to post` };
    } catch (err: any) {
      return { state: 'unknown', detail: `Bot API unavailable: ${err?.message ?? err}` };
    }
  };
}
