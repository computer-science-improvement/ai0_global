import type { Platform } from '../agents/agent.types';
import { parseResourceRef } from '../agents/agent.types';
import { CAPABILITIES, implementedFormats } from '../platform/capabilities';
import type { Playbook, PlatformSection, Series } from '../network/playbook';
import { PlaybookSchema, SeriesSchema, validatePlaybook } from '../network/playbook';
import { instancesOn, parseCadence, seriesSourceLabel, type SeriesSourceCatalog } from '../network/series';
import { cronToCadence } from './cron-cadence';
import { mapType } from './type-mapping';

/**
 * The binding migration proposal (spec 023 FR-011), pure: every enabled strategy binding of a channel's
 * network → a migrated series, a frequency hint or an "unmappable" line with its reason. The playbook draft is
 * the active playbook (or a minimal one from the card) plus the migrated series (origin `migration`, unlocked).
 */

export interface MigrationBinding {
  id:          string;
  ext_id:      string;
  type:        string;
  schedule:    string;
  params:      Record<string, unknown>;
  platform:    string;
  /** `telegram:<key>` / `<platform>:<account id>`; null when the destination no longer resolves. */
  resourceRef: string | null;
}

export interface ProposalResource { ref: string; platform: Platform; tz: string; quiet: { start: number; end: number } }

export interface ProposalCtx {
  channelKey:      string;
  agent:           { id: string; handle: string } | null;
  networkMode:     'single' | 'independent' | 'legacy_duplicate';
  /** Usable resources of the network (the agent plans these). */
  resources:       ProposalResource[];
  /** Every resource of the group, usable or not. */
  allRefs:         string[];
  telegramFormats: string[];
  card:            { postsPerDayMin: number; postsPerDayMax: number; formats: Record<string, number> };
  active:          Playbook | null;
  activeVersion:   number | null;
  catalog:         SeriesSourceCatalog | null;
  /** Posts a binding published in the last 14 days (null = unknown). */
  history:         Map<string, number | null>;
  cronTz:          string;
  now:             Date;
}

export type BindingOutcome = {
  ext_id:       string;
  type:         string;
  resource_ref: string | null;
  schedule:     string;
  warnings:     string[];
} & (
  | { outcome: 'series'; series: string; cadence: string; format: string; source: string | null; source_mode: 'suggested' | 'required'; per_day: number }
  | { outcome: 'frequency'; per_day: number; format: string; source: string | null; reason: string }
  | { outcome: 'unmappable'; reason: string }
);

export interface MigrationProposal {
  channel_key:     string;
  agent:           { id: string; handle: string } | null;
  active_version:  number | null;
  bindings:        BindingOutcome[];
  /** The playbook draft; null when nothing maps (or there is no agent). */
  body:            Playbook | null;
  rationale:       string;
  /** Validation errors of the draft (English); a draft with errors is never written. */
  errors:          string[];
  mapped:          number;
  total:           number;
}

const API_CAP = (p: Platform): number => (p === 'telegram' ? 24 : Math.min(24, CAPABILITIES[p].dailyApiCap));

function uniqueName(base: string, taken: Set<string>): string {
  const b = base.slice(0, 80);
  if (b.length >= 3 && !taken.has(b)) return b;
  for (let i = 2; i < 100; i++) {
    const n = `${b.slice(0, 75)} (${i})`;
    if (!taken.has(n)) return n;
  }
  return `${b.slice(0, 70)} ${Date.now() % 1e6}`;
}

