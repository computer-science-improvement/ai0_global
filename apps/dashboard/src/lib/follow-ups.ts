// Spec 069 FR-001: a confirmation card may carry follow-ups (`payload.then`) that Apply runs one by one after the main
// action — the series bound to a new dataset, the rule, the skills switched off. The owner ticks what to run; the
// server records each outcome in `result.then`. The card's status is the main action's.

import type { Tone } from '../components/ui/primitives';

export interface FollowUp { key: string; kind: string; summary: string; ticked: boolean }
export interface FollowUpOutcome { key: string; ok: boolean; error?: string }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** The follow-ups of a card payload, in the order they run (malformed items are left out). */
export function followUpsOf(payload: unknown): FollowUp[] {
  const raw = obj(payload).then;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): FollowUp[] => {
    const o = obj(x);
    if (typeof o.key !== 'string' || !o.key || typeof o.kind !== 'string') return [];
    return [{ key: o.key, kind: o.kind, summary: typeof o.summary === 'string' && o.summary ? o.summary : o.key, ticked: o.ticked !== false }];
  });
}

/** The keys that start unticked (a soft suggestion the server marked `ticked: false`). */
export function initialSkip(items: readonly FollowUp[]): string[] {
  return items.filter((i) => !i.ticked).map((i) => i.key);
}

/** The Apply `input` for a card with follow-ups: always an explicit list, so the owner's choice (even "all") is what the server runs. */
export function followUpInput(items: readonly FollowUp[], skip: readonly string[]): { skip_then: string[] } | null {
  return items.length ? { skip_then: items.map((i) => i.key).filter((k) => skip.includes(k)) } : null;
}

/** What the server recorded for each follow-up of an applied card. */
export function outcomesOf(result: unknown): FollowUpOutcome[] {
  const raw = obj(result).then;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): FollowUpOutcome[] => {
    const o = obj(x);
    if (typeof o.key !== 'string') return [];
    return [{ key: o.key, ok: o.ok === true, ...(typeof o.error === 'string' ? { error: o.error } : {}) }];
  });
}

const NOT_RUN: Record<string, string> = {
  skipped: 'left unticked',
  not_ticked: 'not ticked',
  import_empty: 'not run: the import added nothing',
};

/** One outcome as a badge: done, left out, or failed with the reason. */
export function outcomeBadge(o: FollowUpOutcome | undefined): { tone: Tone; text: string; detail: string | null } {
  if (!o) return { tone: 'neutral', text: 'not run', detail: null };
  if (o.ok) return { tone: 'success', text: 'done', detail: null };
  const known = o.error ? NOT_RUN[o.error] : undefined;
  if (known) return { tone: o.error === 'import_empty' ? 'warning' : 'neutral', text: known, detail: null };
  return { tone: 'danger', text: 'failed', detail: o.error ?? null };
}

/** Short name of the kind of a follow-up, for the badge before its summary. */
export const FOLLOW_UP_LABEL: Record<string, string> = {
  series_change: 'Series', owner_rule: 'Rule', detach_skill: 'Skill off', attach_skill: 'Skill on', write_skill: 'Skill',
};

export const followUpLabel = (kind: string): string => FOLLOW_UP_LABEL[kind] ?? kind.replace(/_/g, ' ');
