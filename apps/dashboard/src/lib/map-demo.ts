import type {
  MapAgentKind, MapEvent, MapPlatform, MapResource, MapRoad, MapSnapshot, MapUnit, UnitState,
} from '../api/map';

// Spec 056: a deterministic demo network for the tests and for a mock backend (`demoSnapshot(tick)`: every tick moves a
// few units into another state and adds an event, so the diff and the animations can be exercised without a server).
// Not imported by the app itself.

interface DemoResource { ref: string; platform: MapPlatform; title: string; followers: number | null; group: string | null }

const RESOURCES: DemoResource[] = [
  { ref: 'telegram:@ai0_global', platform: 'telegram', title: 'AI0 Global', followers: 18400, group: 'g-tech' },
  { ref: 'instagram:ig-tech', platform: 'instagram', title: 'ai0.global', followers: 5200, group: 'g-tech' },
  { ref: 'facebook:fb-tech', platform: 'facebook', title: 'AI0 Global FB', followers: 2100, group: 'g-tech' },
  { ref: 'threads:th-tech', platform: 'threads', title: 'ai0.global', followers: 980, group: 'g-tech' },
  { ref: 'tiktok:tt-tech', platform: 'tiktok', title: 'ai0.global', followers: null, group: 'g-tech' },
  { ref: 'telegram:@recipes_ua', platform: 'telegram', title: 'Recipes', followers: 42100, group: 'g-food' },
  { ref: 'instagram:ig-food', platform: 'instagram', title: 'recipes.ua', followers: 15800, group: 'g-food' },
  { ref: 'tiktok:tt-food', platform: 'tiktok', title: 'recipes.ua', followers: null, group: 'g-food' },
  { ref: 'telegram:@space_ua', platform: 'telegram', title: 'Space', followers: 9300, group: 'g-space' },
  { ref: 'telegram:@movies_ua', platform: 'telegram', title: 'Movies', followers: 6700, group: null },
  { ref: 'telegram:@gaming_ua', platform: 'telegram', title: 'Gaming', followers: 3400, group: null },
];

const NETWORKS = [
  { id: 'g-tech', name: 'Tech & Science', anchorRef: 'telegram:@ai0_global' },
  { id: 'g-food', name: 'Food', anchorRef: 'telegram:@recipes_ua' },
  { id: 'g-space', name: 'Space', anchorRef: 'telegram:@space_ua' },
];

const handleOf = (ref: string) => ref.replace(/^[a-z]+:/, '').replace(/^@/, '').replace(/[^a-z0-9_]+/gi, '_').toLowerCase();

const CHILDREN: MapAgentKind[] = ['planner', 'executor', 'reviewer', 'idea_reviewer'];

/** The state a unit has at a tick: a base pattern, then a few units rotate through work states as the ticks advance. */
const BASE_STATES: UnitState[] = ['idle', 'idle', 'writing', 'idle', 'reviewing', 'idle', 'planning', 'idle', 'waiting', 'idle', 'idle', 'error', 'idle', 'paused', 'idle'];
const ROTATION: UnitState[] = ['planning', 'writing', 'reviewing', 'publishing', 'idle'];

