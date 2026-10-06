import { z } from 'zod';
import { parseResourceRef, Platform } from '../agents/agent.types';
import { CAPABILITIES, implementedFormats } from '../platform/capabilities';

import type { ChannelMode } from '../card';
import { isQuietHour } from '../roles/time';
import { scheduleChangeNeedsCard, SILENT_SHIFT_MAX_MINUTES } from '../approval/approval-policy';
import {
  CadenceSchema, cadenceChange, instancesOn, parseCadence, SERIES_ORIGINS, SERIES_SOURCE_MODES, seriesSourceErrors,
  SeriesSourceCatalog, seriesSourceLabel, SeriesSourceSchema,
} from './series';

export { CADENCE_RE } from './series';

const HOUR = z.number().int().min(0).max(23);

export const PlatformSectionSchema = z.object({
  resource_ref:   z.string().min(3).max(200),
  role:           z.string().min(3).max(120).describe('core | discovery | community | archive | funnel_to:<resource_ref>'),
  formats:        z.record(z.string(), z.number().min(0).max(1)).describe('Ваги форматів 0–1 (лише формати цієї платформи)'),
  per_day:        z.object({ min: z.number().int().min(0).max(24), max: z.number().int().min(0).max(24) }),
  best_hours:     z.array(HOUR).max(12).default([]),
  tone:           z.string().max(300).optional(),
  hashtag_policy: z.object({ vocab: z.array(z.string().min(1).max(40)).max(40).default([]), min: z.number().int().min(0).max(30).default(0), max: z.number().int().min(0).max(30).default(5) }).default({ vocab: [], min: 0, max: 5 }),
  link_policy:    z.string().max(200).optional(),
  cta:            z.string().max(200).optional(),
});
export type PlatformSection = z.infer<typeof PlatformSectionSchema>;

// Series v2 (spec 023 FR-002): several days and times, an optional source, ownership. Old bodies parse with defaults.
export const SeriesSchema = z.object({
  name:          z.string().min(3).max(80),
  cadence:       CadenceSchema.describe('daily@HH:MM[,HH:MM] або weekly:mon[,thu]@HH:MM[,…] (до 6 часів, час картки ресурсу)'),
  resource_ref:  z.string().min(3).max(200),
  format:        z.string().min(2).max(30),
  brief:         z.string().min(10).max(600),
  active:        z.boolean().default(true),
  source:        SeriesSourceSchema.optional().describe('Звідки брати матеріал: library | api | feed | network_highlights | free'),
  source_mode:   z.enum(SERIES_SOURCE_MODES).default('suggested').describe('suggested — джерело можна замінити з поясненням; required — лише воно'),
  /** Who created it. Set by code: an agent cannot claim owner or migration. */
  origin:        z.enum(SERIES_ORIGINS).default('agent'),
  /** Set by code when the owner creates or edits the series; agents get `series_locked`. */
  locked:        z.boolean().default(false),
  /** The strategy binding ext_id the series was migrated from (T6). */
  migrated_from: z.string().max(120).optional(),
});
export type Series = z.infer<typeof SeriesSchema>;

