// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B5.2: the sections below the hero render on the server with real, partial and missing data, and the things the
// lead cannot see in a screenshot are pinned here: the pressed/live semantics, the gating of the MANAGER, the decorative
// art being hidden from screen readers, the CTA placements and anchors the tracking and the nav depend on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import type { LandingNetwork, LandingNetworkResource, LandingPulse } from '../../api/landing';
import { RoleExplorer } from './RoleExplorer';
import { GuardTrack, LoopRing, gateDelay } from './LoopRing';
import { ApprovalDeck, ApprovalModes, MODES } from './ApprovalDeck';
import { AD_STEPS, AdSteps } from './AdSteps';
import { DEMO_BLOCKS, DEMO_CAPTION, ShadowLiveDemo } from './ShadowLiveDemo';
import { LANDING_WL_TITLES, WhiteLabelFeatures, WhiteLabelSection, WL_FEATURES } from './WhiteLabel';
import { Muted, SectionHead } from './SectionHead';
import { NetworkShowcase } from './NetworkShowcase';
import { LandingCtaProvider } from './cta';
import { GUARDS, LOOP_STEPS } from '../../lib/landing-view';

// Built from char codes: lib/no-cyrillic-ui.test.ts scans every file under src/, tests included.
const CYRILLIC = new RegExp(`[${String.fromCharCode(0x400)}-${String.fromCharCode(0x4ff)}]`);
const AD_LABEL = `#${String.fromCharCode(0x440, 0x435, 0x43a, 0x43b, 0x430, 0x43c, 0x430)}`;

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(HERE, rel), 'utf8');

function pulse(agents: Partial<LandingPulse['agents']> = {}, extra: Partial<LandingPulse> = {}, last7d: Partial<LandingPulse['last7d']> = {}): LandingPulse {
  return {
    agents: { orchestratorsLive: 0, orchestratorsShadow: 0, rolesActive: [], manager: 'off', ...agents },
    last7d: {
      agentPosts: 0, allPosts: 0, autonomyShare: 0, platforms: [], agentRuns: 0, skippedByAgents: 0,
      directivesFiled: 0, managerReviews: 0, ideasReviewed: 0, ownerDecisions: 0, ...last7d,
    },
    lastAgentPostAt: null, claims: { managerLive: false }, generatedAt: '2026-10-08T10:00:00Z', stale: false, ...extra,
  };
}

const res = (platform: LandingNetworkResource['platform'], handle: string | null, displayName: string | null, aiRun: LandingNetworkResource['aiRun'] = 'live'): LandingNetworkResource => ({
  platform, handle, displayName, avatarUrl: null, followerCount: 10, url: `https://example.com/${handle}`, order: 0, aiRun, adDmUrl: null,
});
const NETS: LandingNetwork[] = [{
  name: 'AI0', blurb: null, order: 0, agent: { name: 'Nova', emoji: null, mode: 'live' }, followers: 10, platforms: ['telegram'], adDmUrl: null,
  resources: [res('telegram', 'ai0_news', 'AI Technologies')],
}];

