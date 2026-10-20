import type { Pool } from 'pg';
import type { Agent, AgentMode } from '../agents/agent.types';
import { telegramKeyOf } from '../agents/agent.types';
import type { ResourceListItem } from '../agents/resource-catalog';
import type { NetworkHealth } from '../health/network-health';
import type { AgentCapStatus, BlockingCap, BudgetStatus } from '../../spend/spend.service';
import { levelOf, levelStats } from './level';
import { MapQueries, type RawEvent, type RawInfra, type RawRoad, type SlotFacts } from './map.queries';
import type {
  MapAlert, MapBudget, MapEvent, MapInfra, MapRoad, MapResource, MapSnapshot, MapUnit, ResourceHealthView,
} from './map.types';
import { errorCode, stateOfRole, unitState, type UnitFacts } from './unit-state';

/**
 * Spec 056 FR-001: builds the network map snapshot from the services the engine already has — the resource catalog,
 * the agent registry and its activity, the budgets, the network health and a handful of batched queries. A 5-second
 * cache is shared by every caller (the page polls every 5 s while anything works, every 30 s otherwise).
 */

export const MAP_CACHE_MS = 5_000;
/** Stuck work comes from the network health view, which also checks sources; it is read at most this often. */
export const HEALTH_CACHE_MS = 60_000;
export const MAX_EVENTS = 30;