export function demoSnapshot(tick = 0, now: Date = new Date('2026-10-20T12:00:00Z')): MapSnapshot {
  const at = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const units: MapUnit[] = [];
  const push = (u: Partial<MapUnit> & Pick<MapUnit, 'id' | 'handle' | 'name' | 'kind'>) => {
    const n = units.length;
    let state: UnitState = u.state ?? BASE_STATES[n % BASE_STATES.length];
    // From tick 1 on, unit n works through the rotation when (n + tick) hits its slot.
    if (tick > 0 && n % 4 === tick % 4) state = ROTATION[(tick + n) % ROTATION.length];
    const level = u.level === undefined ? 1 + (n % 7) : u.level;
    units.push({
      emoji: null, parentId: null, homeRef: null, mode: 'live', effectiveMode: 'live', stateSince: state === 'idle' ? null : at(2 + (n % 9)), detail: null,
      spentTodayUsd: Math.round((0.02 + (n % 5) * 0.037) * 1000) / 1000, capUsd: null, runsToday: n % 6, lastRunAt: at(3 + n), level, levelStats: level == null ? null : { clean: 6 + level, pass: 4 + level, rejected: n % 3, failedRuns: n % 2, score: level * 10 - 6 },
      ...u, state,
    });
    const last = units[units.length - 1];
    last.detail = last.state === 'idle' ? null : last.state === 'waiting' ? '2 posts wait for you' : last.state === 'error' ? 'publish_failed' : last.state === 'paused' ? 'paused by the owner' : `Topic ${n}`;
  };

  push({ id: 'u-manager', handle: 'manager', name: 'MANAGER', kind: 'manager', emoji: '🧭', level: null, state: tick > 0 && tick % 5 === 0 ? 'planning' : 'idle' });
  push({ id: 'u-ai0', handle: 'ai0', name: '@ai0', kind: 'builder', emoji: '🛠', level: null, state: 'idle' });
  for (const r of RESOURCES) {
    const h = handleOf(r.ref);
    const oid = `u-${h}`;
    push({ id: oid, handle: h, name: r.title, kind: 'orchestrator', homeRef: r.ref });
    for (const k of CHILDREN) {
      if (k === 'idea_reviewer' && r.platform !== 'telegram') continue;
      push({ id: `${oid}-${k}`, handle: `${h}_${k}`, name: `${r.title} ${k}`, kind: k, parentId: oid, homeRef: r.ref });
    }
  }

  const waitingOf = (ref: string) => units.find((u) => u.homeRef === ref && u.kind === 'orchestrator' && u.state === 'waiting') ? 2 : 0;
  const resources: MapResource[] = RESOURCES.map((r, i) => ({
    ref: r.ref, platform: r.platform, title: r.title, username: r.platform === 'telegram' ? r.ref.replace(/^telegram:@/, '') : null,
    followers: r.followers, groupId: r.group, health: r.ref === 'instagram:ig-food' ? 'broken' : r.ref === 'tiktok:tt-tech' ? 'warning' : 'ok',
    healthDetail: r.ref === 'instagram:ig-food' ? 'token expired' : r.ref === 'tiktok:tt-tech' ? 'token expires in 5 days' : null,
    paused: r.ref === 'telegram:@gaming_ua', postsToday: (i * 3) % 5, waiting: waitingOf(r.ref), agent: handleOf(r.ref),
  }));

  const roads: MapRoad[] = [
    { from: 'telegram:@ai0_global', to: 'instagram:ig-tech', kind: 'promo', count30d: 9, lastAt: at(180), joins30d: 41 },
    { from: 'instagram:ig-tech', to: 'telegram:@ai0_global', kind: 'promo', count30d: 4, lastAt: at(900), joins30d: null },
    { from: 'telegram:@recipes_ua', to: 'instagram:ig-food', kind: 'repost', count30d: 15, lastAt: at(60), joins30d: null },
    { from: 'telegram:@recipes_ua', to: 'tiktok:tt-food', kind: 'duplicate', count30d: 6, lastAt: at(300), joins30d: null },
    { from: 'telegram:@ai0_global', to: 'telegram:@space_ua', kind: 'promo', count30d: 2, lastAt: at(2600), joins30d: 7 },
    { from: 'telegram:@movies_ua', to: 'telegram:@gaming_ua', kind: 'promo', count30d: 3, lastAt: at(1500), joins30d: null },
  ];

  const events: MapEvent[] = [];
  const ev = (id: string, minAgo: number, kind: MapEvent['kind'], agent: string | null, ref: string | null, text: string, toRef?: string) =>
    events.push({ id, at: at(minAgo), kind, agent, ref, ...(toRef ? { toRef } : {}), text });
  // New events arrive with the ticks (oldest first so the newest ends up on top).
  for (let t = Math.max(1, tick - 11); t <= tick; t++) {
    const r = RESOURCES[t % RESOURCES.length];
    const h = handleOf(r.ref);
    const minAgo = (tick - t) * 1 + 0.2;
    if (t % 4 === 0) ev(`slot:t${t}:promo`, minAgo, 'promo', h, r.ref, `promoted ${RESOURCES[(t + 1) % RESOURCES.length].title}`, RESOURCES[(t + 1) % RESOURCES.length].ref);
    else if (t % 4 === 1) ev(`slot:t${t}:published`, minAgo, 'post_published', h, r.ref, `published "Demo post ${t}"`);
    else if (t % 4 === 2) ev(`run:t${t}:end`, minAgo, 'run_finished', `${h}_executor`, r.ref, 'finished writing');
    else ev(`run:t${t}:fail`, minAgo, 'run_failed', `${h}_planner`, r.ref, 'run failed while planning: hit its budget');
  }
  ev('slot:base:approved', 40, 'post_approved', 'recipes_ua', 'telegram:@recipes_ua', 'you approved "Borscht, the quick way"');
  ev('dir:base', 95, 'directive', 'ai0_global', 'telegram:@ai0_global', 'received a cross promo directive');
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return {
    generatedAt: now.toISOString(),
    budget: { spentUsd: 1.84 + tick * 0.01, capUsd: 3, pct: Math.round(((1.84 + tick * 0.01) / 3) * 1000) / 10, blocking: false },
    totals: { runsToday: units.reduce((s, u) => s + u.runsToday, 0), postsToday: resources.reduce((s, r) => s + r.postsToday, 0) },
    networks: NETWORKS, resources, units, roads,
    alerts: [
      { kind: 'approval', count: 2, ref: 'telegram:@ai0_global', agent: 'ai0_global', title: '2 posts wait for approval on AI0 Global', path: '/app/agents/inbox?tab=approvals' },
      { kind: 'connection', count: 1, ref: 'instagram:ig-food', agent: 'ig_food', title: 'recipes.ua: token expired', path: '/app/connections' },
      { kind: 'directive', count: 1, ref: 'telegram:@space_ua', agent: 'space_ua', title: '1 directive waits for your decision (@space_ua)', path: '/app/agents/manager?tab=directives' },
    ],
    events: events.slice(0, 30),
  };
}