export const PlaybookSchema = z.object({
  platforms: z.array(PlatformSectionSchema).min(1).max(8),
  series:    z.array(SeriesSchema).max(20).default([]),
  pillars:   z.array(z.object({ name: z.string().min(2).max(80), share: z.number().min(0).max(100) })).max(12).default([]),
  rules:     z.array(z.string().min(3).max(300)).max(30).default([]),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

export interface NetworkResource { ref: string; platform: Platform }

/** Formats a section may name: the platform's implemented formats (Telegram: card formats). */
function allowedFormats(platform: Platform, telegramFormats: string[]): Set<string> {
  return new Set(platform === 'telegram' ? telegramFormats : implementedFormats(platform));
}

/** Extra context for the series v2 checks (spec 023 FR-002); without it those checks are skipped. */
export interface PlaybookCheckOptions {
  /** The card's quiet hours: no series time may fall into them. */
  quiet?:   { startHour: number; endHour: number };
  /** Library datasets and card feeds a series source may name (API names are always checked). */
  sources?: SeriesSourceCatalog | null;
}

/** Deterministic playbook checks (spec 020 FR-002). Errors are Ukrainian lines for the model. */
export function validatePlaybook(p: Playbook, resources: NetworkResource[], telegramFormats: string[], opts: PlaybookCheckOptions = {}): string[] {
  const errors: string[] = [];
  const byRef = new Map(resources.map((r) => [r.ref, r]));
  const seen = new Set<string>();
  for (const s of p.platforms) {
    const r = byRef.get(s.resource_ref);
    const label = `платформа ${s.resource_ref}`;
    if (!r) { errors.push(`${label}: ресурс не в цій мережі (є: ${resources.map((x) => x.ref).join(', ')})`); continue; }
    if (seen.has(s.resource_ref)) errors.push(`${label}: секція повторюється`);
    seen.add(s.resource_ref);
    const allowed = allowedFormats(r.platform, telegramFormats);
    const bad = Object.keys(s.formats).filter((f) => !allowed.has(f));
    if (bad.length) errors.push(`${label}: формати ${bad.join(', ')} недоступні; доступні: ${[...allowed].join(', ')}`);
    if (!Object.values(s.formats).some((w) => w > 0)) errors.push(`${label}: потрібен хоча б один формат з вагою > 0`);
    if (s.per_day.min > s.per_day.max) errors.push(`${label}: per_day.min > per_day.max`);
    if (r.platform !== 'telegram' && s.per_day.max > CAPABILITIES[r.platform].dailyApiCap) {
      errors.push(`${label}: per_day.max ${s.per_day.max} > ліміту API ${CAPABILITIES[r.platform].dailyApiCap}`);
    }
    const funnel = s.role.match(/^funnel_to:(.+)$/);
    if (funnel && !byRef.has(funnel[1])) errors.push(`${label}: funnel_to ${funnel[1]} — не ресурс мережі`);
    if (!funnel && !['core', 'discovery', 'community', 'archive'].includes(s.role)) errors.push(`${label}: роль ${s.role} — одна з core | discovery | community | archive | funnel_to:<ref>`);
    if (s.hashtag_policy.min > s.hashtag_policy.max) errors.push(`${label}: hashtag_policy.min > max`);
  }
  for (const se of p.series) {
    const r = byRef.get(se.resource_ref);
    if (!r) { errors.push(`серія «${se.name}»: ресурс ${se.resource_ref} не в мережі`); continue; }
    if (!allowedFormats(r.platform, telegramFormats).has(se.format)) errors.push(`серія «${se.name}»: формат ${se.format} недоступний для ${r.platform}`);
    if (!p.platforms.some((x) => x.resource_ref === se.resource_ref)) errors.push(`серія «${se.name}»: для ${se.resource_ref} немає секції платформи`);
    // Series v2 (spec 023 FR-002).
    const cad = parseCadence(se.cadence);
    if (opts.quiet && cad) {
      const bad = cad.times.filter((t) => isQuietHour(Number(t.slice(0, 2)), opts.quiet!.startHour, opts.quiet!.endHour));
      if (bad.length) errors.push(`серія «${se.name}»: час ${bad.join(', ')} у тихі години`);
    }
    errors.push(...seriesSourceErrors(se.name, se.source, opts.sources ?? null));
  }
  // Active series instances per day on a resource must fit its per_day.max.
  for (const sec of p.platforms) {
    const mine = p.series.filter((s) => s.active !== false && s.resource_ref === sec.resource_ref);
    if (!mine.length) continue;
    for (let wd = 0; wd < 7; wd++) {
      const n = mine.reduce((a, s) => a + (parseCadence(s.cadence) ? instancesOn(parseCadence(s.cadence)!, wd).length : 0), 0);
      if (n > sec.per_day.max) { errors.push(`${sec.resource_ref}: серій ${n} на день > per_day.max ${sec.per_day.max}`); break; }
    }
  }
  if (p.pillars.length) {
    const sum = p.pillars.reduce((a, x) => a + x.share, 0);
    if (sum < 95 || sum > 105) errors.push(`частки тем (pillars) мають давати 100 ± 5, зараз ${sum}`);
  }
  if (new Set(p.series.map((s) => s.name)).size !== p.series.length) errors.push('назви серій мають бути унікальні');
  return errors;
}

/**
 * Structural changes need the owner (D1): resources, roles, formats added or
 * removed, a large frequency change, series added/removed, topic pillars, rules.
 * Weights (±0.3), best hours, hashtags, tone, CTA and pausing a series apply at once.
 *
 * Series v2 (spec 023 FR-003, with spec 031): a series moved to another resource or format, other days or
 * another number of times, another kind of source or source mode is structural. A time shift of
 * ≤ 90 min on the same days and a source change within its kind are not — unless the resource is in
 * `approve` mode (`mode`), where every schedule change, pausing a series included, goes to the owner.
 * Without `mode` a time shift stays structural (the conservative default). Reasons are English: the owner
 * reads them in the Inbox.
 */
export function classifyPlaybookChange(prev: Playbook | null, next: Playbook, opts: { mode?: ChannelMode } = {}): { structural: boolean; reasons: string[] } {
  if (!prev) return { structural: true, reasons: ['first playbook version'] };
  const reasons: string[] = [];
  const pm = new Map(prev.platforms.map((s) => [s.resource_ref, s]));
  const nm = new Map(next.platforms.map((s) => [s.resource_ref, s]));
  for (const ref of new Set([...pm.keys(), ...nm.keys()])) {
    const a = pm.get(ref);
    const b = nm.get(ref);
    if (!a || !b) { reasons.push(`${a ? 'removed' : 'added'} resource ${ref}`); continue; }
    if (a.role !== b.role) reasons.push(`${ref}: role ${a.role} → ${b.role}`);
    const fa = Object.keys(a.formats).filter((f) => a.formats[f] > 0).sort().join(',');
    const fb = Object.keys(b.formats).filter((f) => b.formats[f] > 0).sort().join(',');
    if (fa !== fb) reasons.push(`${ref}: formats ${fa} → ${fb}`);
    for (const f of Object.keys(b.formats)) {
      if (a.formats[f] !== undefined && Math.abs(b.formats[f] - a.formats[f]) > 0.3001) reasons.push(`${ref}: weight of ${f} ${a.formats[f]} → ${b.formats[f]}`);
    }
    const big = (x: number, y: number) => (x === 0 ? y > 0 : Math.abs(y - x) / x >= 0.3);
    if (big(a.per_day.max, b.per_day.max) || big(a.per_day.min, b.per_day.min)) reasons.push(`${ref}: posts per day ${a.per_day.min}–${a.per_day.max} → ${b.per_day.min}–${b.per_day.max}`);
  }
  const sa = new Set(prev.series.map((s) => s.name));
  const sb = new Set(next.series.map((s) => s.name));
  for (const n of sb) if (!sa.has(n)) reasons.push(`new series "${n}"`);
  for (const n of sa) if (!sb.has(n)) reasons.push(`removed series "${n}"`);
  for (const s of next.series) {
    const o = prev.series.find((x) => x.name === s.name);
    if (o) reasons.push(...seriesChangeReasons(o, s, opts.mode));
  }
  if (prev.pillars.map((p) => p.name).sort().join('|') !== next.pillars.map((p) => p.name).sort().join('|')) reasons.push('topic pillars changed');
  if (prev.rules.join('\n') !== next.rules.join('\n')) reasons.push('rules changed');
  return { structural: reasons.length > 0, reasons };
}

/** The structural changes of one series (empty = it may apply at once). */
export function seriesChangeReasons(o: Series, s: Series, mode?: ChannelMode): string[] {
  const out: string[] = [];
  const label = `series "${s.name}"`;
  if (o.resource_ref !== s.resource_ref) out.push(`${label}: resource ${o.resource_ref} → ${s.resource_ref}`);
  if (o.format !== s.format) out.push(`${label}: format ${o.format} → ${s.format}`);
  const c = cadenceChange(o.cadence, s.cadence);
  if ('structural' in c) out.push(`${label}: schedule ${o.cadence} → ${s.cadence} (${c.structural})`);
  else if ('shiftMinutes' in c && (mode === undefined || c.shiftMinutes > SILENT_SHIFT_MAX_MINUTES || scheduleChangeNeedsCard(mode, c.shiftMinutes))) {
    out.push(`${label}: time ${o.cadence} → ${s.cadence} (shift ${c.shiftMinutes} min)`);
  }
  if ((o.source?.kind ?? 'none') !== (s.source?.kind ?? 'none')) out.push(`${label}: source ${o.source?.kind ?? 'none'} → ${s.source?.kind ?? 'none'}`);
  if ((o.source_mode ?? 'suggested') !== (s.source_mode ?? 'suggested')) out.push(`${label}: source mode ${o.source_mode ?? 'suggested'} → ${s.source_mode ?? 'suggested'}`);
  if (mode === 'approve' && (o.active !== false) !== (s.active !== false)) out.push(`${label}: ${s.active === false ? 'paused' : 'resumed'} (approval mode)`);
  return out;
}

/** The section of one resource as prompt text (platform executor, planner). */
export function renderSection(s: PlatformSection): string {
  return [
    `Роль: ${s.role}. Формати: ${Object.entries(s.formats).filter(([, w]) => w > 0).map(([f, w]) => `${f} ${w}`).join(', ')}.`,
    `Частота: ${s.per_day.min}–${s.per_day.max}/день${s.best_hours.length ? `, найкращі години ${s.best_hours.join(', ')}` : ''}.`,
    s.tone ? `Тон: ${s.tone}` : '',
    `Хештеги: ${s.hashtag_policy.min}–${s.hashtag_policy.max}${s.hashtag_policy.vocab.length ? ` зі словника ${s.hashtag_policy.vocab.map((h) => `#${h}`).join(' ')}` : ''}.`,
    s.link_policy ? `Посилання: ${s.link_policy}` : '',
    s.cta ? `Заклик: ${s.cta}` : '',
  ].filter(Boolean).join('\n');
}

export function renderPlaybook(p: Playbook): string {
  return [
    ...p.platforms.map((s) => `### ${s.resource_ref}\n${renderSection(s)}`),
    p.series.length ? `### Серії\n${p.series.map((s) => `- «${s.name}» ${s.cadence} → ${s.resource_ref} (${s.format})${s.active === false ? ' [пауза]' : ''}${s.locked ? ' [власник]' : ''}${s.source ? ` · джерело ${seriesSourceLabel(s.source)}${s.source_mode === 'required' ? ' (обовʼязкове)' : ''}` : ''}: ${s.brief}`).join('\n')}` : '',
    p.pillars.length ? `### Теми\n${p.pillars.map((x) => `- ${x.name}: ${x.share}%`).join('\n')}` : '',
    p.rules.length ? `### Правила\n${p.rules.map((r) => `- ${r}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Series instances due on a date (weekday 0 = Sunday): one {series, time} per time of the cadence (series v2). */
export function seriesDue(p: Playbook, weekday: number): Array<{ series: Series; time: string }> {
  return p.series.filter((s) => s.active !== false).flatMap((s) => {
    const c = parseCadence(s.cadence);
    return c ? instancesOn(c, weekday).map((time) => ({ series: s, time })) : [];
  });
}

export function platformOfRef(ref: string): Platform | null {
  return parseResourceRef(ref)?.platform ?? null;
}
