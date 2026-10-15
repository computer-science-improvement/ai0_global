// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 023 FR-013, phase B: strategies no longer run. No UI path creates, enables or schedules a binding,
// /app/strategies* redirects to /app/agents and the menu has no Strategies entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_REGISTRY, NAV_GROUPS } from '../nav/registry';
import { Route as StrategiesRoute } from '../routes/app.strategies';
import { Route as StrategyDetailRoute } from '../routes/app.strategies_.$id';
import { Route as StrategyNewRoute } from '../routes/app.strategies_.new';
import { needsAttention } from '../components/strategies/MigrationBanner';
import type { MigrationChannel } from '../api/strategies';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(f) && !f.endsWith('.test.ts') ? [p] : [];
  });
}

test('the strategies API module has no create/delete call and PATCH only pauses or edits notes', () => {
  const api = readFileSync(join(SRC, 'api', 'strategies.ts'), 'utf8');
  assert.doesNotMatch(api, /api<[^>]*>\('\/api\/strategies', \{ method: 'POST'/);
  assert.doesNotMatch(api, /method: 'DELETE'/);
  assert.doesNotMatch(api, /\/runs|\/preview|\/post-preview|\/api\/strategies\/types/);
  const patchType = api.slice(api.indexOf('export interface PatchStrategyInput'), api.indexOf('export function usePatchStrategy'));
  assert.match(patchType, /enabled\?: false;/);
  assert.doesNotMatch(patchType, /schedule|params|ext_id|channel_id/);
});

test('no page offers to add, re-enable or preview a strategy', () => {
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /useCreateStrategy|useDeleteStrategy|useStrategyRuns|useStrategyPreview|StrategyForm|InlineScheduleEditor|Add strategy/, file);
    assert.doesNotMatch(text, /enabled: !s\.enabled/, `${file} toggles a strategy on`);
    assert.doesNotMatch(text, /next_run_at|content_remaining/, `${file} reads a removed strategy field`);
  }
});

function redirectTarget(route: { options: any }): { to: string; replace?: boolean } {
  try {
    route.options.beforeLoad({ search: {}, params: {} });
  } catch (thrown: any) {
    const opts = thrown?.options ?? thrown;
    return { to: opts.to, replace: opts.replace };
  }
  assert.fail('beforeLoad did not redirect');
}

test('/app/strategies, /app/strategies/$id and /app/strategies/new redirect to /app/agents', () => {
  for (const route of [StrategiesRoute, StrategyDetailRoute, StrategyNewRoute]) {
    assert.deepEqual(redirectTarget(route), { to: '/app/agents', replace: true });
    assert.equal((route.options as { component?: unknown }).component, undefined);
  }
});

test('the menu has no Strategies entry and no Legacy group', () => {
  assert.deepEqual(NAV_REGISTRY.filter((e) => /strateg/.test(e.id) || /\/app\/strategies/.test(JSON.stringify(e))), []);
  assert.equal(NAV_GROUPS.some((g) => (g.id as string) === 'g_legacy'), false);
});

test('the bindings card on /app/agents lists only channels with enabled bindings or a pending card', () => {
  const base = { channel_key: 'c', agent: null, state: 'legacy', enabled: [], retired: [], draft: null, shadow: null, cards: [] } as unknown as MigrationChannel;
  assert.equal(needsAttention(base), false);
  assert.equal(needsAttention({ ...base, state: 'retired', retired: ['x'] }), false);
  assert.equal(needsAttention({ ...base, state: 'not_migrated', enabled: ['x'] }), true);
  assert.equal(needsAttention({ ...base, cards: [{ id: '1', kind: 'strategy_cutover', summary: 's' }] as unknown as MigrationChannel['cards'] }), true);
});
