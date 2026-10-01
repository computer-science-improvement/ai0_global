// apps/automation/src/publishers/errors.ts

/**
 * Thrown by TelegramPublisher.publish() / publishPrompt() when the target
 * channel has `publish_paused = true`. Distinct from a generic Error so
 * upstream catch blocks (SchedulerService, strategy runners) can treat it
 * as a soft "skipped" outcome and record `strategy_runs.status = 'skipped'`
 * instead of polluting the run log with a stack trace.
 *
 * Forward fanout doesn't throw this — instead, TelegramPublisher.forward
 * just logs + returns the original message id, so a paused forward target
 * doesn't break the primary publish.
 */
export class ChannelPausedError extends Error {
  readonly channelId: string;
  constructor(channelId: string) {
    super(`Channel ${channelId} has publish_paused=true — refusing to publish.`);
    this.name      = 'ChannelPausedError';
    this.channelId = channelId;
  }
}

/** Type guard — preferable to `instanceof` across worker boundaries
 *  where prototype chains can be lost. */
export function isChannelPausedError(err: unknown): err is ChannelPausedError {
  return err instanceof Error && (err as Error).name === 'ChannelPausedError';
}

/**
 * Thrown by ContentStrategyRunner when a run did nothing on purpose before
 * touching the strategy — the channel's posting lock is held by another
 * in-flight strategy or its post-publish cooldown is active. Recorded as
 * `strategy_runs.status = 'skipped'` so the run log doesn't claim `ok` for
 * a tick that never ran.
 */
export class RunSkippedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RunSkippedError';
  }
}

export function isRunSkippedError(err: unknown): err is RunSkippedError {
  return err instanceof Error && (err as Error).name === 'RunSkippedError';
}

/** strategy_runs status for a run that threw: soft skips vs real failures. */
export function runOutcomeForError(err: unknown): 'skipped' | 'error' {
  return isChannelPausedError(err) || isRunSkippedError(err) ? 'skipped' : 'error';
}