/** A minimal playbook from the card: the anchor's section with the card's formats and posts per day. */
export function minimalPlaybook(ctx: Pick<ProposalCtx, 'channelKey' | 'card' | 'telegramFormats'>): Playbook {
  const formats = Object.fromEntries(Object.entries(ctx.card.formats).filter(([f, w]) => Number(w) > 0 && ctx.telegramFormats.includes(f)).map(([f, w]) => [f, Math.min(1, Number(w))]));
  return PlaybookSchema.parse({
    platforms: [{
      resource_ref: `telegram:${ctx.channelKey}`, role: 'core',
      formats: Object.keys(formats).length ? formats : { text: 1 },
      per_day: { min: Math.min(ctx.card.postsPerDayMin, ctx.card.postsPerDayMax), max: ctx.card.postsPerDayMax },
    }],
  });
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function buildProposal(bindings: MigrationBinding[], ctx: ProposalCtx): MigrationProposal {
  const outcomes: BindingOutcome[] = [];
  const base: Playbook = ctx.active ? clone(ctx.active) : minimalPlaybook(ctx);
  const body: Playbook = { ...base, platforms: base.platforms.map((p) => ({ ...p, formats: { ...p.formats }, per_day: { ...p.per_day } })), series: [...base.series], rules: [...base.rules] };
  const usable = new Map(ctx.resources.map((r) => [r.ref, r]));
  const taken = new Set(body.series.map((s) => s.name));
  const migrated = new Set(body.series.map((s) => s.migrated_from).filter(Boolean) as string[]);
  const notes: string[] = [];
  const sectionNotes: string[] = [];
  const hints = new Map<string, number>();

  const section = (r: ProposalResource, format: string): PlatformSection => {
    let s = body.platforms.find((p) => p.resource_ref === r.ref);
    if (!s) {
      s = { resource_ref: r.ref, role: r.ref === `telegram:${ctx.channelKey}` ? 'core' : 'discovery', formats: { [format]: 1 }, per_day: { min: 0, max: 1 }, best_hours: [], hashtag_policy: { vocab: [], min: 0, max: 5 } };
      body.platforms.push(s);
      sectionNotes.push(`added a section for ${r.ref}`);
    }
    if (!(Number(s.formats[format]) > 0)) {
      s.formats[format] = 0.5;
      sectionNotes.push(`${r.ref}: format ${format} weight 0.5`);
    }
    return s;
  };

  for (const b of [...bindings].sort((x, y) => x.ext_id.localeCompare(y.ext_id))) {
    const head = { ext_id: b.ext_id, type: b.type, resource_ref: b.resourceRef, schedule: b.schedule };
    const fail = (reason: string) => outcomes.push({ ...head, warnings: [], outcome: 'unmappable', reason });
    if (!b.resourceRef) { fail('the binding has no resolvable destination'); continue; }
    if (migrated.has(b.ext_id)) { fail('already migrated: a series names this binding (migrated_from)'); continue; }
    const r = usable.get(b.resourceRef);
    const platform = parseResourceRef(b.resourceRef)?.platform ?? null;
    if (!r || !platform) {
      fail(ctx.allRefs.includes(b.resourceRef) ? `${b.resourceRef} is not usable by the agent (no access or token invalid)` : `${b.resourceRef} is not part of this network`);
      continue;
    }
    if (platform !== 'telegram' && ctx.networkMode === 'legacy_duplicate') {
      fail(`${b.resourceRef} gets the auto-duplicated Telegram posts in this network (legacy_duplicate); switch the network to independent first`);
      continue;
    }
    const formats = platform === 'telegram' ? ctx.telegramFormats : implementedFormats(platform);
    const t = mapType(b.type, b.params ?? {}, platform, formats, ctx.catalog);
    if (!t.ok) { fail(t.reason); continue; }
    const c = cronToCadence({ schedule: b.schedule, retryLoop: t.retryLoop, cronTz: ctx.cronTz, targetTz: r.tz, quiet: r.quiet, now: ctx.now });
    if (c.kind === 'unmappable') { fail(c.reason); continue; }
    const srcLabel = t.source ? seriesSourceLabel(t.source) : null;
    if (c.kind === 'frequency') {
      const hist = ctx.history.get(b.ext_id);
      const perDay = hist != null && hist > 0 ? Math.max(1, Math.round(hist / 14)) : Math.max(1, Math.round(c.perDay));
      const warnings = [...t.warnings, ...c.warnings, hist != null && hist > 0 ? `${hist} posts in the last 14 days` : 'no published posts in 14 days; the hint comes from the cron'];
      section(r, t.format);
      hints.set(r.ref, (hints.get(r.ref) ?? 0) + perDay);
      notes.push(`Замість стратегії ${b.ext_id} (${b.type}): близько ${perDay} пост(ів) на день у ${r.ref}, формат ${t.format}${srcLabel ? `, джерело ${srcLabel}` : ''}, без фіксованого часу.`.slice(0, 300));
      outcomes.push({ ...head, warnings, outcome: 'frequency', per_day: perDay, format: t.format, source: srcLabel, reason: c.reason });
      continue;
    }
    const name = uniqueName(b.ext_id, taken);
    taken.add(name);
    const parsed = SeriesSchema.safeParse({
      name, cadence: c.cadence, resource_ref: r.ref, format: t.format, brief: t.brief, active: true,
      ...(t.source ? { source: t.source } : {}), source_mode: t.mode, origin: 'migration', locked: false, migrated_from: b.ext_id.slice(0, 120),
    });
    if (!parsed.success) { fail(`series rejected: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`); continue; }
    section(r, t.format);
    body.series.push(parsed.data);
    outcomes.push({ ...head, warnings: [...t.warnings, ...c.warnings], outcome: 'series', series: name, cadence: c.cadence, format: t.format, source: srcLabel, source_mode: t.mode, per_day: c.perDay });
  }

  // Posts per day: the series instances of the busiest weekday (validatePlaybook) plus the frequency hints.
  for (const s of body.platforms) {
    const r = usable.get(s.resource_ref);
    if (!r) continue;
    const seriesMax = Math.max(...[0, 1, 2, 3, 4, 5, 6].map((wd) => body.series
      .filter((x) => x.active !== false && x.resource_ref === s.resource_ref)
      .reduce((a, x) => a + (parseCadence(x.cadence) ? instancesOn(parseCadence(x.cadence)!, wd).length : 0), 0)));
    const need = Math.min(API_CAP(r.platform), seriesMax + Math.round(hints.get(s.resource_ref) ?? 0));
    if (need > s.per_day.max) {
      sectionNotes.push(`${s.resource_ref}: posts per day max ${s.per_day.max} → ${need}`);
      s.per_day.max = need;
    }
  }

  for (const n of notes) if (body.rules.length < 30 && !body.rules.includes(n)) body.rules.push(n);
  const mapped = outcomes.filter((o) => o.outcome !== 'unmappable').length;
  const changed = mapped > 0;
  const errors = changed && ctx.agent
    ? validatePlaybook(body, ctx.resources.map((r) => ({ ref: r.ref, platform: r.platform })), ctx.telegramFormats, { sources: ctx.catalog })
    : [];
  const final = changed && ctx.agent ? PlaybookSchema.safeParse(body) : null;
  if (final && !final.success) errors.push(...final.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  return {
    channel_key: ctx.channelKey, agent: ctx.agent, active_version: ctx.activeVersion, bindings: outcomes,
    body: final?.success ? final.data : null,
    rationale: rationaleOf(ctx, outcomes, sectionNotes),
    errors, mapped, total: outcomes.length,
  };
}

/** The draft's rationale: a per-binding table and the unmappable list (English, the owner reads it). */
export function rationaleOf(ctx: Pick<ProposalCtx, 'channelKey'>, outcomes: BindingOutcome[], sectionNotes: string[] = []): string {
  const mapped = outcomes.filter((o) => o.outcome !== 'unmappable');
  const lines = [`Strategy migration for ${ctx.channelKey}: ${mapped.length} of ${outcomes.length} enabled binding(s) mapped. The bindings keep publishing until the cutover.`];
  const series = outcomes.filter((o): o is Extract<BindingOutcome, { outcome: 'series' }> => o.outcome === 'series');
  if (series.length) {
    lines.push('', 'Series:');
    for (const o of series) {
      lines.push(`- ${o.ext_id}: ${o.schedule} → ${o.cadence} · ${o.type} → ${o.format}${o.source ? ` / ${o.source}${o.source_mode === 'required' ? ' (required)' : ''}` : ' / no source'}${o.warnings.length ? ` · ${o.warnings.join('; ')}` : ''}`);
    }
  }
  const freq = outcomes.filter((o): o is Extract<BindingOutcome, { outcome: 'frequency' }> => o.outcome === 'frequency');
  if (freq.length) {
    lines.push('', 'Frequency hints (no fixed times):');
    for (const o of freq) lines.push(`- ${o.ext_id}: ${o.schedule} → about ${o.per_day}/day (${o.reason}) · ${o.type} → ${o.format}${o.source ? ` / ${o.source}` : ''}${o.warnings.length ? ` · ${o.warnings.join('; ')}` : ''}`);
  }
  const un = outcomes.filter((o): o is Extract<BindingOutcome, { outcome: 'unmappable' }> => o.outcome === 'unmappable');
  if (un.length) {
    lines.push('', 'Unmappable (left as they are):');
    for (const o of un) lines.push(`- ${o.ext_id} (${o.type}, ${o.schedule}): ${o.reason}`);
  }
  if (sectionNotes.length) lines.push('', `Playbook adjustments: ${[...new Set(sectionNotes)].join('; ')}`);
  return lines.join('\n');
}

/** A stable fingerprint of what a proposal was built from (a stale migrate card fails at Apply). */
export function proposalKey(p: Pick<MigrationProposal, 'bindings' | 'active_version'>): string {
  return JSON.stringify({ v: p.active_version, b: p.bindings.map((o) => [o.ext_id, o.schedule, o.outcome, o.outcome === 'series' ? o.cadence : null]) });
}

/** Migrated series of a playbook (by binding ext_id). */
export function migratedSeries(body: Playbook | null): Series[] {
  return (body?.series ?? []).filter((s) => !!s.migrated_from);
}
