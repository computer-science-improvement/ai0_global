import type { Pool } from 'pg';
import type { Agent } from '../agents/agent.types';
import { telegramKeyOf } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { CardSource, EditorCard } from '../card';
import { CAPABILITIES, implementedFormats } from '../platform/capabilities';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import { isQuietHour, localDate, localTimeLabel, zonedToUtc } from '../roles/time';
import { DEFAULT_TZ } from '../time/resource-time';
import { networkContext, NetworkContextDeps, NetworkCtx, resourceClock } from '../network/network-context';
import type { NetworkRepository } from '../network/network.repository';
import { Playbook, validatePlaybook } from '../network/playbook';
import { instancesOn, parseCadence, SeriesSourceCatalog, seriesSourceLabel, type SeriesSource } from '../network/series';
import { normalizePlaybook } from '../network/series-edit';
import { API_SOURCE_NAMES } from '../tools/api-adapters/names';
import { planPerDay, PlanScheduleCtx, scheduleBlock } from './plan-schedule-rules';
import type { ScheduleRepository } from './schedule.repository';
import {
  blackoutAt, pinInstant, ruleDto, ruleLabel, ruleOn, ruleProblems, ruleToInput, ScheduleRule, ScheduleRuleInput, ScheduleRulePatch, shiftDate, weekdayOf,
} from './schedule-rules';
import { applySeriesOp, SeriesFields, SeriesOp, seriesDiff, seriesKey } from './series-change';
import { SeriesForSlot, seriesNote, seriesSourceMismatch, sourceHints } from './series-guard';

/**
 * One place for the schedule (spec 023 FR-004…FR-007): the planners' rule context and pin
 * materialisation, the executor's series context and guard, and the owner's surface — the Schedule
 * REST, the Schedule tab and the chat cards share every validation here. Owner-facing text is English;
 * text for the agents stays Ukrainian.
 */

export type Fail = { error: string; details?: unknown; status?: number };
export const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && typeof (x as Fail).error === 'string';

export interface ScheduleScope { agent: Agent; card: EditorCard; net: NetworkCtx }

export interface ScheduleServiceDeps {
  pool:     Pick<Pool, 'query'>;
  rules:    ScheduleRepository;
  network:  Pick<NetworkRepository, 'activePlaybook' | 'groupOfChannel' | 'groupResources' | 'insertPlaybook'>;
  agents:   Pick<AgentsRepository, 'getByHandle' | 'get' | 'findTop'>;
  card:     (channelKey: string) => Promise<EditorCard | null>;
  plans:    Pick<EditorPlansRepository, 'reservedSlots' | 'getSlot'>;
  inbox:    Pick<OwnerInbox, 'post'>;
  time?:    NetworkContextDeps['time'];
  usable?:  NetworkContextDeps['usable'];
  /** Library datasets and card feeds a source may name. */
  sourceCatalog?: (card: EditorCard | null) => Promise<SeriesSourceCatalog>;
  /** Unposted rows of a dataset on a resource (content ledger); null = unknown. */
  unposted?: (resourceRef: string, dataset: string) => Promise<number | null>;
  now?:     () => Date;
}

