// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B5: the pure rules behind the redesigned landing — public titles, the orbit's agents, the channel marquee, the hero
// pill, the agent.log lines, the role explorer copy and the #networks heading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LandingNetwork, LandingNetworkAgent, LandingNetworkResource, LandingPulse } from '../api/landing';
import {
  GUARDS, LOOP_STEPS, ROLES, agentLogLines, agentNodes, explorerRoles, fillTo, heroLivePill, initials, livePlatforms,
  marqueeChannels, networkHeadline, orchestratorCount, publicTitle, ringAngles,
} from './landing-view';

const res = (
  platform: LandingNetworkResource['platform'], handle: string | null, displayName: string | null, order = 0,
  aiRun: LandingNetworkResource['aiRun'] = 'live',
): LandingNetworkResource => ({
  platform, handle, displayName, avatarUrl: null, followerCount: null, url: null, order, aiRun, adDmUrl: null,
});

const net = (name: string | null, resources: LandingNetworkResource[], agent: LandingNetwork['agent'] = null): LandingNetwork => ({
  name, blurb: null, order: 0, agent, followers: null, platforms: [], adDmUrl: null, resources,
});

const agent = (name: string, mode: LandingNetworkAgent['mode']): LandingNetworkAgent => ({ name, emoji: null, mode });

function pulse(over: Partial<LandingPulse['last7d']> = {}, agents: Partial<LandingPulse['agents']> = {}, lastAgentPostAt: string | null = null): LandingPulse {
  return {
    agents: { orchestratorsLive: 0, orchestratorsShadow: 0, rolesActive: [], manager: 'off', ...agents },
    last7d: {
      agentPosts: 0, allPosts: 0, autonomyShare: 0, platforms: [], agentRuns: 0, skippedByAgents: 0,
      directivesFiled: 0, managerReviews: 0, ideasReviewed: 0, ownerDecisions: 0, ...over,
    },
    lastAgentPostAt, claims: { managerLive: false }, generatedAt: '2026-10-08T10:00:00Z', stale: false,
  };
}

test('publicTitle drops the dev suffix of a synced channel title, whatever its case or spacing', () => {
  assert.equal(publicTitle('AI Technologies | DEV'), 'AI Technologies');
  assert.equal(publicTitle('AI Technologies |DEV'), 'AI Technologies');
  assert.equal(publicTitle('AI Technologies   |   dev  '), 'AI Technologies');
  assert.equal(publicTitle('AI News (dev)'), 'AI News');
  assert.equal(publicTitle('Recipes [DEV]'), 'Recipes');
  assert.equal(publicTitle('Developer Tools'), 'Developer Tools', 'only a trailing marker goes');
  assert.equal(publicTitle('DEV | Notes'), 'DEV | Notes', 'a leading one is part of the name');
  assert.equal(publicTitle('| DEV'), null, 'nothing left: the caller falls back to the handle');
  assert.equal(publicTitle(null), null);
  assert.equal(publicTitle(undefined), null);
  assert.equal(publicTitle('  '), null);
});

test('initials: the first two characters, the first in capitals', () => {
  assert.equal(initials('nova'), 'No');
  assert.equal(initials('  Prompts'), 'Pr');
  assert.equal(initials('X'), 'X');
  assert.equal(initials(''), '');
});

test('orbit agents: one tile per agent name, live before shadow, never a network without an agent', () => {
  const nodes = agentNodes([
    net('Pipeline only', [res('telegram', 'p', null)]),
    net('One', [], agent('Kit', 'shadow')),
    net('Two', [], agent('Nova', 'live')),
    net('Three', [], agent('nova', 'live')),
    net(null, [res('telegram', 's', null, 1)], agent('Loco', 'live')),
  ]);
  assert.deepEqual(nodes.map((n) => [n.name, n.mode]), [['Nova', 'live'], ['Loco', 'live'], ['Kit', 'shadow']]);
  assert.equal(nodes[0].initials, 'No');
  assert.equal(agentNodes(Array.from({ length: 9 }, (_, i) => net(`N${i}`, [], agent(`Agent ${i}`, 'live')))).length, 5, 'at most 5');
  assert.deepEqual(agentNodes(undefined), []);
  assert.deepEqual(agentNodes([net('x', [res('telegram', 'a', null)])]), []);
});

