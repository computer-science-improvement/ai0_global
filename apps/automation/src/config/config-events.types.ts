// apps/automation/src/config/config-events.types.ts
export type ConfigChangedKind = 'bot' | 'channel' | 'strategy' | 'forward-route' | 'telegraph' | 'all';

export interface ConfigChangedEvent {
  kind: ConfigChangedKind;
  id?:  string;
  at:   string;          // ISO timestamp
}

export const CONFIG_CHANGED_CHANNEL = 'config:changed';
