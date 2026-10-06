// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 027 FR-012 / T7: the ⌘K matcher. Fixture: every page of the default menu
// is the top result for some query of at most 3 keystrokes.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_REGISTRY } from './registry';
import { defaultConfig, resolveNav } from './resolve';
import { addCustomLink, hideItem, pinPage, setOverride, togglePin } from './ops';
import { guessLabel } from './config';
import { buildPaletteEntries, isTypingTarget, pushRecent, readRecent, RECENT_KEY, scoreEntry, searchPalette, type PaletteEntry } from './palette';

const g = globalThis as any;
afterEach(() => { delete g.localStorage; });

const agents = [{ handle: 'manager', name: 'Manager', emoji: '🧭' }, { handle: 'space', name: 'Space network', emoji: null }];
const defaultEntries = () => buildPaletteEntries(resolveNav(NAV_REGISTRY, null), agents);

/** Every query of ≤ 3 characters built from the label, its words' initials and the keywords. */
function candidateQueries(e: PaletteEntry): string[] {
  const src = [e.label, ...e.keywords].map((s) => s.toLowerCase());
  const out = new Set<string>();
  for (const s of src) {
    for (let n = 1; n <= 3; n++) out.add(s.slice(0, n));
    for (const w of s.split(/\s+/)) for (let n = 1; n <= 3; n++) out.add(w.slice(0, n));
    const initials = s.split(/\s+/).map((w) => w[0]).join('');
    for (let n = 2; n <= 3; n++) if (initials.length >= n) out.add(initials.slice(0, n));
  }
  return [...out].filter(Boolean);
}

test('every page of the default menu is reachable in 3 keystrokes or fewer', () => {
  const entries = defaultEntries();
  const nav = resolveNav(NAV_REGISTRY, null);
  const top = nav.groups.flatMap((g) => g.items.map((i) => `page:${i.id}`));
  assert.ok(top.length >= 20, `the default menu has ${top.length} pages`);
  const report: string[] = [];
  for (const key of top) {
    const e = entries.find((x) => x.key === key)!;
    const hit = candidateQueries(e).sort((a, b) => a.length - b.length).find((q) => searchPalette(entries, q)[0]?.key === key);
    if (!hit) report.push(`${e.label}: no ≤3-key query puts it first`);
  }
  assert.deepEqual(report, []);
  // Spot checks of the obvious ones.
  for (const [q, label] of [['ag', 'Agents'], ['ch', 'Chat'], ['dm', 'DM inbox'], ['ed', 'Editor'], ['se', 'Settings'], ['sp', 'Spend'], ['po', 'Posts to approve'], ['ads', 'Ads']] as const) {
    assert.equal(searchPalette(entries, q)[0].label, label, q);
  }
});

test('hidden pages are listed and marked; renamed pages match old and new names; paths match', () => {
  const cfg = setOverride(hideItem(defaultConfig(), 'strategies'), 'agents', { label: 'Team' });
  const entries = buildPaletteEntries(resolveNav(NAV_REGISTRY, cfg));
  const strategies = entries.find((e) => e.key === 'page:strategies')!;
  assert.equal(strategies.hidden, true);
  assert.equal(searchPalette(entries, 'strat')[0].key, 'page:strategies');
  assert.equal(entries.find((e) => e.key === 'page:agents-inbox')!.hidden, true, 'hidden by default');
  assert.equal(entries.find((e) => e.key === 'page:chat')!.hidden, undefined);
  assert.equal(searchPalette(entries, 'team')[0].key, 'page:agents');
  assert.equal(searchPalette(entries, 'agents')[0].key, 'page:agents', 'the default label still matches');
  assert.equal(searchPalette(entries, 'connections/groups')[0].key, 'page:groups');
  assert.ok(!entries.some((e) => e.key === 'page:agent-detail'), 'route templates are not palette entries');
});