test('ring angles spread evenly from the start angle', () => {
  assert.deepEqual(ringAngles(5, -90), [-90, -18, 54, 126, 198]);
  assert.deepEqual(ringAngles(1, -140), [-140]);
  assert.deepEqual(ringAngles(0, 0), []);
  assert.deepEqual(ringAngles(3, 0), [0, 120, 240]);
});

test('the hero pill says "live" only with live agents, and names the platforms that had agent posts', () => {
  assert.deepEqual(heroLivePill(undefined, 0), { text: 'A network run by AI agents', live: false });
  assert.deepEqual(heroLivePill(pulse(), 3), { text: 'A network run by AI agents · 3 platforms', live: false }, 'zero live agents: the plain pill');
  const tg = [{ platform: 'telegram' as const, posts: 5, agentPosts: 5 }, { platform: 'tiktok' as const, posts: 2, agentPosts: 0 }];
  assert.equal(heroLivePill(pulse({ platforms: tg }, { orchestratorsLive: 1 }), 2).text, 'Live · 1 agent publishing to Telegram');
  const two = [...tg, { platform: 'instagram' as const, posts: 4, agentPosts: 2 }];
  assert.equal(heroLivePill(pulse({ platforms: two }, { orchestratorsLive: 2 }), 2).text, 'Live · 2 agents publishing to Telegram and Instagram');
  const three = [...two, { platform: 'threads' as const, posts: 1, agentPosts: 1 }];
  assert.equal(heroLivePill(pulse({ platforms: three }, { orchestratorsLive: 4 }), 2).text, 'Live · 4 agents publishing to 3 platforms');
  assert.equal(heroLivePill(pulse({}, { orchestratorsLive: 2 }), 2).text, 'Live · 2 agents publishing', 'no platform with agent posts: no "to"');
  assert.deepEqual(livePlatforms(pulse({ platforms: three })), ['telegram', 'instagram', 'threads']);
});

test('marquee channels: payload order, public title, handle only when the title replaces it, capped', () => {
  const nets = [
    net('A', [res('telegram', 'ai_news', 'AI News | DEV', 0), res('instagram', 'ai.news', 'AI News', 1, 'shadow')]),
    net(null, [res('telegram', 'quotes', null, 2, 'none'), res('facebook', null, null, 3)]),
  ];
  const ch = marqueeChannels(nets);
  assert.deepEqual(ch.map((c) => [c.name, c.handle, c.platform, c.aiRun]), [
    ['AI News', '@ai_news', 'telegram', 'live'],
    ['AI News', '@ai.news', 'instagram', 'shadow'],
    ['@quotes', null, 'telegram', 'none'],
    ['Facebook', null, 'facebook', 'live'],
  ]);
  assert.equal(new Set(ch.map((c) => c.key)).size, 4, 'keys are unique even for equal names');
  assert.ok(ch.every((c) => !/dev/i.test(c.name)));
  assert.equal(marqueeChannels(nets, 2).length, 2);
  assert.deepEqual(marqueeChannels(undefined), []);
});

test('fillTo pads a short list by repeating it, and numbers the copies', () => {
  assert.deepEqual(fillTo([], 5), []);
  assert.deepEqual(fillTo(['a', 'b'], 5).map((x) => `${x.item}${x.copy}`), ['a0', 'b0', 'a1', 'b1', 'a2']);
  assert.equal(fillTo(['a', 'b', 'c'], 2).length, 3, 'never fewer than the list itself');
});