export interface MapDeps {
  pool:     Pick<Pool, 'query'>;
  agents:   {
    list(): Promise<Agent[]>;
    activity(): Promise<Map<string, { spentTodayUsd: number; lastRunAt: Date | null; lastStatus: string | null; runsToday: number }>>;
  };
  catalog:  { list(): Promise<ResourceListItem[]> };
  budgets:  () => Promise<{ rows: BudgetStatus[]; agentCaps: AgentCapStatus[]; blocking: BlockingCap[] }>;
  /** Refs with an active pause (spec 025). */
  pausedRefs: () => Promise<Set<string>>;
  /** Stuck work (spec 049); optional, a failure leaves it out. */
  health?:  () => Promise<NetworkHealth>;
  now?:     () => Date;
  cacheMs?: number;
  log?:     (msg: string) => void;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Connection state → the building's health ring. */
export function healthView(state: string | undefined): ResourceHealthView {
  switch (state) {
    case 'ok': return 'ok';
    case 'token_expiring': case 'rate_limited': return 'warning';
    case 'no_access': case 'token_invalid': return 'broken';
    default: return 'unknown';
  }
}

/** The Connections page section that manages each platform. */
const CONNECTION_SECTION: Record<string, string> = { telegram: 'telegram', instagram: 'meta', facebook: 'meta', threads: 'meta', tiktok: 'tiktok', youtube: 'telegram' };

const INFRA_TAB: Record<MapInfra['kind'], string> = { bot: 'bots', mtproto: 'sessions', telegraph: 'telegraph' };
const INFRA_NOUN: Record<MapInfra['kind'], string> = { bot: 'Telegram bot', mtproto: 'MTProto session', telegraph: 'Telegraph account' };

/** A bot, a session or a Telegraph account on the map: health from its last verify; the default bot serves channels without one. */
export function infraItems(raw: RawInfra[], catalogRefs: string[], channelBots: Map<string, string>): MapInfra[] {
  const known = new Set(raw.map((r) => r.id));
  const fallback = raw.find((r) => r.kind === 'bot' && r.isDefault)?.id ?? null;
  const serves = new Map<string, string[]>();
  for (const ref of catalogRefs) {
    if (!ref.startsWith('telegram:')) continue;
    const named = channelBots.get(ref);
    const bot = named && known.has(named) ? named : fallback;
    if (bot) serves.set(bot, [...(serves.get(bot) ?? []), ref]);
  }
  return raw.map((r) => {
    const handle = r.username ? `@${r.username.replace(/^@/, '')}` : null;
    return {
      id: r.id, kind: r.kind,
      title: (r.kind === 'bot' ? handle ?? r.name : r.kind === 'telegraph' ? r.name : r.name ?? handle) ?? INFRA_NOUN[r.kind],
      username: r.username, active: r.active, isDefault: r.isDefault, role: r.role,
      health: r.verifyError ? 'broken' : r.lastVerifiedAt ? 'ok' : 'unknown',
      healthDetail: r.verifyError ? clip(r.verifyError.replace(/\s+/g, ' ').trim(), 160) : null,
      lastVerifiedAt: iso(r.lastVerifiedAt), serves: [...(serves.get(r.id) ?? [])].sort(),
      path: `/app/connections?section=telegram&tab=${INFRA_TAB[r.kind]}`,
    };
  });
}

const VERB = { planning: 'planning', writing: 'writing', reviewing: 'reviewing' } as Record<string, string>;
const STATUS_TEXT: Record<string, string> = {
  error: 'failed', budget_exceeded: 'hit its budget', max_steps: 'ran out of steps', no_terminal: 'ended without a result',
};
const quoted = (t: string | null | undefined) => (t ? ` "${clip(t.replace(/\s+/g, ' ').trim(), 80)}"` : '');

/** The English line of an event (the topic is the only post-derived text). */
export function eventText(e: RawEvent, titleOf: (ref: string | null | undefined) => string): string {
  switch (e.kind) {
    case 'run_started': {
      const verb = VERB[stateOfRole(e.extra ?? '')] ?? 'working';
      return `started ${verb}${quoted(e.topic)}`;
    }
    case 'run_finished': return `finished ${VERB[stateOfRole(e.extra ?? '')] ?? 'working'}${quoted(e.topic)}`;
    case 'run_failed': {
      const [role, status] = (e.extra ?? '').split('|');
      return `run failed while ${VERB[stateOfRole(role ?? '')] ?? 'working'}: ${STATUS_TEXT[status ?? ''] ?? status ?? 'error'}`;
    }
    case 'post_published': return `published${quoted(e.topic)}`;
    case 'post_failed': return `could not publish${quoted(e.topic)}${errorCode(e.extra) ? ` (${errorCode(e.extra)})` : ''}`;
    case 'post_approved': return `you approved${quoted(e.topic)}`;
    case 'post_rejected': return `you rejected${quoted(e.topic)}`;
    case 'promo': return `${e.extra === 'repost' ? 'reposted' : 'promoted'} ${titleOf(e.toRef)}`;
    case 'directive': return `received a ${(e.extra ?? 'new').replace(/_/g, ' ')} directive`;
    case 'launch_started': return `${e.extra ?? 'a channel'} launch started`;
    case 'launch_graduated': return `${e.extra ?? 'a channel'} went live`;
    default: return e.kind;
  }
}

/** Merge slot facts of several resources (a network orchestrator runs them all) into the facts the state rules read. */
export function mergeSlotFacts(rows: SlotFacts[]): NonNullable<UnitFacts['slots']> {
  const later = <T extends { at: Date }>(a: T | null | undefined, b: T | null): T | null => (!a ? b : !b ? a : b.at > a.at ? b : a);
  const earlier = <T extends { at: Date }>(a: T | null | undefined, b: T | null): T | null => (!a ? b : !b ? a : b.at < a.at ? b : a);
  let failed: { at: Date; error: string | null } | null = null;
  let running: { at: Date; topic: string | null } | null = null;
  let due: { at: Date; topic: string | null } | null = null;
  let awaiting = 0;
  let since: Date | null = null;
  for (const r of rows) {
    awaiting += r.awaiting;
    if (r.awaitingSince && (!since || r.awaitingSince < since)) since = r.awaitingSince;
    if (r.failedAt) failed = later(failed, { at: r.failedAt, error: r.failedError });
    if (r.runningAt) running = later(running, { at: r.runningAt, topic: r.runningTopic });
    if (r.dueAt) due = earlier(due, { at: r.dueAt, topic: r.dueTopic });
  }
  return { failed, running, approvedDue: due, awaiting, awaitingSince: since };
}

export class MapService {
  private cache: { at: number; snap: MapSnapshot } | null = null;
  private inflight: Promise<MapSnapshot> | null = null;
  private healthCache: { at: number; health: NetworkHealth | null } | null = null;
  private readonly q: MapQueries;

