// apps/automation/src/publishers/errors.ts

/**
 * Thrown by TelegramPublisher.publish() / publishPrompt() when the target
 * channel has `publish_paused = true`. Distinct from a generic Error so
 * callers can treat it as a soft "skipped" outcome instead of a failure.
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
