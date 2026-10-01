// schedule-time-zone.ts — the one time zone every strategy cron is evaluated in.
//
// Binding schedules are written in owner (Kyiv) time — "0 19 * * *" means 19:00
// in Kyiv, which is also the zone digest dedup keys use (kyivDate). Without an
// explicit zone the cron lib used the process TZ, i.e. UTC in the Docker image,
// so every schedule fired 2–3 h late relative to what the owner wrote.
// Opt-in: set SCHEDULER_TZ=Europe/Kyiv to evaluate crons in owner time. Unset
// keeps the process TZ (UTC in Docker), i.e. the historical behaviour, so a
// deploy never silently shifts every existing schedule by 2–3 h.
import { CronJob } from 'cron';

export const SCHEDULE_TIME_ZONE: string | undefined = process.env.SCHEDULER_TZ || undefined;

/** A stopped CronJob evaluated in SCHEDULE_TIME_ZONE (also used to validate a
 *  cron expression and to compute next_run_at, so UI and scheduler agree). */
export function makeCronJob(schedule: string, onTick: () => void | Promise<void>): CronJob {
  return new CronJob(schedule, onTick, null, false, SCHEDULE_TIME_ZONE ?? null);
}