test('agent.log lines come from the pulse only, and a zero count leaves its line out', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.deepEqual(agentLogLines(undefined, now), []);
  assert.deepEqual(agentLogLines(pulse(), now), [], 'an empty week: no terminal');
  const full = pulse(
    { agentPosts: 30, autonomyShare: 88, skippedByAgents: 1, ideasReviewed: 4, agentRuns: 12, managerReviews: 2, directivesFiled: 1, ownerDecisions: 3 },
    {}, '2026-10-08T10:00:00Z',
  );
  full.claims.managerLive = true;
  const lines = agentLogLines(full, now);
  assert.deepEqual(lines.map((l) => [l.role, l.text]), [
    ['executor', '30 posts published (88% of all)'],
    ['executor', '1 slot skipped by the agent’s own call'],
    ['idea reviewer', '4 ideas reviewed'],
    ['agents', '12 successful runs'],
    ['manager', '2 reviews, 1 directive'],
    ['owner', '3 decisions'],
    ['last post', '2 h ago'],
  ]);
  assert.equal(lines.find((l) => l.role === 'owner')?.owner, true);
  assert.equal(new Set(lines.map((l) => l.key)).size, lines.length);
  full.claims.managerLive = false;
  assert.ok(!agentLogLines(full, now).some((l) => l.role === 'manager'), 'manager lines only while the MANAGER is live');
  assert.deepEqual(agentLogLines(pulse({ agentPosts: 1 }), now).map((l) => l.text), ['1 post published']);
});

test('role explorer: seven roles, the workers keyed like the pulse, MANAGER copy gated by managerLive', () => {
  const live = explorerRoles(true);
  assert.deepEqual(live.map((r) => r.num), ['01', '02', '03', '04', '05', '06', '07']);
  assert.deepEqual(live.slice(2).map((r) => r.id), ROLES.map((r) => r.kind), 'worker ids are the ROLES kinds, in order');
  assert.deepEqual(live.slice(2).map((r) => r.title), ROLES.map((r) => r.label));
  assert.equal(new Set(live.map((r) => r.id)).size, 7);
  assert.equal(live[0].soon, false);
  assert.match(live[0].desc, /^Reads /);
  assert.equal(live[1].up, 'MANAGER');
  const soon = explorerRoles(false);
  assert.equal(soon[0].soon, true);
  assert.match(soon[0].desc, /^Will read /);
  assert.equal(soon[1].up, 'the owner', 'no MANAGER yet: the orchestrators report to the owner');
  assert.ok(soon.every((r) => r.tags.length > 0 && r.desc.length > 20));
  assert.deepEqual(live[5].tags, ['dedup', 'rate limits', 'quiet hours', 'budget', 'kill switch']);
});

test('orchestrator count adds live and training agents', () => {
  assert.equal(orchestratorCount(undefined), 0);
  assert.equal(orchestratorCount(pulse({}, { orchestratorsLive: 2, orchestratorsShadow: 1 })), 3);
});

test('guards and loop steps: the five gates of the Executor copy, six steps on a circle', () => {
  assert.deepEqual(GUARDS.map((g) => g.label), ['Dedup', 'Rate limits', 'Quiet hours', 'Budget', 'Kill switch']);
  assert.deepEqual(GUARDS.map((g) => g.at), [18, 34, 50, 66, 82]);
  const executor = explorerRoles(true).find((r) => r.id === 'executor')?.desc.toLowerCase() ?? '';
  for (const g of GUARDS) assert.ok(executor.includes(g.label.toLowerCase()), `${g.label} is named by the Executor copy`);
  assert.deepEqual(LOOP_STEPS.map((s) => s.label), ['Plan', 'Write', 'Guard', 'Publish', 'Measure', 'Learn']);
  for (const s of LOOP_STEPS) {
    const r = Math.hypot(s.x - 50, s.y - 50);
    assert.ok(r > 38 && r < 41, `${s.label} sits on the ring (r=${r.toFixed(1)})`);
  }
});

test('network headline is made of the payload and never claims more than the cards show', () => {
  assert.deepEqual(networkHeadline(undefined), { lead: 'The network', rest: null });
  assert.deepEqual(networkHeadline([]), { lead: 'The network', rest: null });
  const mixed = [
    net('A', [res('telegram', 'a', null, 0), res('instagram', 'b', null, 1, 'shadow')]),
    net(null, [res('telegram', 'c', null, 2, 'none')]),
  ];
  assert.deepEqual(networkHeadline(mixed), { lead: '3 channels and profiles', rest: '1 run by AI agents today' });
  assert.deepEqual(networkHeadline([net('A', [res('telegram', 'a', null, 0, 'shadow')])]), { lead: '1 channel or profile', rest: 'AI agents are training in shadow' });
  assert.deepEqual(networkHeadline([net(null, [res('telegram', 'a', null, 0, 'none')])]), { lead: '1 channel or profile', rest: null });
});
