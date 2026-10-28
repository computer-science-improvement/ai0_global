// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B5: the landing parts render on the server (no browser) with real, partial and missing data. This pins what the
// lead checks by eye: nothing crashes on an empty payload, decorative art is aria-hidden and has a spoken summary, the
// duplicate halves of a looping strip are hidden from screen readers, and no dev suffix reaches the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import type { LandingNetwork, LandingNetworkResource, LandingPulse } from '../../api/landing';
import { HeroHeadline, HEADLINE_TOTAL_S } from './HeroHeadline';
import { HeroOrbit } from './HeroOrbit';
import { AgentLog, LOG_SCROLL_MIN } from './AgentLog';
import { ChannelMarquee } from './ChannelMarquee';
import { ProofStrip } from './ProofStrip';
import { CountUp } from './CountUp';

const res = (
  platform: LandingNetworkResource['platform'], handle: string | null, displayName: string | null, order = 0,
  aiRun: LandingNetworkResource['aiRun'] = 'live',
): LandingNetworkResource => ({
  platform, handle, displayName, avatarUrl: null, followerCount: 10, url: null, order, aiRun, adDmUrl: null,
});

const net = (name: string | null, resources: LandingNetworkResource[], agent: LandingNetwork['agent'] = null): LandingNetwork => ({
  name, blurb: null, order: 0, agent, followers: null, platforms: [], adDmUrl: null, resources,
});

function pulse(over: Partial<LandingPulse['last7d']> = {}, agents: Partial<LandingPulse['agents']> = {}, extra: Partial<LandingPulse> = {}): LandingPulse {
  return {
    agents: { orchestratorsLive: 0, orchestratorsShadow: 0, rolesActive: [], manager: 'off', ...agents },
    last7d: {
      agentPosts: 0, allPosts: 0, autonomyShare: 0, platforms: [], agentRuns: 0, skippedByAgents: 0,
      directivesFiled: 0, managerReviews: 0, ideasReviewed: 0, ownerDecisions: 0, ...over,
    },
    lastAgentPostAt: null, claims: { managerLive: false }, generatedAt: '2026-10-08T10:00:00Z', stale: false, ...extra,
  };
}

const NETS = [
  net('AI0', [res('telegram', 'ai0_dev', 'AI Technologies | DEV', 0), res('instagram', 'ai0.dev', 'AI Technologies', 1)], { name: 'Nova', emoji: '🛰️', mode: 'live' }),
  net(null, [res('telegram', 'quotes', null, 2, 'none')]),
];

test('the headline is the owner-approved sentence, word by word, and finishes under 900 ms', () => {
  const html = renderToString(h(HeroHeadline));
  assert.equal(html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'"), 'A media network run by AI agents');
  assert.equal((html.match(/class="lp-w"/g) ?? []).length, 7);
  assert.equal((html.match(/is-accent/g) ?? []).length, 2, '"AI agents" is in the accent colour');
  assert.match(html, /class="lp-caret" aria-hidden="true"/);
  assert.ok(HEADLINE_TOTAL_S <= 0.9, `the headline entry takes ${HEADLINE_TOTAL_S}s`);
  assert.match(html, /animation-delay:0\.05s/);
});

test('the orbit draws only the agents and platforms of the payload, and says so in words', () => {
  const html = renderToString(h(HeroOrbit, { networks: NETS, pulse: pulse({ platforms: [{ platform: 'telegram', posts: 4, agentPosts: 4 }] }, { orchestratorsLive: 1 }, { claims: { managerLive: true } }), platforms: ['telegram', 'instagram'] }));
  assert.match(html, /class="lp-orbit lp-fade"[^>]*aria-hidden="true"/, 'the picture is decorative');
  assert.match(html, /<p class="lp-sr">A MANAGER agent watches the whole network\. Agents: Nova\. Platforms: Telegram, Instagram\.<\/p>/);
  assert.equal((html.match(/class="lp-agent[ "]/g) ?? []).length, 1, 'one agent tile: the pipeline network has no agent');
  assert.match(html, /🛰️/);
  assert.match(html, /lp-plat is-on/, 'Telegram had agent posts this week');
  assert.equal((html.match(/class="lp-plat"/g) ?? []).length, 1, 'Instagram did not');
  assert.match(html, /watches all/);
  assert.ok(!html.includes('is-dim'), 'a live MANAGER is not dimmed');
});

test('the orbit survives having no data at all: ghost agents, default platforms, a dimmed MANAGER that says "soon"', () => {
  const html = renderToString(h(HeroOrbit, { networks: undefined, pulse: undefined, platforms: [] }));
  assert.equal((html.match(/lp-agent is-ghost/g) ?? []).length, 3);
  assert.match(html, /lp-core is-dim/);
  assert.match(html, /soon/);
  assert.match(html, /Platforms: Telegram, Instagram, Facebook, Threads, TikTok\./);
  assert.match(html, /coming soon/);
  assert.ok(!html.includes('is-on'), 'no platform glows without a pulse');
});

