import type { EditorCard } from '../card';
import { isPlaceholderPlan, type EditorPlansRepository } from '../repo/editor-plans.repository';
import type { EditorRunnerService } from '../roles/editor-runner.service';
import { localDate } from '../roles/time';
import { shiftDate } from '../schedule/schedule-rules';

/**
 * Spec 073 FR-006 (A26): what Start plans. A launched channel goes into approval mode, which writes a day ahead, so Start
 * plans today and tomorrow (the scheduler's `maybePlanAhead` would only plan tomorrow at the batch hour in the evening).
 *   - today: `runPlanner(card)`; an error is logged and does not stop tomorrow;
 *   - tomorrow (`shiftDate` on the card zone's local date, so DST cannot move it): left alone when it already has a plan that
 *     is not a placeholder, as `maybePlanAhead` does; otherwise `runPlanner(card, { planDate })`.
 * The two runs are sequential. Never throws.
 */
export interface PlanAheadDeps {
  runner: Pick<EditorRunnerService, 'runPlanner'>;
  plans:  Pick<EditorPlansRepository, 'getActivePlan'>;
  now?:   () => Date;
  log?:   (msg: string) => void;
}

export async function planTodayAndTomorrow(d: PlanAheadDeps, card: EditorCard): Promise<void> {
  try {
    await d.runner.runPlanner(card);
  } catch (err: any) {
    d.log?.(`launch plan of ${card.channelKey} for today failed: ${err?.message ?? err}`);
  }
  const tomorrow = shiftDate(localDate((d.now ?? (() => new Date()))(), card.timezone), 1);
  try {
    const active = await d.plans.getActivePlan(card.channelKey, tomorrow);
    if (active && !isPlaceholderPlan(active.rationale)) return;
    await d.runner.runPlanner(card, { planDate: tomorrow });
  } catch (err: any) {
    d.log?.(`launch plan of ${card.channelKey} for ${tomorrow} failed: ${err?.message ?? err}`);
  }
}
