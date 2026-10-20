import type {
  MapAgentKind, MapEvent, MapInfra, MapPlatform, MapResource, MapRoad, MapSnapshot, MapUnit, UnitState,
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
  { ref: 'instagram:ig-solo', platform: 'instagram', title: 'solo.shop', followers: 1200, group: null },
  { ref: 'facebook:fb-old', platform: 'facebook', title: 'Old test page', followers: 310, group: null },
];

const INFRA: MapInfra[] = [
  { id: 'bot:main', kind: 'bot', title: '@ai0_publisher_bot', username: 'ai0_publisher_bot', health: 'ok', healthDetail: null, active: true, isDefault: true, role: null, inUse: true,
    lastVerifiedAt: '2026-10-20T09:00:00Z', serves: ['telegram:@ai0_global', 'telegram:@gaming_ua', 'telegram:@recipes_ua', 'telegram:@space_ua'], path: '/app/connections?section=telegram&tab=bots' },
  { id: 'bot:movies', kind: 'bot', title: '@movies_poster_bot', username: 'movies_poster_bot', health: 'broken', healthDetail: '401 Unauthorized', active: true, isDefault: false, role: null, inUse: true,
    lastVerifiedAt: '2026-10-19T09:00:00Z', serves: ['telegram:@movies_ua'], path: '/app/connections?section=telegram&tab=bots' },
  { id: 'bot:old', kind: 'bot', title: '@old_test_bot', username: 'old_test_bot', health: 'unknown', healthDetail: null, active: false, isDefault: false, role: null, inUse: false,
    lastVerifiedAt: null, serves: [], path: '/app/connections?section=telegram&tab=bots' },
  { id: 'mtproto:tracker', kind: 'mtproto', title: 'Stats reader', username: 'ai0_stats', health: 'ok', healthDetail: null, active: true, isDefault: false, role: 'tracker', inUse: true,
    lastVerifiedAt: '2026-10-20T08:00:00Z', serves: ['telegram:@ai0_global', 'telegram:@gaming_ua', 'telegram:@movies_ua', 'telegram:@recipes_ua', 'telegram:@space_ua'], path: '/app/connections?section=telegram&tab=sessions' },
  { id: 'mtproto:agent', kind: 'mtproto', title: 'Agent account', username: 'ai0_agent', health: 'ok', healthDetail: null, active: true, isDefault: false, role: 'agent', inUse: true,
    lastVerifiedAt: '2026-10-20T08:00:00Z', serves: [], path: '/app/connections?section=telegram&tab=sessions' },
  { id: 'telegraph:default', kind: 'telegraph', title: 'ai0', username: 'AI0 Global', health: 'ok', healthDetail: null, active: true, isDefault: false, role: null, inUse: true,
    lastVerifiedAt: '2026-10-18T08:00:00Z', serves: [], path: '/app/connections?section=telegram&tab=telegraph' },
];

