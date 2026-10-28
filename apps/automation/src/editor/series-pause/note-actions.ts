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

/**
 * Spec 078 D5 gap #1: an action as the dashboard gets it. The stored `label` is the owner's Telegram text (Ukrainian) and
 * stays that for the cards; the dashboard is English, so the `label` here is made from the action's type. `target` is what
 * the key names (`parseNoteAction`), so the page does not parse keys.
 */
export type InboxActionTarget =
  | { pauseId: string }
  | { channelKey: string; seriesKey: string; label: string }
  | { ref: string };

export interface InboxActionView {
  key:    string;
  type:   ParsedNoteAction['type'];
  label:  string;
  target: InboxActionTarget;
}

/** A note with one pause action says "Pause series"; with two, each is named after its series (as the Telegram card does). */
const pauseLabel = (label: string, siblings: number) => (siblings > 1 ? `Pause: ${label.length > 24 ? `${label.slice(0, 23)}…` : label}` : 'Pause series');

/** One stored action in the dashboard's words; null for a key that is not ours. `pauses` = how many pause actions the note has. */
export function actionView(a: Pick<NoteAction, 'key'>, pauses = 1): InboxActionView | null {
  const p = parseNoteAction(a.key);
  if (!p) return null;
  switch (p.type) {
    case 'resume': return { key: a.key, type: 'resume', label: 'Resume', target: { pauseId: p.id } };
    case 'keep':   return { key: a.key, type: 'keep', label: 'Keep paused', target: { pauseId: p.id } };
    case 'pause':  return { key: a.key, type: 'pause', label: pauseLabel(p.label, pauses), target: { channelKey: p.channelKey, seriesKey: p.seriesKey, label: p.label } };
    case 'mute':   return { key: a.key, type: 'mute', label: 'Mute for 7 days', target: { ref: p.ref } };
  }
}

/** The actions of a stored note (`agent_inbox.actions`) for the dashboard: the usable ones, in their stored order. */
export function actionViews(stored: unknown): InboxActionView[] {
  const list = cleanActions(stored);
  const pauses = list.filter((a) => parseNoteAction(a.key)?.type === 'pause').length;
  return list.map((a) => actionView(a, pauses)).filter((v): v is InboxActionView => v !== null);
}
