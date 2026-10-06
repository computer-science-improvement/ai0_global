// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 029 T6/T7: the view logic of the Agents and AI spend cards and the Spend page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  barPct, budgetBadge, budgetBarColor, cardView, customRangeError, deltaTone, estimatedNote, fmtDelta, fmtRate, fmtTokens, fmtUsd,
  parseUsd, seriesColor, spendIsEmpty,
} from './spend';
import { parseSpendSearch } from './spend-search';
import { spendParams } from '../api/spend';

test('card view: loading, error, empty and data states', () => {
  const empty = (d: { n: number }) => d.n === 0;
  assert.equal(cardView({ isLoading: true }, empty), 'loading');
  assert.equal(cardView({ error: new Error('x') }, empty), 'error');
  assert.equal(cardView({ error: new Error('refetch failed'), data: { n: 1 } }, empty), 'data', 'stale data beats a refetch error');
  assert.equal(cardView({ data: { n: 0 } }, empty), 'empty');
  assert.equal(cardView({ data: { n: 2 } }, empty), 'data');
  const s = (calls: number, usd: number, blocking: unknown[] = []) => ({ periods: { '30d': { calls, usd } }, blocking });
  assert.equal(spendIsEmpty(s(0, 0)), true);
  assert.equal(spendIsEmpty(s(3, 0)), false);
  assert.equal(spendIsEmpty(s(0, 0, [{}])), false, 'a blocking cap is shown even with an empty ledger');
});

test('budget colours follow BR-CORE-34 and a hit cap reads Blocked', () => {
  assert.equal(budgetBarColor('ok'), 'var(--color-accent)');
  assert.equal(budgetBarColor('warning'), 'var(--color-warning)');
  assert.equal(budgetBarColor('danger'), 'var(--color-danger)');
  assert.equal(budgetBarColor('blocked'), 'var(--color-danger)');
  assert.equal(budgetBarColor('over'), 'var(--color-danger)');
  assert.deepEqual(budgetBadge('blocked', true), { tone: 'danger', label: 'Blocked' });
  assert.deepEqual(budgetBadge('over', false), { tone: 'warning', label: 'Over cap (alert only)' });
  assert.deepEqual(budgetBadge('ok', false), { tone: 'neutral', label: 'Alert only' });
  assert.equal(budgetBadge('ok', true), null);
  assert.equal(barPct(1.5, 3), 50);
  assert.equal(barPct(5, 3), 100);
  assert.equal(barPct(0.1, 0), 100);
  assert.equal(barPct(1, null), 0);
});

test('number formats and deltas', () => {
  assert.equal(fmtUsd(0), '$0.00');
  assert.equal(fmtUsd(0.0042), '$0.0042');
  assert.equal(fmtUsd(4.2), '$4.20');
  assert.equal(fmtUsd(12345.6), '$12,346');
  assert.equal(fmtUsd(null), '—');
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(1234), '1.2K');
  assert.equal(fmtTokens(45_600), '46K');
  assert.equal(fmtTokens(4_100_000), '4.1M');
  assert.equal(fmtDelta(12.4), '+12%');
  assert.equal(fmtDelta(-8.25), '−8.3%');
  assert.equal(fmtDelta(null, 0, 1), 'new');
  assert.equal(fmtDelta(null, 0, 0), '—');
  assert.equal(deltaTone(5), 'warning');
  assert.equal(deltaTone(-5), 'success');
  assert.equal(fmtRate(91.6), '92%');
  assert.equal(fmtRate(null), '—');
});

test('the "% estimated" note appears only above 10 %', () => {
  assert.equal(estimatedNote({ estimatedPct: 5, unpricedPct: 0, unpricedCalls: 0, note: false }), null);
  assert.equal(estimatedNote({ estimatedPct: 42, unpricedPct: 0, unpricedCalls: 0, note: true }), '42% of USD is estimated from the price table');
  assert.match(estimatedNote({ estimatedPct: 0, unpricedPct: 25, unpricedCalls: 3, note: true })!, /3 calls \(25%\) have no price/);
});

test('Spend page URL state, custom ranges and money inputs', () => {
  assert.deepEqual(parseSpendSearch({ tab: 'budgets', range: '30d', groupBy: 'agent', shadow: '1', provider: 'anthropic' }),
    { tab: 'budgets', range: '30d', from: undefined, to: undefined, groupBy: 'agent', stackBy: undefined, agent: undefined, feature: undefined, provider: 'anthropic', shadow: true });
  const bad = parseSpendSearch({ tab: 'x', range: '1y', groupBy: 'week', provider: 'gemini', agent: 'nope', feature: 'DROP TABLE', from: '2026-01-01' });
  assert.deepEqual(Object.values(bad).filter((v) => v !== undefined), []);
  assert.equal(customRangeError('2026-01-01', '2026-01-31'), null);
  assert.equal(customRangeError('2026-02-01', '2026-01-31'), 'The start is after the end');
  assert.equal(customRangeError('2025-01-01', '2026-01-03'), 'At most 366 days');
  assert.equal(customRangeError('', '2026-01-03'), 'Pick both days');
  assert.equal(parseUsd(''), null);
  assert.equal(parseUsd('0,25'), 0.25);
  assert.ok(Number.isNaN(parseUsd('-1')));
  assert.ok(Number.isNaN(parseUsd('abc')));
  assert.equal(spendParams({ range: '7d', groupBy: 'feature', shadow: true, feature: 'editor.' }), 'range=7d&groupBy=feature&feature=editor.&shadow=1');
  assert.equal(spendParams({ range: '7d', from: '2026-01-01', to: '2026-01-02', groupBy: 'raw' as any }), 'from=2026-01-01&to=2026-01-02&groupBy=raw');
  assert.equal(seriesColor('other', 0), 'var(--color-ink-dim)');
  assert.equal(seriesColor('openrouter', 9), 'var(--color-warning)');
});
