// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LandingNetwork, LandingNetworkResource, LandingPulse } from '../api/landing';
import {
  agentChip, aiRunBadge, audienceStats, diagramNodes, heroPill, heroPlatforms, networkPlatforms,
  proofTiles, relativeTime, resourceKey, roleChips,
} from './landing-view';

const res = (platform: LandingNetworkResource['platform'], handle: string, order: number, followers: number | null = null): LandingNetworkResource => ({
  platform, handle, displayName: null, avatarUrl: null, followerCount: followers, url: null, order, aiRun: 'live', adDmUrl: null,
});

const net = (name: string | null, resources: LandingNetworkResource[], agent: LandingNetwork['agent'] = null): LandingNetwork => ({
  name, blurb: null, order: 0, agent, followers: null, platforms: [], adDmUrl: null, resources,
});

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

test('zero-value proof tiles are hidden; an empty pulse hides the whole strip', () => {
  assert.deepEqual(proofTiles(undefined), []);
  assert.deepEqual(proofTiles(pulse()), [], 'zero agent posts: no tiles at all');
  const now = Date.parse('2026-10-08T12:00:00Z');
  const tiles = proofTiles(pulse({ agentPosts: 42, autonomyShare: 0 }, { orchestratorsLive: 3 }, '2026-10-08T11:00:00Z'), now);
  assert.deepEqual(tiles.map((t) => [t.key, t.value, t.label]), [
    ['agentPosts', '42', 'posts by agents in 7 days'],
    ['orchestratorsLive', '3', 'agents live'],
    ['lastAgentPost', '1 h ago', 'last agent post'],
  ]);
  for (const t of tiles) assert.ok(t.definition.length > 20, 'every tile explains its number');
  const one = proofTiles(pulse({ agentPosts: 1, autonomyShare: 64 }, { orchestratorsLive: 1 }), now);
  assert.deepEqual(one.map((t) => t.label), ['post by agents in 7 days', 'agent live', 'of content created by agents']);
  assert.equal(one[2].value, '64%');
});

test('relative time', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.equal(relativeTime('2026-10-08T11:59:40Z', now), 'just now');
  assert.equal(relativeTime('2026-10-08T11:48:00Z', now), '12 min ago');
  assert.equal(relativeTime('2026-10-07T11:00:00Z', now), '1 day ago');
  assert.equal(relativeTime('2026-10-05T11:00:00Z', now), '3 days ago');
  assert.equal(relativeTime('2026-10-09T11:00:00Z', now), 'just now', 'clock skew never shows the future');
});

test('platform count: YouTube counts only when a featured YouTube resource is in the payload', () => {
  const base = [net('A', [res('telegram', 'a', 0), res('instagram', 'b', 1)]), net(null, [res('telegram', 'c', 2)])];
  assert.deepEqual(networkPlatforms(base), ['telegram', 'instagram']);
  assert.equal(heroPill(networkPlatforms(base).length), 'A network run by AI agents · 2 platforms');
  const withYt = [...base, net('B', [res('youtube', 'yt', 3)])];
  assert.deepEqual(networkPlatforms(withYt), ['telegram', 'instagram', 'youtube']);
  assert.equal(heroPill(networkPlatforms(withYt).length), 'A network run by AI agents · 3 platforms');
  assert.equal(heroPill(0), 'A network run by AI agents');
  assert.equal(heroPill(1), 'A network run by AI agents · 1 platform');
});

test('hero platforms fall back to the pulse when the showcase is empty', () => {
  const p = pulse({ platforms: [{ platform: 'tiktok', posts: 3, agentPosts: 1 }, { platform: 'telegram', posts: 5, agentPosts: 5 }] });
  assert.deepEqual(heroPlatforms([], p), ['telegram', 'tiktok']);
  assert.deepEqual(heroPlatforms(undefined, undefined), []);
  assert.deepEqual(heroPlatforms([net('A', [res('facebook', 'f', 0)])], p), ['facebook']);
});

test('audience stats', () => {
  const s = audienceStats([net('A', [res('telegram', 'a', 0, 1000), res('tiktok', 't', 1, null)]), net(null, [res('telegram', 'c', 2, 50)])]);
  assert.deepEqual(s, { followers: 1050, resources: 3, platforms: 2 });
});

test('diagram nodes: at most 4 real networks, live agents first, standalone never drawn', () => {
  const live = { name: 'Nova', emoji: '🛰️', mode: 'live' as const };
  const shadow = { name: 'Kit', emoji: null, mode: 'shadow' as const };
  const nodes = diagramNodes([
    net('No agent', [res('telegram', 'a', 0)]), net('Shadowy', [], shadow), net('Live 1', [], live),
    net(null, [res('telegram', 'b', 1)]), net('Live 2', [], live), net('Live 3', [], live),
  ]);
  assert.deepEqual(nodes.map((n) => n.label), ['Live 1', 'Live 2', 'Live 3', 'Shadowy']);
  assert.equal(nodes[0].mode, 'live');
  assert.deepEqual(diagramNodes(undefined), []);
});

test('role chips light up only roles with runs this week', () => {
  const chips = roleChips(pulse({}, { rolesActive: ['planner', 'executor'] }));
  assert.deepEqual(chips.filter((c) => c.active).map((c) => c.label), ['Planner', 'Executor']);
  assert.equal(chips.length, 5);
  assert.ok(roleChips(undefined).every((c) => !c.active));
});

test('badge and chip copy never presents an agent as a person', () => {
  assert.equal(aiRunBadge('live').label, 'Run by an AI agent');
  assert.match(aiRunBadge('shadow').label, /shadow/);
  assert.equal(aiRunBadge('none').label, 'Automated pipeline');
  assert.equal(agentChip({ name: 'Olena', emoji: '🤖', mode: 'live' }), 'Run by AI agent Olena · live');
  assert.equal(agentChip({ name: 'Olena', emoji: null, mode: 'shadow' }), 'AI agent Olena in training (shadow)');
  assert.equal(agentChip(null), null);
});

test('resource keys include the order, so two cards without a handle never collide', () => {
  assert.notEqual(resourceKey(res('telegram', '', 1)), resourceKey(res('telegram', '', 2)));
  assert.equal(resourceKey({ platform: 'youtube', handle: null, order: 3 }), 'youtube::3');
});
