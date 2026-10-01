import { createHash, randomBytes } from 'crypto';
import type { Pool } from 'pg';
import { parseResourceRef } from '../agents/agent.types';

export interface TrackedLink {
  id:           string;
  kind:         'tg_invite' | 'utm';
  targetRef:    string;
  sourceRef:    string;
  slotId:       string | null;
  directiveId:  string | null;
  url:          string;
  code:         string | null;
  tgInviteName: string | null;
  status:       'active' | 'revoked';
  createdAt:    Date;
}

const toLink = (r: any): TrackedLink => ({
  id: r.id, kind: r.kind, targetRef: r.target_ref, sourceRef: r.source_ref, slotId: r.slot_id ?? null, directiveId: r.directive_id ?? null,
  url: r.url, code: r.code ?? null, tgInviteName: r.tg_invite_name ?? null, status: r.status, createdAt: r.created_at,
});

/** `src:<platform>:<short>` — at most 32 characters (Bot API invite link name limit). */
export function inviteName(sourceRef: string, slotId: string | null): string {
  const p = parseResourceRef(sourceRef);
  const short = (slotId ?? randomBytes(4).toString('hex')).replace(/-/g, '').slice(0, 8);
  return `src:${(p?.platform ?? 'x').slice(0, 2)}:${(p?.id ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 12)}:${short}`.slice(0, 32);
}

export function utmUrl(base: string, p: { source: string; medium: string; campaign: string }): string {
  const u = new URL(base);
  u.searchParams.set('utm_source', p.source);
  u.searchParams.set('utm_medium', p.medium);
  u.searchParams.set('utm_campaign', p.campaign);
  return u.toString();
}

const CRAWLER_RE = /bot|crawler|spider|preview|facebookexternalhit|telegrambot|whatsapp|slack|discord|twitterbot|linkedin|embedly|curl|wget|python-requests|headless/i;

/** Link-preview bots and scripts do not count as clicks. */
export function isCrawler(ua: string | null | undefined): boolean {
  return !ua || CRAWLER_RE.test(ua);
}

/** The public page of a resource (UTM destination) — null when we cannot build one. */
export function publicUrlOf(r: { platform: string; username: string | null }): string | null {
  const u = r.username?.replace(/^@/, '');
  if (!u) return null;
  switch (r.platform) {
    case 'telegram':  return `https://t.me/${u}`;
    case 'instagram': return `https://www.instagram.com/${u}/`;
    case 'threads':   return `https://www.threads.net/@${u}`;
    case 'facebook':  return `https://www.facebook.com/${u}`;
    case 'tiktok':    return `https://www.tiktok.com/@${u}`;
    default:          return null;
  }
}

/** Salted, non-reversible user hash (no Telegram user ids are stored). */
export function userHash(userId: number | string, salt: string): string {
  return createHash('sha256').update(`${salt}:${userId}`).digest('hex').slice(0, 32);
}

export interface TrackedLinksDeps {
  pool: Pick<Pool, 'query'>;
  /** Bot API createChatInviteLink on the target channel's bot; throws when the bot lacks invite rights. */
  createInvite: (channelKey: string, name: string) => Promise<string>;
  /** Public base of the redirect for UTM links (e.g. https://ai0.example); null disables UTM tracking. */
  redirectBase: string | null;
  salt: string;
}

/** Tracked links for promos (spec 022 FR-002) and the joins they bring. */
export class TrackedLinks {
  constructor(private readonly d: TrackedLinksDeps) {}