  constructor(private readonly d: MapDeps) { this.q = new MapQueries(d.pool); }

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /** The snapshot; shared for 5 s by every caller, and one build at a time. */
  async snapshot(): Promise<MapSnapshot> {
    const now = this.now().getTime();
    if (this.cache && now - this.cache.at < (this.d.cacheMs ?? MAP_CACHE_MS)) return this.cache.snap;
    if (!this.inflight) {
      this.inflight = this.build().then((snap) => { this.cache = { at: this.now().getTime(), snap }; return snap; })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async stuckHealth(): Promise<NetworkHealth | null> {
    if (!this.d.health) return null;
    const now = this.now().getTime();
    if (this.healthCache && now - this.healthCache.at < HEALTH_CACHE_MS) return this.healthCache.health;
    const health = await this.d.health().catch((err) => { this.d.log?.(`map: network health unavailable: ${err?.message ?? err}`); return null; });
    this.healthCache = { at: now, health };
    return health;
  }

  async build(): Promise<MapSnapshot> {
    const now = this.now();
    const q = this.q;
    const [
      agents, activity, catalog, budget, paused, health,
      networks, modes, running, lastRuns, slotFacts, levelRows, failedRuns, resHealth, roads, joins, dirWait, launchWait, rawInfra, channelBots,
      evRuns, evSlots, evDirs, evLaunches,
    ] = await Promise.all([
      this.d.agents.list(), this.d.agents.activity(), this.d.catalog.list(),
      this.d.budgets().catch(() => ({ rows: [] as BudgetStatus[], agentCaps: [] as AgentCapStatus[], blocking: [] as BlockingCap[] })),
      this.d.pausedRefs().catch(() => new Set<string>()), this.stuckHealth(),
      q.networks(), q.channelModes(), q.runningRuns(), q.lastRuns(), q.slotFacts(), q.levelRows(), q.failedRuns(), q.resourceHealth(),
      q.roads(), q.joins(), q.directivesWaiting(), q.launchesWaiting(), q.infra(), q.channelBots(),
      q.runEvents(), q.slotEvents(), q.directiveEvents(), q.launchEvents(),
    ]);

    const byId = new Map(agents.map((a) => [a.id, a]));
    const byHandle = new Map(agents.map((a) => [a.handle, a]));
    const catalogByRef = new Map(catalog.map((c) => [c.ref, c]));
    const titleOf = (ref: string | null | undefined) => (ref ? catalogByRef.get(ref)?.title ?? catalogByRef.get(ref)?.username ?? ref : 'another channel');
    const slotByRef = new Map(slotFacts.map((s) => [s.ref, s]));
    const healthByRef = new Map(resHealth.map((h) => [h.ref, h]));
    const anchorOf = new Map(networks.map((n) => [n.id, n.anchorRef]));

    // ── resources ──
    const resources: MapResource[] = catalog.map((c) => {
      const h = healthByRef.get(c.ref);
      const view = healthView(h?.state);
      return {
        ref: c.ref, platform: c.platform, title: c.title, username: c.username, followers: c.followers, groupId: c.groupId,
        health: view, healthDetail: view === 'warning' || view === 'broken' ? (h?.detail ? clip(h.detail, 160) : null) : null,
        paused: paused.has(c.ref), postsToday: slotByRef.get(c.ref)?.postsToday ?? 0, waiting: slotByRef.get(c.ref)?.awaiting ?? 0, agent: c.agent,
      };
    });
    const infra = infraItems(rawInfra, catalog.map((c) => c.ref), channelBots);
    const groupsWithResources = new Set(catalog.map((c) => c.groupId).filter(Boolean));
    const mapNetworks = networks.filter((n) => groupsWithResources.has(n.id));

    // ── units ──
    const orchestratorOf = (a: Agent): Agent => (a.parentId ? byId.get(a.parentId) ?? a : a);
    /** The building an agent stands next to. */
    const homeOf = (a: Agent): string | null => {
      const o = orchestratorOf(a);
      let ref: string | null = null;
      if (o.scope === 'resource') ref = o.scopeId;
      else if (o.scope === 'network' && o.scopeId) ref = anchorOf.get(o.scopeId) ?? catalog.find((c) => c.groupId === o.scopeId)?.ref ?? null;
      return ref && catalogByRef.has(ref) ? ref : null;
    };
    /** The resources an orchestrator's slots are on. */
    const refsOf = (o: Agent): string[] => {
      if (o.scope === 'resource' && o.scopeId) return [o.scopeId];
      if (o.scope === 'network' && o.scopeId) return catalog.filter((c) => c.groupId === o.scopeId).map((c) => c.ref);
      return [];
    };
    const modeOf = (a: Agent): AgentMode => {
      const o = orchestratorOf(a);
      const key = telegramKeyOf(o) ? `telegram:${telegramKeyOf(o)}` : homeOf(o);
      return (key ? (modes.get(key) as AgentMode | undefined) : undefined) ?? o.mode;
    };

    const runningBy = new Map(running.map((r) => [r.agentId, r]));
    const lastBy = new Map(lastRuns.map((r) => [r.agentId, r]));

    // level: the orchestrator's score from its resources' slots plus failed runs of it and its children
    const levelByRef = new Map(levelRows.map((r) => [r.ref, r]));
    const scoreOf = new Map<string, { clean: number; pass: number; rejected: number; failedRuns: number }>();
    for (const c of catalog) {
      const lv = levelByRef.get(c.ref);
      const owner = c.agent ? byHandle.get(c.agent) : null;
      if (!lv || !owner) continue;
      const s = scoreOf.get(owner.id) ?? { clean: 0, pass: 0, rejected: 0, failedRuns: 0 };
      s.clean += lv.clean; s.pass += lv.pass; s.rejected += lv.rejected;
      scoreOf.set(owner.id, s);
    }
    for (const a of agents) {
      const n = failedRuns.get(a.id);
      if (!n) continue;
      const o = orchestratorOf(a);
      if (o.kind !== 'orchestrator') continue;
      const s = scoreOf.get(o.id) ?? { clean: 0, pass: 0, rejected: 0, failedRuns: 0 };
      s.failedRuns += n;
      scoreOf.set(o.id, s);
    }

    const units: MapUnit[] = agents.map((a) => {
      const o = orchestratorOf(a);
      const home = homeOf(a);
      const effectiveMode = modeOf(a);
      const act = activity.get(a.id);
      const run = runningBy.get(a.id);
      const last = lastBy.get(a.id);
      const facts: UnitFacts = {
        effectiveMode, resourcePaused: !!home && paused.has(home),
        runningRun: run ? { role: run.role, startedAt: run.startedAt, topic: run.topic } : null,
        lastRun: last ? { status: last.status, finishedAt: last.finishedAt, error: last.error } : null,
        // slot-derived states belong to the orchestrator (its role children show only their own runs)
        slots: a.kind === 'orchestrator' ? mergeSlotFacts(refsOf(o).map((r) => slotByRef.get(r)).filter((x): x is SlotFacts => !!x)) : undefined,
        lastRunAt: act?.lastRunAt ?? null,
      };
      const st = unitState(a, facts, now);
      const rated = a.scope !== 'system' || a.kind === 'orchestrator';
      const lvIn = rated ? scoreOf.get(o.id) ?? { clean: 0, pass: 0, rejected: 0, failedRuns: 0 } : null;
      const stats = lvIn ? levelStats(lvIn) : null;
      return {
        id: a.id, handle: a.handle, name: a.name, kind: a.kind, emoji: a.emoji, parentId: a.parentId, homeRef: home,
        mode: a.mode, effectiveMode, state: st.state, stateSince: iso(st.since), detail: st.detail,
        spentTodayUsd: Math.round((act?.spentTodayUsd ?? 0) * 1e6) / 1e6, capUsd: a.dailyBudgetUsd == null ? null : Number(a.dailyBudgetUsd),
        runsToday: act?.runsToday ?? 0, lastRunAt: iso(act?.lastRunAt), level: stats ? levelOf(stats.score) : null, levelStats: stats,
      };
    });

    // ── roads ──
    const roadMap = new Map<string, RawRoad>();
    for (const r of roads) {
      const k = `${r.from}>${r.to}>${r.kind}`;
      const cur = roadMap.get(k);
      if (!cur) roadMap.set(k, { ...r });
      else { cur.count += r.count; if (r.lastAt && (!cur.lastAt || r.lastAt > cur.lastAt)) cur.lastAt = r.lastAt; }
    }
    const mapRoads: MapRoad[] = [...roadMap.values()]
      .filter((r) => r.from !== r.to && catalogByRef.has(r.from) && catalogByRef.has(r.to))
      .map((r) => ({ from: r.from, to: r.to, kind: r.kind, count30d: r.count, lastAt: iso(r.lastAt), joins30d: r.kind === 'promo' ? joins.get(`${r.from}>${r.to}`) ?? null : null }))
      .sort((a, b) => b.count30d - a.count30d || (a.from + a.to).localeCompare(b.from + b.to));

    // ── alerts ──
    const alerts: MapAlert[] = [];
    for (const r of resources) {
      if (r.waiting > 0) {
        alerts.push({ kind: 'approval', count: r.waiting, ref: r.ref, agent: r.agent, path: '/app/agents/inbox?tab=approvals',
          title: `${r.waiting} ${plural(r.waiting, 'post waits', 'posts wait')} for approval on ${titleOf(r.ref)}` });
      }
    }
    for (const r of resources) {
      if (r.health === 'warning' || r.health === 'broken') {
        const muted = healthByRef.get(r.ref)?.muted;
        if (muted) continue;
        alerts.push({ kind: 'connection', count: 1, ref: r.ref, agent: r.agent, path: `/app/connections?section=${CONNECTION_SECTION[r.platform]}`,
          title: `${titleOf(r.ref)}: ${r.healthDetail ?? (r.health === 'broken' ? 'connection problem' : 'connection needs attention')}` });
      }
    }
    for (const i of infra) {
      if (!i.active || i.health !== 'broken') continue;
      alerts.push({ kind: 'connection', count: 1, ref: i.id, agent: null, path: i.path, title: `${INFRA_NOUN[i.kind]} ${i.title}: ${i.healthDetail ?? 'the last check failed'}` });
    }
    for (const d of dirWait) {
      const a = byHandle.get(d.handle);
      alerts.push({ kind: 'directive', count: d.count, ref: a ? homeOf(a) : null, agent: d.handle, path: '/app/agents/manager?tab=directives',
        title: `${d.count} ${plural(d.count, 'directive waits', 'directives wait')} for your decision (@${d.handle})` });
    }
    for (const l of launchWait) {
      alerts.push({ kind: 'launch', count: 1, ref: catalogByRef.has(l.targetRef) ? l.targetRef : null, agent: l.handle, path: `/app/artifacts?type=launch&open=launch:${l.id}`,
        title: l.status === 'ready' ? `${l.channelKey}: the launch plan is ready for Start` : `${l.channelKey}: ready to go Live` });
    }
    for (const g of health?.stuck ?? []) {
      if (g.count <= 0 || g.kind === 'approval_waiting') continue; // the approval alerts above already count waiting posts
      const first = g.items[0];
      const ref = first?.channelKey ? `telegram:${first.channelKey}` : null;
      alerts.push({ kind: 'stuck', count: g.count, ref: ref && catalogByRef.has(ref) ? ref : null, agent: first?.agent ?? null, path: '/app/health', title: `${g.label}: ${g.count}` });
    }
    const blocking = budget.blocking;
    if (blocking.length) {
      alerts.push({ kind: 'budget', count: blocking.length, ref: null, agent: null, path: '/app/spend',
        title: `${blocking.length} spend ${plural(blocking.length, 'cap blocks', 'caps block')} AI calls (${blocking.slice(0, 2).map((b) => b.label).join(', ')})` });
    }

    // ── events ──
    const unitById = new Map(units.map((u) => [u.id, u]));
    const agentHandleOf = (e: RawEvent): string | null => {
      if (e.agentId) return byId.get(e.agentId)?.handle ?? null;
      const owner = (e.ref ? catalogByRef.get(e.ref)?.agent : null) ?? null;
      return owner;
    };
    const events: MapEvent[] = [...evRuns, ...evSlots, ...evDirs, ...evLaunches]
      .sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id))
      .slice(0, MAX_EVENTS)
      .map((e) => ({
        id: e.id, at: e.at.toISOString(), kind: e.kind as MapEvent['kind'], agent: agentHandleOf(e),
        // an agent's own events stand at its building (a run's channel key is only a fallback)
        ref: (e.agentId ? unitById.get(e.agentId)?.homeRef : null) ?? e.ref ?? null,
        ...(e.toRef ? { toRef: e.toRef } : {}), text: eventText(e, titleOf),
      }));

    // ── top bar ──
    const global = budget.rows.find((b) => b.scopeKind === 'global' && b.dailyUsd != null) ?? budget.rows.find((b) => b.scopeKind === 'global');
    const spent = global ? global.spentTodayUsd : units.reduce((t, u) => t + u.spentTodayUsd, 0);
    const mapBudget: MapBudget = {
      spentUsd: Math.round(spent * 1e4) / 1e4, capUsd: global?.dailyUsd ?? null,
      pct: global?.dailyUsd ? Math.round((spent / global.dailyUsd) * 1000) / 10 : null, blocking: blocking.length > 0,
    };

    return {
      generatedAt: now.toISOString(), budget: mapBudget,
      totals: { runsToday: units.reduce((t, u) => t + u.runsToday, 0), postsToday: resources.reduce((t, r) => t + r.postsToday, 0) },
      networks: mapNetworks, resources, infra, units, roads: mapRoads, alerts, events,
    };
  }
}
