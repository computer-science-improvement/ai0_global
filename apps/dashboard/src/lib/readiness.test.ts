// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 072 FR-008/FR-010, A11, A13, A23: the words of the Readiness panel and of the Start-anyway confirms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReadinessFinding, ReadinessView } from '../api/readiness';
import {
  FRESH_WINDOW_MS, START_ANYWAY, badgesOf, blockerLines, bodyLine, fixAllNote, fixAllPhrase, fixLabels, fixToasts, hasFix, isFreshWindow,
  last24hLine, parseReadinessFlag, readinessLink, readinessPath, sectionsOf, splitLink, startPhrase,
} from './readiness';

const f = (code: string, severity: ReadinessFinding['severity'], over: Partial<ReadinessFinding> = {}): ReadinessFinding => ({
  key: `${code}|${over.subject?.id ?? 'x'}`, code, severity, title: `Title of ${code}`, detail: `Detail of ${code}`,
  subject: { type: 'channel', id: 'x', label: `label of ${code}` }, link: null, firstSeenAt: '2026-10-20T10:00:00.000Z', fix: null, ...over,
});
const fixOf = (label: string, auto = false) => ({ label, auto });

// ── the card ─────────────────────────────────────────────────────────────────

test('badgesOf: blockers, warnings or Ready, singular and plural', () => {
  assert.deepEqual(badgesOf({ blockers: 2, warnings: 0 }), [{ tone: 'danger', label: '2 blockers' }]);
  assert.deepEqual(badgesOf({ blockers: 1, warnings: 3 }), [{ tone: 'danger', label: '1 blocker' }, { tone: 'warning', label: '3 warnings' }]);
  assert.deepEqual(badgesOf({ blockers: 0, warnings: 1 }), [{ tone: 'warning', label: '1 warning' }]);
  assert.deepEqual(badgesOf({ blockers: 0, warnings: 0 }), [{ tone: 'success', label: 'Ready' }]);
});

test('bodyLine: the first open blocker\'s title, else the all-clear line; a fixed-by-code row is not a blocker', () => {
  assert.equal(bodyLine({ findings: [f('a', 'warn'), f('b', 'error'), f('c', 'error')] }), 'Title of b');
  assert.equal(bodyLine({ findings: [f('a', 'warn'), f('auto_fixed', 'error')] }), 'Nothing blocks this channel.');
  assert.equal(bodyLine({ findings: [] }), 'Nothing blocks this channel.');
});

test('last24hLine: the counts, the skip groups by size, and the quiet day', () => {
  assert.equal(
    last24hLine({ planned: 6, published: 2, awaiting: 1, skipped: 3, byGroup: { config: 1, lint: 2 } }),
    'Last 24 h: 6 planned · 2 published · 1 waiting · 3 skipped (2 lint, 1 config)',
  );
  assert.equal(last24hLine({ planned: 4, published: 4, awaiting: 0, skipped: 0, byGroup: {} }), 'Last 24 h: 4 planned · 4 published · 0 waiting · 0 skipped');
  assert.equal(last24hLine({ planned: 2, published: 0, awaiting: 0, skipped: 2, byGroup: { nothing_fresh: 2 } }), 'Last 24 h: 2 planned · 0 published · 0 waiting · 2 skipped (2 nothing fresh)');
  assert.equal(last24hLine({ planned: 0, published: 0, awaiting: 0, skipped: 0, byGroup: {} }), 'Last 24 h: nothing planned');
  assert.equal(last24hLine({ planned: 1, published: 0, awaiting: 0, skipped: 1, byGroup: { b: 1, a: 1 } }), 'Last 24 h: 1 planned · 0 published · 0 waiting · 1 skipped (1 a, 1 b)');
});

test('fixAllNote: only when something can be fixed', () => {
  assert.equal(fixAllNote({ fixable: 2 }), 'Fix all can resolve 2');
  assert.equal(fixAllNote({ fixable: 0 }), null);
});

// ── the dialog ───────────────────────────────────────────────────────────────