const NETWORKS = [
  { id: 'g-tech', name: 'Tech & Science', anchorRef: 'telegram:@ai0_global', mode: 'independent' as const },
  { id: 'g-food', name: 'Food', anchorRef: 'telegram:@recipes_ua', mode: 'legacy_duplicate' as const },
  { id: 'g-space', name: 'Space', anchorRef: 'telegram:@space_ua', mode: 'independent' as const },
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
    mode: (['live', 'live', 'approve', 'shadow', 'live', 'approve', 'live', 'off', 'live', 'shadow', 'live', 'approve'] as const)[i % 12],
  }));

  // Roads are the current links (spec 058): the networks' copy links, the promo links the owner made, and — on request — past ones.
  const road = (r: Partial<MapRoad> & Pick<MapRoad, 'from' | 'to' | 'kind'>): MapRoad => ({
    count30d: 0, lastAt: null, joins30d: null, relation: 'promo', past: false, linkedAt: null, blocked: false, ...r,
  });
  const copy = (from: string, to: string, kind: 'duplicate' | 'adapt', count30d: number, minAgo: number | null) =>
    road({ from, to, kind, relation: 'network', count30d, lastAt: minAgo == null ? null : at(minAgo) });
  const roads: MapRoad[] = [
    // copy links: an Independent network (Tech & Science; Threads is a member with no copies yet), an Auto-duplicate one (Food)
    copy('telegram:@ai0_global', 'instagram:ig-tech', 'adapt', 12, 60),
    copy('telegram:@ai0_global', 'facebook:fb-tech', 'adapt', 8, 240),
    copy('telegram:@ai0_global', 'threads:th-tech', 'adapt', 0, null),
    copy('telegram:@ai0_global', 'tiktok:tt-tech', 'adapt', 3, 1500),
    copy('telegram:@recipes_ua', 'instagram:ig-food', 'duplicate', 15, 60),
    copy('telegram:@recipes_ua', 'tiktok:tt-food', 'duplicate', 6, 300),
    // promo links: with traffic, a repost link, and a pair linked a moment ago with no traffic yet
    road({ from: 'telegram:@ai0_global', to: 'instagram:ig-tech', kind: 'promo', count30d: 13, lastAt: at(180), joins30d: 41, linkedAt: at(60 * 24 * 20) }),
    road({ from: 'telegram:@ai0_global', to: 'telegram:@space_ua', kind: 'promo', count30d: 2, lastAt: at(2600), joins30d: 7, linkedAt: at(60 * 24 * 9) }),
    road({ from: 'telegram:@recipes_ua', to: 'telegram:@movies_ua', kind: 'repost', count30d: 5, lastAt: at(500), linkedAt: at(60 * 24 * 12) }),
    road({ from: 'instagram:ig-solo', to: 'telegram:@movies_ua', kind: 'promo', linkedAt: at(4) }),
    // past links: a pair the owner unlinked, an old pair nobody unlinked, a resource that left the Food network
    road({ from: 'telegram:@movies_ua', to: 'telegram:@gaming_ua', kind: 'promo', count30d: 3, lastAt: at(1500), past: true, blocked: true }),
    road({ from: 'telegram:@gaming_ua', to: 'instagram:ig-solo', kind: 'promo', count30d: 2, lastAt: at(3200), past: true }),
    road({ from: 'telegram:@recipes_ua', to: 'facebook:fb-old', kind: 'duplicate', relation: 'network', count30d: 4, lastAt: at(2000), past: true }),
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
  ev('link:base:1', 25, 'link_made', null, 'instagram:ig-solo', 'you linked solo.shop and Movies', 'telegram:@movies_ua');
  ev('link:base:2', 70, 'network_left', null, 'facebook:fb-old', 'Old test page left Food');
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return {
    generatedAt: now.toISOString(),
    budget: { spentUsd: 1.84 + tick * 0.01, capUsd: 3, pct: Math.round(((1.84 + tick * 0.01) / 3) * 1000) / 10, blocking: false },
    totals: { runsToday: units.reduce((s, u) => s + u.runsToday, 0), postsToday: resources.reduce((s, r) => s + r.postsToday, 0) },
    networks: NETWORKS, resources, infra: INFRA, units, roads,
    alerts: [
      { kind: 'approval', count: 2, ref: 'telegram:@ai0_global', agent: 'ai0_global', title: '2 posts wait for approval on AI0 Global', path: '/app/agents/inbox?tab=approvals' },
      { kind: 'connection', count: 1, ref: 'instagram:ig-food', agent: 'ig_food', title: 'recipes.ua: token expired', path: '/app/connections' },
      { kind: 'connection', count: 1, ref: 'bot:movies', agent: null, title: 'Telegram bot @movies_poster_bot: 401 Unauthorized', path: '/app/connections?section=telegram&tab=bots' },
      { kind: 'directive', count: 1, ref: 'telegram:@space_ua', agent: 'space_ua', title: '1 directive waits for your decision (@space_ua)', path: '/app/agents/manager?tab=directives' },
    ],
    events: events.slice(0, 30),
  };
}
