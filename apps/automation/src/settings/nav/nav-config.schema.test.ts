// Spec 027 FR-005: every shape limit of the saved menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NAV_LIMITS, NAV_SCHEMA_MAX, isSafeNavPath, validateNavConfig } from './nav-config.schema';

const base = () => ({
  schemaVersion: 1,
  groups: [{ id: 'g_home', items: ['overview', 'approvals'] }, { id: 'g_c_ab12', title: 'Daily', items: ['c_x1'] }],
  pinned: ['approvals'],
  hidden: ['strategies'],
  custom: [{ id: 'c_x1', label: 'Directives', icon: 'agents', to: '/app/agents/manager', search: { tab: 'directives' } }],
  overrides: { agents: { label: 'Team', badge: false } },
});

function issues(cfg: unknown): string[] {
  const r = validateNavConfig(cfg);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
}

test('a well-formed menu passes and labels are trimmed', () => {
  const cfg = base();
  cfg.overrides.agents.label = '  Team  ';
  const r = validateNavConfig(cfg);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.config.overrides.agents.label, 'Team');
    assert.equal(JSON.parse(r.json).overrides.agents.label, 'Team');
  }
});

test('schemaVersion is 1..NAV_SCHEMA_MAX', () => {
  assert.equal(NAV_SCHEMA_MAX, 1);
  for (const v of [0, NAV_SCHEMA_MAX + 1, 1.5, '1', undefined]) {
    assert.ok(issues({ ...base(), schemaVersion: v }).length > 0, `schemaVersion ${v}`);
  }
});

test('size: more than 32 KB is refused before the shape check', () => {
  const big = { ...base(), overrides: Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`item-${i}`, { label: 'x'.repeat(40) }])) } as any;
  big.pad = 'y'.repeat(NAV_LIMITS.bytes);
  assert.deepEqual(issues(big), [': config is larger than 32 KB']);
});

test('counts: groups ≤ 20, refs ≤ 150, custom ≤ 50, pinned ≤ 10', () => {
  const groups = Array.from({ length: 21 }, (_, i) => ({ id: `g_c_${i}`, items: [] }));
  assert.ok(issues({ ...base(), groups }).some((m) => m.includes('20 groups')));
  assert.equal(issues({ ...base(), groups: groups.slice(0, 20) }).length, 0);

  const refs = Array.from({ length: 149 }, (_, i) => `i${i}`);
  assert.ok(issues({ ...base(), groups: [{ id: 'g_home', items: refs }] }).some((m) => m.includes('150 item references')));
  assert.equal(issues({ ...base(), groups: [{ id: 'g_home', items: refs.slice(0, 148) }] }).length, 0, '148 + 1 pinned + 1 hidden = 150');

  const custom = Array.from({ length: 51 }, (_, i) => ({ id: `c_${i}`, label: `L${i}`, icon: 'globe', to: '/app/channels' }));
  assert.ok(issues({ ...base(), custom }).some((m) => m.includes('50 custom links')));
  assert.ok(issues({ ...base(), pinned: Array.from({ length: 11 }, (_, i) => `p${i}`) }).some((m) => m.includes('10 pinned')));
});

test('ids: ^[a-z0-9_:-]{1,64}$ everywhere', () => {
  for (const bad of ['', 'Upper', 'with space', 'x'.repeat(65), 'a/b', 'é']) {
    assert.ok(issues({ ...base(), pinned: [bad] }).length > 0, `pinned ${JSON.stringify(bad)}`);
    assert.ok(issues({ ...base(), groups: [{ id: bad, items: [] }] }).length > 0, `group ${JSON.stringify(bad)}`);
    assert.ok(issues({ ...base(), overrides: { [bad]: { badge: true } } }).length > 0, `override key ${JSON.stringify(bad)}`);
  }
  assert.ok(issues({ ...base(), groups: [{ id: 'g_home', items: [] }, { id: 'g_home', items: [] }] }).some((m) => m.includes('duplicate group')));
});

test('labels: 1–40 characters after trimming', () => {
  assert.ok(issues({ ...base(), overrides: { agents: { label: '   ' } } }).length > 0);
  assert.ok(issues({ ...base(), overrides: { agents: { label: 'x'.repeat(41) } } }).length > 0);
  assert.equal(issues({ ...base(), overrides: { agents: { label: 'x'.repeat(40) } } }).length, 0);
  assert.ok(issues({ ...base(), groups: [{ id: 'g_c_1', title: '', items: [] }] }).length > 0);
});

test('custom links: internal /app paths only', () => {
  assert.ok(isSafeNavPath('/app'));
  assert.ok(isSafeNavPath('/app/channels'));
  assert.ok(isSafeNavPath('/app/agents/@manager'));
  for (const bad of ['/', '/login', 'https://evil.example', '//evil.example', '/app//x', '/app/../login', '/app/x:y', 'javascript:alert(1)', '/application', '/app/x?y=1', '/app/x#h', '/app/x y', '/app\\x']) {
    assert.equal(isSafeNavPath(bad), false, bad);
    const cfg = base();
    cfg.custom[0].to = bad;
    assert.ok(issues(cfg).some((m) => m.startsWith('custom.0.to')), bad);
  }
  const cfg = base() as any;
  cfg.custom[0].search = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']));
  assert.ok(issues(cfg).length > 0, 'at most 10 query params');
});

test('unknown keys are refused (strict shape)', () => {
  assert.ok(issues({ ...base(), extra: 1 }).length > 0);
  assert.ok(issues({ ...base(), overrides: { agents: { color: 'red' } } }).length > 0);
  assert.ok(issues(null).length > 0);
  assert.ok(issues([]).length > 0);
});
