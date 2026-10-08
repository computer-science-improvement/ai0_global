// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 024 FR-011: resources are not "mirrors" — the UI says duplicate / adapt /
// unique / skip and "Auto-duplicate (legacy)". This guard fails when "mirror"
// appears in dashboard source outside comments, except the stored crosspost
// value 'mirror' (a quoted API value, never shown as is).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'lib/no-mirror-ui.test.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') && !name.endsWith('.test.ts') && name !== 'routeTree.gen.ts' ? [p] : [];
  });
}

/** Source without comments (block, JSX and line comments that start a line or follow whitespace — URLs keep their "//"). */
export function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** Lines that still say "mirror" once comments and the quoted stored value are gone. */
export function mirrorLines(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  stripComments(src).split('\n').forEach((text, i) => {
    const rest = text.replace(/(['"])mirror\1/g, '');
    if (/mirror/i.test(rest)) out.push({ line: i + 1, text: text.trim().slice(0, 160) });
  });
  return out;
}

test('the guard ignores comments and the stored value, and flags visible text', () => {
  assert.deepEqual(mirrorLines("// mirrors the server\nconst m: Mode = 'mirror';\n/** Mirror of x */\n<option value=\"mirror\">duplicate</option>"), []);
  assert.deepEqual(mirrorLines("const url = 'https://x.y'; // mirror"), []);
  assert.equal(mirrorLines('<b>mirror</b> — the same content').length, 1);
  assert.equal(mirrorLines("label: 'Mirror'").length, 1);
  assert.equal(mirrorLines("toast('posts mirror to Meta')").length, 1);
});

test('no user-visible "mirror" in dashboard source', () => {
  const files = walk(SRC);
  assert.ok(files.length > 50, `expected the dashboard sources under ${SRC}`);
  const problems: string[] = [];
  for (const f of files) {
    const rel = relative(SRC, f).split('\\').join('/');
    if (rel === SELF) continue;
    for (const o of mirrorLines(readFileSync(f, 'utf8'))) problems.push(`${rel}:${o.line}  ${o.text}`);
  }
  assert.deepEqual(problems, [], `Say duplicate / auto-duplicate instead of "mirror" (spec 024 FR-011):\n${problems.join('\n')}`);
});
