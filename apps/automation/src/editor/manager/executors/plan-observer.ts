import type { Pool } from 'pg';

/** What verification reads from the day plans (spec 025 FR-010…FR-012). */
export interface ObservedSlot { ref: string; format: string; series: string | null; status: string }
export interface ObservedPlan { planDate: string; createdAt: Date; slots: ObservedSlot[] }

export interface PlanObserver {
  /**
   * Active day plans of an anchor channel (network plans live on the anchor): `after` — created after that
   * moment, oldest plan day first; `before` — plan days before that moment's date, newest first.
   */
  plans(anchorKey: string, o: { after?: Date; before?: Date; limit: number }): Promise<ObservedPlan[]>;
}

/** editor_plans / editor_slots (content slots only; a Telegram slot without resource_ref is on the anchor). */
export class SqlPlanObserver implements PlanObserver {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async plans(anchorKey: string, o: { after?: Date; before?: Date; limit: number }): Promise<ObservedPlan[]> {
    const { rows: plans } = o.after
      ? await this.pool.query(
        `SELECT id, plan_date::text AS plan_date, created_at FROM editor_plans
          WHERE channel_key = $1 AND status = 'active' AND created_at > $2 ORDER BY plan_date, created_at LIMIT $3`, [anchorKey, o.after, o.limit])
      : await this.pool.query(
        `SELECT id, plan_date::text AS plan_date, created_at FROM editor_plans
          WHERE channel_key = $1 AND status = 'active' AND plan_date < ($2::timestamptz AT TIME ZONE 'Europe/Kyiv')::date
          ORDER BY plan_date DESC LIMIT $3`, [anchorKey, o.before ?? new Date(), o.limit]);
    if (!plans.length) return [];
    const { rows: slots } = await this.pool.query(
      `SELECT plan_id, COALESCE(resource_ref, 'telegram:' || channel_key) AS ref, format, status,
              COALESCE(series_name, (SELECT substr(x, 8) FROM jsonb_array_elements_text(source_hints) x WHERE x LIKE 'series:%' LIMIT 1)) AS series
         FROM editor_slots WHERE plan_id = ANY($1::uuid[]) AND kind = 'content'`, [plans.map((p) => p.id)]);
    return plans.map((p) => ({
      planDate: p.plan_date, createdAt: p.created_at,
      slots: slots.filter((s) => s.plan_id === p.id).map((s) => ({ ref: s.ref, format: s.format, series: s.series ?? null, status: s.status })),
    }));
  }
}