test('custom links are included unless their page is gone; agents and actions are there', () => {
  let cfg = addCustomLink(defaultConfig(), { id: 'c_crypto', label: 'Crypto channels', icon: 'channels', to: '/app/channels', search: { q: 'crypto' } }, 'g_home');
  cfg = addCustomLink(cfg, { id: 'c_gone', label: 'Gone page', icon: 'globe', to: '/app/gone' }, 'g_home');
  const nav = resolveNav(NAV_REGISTRY, cfg, { routeExists: (h) => !h.startsWith('/app/gone') });
  const entries = buildPaletteEntries(nav, agents);
  assert.equal(searchPalette(entries, 'cry')[0].key, 'link:c_crypto');
  assert.equal(entries.find((e) => e.key === 'link:c_crypto')!.detail, '/app/channels?q=crypto');
  assert.ok(!entries.some((e) => e.key === 'link:c_gone'));
  assert.equal(searchPalette(entries, '@spa')[0].key, 'agent:space');
  assert.deepEqual(searchPalette(entries, 'new post')[0].target, { type: 'action', action: 'new-post' });
  assert.equal(searchPalette(entries, 'pin cur')[0].key, 'action:pin-page');
  assert.equal(searchPalette(entries, 'collapse')[0].key, 'action:collapse-sidebar');
  assert.equal(searchPalette(entries, 'edit menu')[0].key, 'action:edit-menu');
});

test('fuzzy matching and no false positives', () => {
  const entries = defaultEntries();
  assert.equal(searchPalette(entries, 'rcmd')[0].key, 'page:recommendations');
  assert.equal(searchPalette(entries, 'zzzq').length, 0);
  assert.equal(scoreEntry('', entries[0]), 1);
});

test('no query: the last 5 picks first, persisted in localStorage (try/catch)', () => {
  const m = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  for (const k of ['page:logs', 'page:ads', 'page:graph', 'page:data', 'page:spend', 'page:chat', 'page:logs']) pushRecent(k);
  assert.deepEqual(readRecent(), ['page:logs', 'page:chat', 'page:spend', 'page:data', 'page:graph']);
  const list = searchPalette(defaultEntries(), '', readRecent());
  assert.deepEqual(list.slice(0, 5).map((e) => e.key), readRecent());
  assert.ok(!list.some((e) => e.kind === 'agent'), 'agents only show up when typed for');
  m.set(RECENT_KEY, '{garbage');
  assert.deepEqual(readRecent(), []);
  g.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(readRecent(), []);
  assert.doesNotThrow(() => pushRecent('page:ads'));
});

test('the shortcut is ignored in text fields', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, getAttribute: () => null, ...extra });
  assert.equal(isTypingTarget(el('INPUT', { type: 'text' })), true);
  assert.equal(isTypingTarget(el('INPUT', { type: 'search' })), true);
  assert.equal(isTypingTarget(el('INPUT', { type: 'checkbox' })), false);
  assert.equal(isTypingTarget(el('TEXTAREA')), true);
  assert.equal(isTypingTarget(el('SELECT')), true);
  assert.equal(isTypingTarget(el('DIV', { isContentEditable: true })), true);
  assert.equal(isTypingTarget(el('BUTTON')), false);
  assert.equal(isTypingTarget(null), false);
});

test('"Pin current page": a registry page by exact address, else a pin-only custom link; persists', () => {
  let c = pinPage(defaultConfig(), { to: '/app/agents/manager', search: { tab: 'directives' } }, 'Directives', 'directives', 'c_x');
  assert.deepEqual(c.pinned, ['directives']);
  assert.equal(c.custom.length, 0);
  const same = pinPage(c, { to: '/app/agents/manager', search: { tab: 'directives' } }, 'Directives', 'directives', 'c_y');
  assert.equal(same, c, 'already pinned: no change');
  c = pinPage(c, { to: '/app/data/recipes' }, guessLabel('/app/data/recipes'), null, 'c_recipes');
  assert.deepEqual(c.pinned, ['directives', 'c_recipes']);
  assert.deepEqual(c.custom.map((x) => [x.id, x.label, x.to]), [['c_recipes', 'Recipes', '/app/data/recipes']]);
  assert.ok(c.hidden.includes('c_recipes'), 'pin-only: not added to a group');
  const nav = resolveNav(NAV_REGISTRY, JSON.parse(JSON.stringify(c)));
  assert.deepEqual(nav.pinned.map((i) => i.id), ['directives', 'c_recipes']);
  // Unpinned later, pinning the same address again reuses the link.
  const again = pinPage(togglePin(c, 'c_recipes'), { to: '/app/data/recipes' }, 'Recipes', null, 'c_other');
  assert.equal(again.custom.length, 1);
  assert.ok(again.pinned.includes('c_recipes'));
});