test('sectionsOf: blockers, warnings, info and what code fixed by itself, in the server\'s order', () => {
  const s = sectionsOf([f('w1', 'warn'), f('e1', 'error'), f('auto_fixed', 'info'), f('i1', 'info'), f('e2', 'error')]);
  assert.deepEqual(s.blockers.map((x) => x.code), ['e1', 'e2']);
  assert.deepEqual(s.warnings.map((x) => x.code), ['w1']);
  assert.deepEqual(s.info.map((x) => x.code), ['i1']);
  assert.deepEqual(s.fixed.map((x) => x.code), ['auto_fixed']);
});

test('hasFix: an open finding with a fix; never a fixed-by-code row', () => {
  assert.equal(hasFix(f('a', 'error', { fix: fixOf('Do it') })), true);
  assert.equal(hasFix(f('a', 'error')), false);
  assert.equal(hasFix(f('auto_fixed', 'info', { fix: fixOf('Do it') })), false);
});

test('Fix all confirm: the action phrase and the distinct labels of errors and warnings (info rows keep their own button)', () => {
  assert.equal(fixAllPhrase(1), 'apply 1 fix');
  assert.equal(fixAllPhrase(3), 'apply 3 fixes');
  const rows = [
    f('a', 'error', { fix: fixOf('Switch the skill off') }), f('b', 'error', { fix: fixOf('Switch the skill off') }),
    f('c', 'warn', { fix: fixOf('Set minimum hashtags to 0', true) }), f('d', 'info', { fix: fixOf('Resume the series') }),
    f('auto_fixed', 'info', { fix: fixOf('Gone') }),
  ];
  assert.deepEqual(fixLabels(rows), ['Switch the skill off', 'Set minimum hashtags to 0']);
  const many = Array.from({ length: 10 }, (_, i) => f(`k${i}`, 'error', { fix: fixOf(`Fix ${i}`) }));
  assert.deepEqual(fixLabels(many, 3), ['Fix 0', 'Fix 1', 'Fix 2', '…and 7 more']);
});

test('fixToasts: what was applied, then the refusal in the server\'s words; an empty request says so', () => {
  assert.deepEqual(fixToasts({ applied: ['Set minimum hashtags to 0'], failed: [] }), [{ kind: 'success', text: 'Fixed: Set minimum hashtags to 0' }]);
  assert.deepEqual(fixToasts({ applied: ['a', 'b'], failed: [{ code: 'x', error: 'permission_denied' }, { code: 'y', error: 'other' }] }), [
    { kind: 'success', text: 'Fixed 2 things' }, { kind: 'error', text: '2 fixes failed: permission_denied' },
  ]);
  assert.deepEqual(fixToasts({ applied: [], failed: [{ code: 'x', error: 'finding_gone' }] }), [{ kind: 'error', text: '1 fix failed: finding_gone' }]);
  assert.deepEqual(fixToasts({ applied: [], failed: [] }), [{ kind: 'success', text: 'Nothing to fix' }]);
});

// ── the request ──────────────────────────────────────────────────────────────

test('readinessPath: the key is encoded, and ?fresh=1 only when asked', () => {
  assert.equal(readinessPath('@space_news'), '/api/editor/channels/%40space_news/readiness');
  assert.equal(readinessPath('@space_news', true), '/api/editor/channels/%40space_news/readiness?fresh=1');
});

test('isFreshWindow: five seconds after a change, never before one or on a clock that went back', () => {
  const t = 1_000_000;
  assert.equal(isFreshWindow(t + 1, null), false);
  assert.equal(isFreshWindow(t + 1, undefined), false);
  assert.equal(isFreshWindow(t, t), true);
  assert.equal(isFreshWindow(t + FRESH_WINDOW_MS - 1, t), true);
  assert.equal(isFreshWindow(t + FRESH_WINDOW_MS, t), false);
  assert.equal(isFreshWindow(t - 1, t), false);
  assert.equal(FRESH_WINDOW_MS, 5_000);
});

