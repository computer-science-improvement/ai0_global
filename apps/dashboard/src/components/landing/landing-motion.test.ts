// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 B5.3: the motion rules of the landing, pinned where a screenshot cannot see them.
//  - entrances never hide content that nothing can reveal; every looping section pauses off screen;
//  - the CSS keeps to the rules of apps/dashboard/CLAUDE.md (no `animation: none`, tokens not hex, nothing under 11px, loops
//    on transform / opacity only, no hand-rolled reduced-motion override of an animation);
//  - no "| DEV" suffix reaches a visitor from a channel card or the media kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import type { LandingNetwork, LandingNetworkResource } from '../../api/landing';
import type { MediaKitChannel } from '../../api/types';
import { DrawLine, LoopScope, Reveal } from './LandingMotion';
import { NetworkShowcase } from './NetworkShowcase';
import { MediaKitCards } from './MediaKit';
import { LandingCtaProvider } from './cta';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const CSS = { 'landing.css': stripComments(read('./landing.css')), 'landing-sections.css': stripComments(read('./landing-sections.css')) };
const ALL_CSS = Object.values(CSS).join('\n');

// ── Entrances ───────────────────────────────────────────────────────────────────────────────────

test('an entrance only hides its block where something can reveal it (IntersectionObserver exists)', () => {
  const g = globalThis as { IntersectionObserver?: unknown };
  const had = g.IntersectionObserver;
  try {
    delete g.IntersectionObserver;
    assert.equal(renderToString(h(Reveal, { className: 'x' }, 'hello')), '<div class="x">hello</div>', 'no observer: the block is simply there');
    assert.equal(renderToString(h(Reveal, { as: 'li', className: 'y' }, 'item')), '<li class="y">item</li>');
    assert.equal(renderToString(h(DrawLine, { className: 'line' })), '<div class="line"></div>', 'the ad-step line is drawn in full');

    g.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    const html = renderToString(h(Reveal, { className: 'x', delay: 0.1 }, 'hello'));
    assert.match(html, /^<div class="x" style="opacity:0;/, 'with an observer the block starts hidden and fades in once');
    assert.match(renderToString(h(DrawLine, { className: 'line' })), /transform:scaleX\(0\)|scaleX\(0\)/);
  } finally {
    if (had === undefined) delete g.IntersectionObserver; else g.IntersectionObserver = had;
  }
});

test('a loop scope is a plain element with the class the pause rule targets, and takes ids and aria props', () => {
  const html = renderToString(h(LoopScope, { as: 'section', id: 'networks', className: 'lp-band', 'aria-labelledby': 't' }, 'x'));
  assert.equal(html, '<section class="lp-scope lp-band" id="networks" aria-labelledby="t">x</section>');
});

test('every section that loops is a LoopScope; the only plain section on the page has nothing that loops', () => {
  const page = read('../../routes/index.tsx');
  const scopes = (page.match(/<LoopScope\b/g) ?? []).length;
  assert.equal(scopes, 7, `hero, marquee, how, loop, human, networks and the closing call to action are scopes (found ${scopes}); the white-label one is in WhiteLabel.tsx`);
  const plain = page.match(/<section\b[^>]*>/g) ?? [];
  assert.equal(plain.length, 1, 'one plain <section>');
  assert.match(plain[0], /id="advertise"/, 'the advertise section: its only motion is a one-off draw and entrances');
  assert.match(read('./WhiteLabel.tsx'), /<LoopScope as="section" id="white-label"/, 'the demo lanes loop');
  // The css that moves must be inside one of those: these are the classes with an infinite animation.
  const infinite = [...ALL_CSS.matchAll(/([^{}]+)\{[^{}]*animation:[^;{}]*infinite[^;{}]*;/g)].map((m) => m[1].trim());
  assert.ok(infinite.length >= 15, 'the looping rules are found');
});

// ── CSS rules ───────────────────────────────────────────────────────────────────────────────────

test('the pause rule: nothing animates under an off-screen scope', () => {
  const rule = CSS['landing.css'].match(/\.lp-scope\.is-offscreen,[\s\S]*?\{[^}]*\}/);
  assert.ok(rule, 'the pause rule exists');
  assert.match(rule[0], /\.lp-scope\.is-offscreen \*,/);
  assert.match(rule[0], /::before/);
  assert.match(rule[0], /::after/);
  assert.match(rule[0], /animation-play-state: paused !important/);
});

test('no `animation: none`, no literal colours, no numeric radius but 50%, nothing under 11px', () => {
  for (const [name, css] of Object.entries(CSS)) {
    assert.ok(!/animation(-name)?:\s*none/.test(css), `${name}: never "animation: none" (an element that starts at opacity 0 would stay invisible)`);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), `${name}: a literal hex colour (use var(--color-*))`);
    assert.ok(!/\brgba?\(/.test(css), `${name}: a literal rgb colour (use color-mix on a token)`);
    for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) {
      const v = m[1].trim();
      assert.ok(/^(var\(--radius-[a-z]+\)|50%|inherit|0)$/.test(v), `${name}: border-radius ${v}`);
    }
    for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) {
      const px = Number(m[1]);
      assert.ok(px >= 11, `${name}: font-size ${px}px is under 11px`);
      assert.ok(Number.isInteger(px), `${name}: font-size ${px}px is a half-pixel size`);
    }
    assert.ok(!/text-transform:\s*uppercase/.test(css), `${name}: only .text-overline is uppercase`);
  }
});