  /**
   * A link to `targetRef` placed on `sourceRef`. Telegram targets get a named
   * invite link; when the bot cannot create one, the public t.me link (joins
   * unknown). Other targets get a UTM link through our redirect.
   */
  async forPromo(o: { targetRef: string; sourceRef: string; slotId: string | null; directiveId: string | null; targetUrl?: string | null; username?: string | null }): Promise<{ link: TrackedLink | null; url: string | null; tracked: boolean; note?: string }> {
    const t = parseResourceRef(o.targetRef);
    if (!t) return { link: null, url: null, tracked: false, note: 'invalid target' };
    if (t.platform === 'telegram') {
      const name = inviteName(o.sourceRef, o.slotId);
      try {
        const url = await this.d.createInvite(t.id, name);
        const { rows } = await this.d.pool.query(
          `INSERT INTO tracked_links (kind, target_ref, source_ref, slot_id, directive_id, url, tg_invite_name) VALUES ('tg_invite', $1, $2, $3, $4, $5, $6) RETURNING *`,
          [o.targetRef, o.sourceRef, o.slotId, o.directiveId, url, name]);
        return { link: toLink(rows[0]), url, tracked: true };
      } catch (err: any) {
        const fallback = o.username ? `https://t.me/${o.username.replace(/^@/, '')}` : t.id.startsWith('@') ? `https://t.me/${t.id.slice(1)}` : null;
        return { link: null, url: fallback, tracked: false, note: `invite link unavailable (${err?.message ?? err}) — public link, joins unknown` };
      }
    }
    if (!o.targetUrl) return { link: null, url: null, tracked: false, note: 'no public URL for the target' };
    if (!this.d.redirectBase) return { link: null, url: o.targetUrl, tracked: false, note: 'redirect base not configured — untracked link' };
    const code = randomBytes(5).toString('hex');
    const dest = utmUrl(o.targetUrl, { source: parseResourceRef(o.sourceRef)?.platform ?? 'ai0', medium: 'promo', campaign: (o.slotId ?? code).slice(0, 8) });
    const url = `${this.d.redirectBase.replace(/\/$/, '')}/r/${code}`;
    const { rows } = await this.d.pool.query(
      `INSERT INTO tracked_links (kind, target_ref, source_ref, slot_id, directive_id, url, code) VALUES ('utm', $1, $2, $3, $4, $5, $6) RETURNING *`,
      [o.targetRef, o.sourceRef, o.slotId, o.directiveId, dest, code]);
    return { link: toLink(rows[0]), url, tracked: true };
  }

  /** A chat_member update: a user joined through one of our named invite links. */
  async recordJoin(u: { inviteLinkUrl?: string | null; inviteLinkName?: string | null; userId: number | string; status: string }): Promise<boolean> {
    if (!['member', 'restricted', 'administrator'].includes(u.status)) return false;
    if (!u.inviteLinkName && !u.inviteLinkUrl) return false;
    const { rows } = await this.d.pool.query(
      `SELECT id FROM tracked_links WHERE kind = 'tg_invite' AND (($1::text IS NOT NULL AND tg_invite_name = $1) OR ($2::text IS NOT NULL AND url = $2)) LIMIT 1`,
      [u.inviteLinkName ?? null, u.inviteLinkUrl ?? null]);
    if (!rows[0]) return false;
    const { rowCount } = await this.d.pool.query(
      `INSERT INTO link_joins (link_id, tg_user_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [rows[0].id, userHash(u.userId, this.d.salt)]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * A UTM redirect hit: returns the destination; counts a click unless it is a
   * link-preview crawler, and at most once per visitor (hashed IP) per hour.
   */
  async click(code: string, v: { userAgent?: string | null; ip?: string | null } = {}): Promise<string | null> {
    const { rows } = await this.d.pool.query(`SELECT id, url FROM tracked_links WHERE code = $1 AND kind = 'utm' AND status = 'active'`, [code]);
    if (!rows[0]) return null;
    if (!isCrawler(v.userAgent)) {
      const hour = new Date().toISOString().slice(0, 13);
      await this.d.pool.query(`INSERT INTO link_joins (link_id, tg_user_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [rows[0].id, userHash(`${v.ip ?? 'unknown'}:${hour}`, this.d.salt)]);
    }
    return rows[0].url;
  }

  async stats(refs: string[]): Promise<Array<{ id: string; kind: string; targetRef: string; sourceRef: string; url: string; status: string; createdAt: Date; joins: number }>> {
    const { rows } = await this.d.pool.query(
      `SELECT l.*, COALESCE(SUM(j.count), 0)::int AS joins FROM tracked_links l LEFT JOIN link_joins j ON j.link_id = l.id
        WHERE l.target_ref = ANY($1::text[]) OR l.source_ref = ANY($1::text[]) GROUP BY l.id ORDER BY l.created_at DESC LIMIT 100`, [refs]);
    return rows.map((r) => ({ ...toLink(r), joins: Number(r.joins) }));
  }
}
