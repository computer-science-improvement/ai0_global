import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import { parseResourceRef, type Platform } from '../agents/agent.types';
import type { ResourceListItem } from '../agents/resource-catalog';
import { BLOCKED_SLOT_ERROR, linkPairs, PENDING_SLOTS, recordMapEvent, unlinkPairs } from '../promo/promo-links';

export { BLOCKED_SLOT_ERROR };

/**
 * Spec 056 follow-up and 058: what the owner changes from the network map — which network a resource belongs to (one
 * resource or several at a time), and which resources may promote each other (links, several at a time). These are the
 * same changes the Connections page and the promo planner know; the map only offers them where the owner sees the relation.
 */

export interface MapActionDeps {
  pool:       Pick<Pool, 'query'>;
  catalog:    { list(): Promise<ResourceListItem[]> };
  /** Drops the cached snapshot so the next poll shows the change. */
  invalidate: () => void;
}

const GroupBody = z.object({ ref: z.string().min(3).max(300), groupId: z.string().uuid().nullable() }).strict();
const BlockBody = z.object({ a: z.string().min(3).max(300), b: z.string().min(3).max(300), blocked: z.boolean() }).strict();
/** Spec 058: at most this many resources per links call (add + remove). */
export const MAX_LINK_REFS = 30;
const RefList = z.array(z.string().min(3).max(300)).max(MAX_LINK_REFS).default([]);
const LinksBody = z.object({ ref: z.string().min(3).max(300), add: RefList, remove: RefList }).strict();
const MembersBody = z.object({ groupId: z.string().uuid(), add: RefList, remove: RefList }).strict();

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

/** Why a derived (copy) slot of a resource that left its network was skipped. */
export const LEFT_NETWORK_SLOT_ERROR = 'resource left the network';

export interface MemberResult { ref: string; ok: boolean; error?: string }

export class MapActions {
  constructor(private readonly d: MapActionDeps) {}

  private bad(error: string, details: string): never { throw new BadRequestException({ error, details }); }

  /**
   * Moves a resource into a network, or out of any (groupId null). One resource per platform per network. Leaving a
   * network also skips the copies (derived slots) that were still to go out to or from the resource.
   */
  async setGroup(body: unknown): Promise<{ ref: string; groupId: string | null; groupName: string | null; canceled: number }> {
    const p = GroupBody.safeParse(body ?? {});
    if (!p.success) this.bad('invalid_body', 'ref and groupId (a network id or null) are required');
    const { ref, groupId } = p.data;
    const r = await this.move((await this.d.catalog.list()).map((x) => ({ ...x })), ref, groupId);
    this.d.invalidate();
    return { ref, ...r };
  }

  /** One move, without touching the cache. `catalog` is the caller's view of the networks (updated here on success). */
  private async move(catalog: ResourceListItem[], ref: string, groupId: string | null): Promise<{ groupId: string | null; groupName: string | null; canceled: number }> {
    const parsed = parseResourceRef(ref);
    if (!parsed) this.bad('invalid_ref', `${ref} is not a resource`);
    const res = catalog.find((r) => r.ref === ref);
    if (!res) throw new NotFoundException({ error: 'resource_not_found', details: `${ref} is not one of your connected resources` });
    let groupName: string | null = null;
    if (groupId) {
      const { rows } = await this.d.pool.query(`SELECT name FROM meta_account_groups WHERE id = $1`, [groupId]);
      if (!rows[0]) throw new NotFoundException({ error: 'network_not_found', details: 'that network no longer exists' });
      groupName = rows[0].name as string;
    }
    if ((res.groupId ?? null) === groupId) return { groupId, groupName, canceled: 0 };
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
    let canceled = 0;
    if (res.groupId) { // the copy link is broken: nothing planned between it and its old network goes out
      canceled = await this.cancelCopies(ref);
      const old = await this.d.pool.query(`SELECT name FROM meta_account_groups WHERE id = $1`, [res.groupId]);
      await recordMapEvent(this.d.pool, { kind: 'network_left', ref, detail: (old.rows[0]?.name as string | undefined) ?? res.groupName ?? null });
    }
    res.groupId = groupId;
    res.groupName = groupName;
    return { groupId, groupName, canceled };
  }

  /** Derived slots (copies / adaptations) to or from a resource that have not gone out yet become skipped. */
  private async cancelCopies(ref: string): Promise<number> {
    const { rows } = await this.d.pool.query(
      `UPDATE editor_slots s SET status = 'skipped', error = $2, updated_at = now()
        WHERE s.derived_from_slot_id IS NOT NULL AND s.status IN ${PENDING_SLOTS}
          AND (COALESCE(s.resource_ref, 'telegram:' || s.channel_key) = $1
               OR (SELECT COALESCE(p.resource_ref, 'telegram:' || p.channel_key) FROM editor_slots p WHERE p.id = s.derived_from_slot_id) = $1)
      RETURNING s.id`, [ref, LEFT_NETWORK_SLOT_ERROR]);
    return rows.length;
  }

