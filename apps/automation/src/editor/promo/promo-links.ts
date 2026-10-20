import type { Pool } from 'pg';
import { parseResourceRef } from '../agents/agent.types';

/**
 * Spec 058: the promo link of a pair of resources (`promo_pairs.linked_at`, both directions) and the owner's stop
 * (`blocked_at`, migration 089). The owner links and unlinks pairs on the network map; approving a promo directive for a
 * pair that is not linked yet links it. Shared by the map actions, the promo planner and the manager's directive tool.
 */

type Q = Pick<Pool, 'query'>;

/** Promo slots that have not gone out yet (an unlinked or blocked pair cancels them). */
export const PENDING_SLOTS = `('planned', 'awaiting_approval', 'approved')`;
/** Why a pending promo slot of a broken pair was skipped. */
export const BLOCKED_SLOT_ERROR = 'promo pair blocked by owner';
/** What the manager is told when it proposes a pair the owner stopped (Ukrainian, like the planner's other refusals). */
export const PAIR_BLOCKED_DETAILS = 'власник заблокував промо між цими ресурсами (карта мережі) — не пропонуй цю пару';

/** The two resources a cross_promo / repost directive is about: the one that posts and the one it points at. */
export function promoRefsOf(kind: string, params: Record<string, unknown>): { sourceRef: string; targetRef: string } | null {
  if (kind !== 'cross_promo' && kind !== 'repost') return null;
  const sourceRef = kind === 'repost' ? String(params.to_ref ?? '') : String(params.source_ref ?? '');
  const targetRef = kind === 'repost' ? String(params.post_ref ?? '').replace(/\/\d+$/, '') : String(params.target_ref ?? '');
  if (!parseResourceRef(sourceRef) || !parseResourceRef(targetRef) || sourceRef === targetRef) return null;
  return { sourceRef, targetRef };
}

/** Has the owner stopped promos between the two? */
export async function isPairBlocked(pool: Q, a: string, b: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM promo_pairs WHERE blocked_at IS NOT NULL AND ((source_ref = $1 AND target_ref = $2) OR (source_ref = $2 AND target_ref = $1)) LIMIT 1`, [a, b]);
  return rows.length > 0;
}

/** A line for the map's event feed (what the owner changed). Never throws: the feed is a nicety, not the change. */
export async function recordMapEvent(pool: Q, e: { kind: 'link_made' | 'link_broken' | 'network_left'; ref: string; otherRef?: string | null; detail?: string | null }): Promise<void> {
  try {
    await pool.query(`INSERT INTO map_link_events (kind, ref, other_ref, detail) VALUES ($1, $2, $3, $4)`, [e.kind, e.ref, e.otherRef ?? null, e.detail ?? null]);
  } catch (err: any) {
    if (err?.code !== '42P01') throw err; // an older database without the table
  }
}

/**
 * Links `ref` with each of `others` both ways (idempotent: an existing link keeps its date) and lifts the owner's stop.
 * Returns the refs whose pair was not linked before.
 */
export async function linkPairs(pool: Q, ref: string, others: string[]): Promise<string[]> {
  if (!others.length) return [];
  const before = await pool.query(
    `SELECT target_ref FROM promo_pairs WHERE source_ref = $1 AND target_ref = ANY($2::text[]) AND linked_at IS NOT NULL AND blocked_at IS NULL`, [ref, others]);
  const was = new Set(before.rows.map((r) => r.target_ref as string));
  await pool.query(
    `INSERT INTO promo_pairs (source_ref, target_ref, linked_at)
     SELECT a, b, now() FROM (SELECT $1::text AS a, unnest($2::text[]) AS b UNION ALL SELECT unnest($2::text[]), $1::text) t
     ON CONFLICT (source_ref, target_ref) DO UPDATE SET linked_at = COALESCE(promo_pairs.linked_at, now()), blocked_at = NULL`, [ref, others]);
  const fresh = others.filter((o) => !was.has(o));
  for (const o of fresh) await recordMapEvent(pool, { kind: 'link_made', ref, otherRef: o });
  return fresh;
}

/**
 * Breaks the link of `ref` with each of `others` both ways: linked_at cleared and blocked_at set (the manager does not
 * propose the pair until it is linked again), and the promo slots of the pair that have not gone out yet are skipped.
 * Returns the refs that were linked or not yet stopped, and how many slots were skipped.
 */
export async function unlinkPairs(pool: Q, ref: string, others: string[]): Promise<{ changed: string[]; canceled: number }> {
  if (!others.length) return { changed: [], canceled: 0 };
  const before = await pool.query(
    `SELECT target_ref FROM promo_pairs WHERE source_ref = $1 AND target_ref = ANY($2::text[]) AND blocked_at IS NOT NULL AND linked_at IS NULL`, [ref, others]);
  const was = new Set(before.rows.map((r) => r.target_ref as string));
  await pool.query(
    `INSERT INTO promo_pairs (source_ref, target_ref, blocked_at)
     SELECT a, b, now() FROM (SELECT $1::text AS a, unnest($2::text[]) AS b UNION ALL SELECT unnest($2::text[]), $1::text) t
     ON CONFLICT (source_ref, target_ref) DO UPDATE SET linked_at = NULL, blocked_at = COALESCE(promo_pairs.blocked_at, now())`, [ref, others]);
  const { rows } = await pool.query(
    `UPDATE editor_slots SET status = 'skipped', error = $3, updated_at = now()
      WHERE promo IS NOT NULL AND status IN ${PENDING_SLOTS}
        AND (promo->>'source_ref' = $1 AND promo->>'target_ref' = ANY($2::text[]) OR promo->>'target_ref' = $1 AND promo->>'source_ref' = ANY($2::text[]))
    RETURNING id`, [ref, others, BLOCKED_SLOT_ERROR]);
  const changed = others.filter((o) => !was.has(o));
  for (const o of changed) await recordMapEvent(pool, { kind: 'link_broken', ref, otherRef: o });
  return { changed, canceled: rows.length };
}
