// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 027 T1 / FR-002: the legacy paths are redirect-only and keep their params.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Route as AgentRoute } from '../routes/app.agent';
import { Route as BotsRoute } from '../routes/app.bots';
import { Route as TelegraphRoute } from '../routes/app.telegraph';
import { Route as CalendarRoute } from '../routes/app.calendar';

/** Run a route's beforeLoad and return the redirect it throws. */
function redirectOf(route: { options: any }, search: Record<string, unknown> = {}): { to: string; search?: unknown } {
  const validated = route.options.validateSearch ? route.options.validateSearch(search) : search;
  try {
    route.options.beforeLoad({ search: validated });
  } catch (thrown: any) {
    const opts = thrown?.options ?? thrown;
    return { to: opts.to, search: opts.search };
  }
  assert.fail('beforeLoad did not redirect');
}

test('/app/agent redirects to the DM inbox and keeps every search param', () => {
  assert.deepEqual(redirectOf(AgentRoute, { cat: 'ad' }), { to: '/app/dm', search: { cat: 'ad' } });
  assert.deepEqual(redirectOf(AgentRoute, { cat: 'vp', x: '1' }), { to: '/app/dm', search: { cat: 'vp', x: '1' } });
  assert.deepEqual(redirectOf(AgentRoute), { to: '/app/dm', search: {} });
});

test('/app/bots and /app/telegraph land on the Telegram tabs of Connections', () => {
  assert.deepEqual(redirectOf(BotsRoute), { to: '/app/connections', search: { section: 'telegram', tab: 'bots' } });
  assert.deepEqual(redirectOf(TelegraphRoute), { to: '/app/connections', search: { section: 'telegram', tab: 'telegraph' } });
});

test('/app/calendar redirects to Scheduled', () => {
  assert.equal(redirectOf(CalendarRoute).to, '/app/scheduled');
});

test('the /app/connections/$platform stub is gone and nothing renders the legacy pages', () => {
  const src = fileURLToPath(new URL('..', import.meta.url));
  assert.equal(existsSync(`${src}routes/app.connections.$platform.tsx`), false);
  for (const f of ['app.agent.tsx', 'app.bots.tsx', 'app.telegraph.tsx', 'app.calendar.tsx']) {
    const code = readFileSync(`${src}routes/${f}`, 'utf8');
    assert.doesNotMatch(code, /component\s*:/, `${f} must be redirect-only`);
  }
  const tree = readFileSync(`${src}routeTree.gen.ts`, 'utf8');
  assert.doesNotMatch(tree, /connections\/\$platform/);
});
