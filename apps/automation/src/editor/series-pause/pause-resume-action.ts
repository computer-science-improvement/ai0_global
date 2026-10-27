import type { PendingActionsService } from '../agents/pending-actions';
import { normalizePlaybook } from '../network/series-edit';
import { isFail, type ScheduleService } from '../schedule/schedule.service';
import type { SeriesPauseActions } from './pause-actions';

/**
 * Wave fix 068 × 069: a card that changes the source of a series («бери з X») also lifts the pause the dead-series breaker
 * (spec 060/068) put on it, or on the channel's plain slots, as one of its follow-ups (`docs/import-bundle.ts`). Without
 * it the owner's new source never produced a post: the planner leaves a paused series out and does not plan a paused channel.
 * The handler is the dashboard's Resume (`SeriesPauseActions.resume`), so the pause keeps the same trace.
 */
export const SERIES_PAUSE_RESUME_KIND = 'series_pause_resume';

export interface PauseResumeDeps {
  pauses:    Pick<SeriesPauseActions, 'resume' | 'list'>;
  /** Used to check, before a series is resumed, that its change really reached the new dataset (the series item can fail on its own). */
  schedule?: Pick<ScheduleService, 'scopeById'>;
}

/**
 * `{ pause_id, key, channel_key }` resumes that pause. The card may wait up to a day for Apply, so the pause it names can be
 * resumed by hand meanwhile, and the breaker (or the owner) can open a new one on the same key: when `pause_id` is already
 * resumed, the open pause of the same channel and key is resumed instead — unless the owner made it (they paused it again after
 * the card was made, a new source is no reason to undo that), which fails with the way to do it by hand. Nothing open: reported as
 * already resumed. A pause that first opens after the card was proposed has no item (see the runbook).
 *
 * With `{ series, dataset, agent_id }` the series must now read `dataset` as its library source (the follow-up before it, the
 * series change, may have failed); otherwise it stays paused and the card says why. An unreadable scope does not block the
 * resume (the check is best effort).
 */
export function registerPauseResumeAction(actions: Pick<PendingActionsService, 'register'>, d: PauseResumeDeps): void {
  actions.register(SERIES_PAUSE_RESUME_KIND, async (p) => {
    const id = typeof p.pause_id === 'string' ? p.pause_id : '';
    if (!id) throw new Error('invalid: the resume item has no pause_id');
    if (d.schedule && typeof p.series === 'string' && typeof p.dataset === 'string' && typeof p.agent_id === 'string') {
      const sc = await d.schedule.scopeById(p.agent_id).catch(() => null);
      if (sc && !isFail(sc)) {
        const series = (sc.net.playbook ? normalizePlaybook(sc.net.playbook) : null)?.series.find((s) => s.name === p.series);
        if (!series || series.source?.kind !== 'library' || series.source.table !== p.dataset) {
          throw new Error(`not_resumed: series "${p.series}" does not read dataset "${p.dataset}" (its change did not apply), so it stays paused`);
        }
      }
    }
    const r = await d.pauses.resume(id, 'dashboard');
    if (!r.pause) throw new Error('pause_not_found: the pause is gone');
    if (r.changed) return { resumed: true, pause_id: id, outcome: r.outcome };

    // The pause this card named was lifted already. Is the same series (or channel) paused again?
    const key = typeof p.key === 'string' && p.key ? p.key : r.pause.key;
    const channelKey = typeof p.channel_key === 'string' && p.channel_key ? p.channel_key : r.pause.channelKey;
    const again = (await d.pauses.list(channelKey, 50)).find((x) => !x.resumedAt && x.key === key);
    if (!again) return { resumed: false, pause_id: id, outcome: 'already resumed' };
    if (again.cause === 'owner') {
      throw new Error(`not_resumed: "${again.label}" was paused again by the owner after this card was made; Resume it from Overview → Paused series`);
    }
    const n = await d.pauses.resume(again.id, 'dashboard');
    return { resumed: n.changed, pause_id: again.id, outcome: n.outcome };
  });
}