export const SCHEDULE_MAX_DAYS = 14;
export const SLOT_CHANGE_HOURS = 48;
const MATERIALISE_EVERY_MS = 10 * 60_000;
const LEAD_MS = 5 * 60_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ScheduleService {
  constructor(private readonly d: ScheduleServiceDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  // ── scope ───────────────────────────────────────────────────────────────────

  async scopeOf(a: Agent): Promise<ScheduleScope | Fail> {
    const orch = a.parentId ? (await this.d.agents.get(a.parentId)) ?? a : a;
    const key = telegramKeyOf(orch);
    const card = key ? await this.d.card(key) : null;
    if (!card) return { error: 'no_channel_card', details: 'an agent without a Telegram channel card has no schedule', status: 400 };
    const net = await networkContext({ repo: this.d.network, usable: this.d.usable, time: this.d.time }, orch, card);
    if (!net) return { error: 'no_channel_card', status: 400 };
    return { agent: orch, card, net };
  }

  async scopeByHandle(handle: string): Promise<ScheduleScope | Fail> {
    const a = await this.d.agents.getByHandle(handle);
    if (!a) return { error: 'agent_not_found', details: handle, status: 404 };
    return this.scopeOf(a);
  }

  async scopeById(id: string): Promise<ScheduleScope | Fail> {
    const a = await this.d.agents.get(id);
    if (!a) return { error: 'agent_not_found', status: 404 };
    return this.scopeOf(a);
  }

  async scopeByChannel(channelKey: string): Promise<ScheduleScope | Fail> {
    const orch = await this.d.agents.findTop('orchestrator', 'resource', `telegram:${channelKey}`);
    if (!orch) return { error: 'no_agent', details: `no agent runs ${channelKey}` };
    return this.scopeOf(orch);
  }

  private playbookOf(sc: ScheduleScope): Playbook | null {
    return sc.net.playbook ? normalizePlaybook(sc.net.playbook) : null;
  }

  /** Zone, quiet hours and minimum gap of every resource in scope. */
  clocks(sc: Pick<ScheduleScope, 'card' | 'net'>): PlanScheduleCtx['clocks'] {
    const out: PlanScheduleCtx['clocks'] = {};
    for (const r of sc.net.resources) {
      const c = resourceClock(r, sc.card);
      // Spec 024 (owner decision): spacing between platform posts is the agent's choice, so code keeps no gap there;
      // Telegram keeps the card's own min gap (an owner setting).
      out[r.ref] = { tz: c.tz, quiet: c.quiet, gapMin: r.platform === 'telegram' ? sc.card.minGapMinutes : 0 };
    }
    return out;
  }

  private async tzOf(ref: string, card: EditorCard | null): Promise<string> {
    if (card && ref === `telegram:${card.channelKey}`) return card.timezone;
    if (this.d.time) {
      try { return await this.d.time.tzOf(ref); } catch { /* default */ }
    }
    return DEFAULT_TZ;
  }

  // ── planners (FR-004) ───────────────────────────────────────────────────────

  /**
   * The rule context of a plan day. `network` covers every resource of the network (the network planner);
   * otherwise only the channel itself (the single-channel planner, which also checks a slot's series here).
   */
  async planContext(card: EditorCard, net: NetworkCtx | null, planDate: string, now: Date, scope: 'single' | 'network'): Promise<PlanScheduleCtx> {
    const anchorRef = `telegram:${card.channelKey}`;
    const all = net ? this.clocks({ card, net }) : {};
    const clocks: PlanScheduleCtx['clocks'] = scope === 'network'
      ? all
      : { [anchorRef]: all[anchorRef] ?? { tz: card.timezone, quiet: { start: card.quietStartHour, end: card.quietEndHour }, gapMin: card.minGapMinutes } };
    const rules = await this.d.rules.activeFor(Object.keys(clocks));
    const byId = new Map(rules.map((r) => [r.id, r]));
    const pins = (await this.d.rules.pinsOn(card.channelKey, planDate))
      .map((s) => ({ resourceRef: s.resourceRef ?? anchorRef, at: s.scheduledAt, ruleId: s.scheduleRuleId!, seriesName: s.seriesName ?? null, windowMin: byId.get(s.scheduleRuleId!)?.windowMin ?? 20 }))
      .filter((p) => clocks[p.resourceRef]);
    const series = (net?.playbook ? normalizePlaybook(net.playbook).series : []).filter((s) => clocks[s.resource_ref]);
    return { planDate, defaultRef: anchorRef, now, clocks, rules, pins, series, checkSlotSeries: scope === 'single' };
  }

  /** The card with the day's posts per day (frequency rule, minus pins) — for validatePlan. */
  effectiveCard<C extends Pick<EditorCard, 'channelKey' | 'postsPerDayMin' | 'postsPerDayMax'>>(card: C, ctx: PlanScheduleCtx): C {
    const pd = planPerDay(ctx, `telegram:${card.channelKey}`, { min: card.postsPerDayMin, max: card.postsPerDayMax });
    return { ...card, postsPerDayMin: pd.min, postsPerDayMax: pd.max };
  }

  /** The network context with each section's per_day for the day — for validateNetworkPlan. */
  effectiveNet(net: NetworkCtx, ctx: PlanScheduleCtx): NetworkCtx {
    if (!net.playbook) return net;
    const pb = normalizePlaybook(net.playbook);
    return { ...net, playbook: { ...pb, platforms: pb.platforms.map((s) => ({ ...s, per_day: planPerDay(ctx, s.resource_ref, s.per_day) })) } };
  }

  /** Prompt lines about today's and tomorrow's schedule for the planner (null when there is nothing). */
  async plannerBlock(card: EditorCard): Promise<string | null> {
    const sc = await this.scopeByChannel(card.channelKey);
    const net = isFail(sc) ? null : sc.net;
    const now = this.now();
    const today = localDate(now, card.timezone);
    const scope = net?.mode === 'independent' && net.playbook ? 'network' : 'single';
    const out: string[] = [];
    for (const date of [today, shiftDate(today, 1)]) {
      const b = scheduleBlock(await this.planContext(card, net, date, now, scope));
      if (b) out.push(b);
    }
    return out.length ? out.join('\n\n') : null;
  }

  // ── pins ────────────────────────────────────────────────────────────────────

  private readonly swept = new Map<string, number>();

  /** Scheduler hook: materialise the channel's pins for today and tomorrow (at most every 10 min per channel). */
  async materialiseChannel(card: EditorCard, now: Date = this.now(), force = false): Promise<number> {
    const last = this.swept.get(card.channelKey) ?? 0;
    if (!force && now.getTime() - last < MATERIALISE_EVERY_MS) return 0;
    this.swept.set(card.channelKey, now.getTime());
    const orch = await this.d.agents.findTop('orchestrator', 'resource', `telegram:${card.channelKey}`);
    return orch ? this.materialiseAgent(orch, card, now) : 0;
  }

  /** Each active pin due today or tomorrow (resource-local) becomes a content slot once per (rule, date). */
  async materialiseAgent(orch: Pick<Agent, 'id'>, card: EditorCard, now: Date = this.now()): Promise<number> {
    const pins = await this.d.rules.activePins(orch.id);
    if (!pins.length) return 0;
    const pb = normalizePlaybook((await this.d.network.activePlaybook(orch.id))?.body ?? { platforms: [], series: [] });
    const anchorRef = `telegram:${card.channelKey}`;
    let n = 0;
    for (const r of pins) {
      const tz = await this.tzOf(r.resourceRef, card);
      const today = localDate(now, tz);
      const series = r.seriesName ? (pb.series ?? []).find((s) => s.name === r.seriesName && s.resource_ref === r.resourceRef) ?? null : null;
      const format = r.format ?? series?.format;
      if (!format) continue;
      for (const date of [today, shiftDate(today, 1)]) {
        if (!ruleOn(r, date)) continue;
        const at = pinInstant(r, date, tz);
        if (at.getTime() <= now.getTime()) continue;
        const id = await this.d.rules.materialise({
          ruleId: r.id, ruleDate: date, channelKey: card.channelKey, planDate: localDate(at, card.timezone), scheduledAt: at,
          resourceRef: r.resourceRef === anchorRef ? null : r.resourceRef, format,
          topic: (r.brief ?? series?.brief ?? `Owner pin ${r.atLocal}`).slice(0, 300),
          sourceHints: [...sourceHints(r.source ?? series?.source ?? null), ...(series ? [`series:${series.name}`] : [])].slice(0, 5),
          seriesName: series?.name ?? null,
        });
        if (id) n++;
      }
    }
    return n;
  }

  // ── executor (FR-005) ───────────────────────────────────────────────────────

  /** The series (or owner pin) a slot realises, with its source and mode. */
  async seriesForSlot(slot: EditorSlot): Promise<SeriesForSlot | null> {
    if (!slot.seriesName && !slot.scheduleRuleId) return null;
    const ref = slot.resourceRef ?? `telegram:${slot.channelKey}`;
    if (slot.seriesName) {
      const orch = await this.d.agents.findTop('orchestrator', 'resource', `telegram:${slot.channelKey}`);
      const pb = orch ? await this.d.network.activePlaybook(orch.id) : null;
      const all = pb ? normalizePlaybook(pb.body).series : [];
      const s = all.find((x) => x.name === slot.seriesName && x.resource_ref === ref) ?? all.find((x) => x.name === slot.seriesName);
      if (s) return { name: s.name, brief: s.brief, format: s.format, source: s.source ?? null, sourceMode: s.source_mode ?? 'suggested', locked: !!s.locked };
    }
    if (slot.scheduleRuleId) {
      const r = await this.d.rules.get(slot.scheduleRuleId);
      if (r) return { name: '', brief: r.brief ?? slot.topic, format: r.format ?? slot.format, source: r.source, sourceMode: 'suggested', locked: true, pin: true };
    }
    return null;
  }

  /**
   * The executor's series note; a `required` library source with nothing left skips the slot by code and
   * tells the owner (`series_source_empty`, once per series a day).
   */
  async executorContext(slot: EditorSlot): Promise<{ note: string | null; skip?: string }> {
    const s = await this.seriesForSlot(slot);
    if (!s) return { note: null };
    const ref = slot.resourceRef ?? `telegram:${slot.channelKey}`;
    if (s.sourceMode === 'required' && s.source?.kind === 'library' && this.d.unposted) {
      const left = await this.d.unposted(ref, s.source.table).catch(() => null);
      if (left === 0) {
        await this.sourceEmpty(slot, s).catch(() => {});
        return { note: null, skip: `series "${s.name}": required source library:${s.source.table} has nothing left on ${ref}` };
      }
    }
    return { note: seriesNote(s, seriesSourceLabel) };
  }

  private async sourceEmpty(slot: EditorSlot, s: SeriesForSlot): Promise<void> {
    const orch = await this.d.agents.findTop('orchestrator', 'resource', `telegram:${slot.channelKey}`);
    const refId = `${orch?.handle ?? slot.channelKey}:${s.name}`;
    const { rows } = await this.d.pool.query(
      `SELECT 1 FROM agent_inbox WHERE kind = 'series_source_empty' AND ref_id = $1 AND created_at > now() - interval '1 day' LIMIT 1`, [refId]);
    if (rows.length) return;
    const src = s.source ? seriesSourceLabel(s.source) : '—';
    await this.d.inbox.post({
      agentId: orch?.id ?? null, kind: 'series_source_empty', severity: 'action', refType: 'series', refId,
      title: `📚 @${orch?.handle ?? slot.channelKey}: series "${s.name}" has no material left (${src})`,
      body: `The series requires ${src}, and every item there was already used on ${slot.resourceRef ?? `telegram:${slot.channelKey}`}. The slot was skipped. Add material, change the source, or make the source suggested.`,
      alert: {
        title: `📚 @${orch?.handle ?? slot.channelKey}: у серії «${s.name}» закінчився матеріал (${src})`,
        body: 'Обовʼязкове джерело серії вичерпане — слот пропущено. Додайте матеріал, змініть джерело або зробіть його необовʼязковим.',
      },
    });
  }

  /**
   * Publish guard of a slot: a live post inside the owner's blackout (`blackout_window`; owner pins are
   * exempt) and a `required` series source the post does not use (`series_source_mismatch`).
   */
  async publishGuard(slot: EditorSlot, refs: { libraryRef?: string | null; sourceUrl?: string | null }, o: { live: boolean; now: Date; card?: EditorCard | null; feeds?: CardSource[] }): Promise<Fail | null> {
    const ref = slot.resourceRef ?? `telegram:${slot.channelKey}`;
    if (o.live && !slot.scheduleRuleId) {
      const rules = await this.d.rules.activeFor([ref]);
      if (rules.some((r) => r.kind === 'blackout')) {
        const tz = await this.tzOf(ref, o.card ?? null);
        const b = blackoutAt(rules, ref, o.now, tz, localDate(o.now, tz));
        if (b) return { error: 'blackout_window', details: `заборонене вікно власника ${b.atLocal}–${b.untilLocal} (${tz}) — не публікуй зараз, skip_slot` };
      }
    }
    const s = await this.seriesForSlot(slot);
    if (s && !s.pin) {
      const why = seriesSourceMismatch(s, refs, (o.feeds ?? []).filter((f) => f.kind === 'rss' || f.kind === 'url'));
      if (why) return { error: 'series_source_mismatch', details: why };
    }
    return null;
  }

  /** `blackout_window` warning for a reserved slot created inside a blackout (reserved slots are never blocked). */
  async reservedWarnings(channelKey: string, at: Date, resourceRef?: string | null): Promise<string[]> {
    const ref = resourceRef ?? `telegram:${channelKey}`;
    const rules = await this.d.rules.activeFor([ref]);
    if (!rules.some((r) => r.kind === 'blackout')) return [];
    const tz = await this.tzOf(ref, await this.d.card(channelKey));
    return blackoutAt(rules, ref, at, tz, localDate(at, tz)) ? ['blackout_window'] : [];
  }

  // ── owner surface (FR-006 / FR-007) ─────────────────────────────────────────

  /** The Schedule tab / get_schedule: series projections, rules, pins, blackouts, frequency, slots. */
  async schedule(sc: ScheduleScope, o: { from?: string | null; to?: string | null; resourceRef?: string | null } = {}) {
    const now = this.now();
    const anchorTz = sc.card.timezone;
    const from = o.from && DATE_RE.test(o.from) ? o.from : localDate(now, anchorTz);
    let to = o.to && DATE_RE.test(o.to) && o.to >= from ? o.to : shiftDate(from, 6);
    if (to > shiftDate(from, SCHEDULE_MAX_DAYS - 1)) to = shiftDate(from, SCHEDULE_MAX_DAYS - 1);
    const days: string[] = [];
    for (let d = from; d <= to; d = shiftDate(d, 1)) days.push(d);
    const pb = this.playbookOf(sc);
    const rules = await this.d.rules.list(sc.agent.id);
    const clocks = this.clocks(sc);
    const cat = this.d.sourceCatalog ? await this.d.sourceCatalog(sc.card).catch(() => null) : null;
    const refs = sc.net.resources.map((r) => r.ref).filter((r) => !o.resourceRef || r === o.resourceRef);
    const items: ScheduleItem[] = [];
    for (const ref of refs) {
      const tz = clocks[ref].tz;
      for (const date of days) {
        const wd = weekdayOf(date);
        for (const s of pb?.series ?? []) {
          if (s.active === false || s.resource_ref !== ref) continue;
          const c = parseCadence(s.cadence);
          for (const time of c ? instancesOn(c, wd) : []) {
            items.push({ kind: 'series', resourceRef: ref, date, time, at: zonedToUtc(date, time, tz).toISOString(), name: s.name, format: s.format, locked: !!s.locked, origin: s.origin ?? 'agent' });
          }
        }
        for (const r of rules) {
          if (r.resourceRef !== ref || !ruleOn(r, date)) continue;
          if (r.kind === 'pin') {
            const series = r.seriesName ? pb?.series.find((s) => s.name === r.seriesName) : null;
            items.push({ kind: 'pin', ruleId: r.id, resourceRef: ref, date, time: r.atLocal!, at: pinInstant(r, date, tz).toISOString(), format: r.format ?? series?.format ?? null, seriesName: r.seriesName, brief: r.brief });
          } else if (r.kind === 'blackout') {
            items.push({ kind: 'blackout', ruleId: r.id, resourceRef: ref, date, time: r.atLocal!, until: r.untilLocal! });
          } else {
            items.push({ kind: 'frequency', ruleId: r.id, resourceRef: ref, date, min: r.perDayMin, max: r.perDayMax });
          }
        }
      }
    }
    const anchorRef = `telegram:${sc.card.channelKey}`;
    const raw = await this.d.rules.slotsBetween(sc.card.channelKey, zonedToUtc(shiftDate(from, -1), '00:00', anchorTz), zonedToUtc(shiftDate(to, 2), '00:00', anchorTz));
    const slots = raw.map((s) => {
      const ref = s.resourceRef ?? anchorRef;
      const tz = clocks[ref]?.tz ?? anchorTz;
      return {
        id: s.id, resourceRef: ref, at: s.scheduledAt.toISOString(), date: localDate(s.scheduledAt, tz), time: localTimeLabel(s.scheduledAt, tz),
        kind: s.kind, status: s.status, format: s.format, topic: s.topic, seriesName: s.seriesName ?? null, scheduleRuleId: s.scheduleRuleId ?? null,
        promo: !!s.promo,
      };
    }).filter((s) => s.date >= from && s.date <= to && refs.includes(s.resourceRef));
    return {
      agent: { id: sc.agent.id, handle: sc.agent.handle }, anchor: sc.card.channelKey, mode: sc.net.mode, playbookVersion: sc.net.playbookVersion,
      now: now.toISOString(), from, to, days,
      resources: sc.net.resources.filter((r) => refs.includes(r.ref)).map((r) => ({
        ref: r.ref, platform: r.platform, timezone: clocks[r.ref].tz, quietHours: clocks[r.ref].quiet,
        formats: r.platform === 'telegram' ? sc.net.telegramFormats : implementedFormats(r.platform),
        perDay: pb?.platforms.find((p) => p.resource_ref === r.ref)?.per_day ?? (r.ref === anchorRef ? { min: sc.card.postsPerDayMin, max: sc.card.postsPerDayMax } : null),
      })),
      series: (pb?.series ?? []).filter((s) => refs.includes(s.resource_ref)).map((s) => ({
        name: s.name, cadence: s.cadence, resource_ref: s.resource_ref, format: s.format, brief: s.brief, active: s.active !== false,
        source: s.source ?? null, source_mode: s.source_mode ?? 'suggested', origin: s.origin ?? 'agent', locked: !!s.locked, migrated_from: s.migrated_from ?? null,
      })),
      rules: rules.filter((r) => refs.includes(r.resourceRef)).map(ruleDto),
      items, slots,
      // What the forms may name as a source (datasets, card feeds, API adapters).
      sourceOptions: { ...(cat ?? { tables: [], feeds: [] }), apis: [...API_SOURCE_NAMES] },
    };
  }

  /** Rule checks (English for the owner) and warnings; `input` is untrusted. */
  async checkRule(sc: ScheduleScope, input: unknown): Promise<{ rule: ScheduleRuleInput; errors: string[]; warnings: string[] }> {
    const p = ScheduleRuleInput.safeParse(input);
    if (!p.success) return { rule: input as ScheduleRuleInput, errors: p.error.issues.map((i) => `${i.path.join('.') || 'rule'}: ${i.message}`), warnings: [] };
    const i = p.data;
    const clocks = this.clocks(sc);
    const r = sc.net.resources.find((x) => x.ref === i.resource_ref);
    if (!r) return { rule: i, errors: [`${i.resource_ref} is not a resource of @${sc.agent.handle} (resources: ${sc.net.resources.map((x) => x.ref).join(', ')})`], warnings: [] };
    const { errors, warnings } = ruleProblems(i, clocks[r.ref]);
    if (i.kind === 'pin') {
      const pb = this.playbookOf(sc);
      const series = i.series_name ? pb?.series.find((s) => s.name === i.series_name) : null;
      if (i.series_name && !series) errors.push(`no series "${i.series_name}" in the active playbook`);
      else if (series && series.resource_ref !== r.ref) errors.push(`series "${series.name}" runs on ${series.resource_ref}, not ${r.ref}`);
      const allowed = r.platform === 'telegram' ? sc.net.telegramFormats : implementedFormats(r.platform);
      const format = i.format ?? series?.format;
      if (format && !allowed.includes(format)) errors.push(`format ${format} is not available on ${r.ref} (available: ${allowed.join(', ')})`);
      errors.push(...await this.sourceProblems(sc, i.source ?? null));
      if (i.at_local && !errors.length) warnings.push(...await this.pinWarnings(sc, i));
    }
    if (i.kind === 'frequency' && r.platform !== 'telegram' && (i.per_day_max ?? 0) > CAPABILITIES[r.platform].dailyApiCap) {
      errors.push(`per_day_max ${i.per_day_max} is above the ${r.platform} API limit of ${CAPABILITIES[r.platform].dailyApiCap}`);
    }
    return { rule: i, errors, warnings: [...new Set(warnings)] };
  }

  private async sourceProblems(sc: ScheduleScope, src: SeriesSource | null): Promise<string[]> {
    if (!src) return [];
    if (src.kind === 'api' && !(API_SOURCE_NAMES as readonly string[]).includes(src.source)) return [`no API source ${src.source} (available: ${API_SOURCE_NAMES.join(', ')})`];
    const cat = this.d.sourceCatalog ? await this.d.sourceCatalog(sc.card).catch(() => null) : null;
    if (!cat) return [];
    if (src.kind === 'library' && !cat.tables.includes(src.table)) return [`no dataset ${src.table} in the library`];
    if (src.kind === 'feed' && !cat.feeds.includes(src.ref)) return [`no feed ${src.ref} on the channel card`];
    return [];
  }

  /** inside_blackout / conflicts_with_reserved for a pin over the next 7 days. */
  private async pinWarnings(sc: ScheduleScope, i: ScheduleRuleInput): Promise<string[]> {
    const out: string[] = [];
    const clock = this.clocks(sc)[i.resource_ref];
    const now = this.now();
    const today = localDate(now, clock.tz);
    const rule = { active: true, days: i.days ?? null, validFrom: i.valid_from ?? null, validUntil: i.valid_until ?? null, atLocal: i.at_local! };
    const rules = await this.d.rules.activeFor([i.resource_ref]);
    const reserved = await this.d.plans.reservedSlots(sc.card.channelKey, now, new Date(now.getTime() + 8 * 86_400_000)).catch(() => [] as EditorSlot[]);
    const anchorRef = `telegram:${sc.card.channelKey}`;
    for (let k = 0; k < 7; k++) {
      const date = shiftDate(today, k);
      if (!ruleOn(rule, date)) continue;
      const at = pinInstant(rule, date, clock.tz);
      if (blackoutAt(rules, i.resource_ref, at, clock.tz, date)) out.push('inside_blackout');
      const gap = Math.max(i.window_min ?? 20, clock.gapMin) * 60_000;
      if (reserved.some((s) => (s.resourceRef ?? anchorRef) === i.resource_ref && Math.abs(s.scheduledAt.getTime() - at.getTime()) < gap)) out.push('conflicts_with_reserved');
    }
    return out;
  }

  /** A rule of this scope's agent (null when absent or another agent's). */
  async rule(sc: ScheduleScope, id: string): Promise<ScheduleRule | null> {
    const r = await this.d.rules.get(id);
    return r && r.agentId === sc.agent.id ? r : null;
  }

  ruleInput(r: ScheduleRule): ScheduleRuleInput {
    return ruleToInput(r);
  }

  async addRule(sc: ScheduleScope, input: unknown, createdBy: 'owner' | 'chat'): Promise<{ rule: ReturnType<typeof ruleDto>; warnings: string[] } | Fail> {
    const chk = await this.checkRule(sc, input);
    if (chk.errors.length) return { error: 'rule_invalid', details: chk.errors, status: 400 };
    const rule = await this.d.rules.insert(sc.agent.id, chk.rule, createdBy);
    if (rule.kind === 'pin') await this.materialiseAgent(sc.agent, sc.card).catch(() => 0);
    return { rule: ruleDto(rule), warnings: chk.warnings };
  }

  /** Edit or disable (`active: false`) a rule. `expectUpdatedAt` makes a chat card fail when the rule changed meanwhile. */
  async updateRule(sc: ScheduleScope, id: string, patchIn: unknown, o: { expectUpdatedAt?: string | null } = {}): Promise<{ rule: ReturnType<typeof ruleDto>; warnings: string[] } | Fail> {
    const p = ScheduleRulePatch.safeParse(patchIn ?? {});
    if (!p.success) return { error: 'rule_invalid', details: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), status: 400 };
    const cur = await this.d.rules.get(id);
    if (!cur || cur.agentId !== sc.agent.id) return { error: 'rule_not_found', status: 404 };
    if (o.expectUpdatedAt && cur.updatedAt.toISOString() !== o.expectUpdatedAt) return { error: 'stale', details: 'the rule changed since this card was proposed', status: 409 };
    const { active: activeIn, ...patch } = p.data;
    const merged: ScheduleRuleInput = { ...ruleToInput(cur), ...patch };
    const active = activeIn ?? cur.active;
    let warnings: string[] = [];
    let rule = merged;
    if (active) {
      const chk = await this.checkRule(sc, merged);
      if (chk.errors.length) return { error: 'rule_invalid', details: chk.errors, status: 400 };
      warnings = chk.warnings;
      rule = chk.rule;
    }
    const saved = await this.d.rules.update(id, rule, active);
    if (!saved) return { error: 'rule_not_found', status: 404 };
    const now = this.now();
    if (cur.kind === 'pin') await this.d.rules.dropFuturePins(id, now);
    if (saved.kind === 'pin' && saved.active) await this.materialiseAgent(sc.agent, sc.card, now).catch(() => 0);
    return { rule: ruleDto(saved), warnings };
  }

  /** English problems of an owner's series in the next body (the playbook validator is the safety net). */
  private async seriesProblems(sc: ScheduleScope, body: Playbook, name: string | null): Promise<string[]> {
    const errors: string[] = [];
    const s = name ? body.series.find((x) => x.name === name) : null;
    if (s) {
      const r = sc.net.resources.find((x) => x.ref === s.resource_ref);
      if (!r) errors.push(`${s.resource_ref} is not a resource of @${sc.agent.handle}`);
      else {
        const allowed = r.platform === 'telegram' ? sc.net.telegramFormats : implementedFormats(r.platform);
        if (!allowed.includes(s.format)) errors.push(`format ${s.format} is not available on ${r.ref} (available: ${allowed.join(', ')})`);
        if (!body.platforms.some((p) => p.resource_ref === s.resource_ref)) errors.push(`the playbook has no section for ${s.resource_ref}`);
      }
      errors.push(...await this.sourceProblems(sc, s.source ?? null));
    }
    if (errors.length) return errors;
    const cat = this.d.sourceCatalog ? await this.d.sourceCatalog(sc.card).catch(() => null) : null;
    // Owner precedence: quiet hours are not enforced for the owner's own series.
    return validatePlaybook(body, sc.net.resources, sc.net.telegramFormats, { sources: cat });
  }

  /** Validate an owner series change; returns the next body and the human diff. */
  async prepareSeriesChange(sc: ScheduleScope, op: SeriesOp, fields: unknown): Promise<{ body: Playbook; diff: string; before: string | null; fields: SeriesFields } | Fail> {
    const f = SeriesFields.safeParse(fields ?? {});
    if (!f.success) return { error: 'invalid_series', details: f.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), status: 400 };
    const pb = this.playbookOf(sc);
    if (!pb) return { error: 'no_playbook', details: `@${sc.agent.handle} has no active playbook yet`, status: 409 };
    const r = applySeriesOp(pb, op, f.data);
    if ('error' in r) return { ...r, status: r.error === 'series_not_found' ? 404 : 400 };
    const errors = await this.seriesProblems(sc, r.body, r.after?.name ?? null);
    if (errors.length) return { error: 'series_invalid', details: errors, status: 400 };
    return { body: r.body, diff: seriesDiff(r.before, r.after), before: seriesKey(r.before), fields: f.data };
  }

  /** Store an owner version (active at once, BR-AGT-53; supersedes the agent's pending draft). */
  async commitSeriesChange(sc: ScheduleScope, op: SeriesOp, fields: unknown, o: { expectBefore?: string | null; source: 'dashboard' | 'chat' } = { source: 'dashboard' }) {
    const prep = await this.prepareSeriesChange(sc, op, fields);
    if (isFail(prep)) return prep;
    if (o.expectBefore !== undefined && prep.before !== o.expectBefore) {
      return { error: 'stale', details: `series "${prep.fields.name}" changed since this card was proposed`, status: 409 } as Fail;
    }
    const pb = await this.d.network.insertPlaybook({
      agentId: sc.agent.id, status: 'active', brief: null, body: prep.body, createdBy: 'owner',
      rationale: `Owner (${o.source}): ${prep.diff}`,
    });
    sc.net.playbook = prep.body;
    sc.net.playbookVersion = pb.version;
    return { ok: true as const, version: pb.version, diff: prep.diff, series: prep.body.series.find((s) => s.name === prep.fields.name) ?? null };
  }

  /** PUT /series/:name: add or edit (locks it). */
  async putSeries(sc: ScheduleScope, name: string, body: unknown) {
    const exists = !!this.playbookOf(sc)?.series.some((s) => s.name === name);
    return this.commitSeriesChange(sc, exists ? 'update' : 'add', { ...(body as object ?? {}), name }, { source: 'dashboard' });
  }

  /** Hand an owner-locked series back to the agent (origin stays). */
  async unlockSeries(sc: ScheduleScope, name: string) {
    const pb = this.playbookOf(sc);
    const s = pb?.series.find((x) => x.name === name);
    if (!pb || !s) return { error: 'series_not_found', status: 404 } as Fail;
    if (!s.locked) return { error: 'not_locked', details: `series "${name}" is already run by the agent`, status: 409 } as Fail;
    const body: Playbook = { ...pb, series: pb.series.map((x) => (x.name === name ? { ...x, locked: false } : x)) };
    const row = await this.d.network.insertPlaybook({ agentId: sc.agent.id, status: 'active', brief: null, body, createdBy: 'owner', rationale: `Owner: unlocked series "${name}" (the agent may change it again)` });
    sc.net.playbook = body;
    sc.net.playbookVersion = row.version;
    return { ok: true as const, version: row.version };
  }

  /** A planned content slot of the scope within the next 48 h (the chat's slot_change). */
  async prepareSlotChange(sc: ScheduleScope, slotId: string, op: 'move' | 'skip', toLocal?: string | null): Promise<{ slot: EditorSlot; to: Date | null; summary: string; warnings: string[] } | Fail> {
    const slot = await this.d.plans.getSlot(slotId);
    const now = this.now();
    if (!slot || slot.channelKey !== sc.card.channelKey) return { error: 'slot_not_found', status: 404 };
    if (slot.kind !== 'content' || slot.status !== 'planned') return { error: 'slot_not_planned', details: `the slot is ${slot.kind} / ${slot.status}; only planned content slots can be moved or skipped`, status: 409 };
    const horizon = now.getTime() + SLOT_CHANGE_HOURS * 3600_000;
    if (slot.scheduledAt.getTime() > horizon) return { error: 'slot_too_far', details: `only slots within the next ${SLOT_CHANGE_HOURS} h`, status: 400 };
    const ref = slot.resourceRef ?? `telegram:${slot.channelKey}`;
    const clock = this.clocks(sc)[ref] ?? { tz: sc.card.timezone, quiet: { start: sc.card.quietStartHour, end: sc.card.quietEndHour }, gapMin: sc.card.minGapMinutes };
    const label = `"${slot.topic.slice(0, 80)}" on ${ref}`;
    const when = (d: Date) => `${new Intl.DateTimeFormat('en-GB', { timeZone: clock.tz, weekday: 'short', day: '2-digit', month: 'short' }).format(d)} ${localTimeLabel(d, clock.tz)}`;
    if (op === 'skip') return { slot, to: null, summary: `Skip ${label} at ${when(slot.scheduledAt)} (${clock.tz})`, warnings: [] };
    const m = (toLocal ?? '').trim().match(/^(?:(\d{4}-\d{2}-\d{2})[ T])?([01]\d|2[0-3]):([0-5]\d)$/);
    if (!m) return { error: 'invalid_time', details: 'to_local is HH:MM or YYYY-MM-DD HH:MM in the resource time zone', status: 400 };
    const date = m[1] ?? localDate(slot.scheduledAt, clock.tz);
    const to = zonedToUtc(date, `${m[2]}:${m[3]}`, clock.tz);
    if (to.getTime() < now.getTime() + LEAD_MS) return { error: 'time_passed', details: 'the new time is in the past or less than 5 minutes away', status: 400 };
    if (to.getTime() > horizon) return { error: 'slot_too_far', details: `the new time must be within the next ${SLOT_CHANGE_HOURS} h`, status: 400 };
    const rules = await this.d.rules.activeFor([ref]);
    const b = blackoutAt(rules, ref, to, clock.tz, date);
    if (b) return { error: 'blackout_window', details: `${m[2]}:${m[3]} is inside the blackout ${b.atLocal}–${b.untilLocal} (${clock.tz})`, status: 400 };
    const warnings = isQuietHour(Number(m[2]), clock.quiet.start, clock.quiet.end) ? ['quiet_hours'] : [];
    return { slot, to, summary: `Move ${label}: ${when(slot.scheduledAt)} → ${when(to)} (${clock.tz})`, warnings };
  }

  async applySlotChange(slotId: string, op: 'move' | 'skip', from: Date, to: Date | null): Promise<{ slot: EditorSlot } | Fail> {
    const r = op === 'skip'
      ? await this.d.rules.skipSlot(slotId, from, 'skipped by the owner (chat)')
      : await this.d.rules.moveSlot(slotId, from, to!);
    return r ? { slot: r } : { error: 'stale', details: 'the slot changed since this card was proposed (moved, started or skipped)', status: 409 };
  }

  /** A rule card's summary (English). */
  ruleSummary(op: 'add' | 'update' | 'disable', rule: ScheduleRuleInput, before?: ScheduleRule | null): string {
    if (op === 'add') return `Add rule on ${rule.resource_ref}: ${ruleLabel(rule)}`;
    if (op === 'disable') return `Disable rule on ${rule.resource_ref}: ${ruleLabel(rule)}`;
    return `Change rule on ${rule.resource_ref}: ${before ? `${ruleLabel(ruleToInput(before))} → ` : ''}${ruleLabel(rule)}`;
  }
}

export type ScheduleItem =
  | { kind: 'series'; resourceRef: string; date: string; time: string; at: string; name: string; format: string; locked: boolean; origin: string }
  | { kind: 'pin'; ruleId: string; resourceRef: string; date: string; time: string; at: string; format: string | null; seriesName: string | null; brief: string | null }
  | { kind: 'blackout'; ruleId: string; resourceRef: string; date: string; time: string; until: string }
  | { kind: 'frequency'; ruleId: string; resourceRef: string; date: string; min: number | null; max: number | null };
