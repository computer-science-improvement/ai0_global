// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 072 FR-008/FR-010, A11, A13, A23: the words of the Readiness panel and of the Start-anyway confirms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReadinessFinding, ReadinessView } from '../api/readiness';
import {
  FRESH_WINDOW_MS, START_ANYWAY, badgesOf, blockedView, blockerIntro, blockerLines, bodyLine, findingHint, findingTitle, fixAllNote, fixAllPhrase, fixConfirm, fixLabels,
  fixToasts, hasFix, isFreshWindow, isStartMove, last24hLine, parseReadinessFlag, readinessLink, readinessPath, sectionsOf, splitLink, startPhrase,
} from './readiness';
import { reasonView } from './reasons';

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

test('Fix all confirm lists only what Fix all applies: a kind it skips (inFixAll: false) keeps its own button', () => {
  const rows = [
    f('a', 'error', { fix: { label: 'Switch the skill off', auto: false, inFixAll: true } }),
    f('b', 'error', { fix: { label: 'Drop the source', auto: false, inFixAll: false } }),
    f('c', 'warn', { fix: { label: 'Set minimum hashtags to 0', auto: true } }),
  ];
  assert.deepEqual(fixLabels(rows), ['Switch the skill off', 'Set minimum hashtags to 0'], 'an older server without the flag: listed');
  assert.equal(hasFix(rows[1]), true);
});

test('S6: a finding is labelled from the reason mirror (lib/reasons.ts); a code it does not hold keeps the server title', () => {
  const known = f('series_source_contradicted', 'error', { title: 'Server words' });
  assert.equal(findingTitle(known), reasonView('series_source_contradicted')!.en);
  assert.equal(findingTitle(f('not_in_the_mirror', 'error')), 'Title of not_in_the_mirror');
  assert.equal(bodyLine({ findings: [known] }), reasonView('series_source_contradicted')!.en);
  assert.deepEqual(blockerLines({ findings: [known] }), [`${reasonView('series_source_contradicted')!.en} — label of series_source_contradicted`]);
  // The what-to-change line shows on an open row without a Fix button only.
  const low = f('dataset_low_fill', 'warn');
  assert.equal(findingHint(low), reasonView('dataset_low_fill')!.fix!.en);
  assert.equal(findingHint({ ...low, fix: fixOf('Do it') }), null);
  assert.equal(findingHint(f('auto_fixed', 'info')), null);
  assert.equal(findingHint(f('not_in_the_mirror', 'warn')), null);
  // W1 integration review: a pause of an unreachable source has no Fix, so its row shows the shared skip entry's line, which
  // must not name one cause (060 pauses for no material and for an unreachable source alike).
  const paused = findingHint(f('series_paused', 'info'));
  assert.equal(paused, 'Resume the series once the cause of the pause is fixed.');
  assert.doesNotMatch(paused!, /material/);
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

test('isStartMove: only off or shadow to approve or live starts posting', () => {
  for (const from of ['off', 'shadow']) for (const to of ['approve', 'live']) assert.equal(isStartMove(from, to), true, `${from} → ${to}`);
  for (const [from, to] of [['approve', 'live'], ['live', 'approve'], ['live', 'off'], ['approve', 'shadow'], ['off', 'shadow'], ['shadow', 'off'], ['off', 'off'], ['live', 'live']]) {
    assert.equal(isStartMove(from, to), false, `${from} → ${to}`);
  }
});

test('blockerIntro: the line above the list of a confirm that has its own text', () => {
  assert.equal(blockerIntro(1), 'The readiness check found 1 open blocker:');
  assert.equal(blockerIntro(3), 'The readiness check found 3 open blockers:');
});

test('blockedView: the view only when blockers are open; no blockers or a failed look asks nothing extra', async () => {
  const view = (blockers: number) => ({ channelKey: '@x', blockers, findings: [] }) as unknown as ReadinessView;
  assert.equal((await blockedView(async () => view(2)))?.blockers, 2);
  assert.equal(await blockedView(async () => view(0)), null);
  assert.equal(await blockedView(async () => { throw new Error('504'); }), null);
  assert.equal(await blockedView(() => { throw new Error('thrown before a promise'); }), null);
  assert.equal(await blockedView(async () => undefined as unknown as ReadinessView), null);
});

// ── where it is wired (T8b, T9) ──────────────────────────────────────────────────

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('the panel is placed on the Overview, the editor page and the started launch panel, and the deep link reaches the Overview', () => {
  assert.ok(read('../components/agents/AgentOverview.tsx').includes('<ReadinessPanel channelKey'));
  assert.ok(read('../routes/app.editor_.$channel.tsx').includes('<ReadinessPanel channelKey={c.channelKey}'));
  const launch = read('../components/launch/LaunchBody.tsx');
  assert.ok(launch.includes('started && v.channelKey') && launch.includes('whenMissing="empty"'), 'only after Start, with the empty state on a 404');
  const route = read('../routes/app.agents_.$handle.tsx');
  assert.ok(route.includes('parseReadinessFlag(s.readiness)') && route.includes('focusReadiness={!!search.readiness}'));
});

test('Start anyway sits in both mode switches and in the launch Start; none of them imports the queryClient singleton (A24)', () => {
  const editor = read('../components/editor/EditorUi.tsx');
  const agents = read('../components/agents/AgentsUi.tsx');
  const artifacts = read('../components/artifacts/ArtifactPanel.tsx');
  assert.ok(editor.includes('isStartMove(mode, next)') && editor.includes('guard.confirmStart(channelKey)'));
  assert.ok(agents.includes('channel && isStartMove(agent.mode, next)') && agents.includes('guard.confirmStart(channel)'));
  assert.ok(artifacts.includes("a.key === 'start'") && artifacts.includes('guard.check(d.row.channel)') && artifacts.includes('START_ANYWAY'));
  const guard = read('../components/readiness/useStartGuard.tsx');
  assert.ok(guard.includes('useQueryClient()') && guard.includes('staleTime: 0') && guard.includes('fresh: true'));
  for (const [name, src] of Object.entries({ editor, agents, artifacts, guard, panel: read('../components/readiness/ReadinessPanel.tsx') })) {
    assert.ok(!/import \{[^}]*\bqueryClient\b[^}]*\} from '[./]+\/router'/.test(src), `${name} reads the client through useQueryClient`);
  }
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

test('W1 integration review: a row Fix that removes a source is a danger "Remove" naming it; any other is "Apply fix"', () => {
  assert.deepEqual(fixConfirm({ label: 'Remove source “pdr_feed” from @pdr', auto: false, inFixAll: false, destructive: true }),
    { action: 'remove source “pdr_feed” from @pdr', confirmLabel: 'Remove', danger: true });
  assert.deepEqual(fixConfirm({ label: 'Switch the skill off', auto: false, inFixAll: true }), { action: 'switch the skill off', confirmLabel: 'Apply fix', danger: false });
});