test('infinite animations move only transform / opacity (the skeleton shimmer and the deck z-index step are the two documented exceptions)', () => {
  const keyframes = new Map<string, string>();
  for (const m of ALL_CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) keyframes.set(m[1], m[2]);
  const looped = new Set<string>();
  for (const m of ALL_CSS.matchAll(/animation:\s*([\w-]+)[^;{}]*\binfinite\b/g)) looped.add(m[1]);
  assert.ok(looped.size >= 12, `looped keyframes found (${[...looped].join(', ')})`);
  const ALLOWED = new Set(['transform', 'opacity', 'z-index', 'background-position']);
  for (const name of looped) {
    const body = keyframes.get(name);
    assert.ok(body, `@keyframes ${name} is defined`);
    for (const decl of body.matchAll(/([a-z-]+)\s*:/g)) assert.ok(ALLOWED.has(decl[1]), `@keyframes ${name} animates ${decl[1]}`);
    if (/background-position/.test(body)) assert.equal(name, 'lp-shimmer');
    if (/z-index/.test(body)) assert.equal(name, 'lp-deck');
  }
});

test('reduced motion: the only rules written for it change layout, never an animation', () => {
  for (const [name, css] of Object.entries(CSS)) {
    for (const m of css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
      assert.ok(!/animation|transition/.test(m[1]), `${name}: a reduced-motion block touches an animation (the global block in index.css does that)`);
    }
  }
  assert.match(CSS['landing.css'], /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.lp-mq \{ width: auto; flex-wrap: wrap;/, 'the marquee becomes a wrapped list');
});

test('every looping animation has a still state in the base style (the global reduced-motion block ends it at once)', () => {
  // Loops do not use fill-mode, so under the global block (duration ~0, one iteration) they fall back to the base rule.
  for (const m of ALL_CSS.matchAll(/animation:[^;{}]*\binfinite\b[^;{}]*;/g)) {
    assert.ok(!/\b(both|forwards|backwards)\b/.test(m[0]), `a looping animation with a fill mode: ${m[0]}`);
  }
  // The deck, the token and the sweep rest in visible, sensible places.
  assert.match(CSS['landing-sections.css'], /\.lp-pc:nth-child\(1\) \{ z-index: 3; \}/);
  assert.match(CSS['landing-sections.css'], /\.lp-stamp \{[^}]*opacity: 0;/);
  assert.match(CSS['landing-sections.css'], /\.lp-step::before, \.lp-step::after \{ opacity: 0;/);
});

// ── No dev suffix ───────────────────────────────────────────────────────────────────────────────

const res = (handle: string | null, displayName: string | null, adDmUrl: string | null = null): LandingNetworkResource => ({
  platform: 'telegram', handle, displayName, avatarUrl: null, followerCount: 10, url: null, order: 0, aiRun: 'live', adDmUrl,
});

test('channel cards and network headers drop the "| DEV" suffix; a title that was only the suffix falls back to the handle', () => {
  const nets: LandingNetwork[] = [
    {
      name: 'AI0 | DEV', blurb: null, order: 0, agent: null, followers: 10, platforms: ['telegram'], adDmUrl: 'https://t.me/x',
      resources: [res('ai0_news', 'AI Technologies | DEV', 'https://t.me/x?text=1'), res('only_dev', '| DEV'), res('plain', 'Plain (dev)')],
    },
    { name: '(dev)', blurb: null, order: 1, agent: null, followers: null, platforms: ['telegram'], adDmUrl: null, resources: [res('solo', 'Solo')] },
  ];
  const html = renderToString(h(LandingCtaProvider, { value: { track: () => undefined, openAdForm: () => undefined } }, h(NetworkShowcase, { networks: nets })));
  const text = html.replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.ok(!/\|\s*DEV|\(dev\)/i.test(text), `a dev suffix reached the markup: ${text.match(/.{20}(\|\s*DEV|\(dev\)).{10}/i)?.[0]}`);
  assert.match(text, />AI Technologies</);
  assert.match(text, /aria-label="Ads here: order an ad in AI Technologies on Telegram"/);
  assert.match(text, />@only_dev</, 'a title that was only the suffix shows the handle');
  assert.match(text, />Plain</);
  assert.match(text, />AI0</, 'the network name is clean too');
  assert.match(text, />Standalone channels</, 'a network name that was only the suffix is a standalone group');
});

test('the media kit drops the suffix in the title and in the aria-label of the ad link', () => {
  const kit: MediaKitChannel[] = [{
    channelKey: 'ai0_news', title: 'AI Technologies | DEV', url: null, subscribers: 100, avgViews30d: 50, posts30d: 4,
    prices: [{ format: 'post', priceUah: 500, note: null }], adDmUrl: 'https://t.me/x',
  }, {
    channelKey: 'bare_key', title: '[DEV]', url: 'https://t.me/bare_key', subscribers: null, avgViews30d: null, posts30d: 0,
    prices: [{ format: 'post', priceUah: 300, note: null }], adDmUrl: null,
  }];
  const html = renderToString(h(MediaKitCards, { channels: kit })).replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.ok(!/\bDEV\b/i.test(html));
  assert.match(html, />AI Technologies</);
  assert.match(html, /aria-label="Order an ad in Telegram: AI Technologies"/);
  assert.match(html, />bare_key</, 'with nothing left of the title the channel key is shown');
  assert.equal(renderToString(h(MediaKitCards, { channels: [] })), '');
});
