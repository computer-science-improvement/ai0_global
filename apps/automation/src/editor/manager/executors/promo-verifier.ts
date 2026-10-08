import type { Pool } from 'pg';
import type { Directive, DirectiveKind } from '../directives.repository';
import type { DirectiveVerifier, VerifyResult } from './types';

/**
 * Verification of `cross_promo` / `repost` (spec 025 FR-015): PromoPlanner applies them (a reserved promo slot
 * with `promo.directive_id`); they are verified when that slot is `published` or `shadowed`.
 */

/** A promo slot that never got a status this long after applied_at is not followed (the promo window is ≤ 7 days). */
export const PROMO_VERIFY_GIVE_UP_MS = 9 * 86_400_000;

export function promoVerifier(pool: Pick<Pool, 'query'>, kind: Extract<DirectiveKind, 'cross_promo' | 'repost'>, now: () => Date = () => new Date()): DirectiveVerifier {
  return {
    kind,
    async verify(dir: Directive): Promise<VerifyResult> {
      const { rows } = await pool.query(
        `SELECT id, status, scheduled_at FROM editor_slots WHERE promo->>'directive_id' = $1 ORDER BY created_at DESC`, [dir.id]);
      const detail = { slots: rows.map((r) => ({ id: r.id, status: r.status })) };
      if (rows.some((r) => r.status === 'published' || r.status === 'shadowed')) return { verified: true, adherence: 'followed', detail };
      const open = rows.some((r) => !['skipped', 'failed'].includes(r.status));
      const stale = dir.appliedAt && now().getTime() - dir.appliedAt.getTime() > PROMO_VERIFY_GIVE_UP_MS;
      if (rows.length && !open) return { verified: false, adherence: 'not_followed', detail };
      if (stale) return { verified: false, adherence: 'not_followed', detail: { ...detail, reason: rows.length ? 'the promo slot never ran' : 'no promo slot' } };
      return { pending: true, detail };
    },
  };
}