  /**
   * Spec 058: puts several resources in a network and takes several out, in one call. The same rules as `setGroup` per
   * resource (one per platform per network, tracked); the removals go first so a resource can be swapped for another of
   * its platform. Partial success: each ref has its own result and nothing is rolled back.
   */
  async setMembers(body: unknown): Promise<{ groupId: string; groupName: string; results: MemberResult[]; canceled: number }> {
    const p = MembersBody.safeParse(body ?? {});
    if (!p.success) this.bad('invalid_body', `groupId and add / remove lists (at most ${MAX_LINK_REFS} resources each) are required`);
    const { groupId } = p.data;
    const add = [...new Set(p.data.add)];
    const remove = [...new Set(p.data.remove)];
    if (add.some((r) => remove.includes(r))) this.bad('invalid_body', 'a resource cannot be both added and removed');
    const { rows } = await this.d.pool.query(`SELECT name FROM meta_account_groups WHERE id = $1`, [groupId]);
    if (!rows[0]) throw new NotFoundException({ error: 'network_not_found', details: 'that network no longer exists' });
    const groupName = rows[0].name as string;
    // our own copy: a successful move changes who holds a platform's place for the next one
    const catalog = (await this.d.catalog.list()).map((r) => ({ ...r }));
    const results: MemberResult[] = [];
    let canceled = 0;
    const run = async (ref: string, to: string | null) => {
      try {
        if (to === null && catalog.find((r) => r.ref === ref)?.groupId !== groupId) {
          throw new ConflictException({ error: 'not_a_member', details: `${ref} is not in «${groupName}»` });
        }
        const r = await this.move(catalog, ref, to);
        canceled += r.canceled;
        results.push({ ref, ok: true });
      } catch (err: any) {
        if (typeof err?.getStatus !== 'function') throw err;
        const res = err.getResponse?.();
        results.push({ ref, ok: false, error: String(res?.details ?? res?.message ?? err.message) });
      }
    };
    for (const ref of remove) await run(ref, null);
    for (const ref of add) await run(ref, groupId);
    this.d.invalidate();
    return { groupId, groupName, results, canceled };
  }

  /**
   * Spec 058: links `ref` with the resources in `add` and breaks its links with `remove` (promo links, both ways). A
   * broken link is stopped (the manager does not propose the pair until it is linked again) and the pair's promo slots
   * that have not gone out yet are skipped. Returns the resources whose link actually changed.
   */
  async setLinks(body: unknown): Promise<{ ref: string; linked: string[]; unlinked: string[]; canceled: number }> {
    const p = LinksBody.safeParse(body ?? {});
    if (!p.success) this.bad('invalid_body', `ref and add / remove lists (at most ${MAX_LINK_REFS} resources in all) are required`);
    const { ref } = p.data;
    const add = [...new Set(p.data.add)];
    const remove = [...new Set(p.data.remove)];
    if (add.length + remove.length > MAX_LINK_REFS) this.bad('too_many_refs', `at most ${MAX_LINK_REFS} resources per call`);
    if (add.some((r) => remove.includes(r))) this.bad('invalid_body', 'a resource cannot be both linked and unlinked');
    if ([ref, ...add, ...remove].some((r) => !parseResourceRef(r))) this.bad('invalid_ref', 'every ref must be a resource');
    if ([...add, ...remove].includes(ref)) this.bad('same_resource', 'a resource cannot be linked with itself');
    const known = new Set((await this.d.catalog.list()).map((r) => r.ref));
    for (const r of [ref, ...add, ...remove]) {
      if (!known.has(r)) throw new NotFoundException({ error: 'resource_not_found', details: `${r} is not one of your connected resources` });
    }
    const broken = await unlinkPairs(this.d.pool, ref, remove);
    const linked = await linkPairs(this.d.pool, ref, add);
    this.d.invalidate();
    return { ref, linked, unlinked: broken.changed, canceled: broken.canceled };
  }

  /**
   * Compatibility with the first map (spec 056): blocks or allows promos between two resources, both ways. Blocking is
   * an unlink (the line goes, the pair's pending promo slots are skipped); allowing links the pair again.
   */
  async setPairBlocked(body: unknown): Promise<{ a: string; b: string; blocked: boolean; canceled: number }> {
    const p = BlockBody.safeParse(body ?? {});
    if (!p.success) this.bad('invalid_body', 'a, b and blocked are required');
    const { a, b, blocked } = p.data;
    if (!parseResourceRef(a) || !parseResourceRef(b)) this.bad('invalid_ref', 'a and b must be resources');
    if (a === b) this.bad('same_resource', 'a and b are the same resource');
    let canceled = 0;
    if (blocked) canceled = (await unlinkPairs(this.d.pool, a, [b])).canceled;
    else await linkPairs(this.d.pool, a, [b]);
    this.d.invalidate();
    return { a, b, blocked, canceled };
  }
}
