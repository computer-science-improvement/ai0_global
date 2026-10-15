/** Spec 039: pure helpers of the Configuration tab (filtering, the texts of values and errors). */
import type { SettingState } from '../api/settings';

/** Settings of a group (or all), matching a free-text query on label, key or help. */
export function filterSettings(list: SettingState[], o: { group?: string; query?: string }): SettingState[] {
  const q = (o.query ?? '').trim().toLowerCase();
  return list.filter((s) => (!o.group || s.group === o.group)
    && (!q || s.label.toLowerCase().includes(q) || s.key.toLowerCase().includes(q) || s.help.toLowerCase().includes(q)));
}

export const isOn = (s: SettingState, v: string | null): boolean => v !== null && v === (s.bool?.on ?? 'true');

/** How a value reads in the UI and the confirm dialog. null = the setting is unset. */
export function valueText(s: SettingState, v: string | null): string {
  if (s.type === 'secret') return v === null ? 'not set' : 'set';
  if (s.type === 'bool') return isOn(s, v ?? s.default) ? 'On' : 'Off';
  if (v === null || v === '') return s.default ? `default (${s.default})` : 'not set';
  return v;
}

/** The value in effect now, as text (the default when unset). */
export function currentText(s: SettingState): string {
  if (s.type === 'secret') return s.set ? 'set' : 'not set';
  return valueText(s, s.value);
}

/** The backend's `{message}` from an ApiError body, else the raw text. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const j = JSON.parse(raw) as { message?: unknown };
    if (typeof j.message === 'string') return j.message;
    if (Array.isArray(j.message)) return j.message.join('; ');
  } catch { /* not JSON */ }
  return raw;
}

/** Client-side check before Save (the server validates again). */
export function draftError(s: SettingState, draft: string): string | null {
  const v = draft.trim();
  if (!v) return 'Enter a value, or use Reset';
  if (s.type === 'int' || s.type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n) || (s.type === 'int' && !Number.isInteger(n))) return s.type === 'int' ? 'A whole number' : 'A number';
    if (s.min !== undefined && n < s.min) return `At least ${s.min}`;
    if (s.max !== undefined && n > s.max) return `At most ${s.max}`;
  }
  if (s.type === 'url' && !/^https?:\/\/\S+$/.test(v)) return 'An http(s) URL';
  if (s.type === 'secret' && /\s/.test(v)) return 'No spaces';
  return null;
}