test('agent.log: nothing without a pulse or an empty week; a short list stands still; six lines scroll with a hidden repeat', () => {
  assert.equal(renderToString(h(AgentLog, { pulse: undefined })), '');
  assert.equal(renderToString(h(AgentLog, { pulse: pulse() })), '');

  const short = renderToString(h(AgentLog, { pulse: pulse({ agentPosts: 3, autonomyShare: 50 }) }));
  assert.match(short, /3 posts published \(50% of all\)/);
  assert.match(short, /last 7 days/);
  assert.ok(!short.includes('lp-feed"'), 'a short list does not scroll');
  assert.equal((short.match(/aria-hidden="true"/g) ?? []).length, 0);

  const busy = pulse(
    { agentPosts: 30, autonomyShare: 88, skippedByAgents: 1, ideasReviewed: 4, agentRuns: 12, ownerDecisions: 3 },
    {}, { lastAgentPostAt: '2026-10-08T10:00:00Z', stale: true },
  );
  const long = renderToString(h(AgentLog, { pulse: busy }));
  assert.ok((long.match(/lp-log-line/g) ?? []).length >= LOG_SCROLL_MIN * 2, 'the list is repeated once');
  assert.match(long, /class="lp-feed"/);
  assert.equal((long.match(/<ul class="lp-log-list" aria-hidden="true"/g) ?? []).length, 1, 'the repeat is hidden from screen readers');
  assert.match(long, /Numbers from the last successful update\./, 'a stale pulse says so here too');
  assert.ok(!/@[a-z_]+/i.test(long.replace(/&#x27;/g, '')), 'no handles in the log');
});

test('the channel marquee: public titles only, the second half and padding hidden, a reserved box while loading', () => {
  const html = renderToString(h(ChannelMarquee, { networks: NETS, loading: false }));
  assert.ok(!/\bdev\b/i.test(html.replace(/ai0_dev|ai0\.dev/g, '')), 'no "| DEV" in the visible names');
  assert.match(html, /AI Technologies/);
  assert.match(html, /@ai0_dev/, 'the handle stays as a mono caption');
  assert.match(html, /aria-label="Channels in the network"/);
  assert.equal((html.match(/<ul class="lp-mq-half" aria-hidden="true">/g) ?? []).length, 1, 'the second half is hidden');
  assert.ok((html.match(/<li class="lp-chan" aria-hidden="true">/g) ?? []).length > 0, 'padding repeats are hidden');
  assert.match(html, /lp-mq-words" aria-hidden="true"/);
  for (const w of ['Plan', 'Write', 'Guard', 'Publish', 'Measure', 'Learn']) assert.match(html, new RegExp(`>${w}<`));

  const loading = renderToString(h(ChannelMarquee, { networks: undefined, loading: true }));
  assert.match(loading, /lp-mq-reserve/);
  assert.ok(!loading.includes('lp-chan'));

  const empty = renderToString(h(ChannelMarquee, { networks: [], loading: false }));
  assert.ok(!empty.includes('lp-chan') && !empty.includes('lp-mq-reserve'), 'no channels: the row is left out, the words stay');
  assert.match(empty, /lp-outline/);
});

test('the hero stats row keeps the zero-hide rule and the "?" definitions, and reserves its height while loading', () => {
  const p = pulse({ agentPosts: 42, autonomyShare: 64 }, { orchestratorsLive: 3 }, { lastAgentPostAt: '2026-10-08T10:00:00Z' });
  const row = renderToString(h(ProofStrip, { pulse: p, variant: 'row' }));
  assert.match(row, /class="lp-proofrow lp-fade"/);
  assert.match(row, /42/);
  assert.match(row, /64%/);
  assert.ok(!row.includes('agents live'), 'the agent count is in the pill, not in the row');
  assert.equal((row.match(/lp-proofrow-help/g) ?? []).length, 3, 'a "?" per tile');
  assert.match(row, /aria-expanded="false"/);

  assert.equal(renderToString(h(ProofStrip, { pulse: pulse(), variant: 'row' })), '', 'an empty week: no strip');
  assert.match(renderToString(h(ProofStrip, { pulse: undefined, variant: 'row', reserve: true })), /lp-proofrow is-reserved/);
  assert.equal(renderToString(h(ProofStrip, { pulse: undefined, variant: 'row' })), '');
  assert.match(renderToString(h(ProofStrip, { pulse: p })), /class="lp-proof"/, 'the default is still the tiles of /white-label');
});

test('a counter carries its final number for screen readers, and in the markup', () => {
  const html = renderToString(h(CountUp, { to: 12345 }));
  assert.match(html, /<span aria-hidden="true">12\.3K<\/span><span class="lp-sr">12\.3K<\/span>/);
});
