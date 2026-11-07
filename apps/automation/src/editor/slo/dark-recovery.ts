/**
 * Spec 091 FR-005: a forced planner run for a dark channel, with one evergreen slot when the planner plans nothing.
 * Implements `DarkRecovery` (types.ts). The caps (once per SLO_DARK_HOURS, SLO_MAX_RECOVERY_RUNS_PER_DAY), the
 * `recovery_runs` counter, the decision row and the 72 h note belong to the controller; this class only recovers.
 */
import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import { hostOf } from '../net/host-failures';
import { evergreenDarkMax } from '../silent/evergreen';
import type { RecoveryLadder } from './recovery-ladder';
import type { DarkContext, DarkRecovery, DarkRecoveryResult, SlotInserter, SloSlotMark } from './types';

export const RECENT_DAYS = 14;
const TOP = 5;

export interface RecentPublished { formats: string[]; hosts: string[] }

/** The formats and source hosts the channel published with in the last 14 days, most used first (at most 5 each). */
export async function recentPublished(pool: Pick<Pool, 'query'>, channelKey: string, now: Date): Promise<RecentPublished> {
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
  const { rows } = await pool.query(
    `SELECT format, post_spec->'source'->>'url' AS url FROM editor_slots
      WHERE channel_key = $1 AND kind = 'content' AND resource_ref IS NULL AND status IN ('published','shadowed')
        AND scheduled_at >= $2 AND scheduled_at <= $3`, [channelKey, since, now]);
  const count = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k]) => k);
  };
  return {
    formats: count(rows.map((r: any) => String(r.format ?? '')).filter(Boolean)),
    hosts: count(rows.map((r: any) => (r.url ? hostOf(String(r.url)) : null)).filter((h): h is string => !!h)),
  };
}

/** The extra context of the recovery planner run (pure). */
export function recoveryContext(ctx: Pick<DarkContext, 'darkSince' | 'lastSkips' | 'target'>, recent: RecentPublished, now: Date): string {
  const hours = Math.max(1, Math.round((now.getTime() - ctx.darkSince.getTime()) / 3_600_000));
  const skips = ctx.lastSkips.slice(0, 5);
  return [
    '## Recovery run (the channel is dark)',
    `The channel has had no post for about ${hours} h (since ${ctx.darkSince.toISOString()}). Daily target: ${ctx.target}.`,
    skips.length ? `Last skip reasons, newest first:\n${skips.map((s) => `- ${s}`).join('\n')}` : 'No recent skip reasons are recorded.',
    `Formats that published in the last ${RECENT_DAYS} days: ${recent.formats.join(', ') || 'none'}. Source hosts that published: ${recent.hosts.join(', ') || 'none'}.`,
    'Plan at least the target; prefer formats and sources that published in the last 14 days.',
  ].join('\n');
}

export interface DarkRecoveryDeps {
  /** Clears the channel's in-memory plannerTries and the persisted try counter (spec 073 FR-005). */
  resetPlannerTries: (channelKey: string) => Promise<void> | void;
  /** One forced planner run with extra context; resolves to the slots planned for today. May throw. */
  runPlanner:        (card: EditorCard, extraContext: string, now: Date) => Promise<number>;
  inserter:          SlotInserter;
  ladder:            Pick<RecoveryLadder, 'evergreenSpec' | 'evergreenRoom'>;
  /** For the 14-day published formats and hosts. */
  pool:              Pick<Pool, 'query'>;
  env:               (k: string) => string | undefined;
  log:               (m: string) => void;
}

export class DarkRecoveryService implements DarkRecovery {
  constructor(private readonly d: DarkRecoveryDeps) {}

  async recover(card: EditorCard, ctx: DarkContext, now: Date): Promise<DarkRecoveryResult> {
    try { await this.d.resetPlannerTries(card.channelKey); } catch (e: any) { this.d.log(`dark recovery ${card.channelKey}: tries not reset: ${e?.message ?? e}`); }

    const recent = await recentPublished(this.d.pool, card.channelKey, now).catch(() => ({ formats: [], hosts: [] }) as RecentPublished);
    let planned = 0;
    let plannerError: string | null = null;
    try {
      planned = Math.max(0, Number(await this.d.runPlanner(card, recoveryContext(ctx, recent, now), now)) || 0);
    } catch (e: any) {
      plannerError = String(e?.message ?? e).slice(0, 160);
      this.d.log(`dark recovery ${card.channelKey}: planner failed: ${plannerError}`);
    }
    if (planned > 0) return { planned, evergreenSlotId: null, summary: `Recovery planner run planned ${planned} slot${planned === 1 ? '' : 's'} for today.` };

    const why = plannerError ? `the planner failed (${plannerError})` : 'the planner planned nothing for today';
    if (evergreenDarkMax(this.d.env) <= 0) return { planned: 0, evergreenSlotId: null, summary: `Recovery: ${why}; evergreen posts are off while dark (SLO_EVERGREEN_DARK_MAX=0).` };
    const room = await this.d.ladder.evergreenRoom(card, now).catch(() => null);
    if (room && room.used >= room.cap) return { planned: 0, evergreenSlotId: null, summary: `Recovery: ${why}; the evergreen cap is used (${room.used}/${room.cap}).` };

    const mark: SloSlotMark = { replaces: null, rung: 'evergreen', cause: null, depth: 1 };
    const id = await this.d.inserter.insert(card, this.d.ladder.evergreenSpec(card), mark, now).catch((e) => { this.d.log(`dark recovery ${card.channelKey}: evergreen not inserted: ${e?.message ?? e}`); return null; });
    return {
      planned: 0, evergreenSlotId: id,
      summary: id ? `Recovery: ${why}; one evergreen slot was added.` : `Recovery: ${why}; no evergreen slot fit into the rest of the day.`,
    };
  }
}
