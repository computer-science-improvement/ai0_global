// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 023 FR-013 phase A: no UI path can create or enable a strategy binding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { navEntry } from '../nav/registry';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(f) && !f.endsWith('.test.ts') ? [p] : [];
  });
}

test('the strategies API module has no create call and PATCH only pauses or edits notes', () => {
  const api = readFileSync(join(SRC, 'api', 'strategies.ts'), 'utf8');
  assert.doesNotMatch(api, /api<[^>]*>\('\/api\/strategies', \{ method: 'POST'/);
  const patchType = api.slice(api.indexOf('export interface PatchStrategyInput'), api.indexOf('export function usePatchStrategy'));
  assert.match(patchType, /enabled\?: false;/);
  assert.doesNotMatch(patchType, /schedule|params|ext_id|channel_id/);
});

test('no page offers to add or re-enable a strategy', () => {
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /useCreateStrategy|StrategyForm|InlineScheduleEditor|Add strategy/, file);
    assert.doesNotMatch(text, /enabled: !s\.enabled/, `${file} toggles a strategy on`);
  }
});

test('Strategies sit in the Legacy menu group', () => {
  assert.equal(navEntry('strategies')?.defaultGroup, 'g_legacy');
  assert.equal(navEntry('strategies-new')?.hiddenByDefault, true);
});
