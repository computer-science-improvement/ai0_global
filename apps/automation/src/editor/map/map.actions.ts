import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import { parseResourceRef, type Platform } from '../agents/agent.types';
import type { ResourceListItem } from '../agents/resource-catalog';

/**
 * Spec 056 follow-up: what the owner changes from the network map — which network a resource belongs to, and whether
 * two resources may promote each other. Both are the same changes the Connections page and the promo planner know;
 * the map only offers them where the owner sees the relation.
 */

export interface MapActionDeps {
  pool:       Pick<Pool, 'query'>;
  catalog:    { list(): Promise<ResourceListItem[]> };
  /** Drops the cached snapshot so the next poll shows the change. */
  invalidate: () => void;
}

const GroupBody = z.object({ ref: z.string().min(3).max(300), groupId: z.string().uuid().nullable() }).strict();
const BlockBody = z.object({ a: z.string().min(3).max(300), b: z.string().min(3).max(300), blocked: z.boolean() }).strict();

const PLATFORM_NAME: Record<Platform, string> = {
  telegram: 'Telegram channel', instagram: 'Instagram account', facebook: 'Facebook page', threads: 'Threads account', tiktok: 'TikTok account', youtube: 'YouTube channel',
};

/** The row a resource's network lives on, per platform. */
const GROUP_UPDATE: Record<Platform, string> = {
  telegram: `UPDATE tracked_channels SET group_id = $2
              WHERE id = (SELECT id FROM tracked_channels WHERE channel_key = $1 ORDER BY is_mine DESC LIMIT 1) RETURNING id`,
  instagram: `UPDATE meta_accounts SET group_id = $2 WHERE id::text = $1 RETURNING id`,
  facebook:  `UPDATE meta_accounts SET group_id = $2 WHERE id::text = $1 RETURNING id`,
  threads:   `UPDATE meta_accounts SET group_id = $2 WHERE id::text = $1 RETURNING id`,
  tiktok:    `UPDATE tiktok_accounts SET group_id = $2 WHERE id::text = $1 RETURNING id`,
  youtube:   `UPDATE youtube_accounts SET group_id = $2 WHERE id::text = $1 RETURNING id`,
};

/** Promo slots that have not gone out yet (a blocked pair cancels them). */
const PENDING = `('planned', 'awaiting_approval', 'approved')`;
export const BLOCKED_SLOT_ERROR = 'promo pair blocked by owner';

export class MapActions {
  constructor(private readonly d: MapActionDeps) {}

  private bad(error: string, details: string): never { throw new BadRequestException({ error, details }); }

  /** Moves a resource into a network, or out of any (groupId null). One resource per platform per network. */
  async setGroup(body: unknown): Promise<{ ref: string; groupId: string | null; groupName: string | null }> {
    const p = GroupBody.safeParse(body ?? {});
    if (!p.success) this.bad('invalid_body', 'ref and groupId (a network id or null) are required');
    const { ref, groupId } = p.data;
    const parsed = parseResourceRef(ref);
    if (!parsed) this.bad('invalid_ref', `${ref} is not a resource`);
    const catalog = await this.d.catalog.list();
    const res = catalog.find((r) => r.ref === ref);
    if (!res) throw new NotFoundException({ error: 'resource_not_found', details: `${ref} is not one of your connected resources` });
    let groupName: string | null = null;
    if (groupId) {
      const { rows } = await this.d.pool.query(`SELECT name FROM meta_account_groups WHERE id = $1`, [groupId]);
      if (!rows[0]) throw new NotFoundException({ error: 'network_not_found', details: 'that network no longer exists' });
      groupName = rows[0].name as string;
    }
    if ((res.groupId ?? null) === groupId) return { ref, groupId, groupName };
    const clash = groupId ? catalog.find((r) => r.groupId === groupId && r.platform === parsed.platform && r.ref !== ref) : null;
    if (clash) {
      throw new ConflictException({
        error: 'network_has_platform',
        details: `«${groupName}» already has a ${PLATFORM_NAME[parsed.platform]} (${clash.title ?? clash.username ?? clash.ref}) — take it out of the network first (one per platform per network)`,
      });
    }
    try {
      const { rows } = await this.d.pool.query(GROUP_UPDATE[parsed.platform], [parsed.id, groupId]);
      if (!rows.length) {
        throw new UnprocessableEntityException({
          error: 'not_tracked', details: `${ref} has no tracked channel row to hold its network — add it on the Connections page first`,
        });
      }
    } catch (err: any) {
      if (err?.code === '23505') { // a switched-off account of the platform still holds the place
        throw new ConflictException({
          error: 'network_has_platform',
          details: `«${groupName}» already has a ${PLATFORM_NAME[parsed.platform]} — take that one out of the network first (one per platform per network)`,
        });
      }
      throw err;
    }
    this.d.invalidate();
    return { ref, groupId, groupName };
  }

  /**
   * Blocks or allows promos between two resources, both ways. Blocking also skips the promo slots of the pair that have
   * not gone out yet; the promo planner refuses the pair until it is allowed again.
   */
  async setPairBlocked(body: unknown): Promise<{ a: string; b: string; blocked: boolean; canceled: number }> {
    const p = BlockBody.safeParse(body ?? {});
    if (!p.success) this.bad('invalid_body', 'a, b and blocked are required');
    const { a, b, blocked } = p.data;
    if (!parseResourceRef(a) || !parseResourceRef(b)) this.bad('invalid_ref', 'a and b must be resources');
    if (a === b) this.bad('same_resource', 'a and b are the same resource');
    let canceled = 0;
    if (blocked) {
      await this.d.pool.query(
        `INSERT INTO promo_pairs (source_ref, target_ref, blocked_at) VALUES ($1, $2, now()), ($2, $1, now())
         ON CONFLICT (source_ref, target_ref) DO UPDATE SET blocked_at = COALESCE(promo_pairs.blocked_at, EXCLUDED.blocked_at)`, [a, b]);
      const { rows } = await this.d.pool.query(
        `UPDATE editor_slots SET status = 'skipped', error = $3, updated_at = now()
          WHERE promo IS NOT NULL AND status IN ${PENDING}
            AND ((promo->>'source_ref' = $1 AND promo->>'target_ref' = $2) OR (promo->>'source_ref' = $2 AND promo->>'target_ref' = $1))
        RETURNING id`, [a, b, BLOCKED_SLOT_ERROR]);
      canceled = rows.length;
    } else {
      await this.d.pool.query(
        `UPDATE promo_pairs SET blocked_at = NULL WHERE (source_ref = $1 AND target_ref = $2) OR (source_ref = $2 AND target_ref = $1)`, [a, b]);
    }
    this.d.invalidate();
    return { a, b, blocked, canceled };
  }
}