// ── links ────────────────────────────────────────────────────────────────────

test('deep link: the agent\'s Overview with the dialog open, and the flag as the router hands it over', () => {
  assert.equal(readinessLink('kira'), '/app/agents/kira?tab=overview&readiness=1');
  assert.equal(readinessLink('@kira'), '/app/agents/kira?tab=overview&readiness=1');
  for (const yes of [1, '1', true, 'true']) assert.equal(parseReadinessFlag(yes), true, String(yes));
  for (const no of [0, '0', false, 'false', '', null, undefined, 2, 'yes']) assert.equal(parseReadinessFlag(no), false, String(no));
});

test('splitLink: a server link becomes a path and a search', () => {
  assert.deepEqual(splitLink('/app/agents/kira?tab=skills'), { to: '/app/agents/kira', search: { tab: 'skills' } });
  assert.deepEqual(splitLink('/app/editor/%40kira'), { to: '/app/editor/%40kira', search: {} });
  assert.deepEqual(splitLink('/app/agents/kira?tab=overview&readiness=1'), { to: '/app/agents/kira', search: { tab: 'overview', readiness: '1' } });
});

// ── Start anyway ─────────────────────────────────────────────────────────────

test('startPhrase: the action of the confirm, singular and plural', () => {
  assert.equal(startPhrase('@x', 2), 'start @x with 2 open blockers');
  assert.equal(startPhrase('@x', 1), 'start @x with 1 open blocker');
  assert.equal(START_ANYWAY, 'Start anyway');
});

test('blockerLines: up to five open blockers by title, then "…and N more"', () => {
  const view = { findings: [
    f('w', 'warn'), f('auto_fixed', 'error'),
    ...Array.from({ length: 7 }, (_, i) => f(`e${i}`, 'error', { subject: { type: 'channel', id: String(i), label: `thing ${i}` } })),
  ] } as Pick<ReadinessView, 'findings'>;
  const lines = blockerLines(view, 5);
  assert.equal(lines.length, 6);
  assert.equal(lines[0], 'Title of e0 — thing 0');
  assert.equal(lines[5], '…and 2 more');
  assert.deepEqual(blockerLines({ findings: [f('e', 'error', { subject: { type: 'channel', id: 'x', label: 'Title of e' } })] }), ['Title of e']);
  assert.deepEqual(blockerLines({ findings: [f('w', 'warn')] }), []);
  assert.deepEqual(blockerLines({ findings: [f('e', 'error'), f('e2', 'error')] }, 2), ['Title of e — label of e', 'Title of e2 — label of e2']);
});

// ── where it is wired (T8b) ──────────────────────────────────────────────────

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('the panel is placed on the Overview, the editor page and the started launch panel, and the deep link reaches the Overview', () => {
  assert.ok(read('../components/agents/AgentOverview.tsx').includes('<ReadinessPanel channelKey'));
  assert.ok(read('../routes/app.editor_.$channel.tsx').includes('<ReadinessPanel channelKey={c.channelKey}'));
  const launch = read('../components/launch/LaunchBody.tsx');
  assert.ok(launch.includes('started && v.channelKey') && launch.includes('whenMissing="empty"'), 'only after Start, with the empty state on a 404');
  const route = read('../routes/app.agents_.$handle.tsx');
  assert.ok(route.includes('parseReadinessFlag(s.readiness)') && route.includes('focusReadiness={!!search.readiness}'));
});

test('a successful change opens the fresh window and invalidates the results before the badges early return, except for the doctor\'s own mutations', () => {
  const src = read('../router.ts');
  const guard = src.indexOf('meta?.readiness');
  const stale = src.indexOf('markReadinessStale()');
  const root = src.indexOf('READINESS_ROOT', stale);
  const early = src.indexOf('meta?.skipNavBadges');
  assert.ok(guard > 0 && guard < stale && stale < early, 'markReadinessStale sits behind the readiness guard and before the skipNavBadges return');
  assert.ok(root > stale && root < early, 'the invalidation sits there too');
});
