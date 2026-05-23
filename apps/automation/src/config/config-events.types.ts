/**
 * Redis pub/sub channel name for config-mutation events. Subscribers
 * (e.g. ConfigCacheService) listen on this channel and reload their
 * in-memory snapshot when a message arrives.
 */
export const CONFIG_CHANGED_CHANNEL = 'config:changed';

/**
 * Discriminator for what kind of config object changed.
 * Subscribers may use this to scope reloads later — for now we just
 * reload everything on any change.
 */
export type ConfigChangedKind =
  | 'bot'
  | 'channel'
  | 'strategy_binding'
  | 'forward_route';

export interface ConfigChangedEvent {
  /** Which type of config row was mutated */
  kind: ConfigChangedKind;
  /** UUID of the affected row, when known */
  id?: string | null;
  /** ISO timestamp of when the change was published */
  at: string;
  /** Optional human-readable hint for log lines */
  reason?: string;
}
