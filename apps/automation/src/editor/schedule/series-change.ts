import { z } from 'zod';
import type { Playbook, Series } from '../network/playbook';
import { SeriesSchema } from '../network/playbook';
import { parseCadence, seriesContent, seriesSourceLabel } from '../network/series';
import { daysLabel } from './schedule-rules';

/**
 * Owner series edits (spec 023 FR-006/FR-007), pure parts: the next playbook body for an add / update /
 * pause / resume / remove, the human diff the card shows, and the staleness key. The owner's edit locks the
 * series; Unlock hands it back to the agent (origin stays).
 */

export const SERIES_OPS = ['add', 'update', 'pause', 'resume', 'remove'] as const;
export type SeriesOp = typeof SERIES_OPS[number];

/** The fields an owner sets (ownership fields are set by code). */
export const SeriesFields = z.object({
  name:         z.string().min(3).max(80),
  cadence:      SeriesSchema.shape.cadence.optional(),
  resource_ref: z.string().min(3).max(200).optional(),
  format:       z.string().min(2).max(30).optional(),
  brief:        z.string().min(10).max(600).optional(),
  active:       z.boolean().optional(),
  source:       SeriesSchema.shape.source.nullable(),
  source_mode:  z.enum(['suggested', 'required']).optional(),
});
export type SeriesFields = z.infer<typeof SeriesFields>;

/** English cadence for owners: "every day 19:00", "weekdays 20:30", "Mon, Thu 10:00, 18:00". */
export function cadenceLabel(cadence: string): string {
  const c = parseCadence(cadence);
  if (!c) return cadence;
  return `${daysLabel(c.days)} ${c.times.join(', ')}`;
}

/** The next body, or an English error. The changed series is locked as the owner's. */
export function applySeriesOp(active: Playbook, op: SeriesOp, f: SeriesFields): { body: Playbook; before: Series | null; after: Series | null } | { error: string; details?: string } {
  const cur = active.series.find((s) => s.name === f.name) ?? null;
  if (op === 'add') {
    if (cur) return { error: 'series_exists', details: `series "${f.name}" already exists` };
    const parsed = SeriesSchema.safeParse({ ...stripNull(f), origin: 'owner', locked: true, migrated_from: undefined });
    if (!parsed.success) return { error: 'invalid_series', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    return { body: { ...active, series: [...active.series, parsed.data] }, before: null, after: parsed.data };
  }
  if (!cur) return { error: 'series_not_found', details: `no series "${f.name}" in the active playbook` };
  if (op === 'remove') return { body: { ...active, series: active.series.filter((s) => s.name !== f.name) }, before: cur, after: null };
  let next: Series;
  if (op === 'pause' || op === 'resume') next = { ...cur, active: op === 'resume', locked: true };
  else {
    const { name: _n, ...patch } = f;
    const merged = { ...cur, ...stripNull(patch), ...(patch.source === null ? { source: undefined } : {}) };
    const parsed = SeriesSchema.safeParse({ ...merged, origin: cur.origin ?? 'agent', locked: true });
    if (!parsed.success) return { error: 'invalid_series', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    next = parsed.data;
  }
  return { body: { ...active, series: active.series.map((s) => (s.name === f.name ? next : s)) }, before: cur, after: next };
}

function stripNull<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

/** «"Рецепт дня": every day 19:00 → weekdays 20:30; format photo → carousel» — the card's human diff. */
export function seriesDiff(before: Series | null, after: Series | null): string {
  if (!before && after) {
    return `New series "${after.name}" on ${after.resource_ref}: ${cadenceLabel(after.cadence)} · ${after.format}${after.source ? ` · source ${seriesSourceLabel(after.source)}${after.source_mode === 'required' ? ' (required)' : ''}` : ''}`;
  }
  if (before && !after) return `Remove series "${before.name}" (${cadenceLabel(before.cadence)} on ${before.resource_ref})`;
  if (!before || !after) return '';
  const parts: string[] = [];
  if (before.cadence !== after.cadence) parts.push(`${cadenceLabel(before.cadence)} → ${cadenceLabel(after.cadence)}`);
  if (before.resource_ref !== after.resource_ref) parts.push(`resource ${before.resource_ref} → ${after.resource_ref}`);
  if (before.format !== after.format) parts.push(`format ${before.format} → ${after.format}`);
  if ((before.active !== false) !== (after.active !== false)) parts.push(after.active === false ? 'paused' : 'resumed');
  const sl = (s: Series) => (s.source ? seriesSourceLabel(s.source) : 'none');
  if (sl(before) !== sl(after)) parts.push(`source ${sl(before)} → ${sl(after)}`);
  if ((before.source_mode ?? 'suggested') !== (after.source_mode ?? 'suggested')) parts.push(`source ${after.source_mode ?? 'suggested'}`);
  if (before.brief !== after.brief) parts.push('new brief');
  if (!before.locked && after.locked && !parts.length) parts.push('locked by the owner');
  return `"${after.name}": ${parts.join('; ') || 'no change'}`;
}

/** The staleness key of a series (null = absent): a card applies only while it is unchanged. */
export function seriesKey(s: Series | null | undefined): string | null {
  return s ? `${seriesContent(s)}|${s.locked ? 'L' : ''}` : null;
}