test('the role explorer: seven roles, the MANAGER dimmed and "soon" until it is live, the count and the lit roles from the pulse', () => {
  const p = pulse({ orchestratorsLive: 3, orchestratorsShadow: 2, rolesActive: ['planner', 'executor'] }, {}, { platforms: [{ platform: 'telegram', posts: 4, agentPosts: 4 }] });
  const html = renderToString(h(RoleExplorer, { pulse: p, platforms: ['telegram', 'instagram'] }));
  assert.equal((html.match(/<button type="button"/g) ?? []).length, 7, 'one button per role');
  assert.match(html, /aria-pressed="true"[^>]*>[^]*?MANAGER/, 'the MANAGER is pressed first');
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.match(html, /lp-rnode is-big is-on is-dim/, 'a MANAGER that is not live is dimmed');
  assert.match(html, /class="lp-soon">soon</);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /01 \/ 07/);
  assert.match(html, /Will read the network/, 'the copy is future tense before the MANAGER is live');
  assert.match(html, /Reports to <b>the owner<\/b>/);
  assert.match(html, /×5/, 'Orchestrator count = live + in training');
  assert.equal((html.match(/class="lp-ran"/g) ?? []).length, 2, 'the roles that ran this week carry a dot');
  assert.match(html, /lp-plat is-on/, 'Telegram had agent posts');
  assert.equal((html.match(/class="lp-plat"/g) ?? []).length, 1, 'Instagram did not');
  assert.equal((html.match(/class="lp-conn/g) ?? []).length, 3);
});

test('a live MANAGER is not dimmed and the orchestrators report to it', () => {
  const html = renderToString(h(RoleExplorer, { pulse: pulse({}, { claims: { managerLive: true } }), platforms: [] }));
  assert.ok(!html.includes('is-dim') && !html.includes('lp-soon'));
  assert.match(html, /Reads the network/);
  assert.ok(!html.includes('lp-ex-plats'), 'no platforms, no platform row');
  assert.equal((html.match(/class="lp-conn/g) ?? []).length, 2);
});

test('the explorer survives no pulse at all', () => {
  const html = renderToString(h(RoleExplorer, { pulse: undefined, platforms: ['telegram'] }));
  assert.match(html, /MANAGER/);
  assert.ok(!html.includes('lp-ran') && !html.includes('lp-rnode-n') && !html.includes('lp-plat is-on'));
});

test('the loop ring is one spoken picture; the guard track is another, with a gate per guard and a token', () => {
  const ring = renderToString(h(LoopRing));
  assert.match(ring, /role="img" aria-label="One loop for every post: Plan, Write, Guard, Publish, Measure, Learn, and back to Plan\."/);
  assert.equal((ring.match(/data-label="/g) ?? []).length, LOOP_STEPS.length);
  assert.match(ring, /--d:5s/, 'the last step lights in the sixth second');

  const track = renderToString(h(GuardTrack));
  assert.match(track, /role="img" aria-label="Every post passes 5 code guards before it is published: dedup, rate limits, quiet hours, budget, kill switch\."/);
  assert.equal((track.match(/class="lp-gate"/g) ?? []).length, GUARDS.length);
  for (const g of GUARDS) assert.match(track, new RegExp(`>${g.label}<`));
  assert.match(track, /class="lp-token mono"/);
  assert.match(track, /class="lp-endp lp-gate-pill"/);
  assert.match(track, /--gd:5\.2s/);
});

test('each gate lights when the token reaches it', () => {
  assert.deepEqual(GUARDS.map((g) => gateDelay(g.at)), [0.84, 1.87, 2.9, 3.93, 4.96]);
});

test('human in the loop: four modes with Approval marked as the launch period; the deck is an aria-hidden illustration', () => {
  const modes = renderToString(h(ApprovalModes));
  assert.equal((modes.match(/class="lp-mode[ "]/g) ?? []).length, MODES.length);
  assert.match(modes, /lp-mode is-on"><div class="lp-mode-head"><span class="lp-mode-name">Approval<\/span><span class="lp-mode-tag mono">launch period<\/span>/);

  const deck = renderToString(h(ApprovalDeck));
  assert.match(deck, /^<div class="lp-deck-wrap" aria-hidden="true">/);
  assert.equal((deck.match(/class="lp-pc"/g) ?? []).length, 3);
  assert.equal((deck.match(/class="lp-stamp"/g) ?? []).length, 3);
  assert.match(deck, /--dl:-6s/);
  assert.ok(!/@[a-z_]+/i.test(deck.replace(/&#x27;/g, '')), 'no handles on placeholder cards');
  assert.ok(!CYRILLIC.test(deck), 'no Ukrainian sample data');
});

test('ad steps: the four steps, the disclosure under the first, the anchor, and the CTA only where it can work', () => {
  const noCta = renderToString(h(AdSteps, { adDmUrl: null }));
  assert.match(noCta, /id="order-an-ad"/);
  assert.equal((noCta.match(/class="lp-adstep"/g) ?? []).length, AD_STEPS.length);
  assert.equal((noCta.match(/<li /g) ?? []).length, 4, 'the cards are list items of an ordered list');
  assert.match(noCta, /<ol class="lp-adstep-list">/);
  assert.equal((noCta.match(/class="lp-disclosure"/g) ?? []).length, 1);
  assert.ok(noCta.includes(AD_LABEL), 'the legal ad label is spelled out');
  assert.ok(!noCta.includes('lp-adcta'), 'no DM link and no form (the admin preview): no button at all');

  const dm = renderToString(h(AdSteps, { adDmUrl: 'https://t.me/x?text=hi' }));
  assert.match(dm, /href="https:\/\/t\.me\/x\?text=hi" target="_blank" rel="noopener"/);
  assert.match(dm, /Opens Telegram with your first message ready\./);

  const form = renderToString(h(LandingCtaProvider, { value: { track: () => undefined, openAdForm: () => undefined } }, h(AdSteps, { adDmUrl: null })));
  assert.match(form, /Request an ad placement/);
  assert.ok(!form.includes('Opens Telegram'), 'the Telegram note only goes with a Telegram link');
});

test('the shadow / live demo starts in shadow, says so in words, and its lanes are decorative', () => {
  const html = renderToString(h(ShadowLiveDemo));
  assert.match(html, /role="group" aria-label="Agent mode"/);
  assert.match(html, /<button type="button" aria-pressed="true">Shadow<\/button><button type="button" aria-pressed="false">Live<\/button>/);
  assert.ok(html.includes(DEMO_CAPTION.shadow.replace(/’/g, '&#x27;')) || html.includes(DEMO_CAPTION.shadow));
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<div class="lp-lanes" aria-hidden="true">/);
  assert.equal((html.match(/class="lp-pb"/g) ?? []).length, DEMO_BLOCKS * 2 * 2, 'two lanes, each one strip repeated once for the loop');
  assert.match(html, /lp-lane is-now"/);
  assert.match(html, /lp-lane is-shadow"/);
  assert.match(html, /ai0 agent · shadow/);
  assert.match(html, /Illustration, not your data\./);
  assert.ok(!html.includes('is-retired') && !html.includes('lp-seg is-live'));
});

test('white label on the landing: the demo, three cards, the single-tenant note and the offer link', () => {
  const html = renderToString(h(WhiteLabelSection));
  assert.match(html, /<section class="lp-scope lp-band is-alt lp-wl" id="white-label" aria-labelledby="white-label-title">/, 'a loop scope: the lanes pause off screen');
  assert.match(html, /lp-demo/);
  const cards = html.match(/class="wl-feature-title">[^<]+/g) ?? [];
  assert.deepEqual(cards.map((c) => c.replace('class="wl-feature-title">', '')), [...LANDING_WL_TITLES]);
  assert.ok(!cards.some((c) => c.includes('Shadow first')), '"Shadow first" is the demo, not a card');
  assert.match(html, /role="note" aria-label="How white label is delivered today"/);
  assert.match(html, /href="\/white-label"/);

  const all = renderToString(h(WhiteLabelFeatures, {}));
  assert.equal((all.match(/class="wl-feature"/g) ?? []).length, WL_FEATURES.length, '/white-label still shows all of them');
  assert.equal((renderToString(h(WhiteLabelFeatures, { limit: 3 })).match(/class="wl-feature"/g) ?? []).length, 3);
});

test('a section head: eyebrow, title with a muted line, lead; the warning tone is for the human', () => {
  const html = renderToString(h(SectionHead, { eyebrow: 'Human in the loop', tone: 'warning', id: 't', title: h('span', null, 'A', h(Muted, null, 'B')), lead: 'Lead' }));
  assert.match(html, /class="text-overline lp-eyebrow is-warning">Human in the loop/);
  assert.match(html, /<h2 id="t" class="lp-h2">/);
  assert.match(html, /class="lp-muted">B/);
  assert.match(html, /<p class="lp-lead">Lead<\/p>/);
  assert.ok(!renderToString(h(SectionHead, { eyebrow: 'x', title: 'y' })).includes('lp-lead'));
});

test('network cards: the lift and the spotlight are in the component, and hover uses the individual translate property', () => {
  const html = renderToString(h(NetworkShowcase, { networks: NETS }));
  assert.match(html, /class="rs-glow"/);
  assert.match(html, /translate: 0 -6px/);
  assert.match(html, /\.rs-glow \{[^}]*opacity: 0\.35/);
  assert.match(html, /\.rs-card:hover \.rs-glow, \.rs-card:focus-within \.rs-glow \{ opacity: 1; \}/);
  assert.ok(!/transform: translateY\(-6px\)/.test(html), 'a hover transform would lose to the inline transform motion leaves behind');
});

test('the landing keeps every anchor, nav target and CTA placement the tracking and the nav rely on', () => {
  const page = src('../../routes/index.tsx');
  for (const id of ['id="top"', 'id="how-it-works"', 'id="networks"', 'id="advertise"']) assert.ok(page.includes(id), `routes/index.tsx lost ${id}`);
  assert.ok(src('./AdSteps.tsx').includes('id="order-an-ad"'));
  assert.ok(src('./WhiteLabel.tsx').includes('id="white-label"'));
  for (const placement of ['topbar', 'hero', 'footer', 'advertise']) assert.match(page, new RegExp(`placement="${placement}"`), `no ${placement} CTA`);
  assert.match(src('./AdSteps.tsx'), /placement="howitworks"/);
  assert.match(page, /sendCtaBeacon\('white_label', 'hero'\)/);
  assert.match(page, /sendCtaBeacon\('white_label', 'footer'\)/);
  assert.match(src('./WhiteLabel.tsx'), /track\('white_label', 'whitelabel'\)/);
  assert.match(page, /<LandingCtaProvider value=\{cta\}>/);
  assert.match(page, /<AdLeadModal/);
});
