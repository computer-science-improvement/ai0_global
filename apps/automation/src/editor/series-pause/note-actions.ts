/**
 * Spec 060 FR-004: the buttons an Inbox note's owner-bot card gets on top of Read / Open. A note carries them as
 * `{ key, label }` (stored in `agent_inbox.actions`, so the card made at post time and the card the sweep makes later
 * are the same); the callback data stays `oc:<card>:<button index>` and the key travels in the card's own buttons.
 * Keys: `resume:<pause id>`, `keep:<pause id>`, `pause:<json [channelKey, seriesKey, label]>`, `mute:<resource ref>`.
 * Labels are the owner's Telegram text (Ukrainian).
 */
export interface NoteAction { key: string; label: string; confirm?: string }

export type ParsedNoteAction =
  | { type: 'resume'; id: string }
  | { type: 'keep'; id: string }
  | { type: 'pause'; channelKey: string; seriesKey: string; label: string }
  | { type: 'mute'; ref: string };

/** A series the owner can pause from a silent-day card (the keys of `series_pauses`). */
export interface PauseTarget { channelKey: string; key: string; label: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The two buttons of a series-paused note. */
export function pausedActions(pauseId: string): NoteAction[] {
  return [
    { key: `resume:${pauseId}`, label: 'Відновити' },
    { key: `keep:${pauseId}`, label: 'Залишити на паузі' },
  ];
}

/** «Пауза серії» for a silent-day card: one button for one series, a named one each when there are two (more are not offered). */
export function pauseActions(targets: readonly PauseTarget[]): NoteAction[] {
  const seen = new Set<string>();
  const list = targets.filter((t) => !t.key.startsWith('resource:') && !seen.has(`${t.channelKey}|${t.key}`) && seen.add(`${t.channelKey}|${t.key}`)).slice(0, 2);
  return list.map((t) => ({
    key: `pause:${JSON.stringify([t.channelKey, t.key, t.label])}`,
    label: list.length === 1 ? 'Пауза серії' : `Пауза: ${t.label.length > 24 ? `${t.label.slice(0, 23)}…` : t.label}`,
  }));
}

/** «Заглушити на 7 днів» for a health card. */
export function muteAction(resourceRef: string): NoteAction {
  return { key: `mute:${resourceRef}`, label: 'Заглушити на 7 днів' };
}

export function parseNoteAction(key: string): ParsedNoteAction | null {
  const i = key.indexOf(':');
  if (i < 0) return null;
  const type = key.slice(0, i), rest = key.slice(i + 1);
  if ((type === 'resume' || type === 'keep') && UUID.test(rest)) return { type, id: rest };
  if (type === 'mute' && rest) return { type: 'mute', ref: rest };
  if (type === 'pause') {
    try {
      const v = JSON.parse(rest);
      if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string' && x) && !v[1].startsWith('resource:')) {
        return { type: 'pause', channelKey: v[0], seriesKey: v[1], label: v[2] };
      }
    } catch { /* not ours */ }
  }
  return null;
}

/** Whether a stored value (jsonb) is a usable list of actions. */
export function cleanActions(v: unknown): NoteAction[] {
  if (!Array.isArray(v)) return [];
  return v.filter((a): a is NoteAction => !!a && typeof a.key === 'string' && typeof a.label === 'string' && parseNoteAction(a.key) !== null);
}
