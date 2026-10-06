// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Owner rule (2026-10-06, AI0-79): all interface text is English. This guard
// fails when Cyrillic appears anywhere in apps/dashboard/src/**/*.{ts,tsx} —
// strings, JSX text and comments alike — except the allow-listed snippets
// below, which are Ukrainian *content* published verbatim into Ukrainian
// channels (the legal ad label and examples of what the owner types there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** file (relative to src/) → exact Cyrillic snippets allowed in it. */
const ALLOW: Record<string, string[]> = {
  // Landing: the legal ad hashtag every sponsored post carries.
  'routes/index.tsx': ['#реклама'],
  // Ad order form: the legal ad label and placeholders for Ukrainian ad content.
  'routes/app.ads.tsx': ['#реклама', 'Реклама. Замовник: …', 'ФОП Коваль', 'Детальніше'],
};

/** This guard itself (its own fixtures and allow-list are Cyrillic). */
const SELF = 'lib/no-cyrillic-ui.test.ts';

const CYRILLIC = /[\u0400-\u04FF\u0500-\u052F]/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [p] : [];
  });
}

/** Every line (1-based number + text) that still has Cyrillic once the allow-listed snippets are removed. */
function offendingLines(source: string, allowed: string[] = []): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  source.split('\n').forEach((text, i) => {
    let rest = text;
    for (const a of allowed) rest = rest.split(a).join('');
    if (CYRILLIC.test(rest)) out.push({ line: i + 1, text: text.trim().slice(0, 160) });
  });
  return out;
}

test('the guard flags Cyrillic in strings and comments, and honours the allow-list', () => {
  assert.deepEqual(offendingLines("const a = 'Approve';\n// fine"), []);
  assert.equal(offendingLines("const a = 'Апрувнути';").length, 1);
  assert.equal(offendingLines('// коментар').length, 1);
  assert.deepEqual(offendingLines("hint: '#реклама is added'", ['#реклама']), []);
  assert.equal(offendingLines("hint: '#реклама і ще'", ['#реклама']).length, 1, 'only the exact snippet is allowed');
});

test('no Cyrillic in dashboard UI source outside the allow-list', () => {
  const files = walk(SRC);
  assert.ok(files.length > 50, `expected the dashboard sources under ${SRC}`);
  const problems: string[] = [];
  for (const f of files) {
    const rel = relative(SRC, f).split('\\').join('/');
    if (rel === SELF) continue;
    for (const o of offendingLines(readFileSync(f, 'utf8'), ALLOW[rel] ?? [])) problems.push(`${rel}:${o.line}  ${o.text}`);
  }
  assert.deepEqual(problems, [], `Interface text must be English (apps/dashboard/CLAUDE.md → Language):\n${problems.join('\n')}`);
});

test('every allow-listed snippet is still used (stale entries are removed)', () => {
  for (const [rel, snippets] of Object.entries(ALLOW)) {
    const src = readFileSync(join(SRC, rel), 'utf8');
    for (const s of snippets) assert.ok(src.includes(s), `${rel} no longer contains «${s}» — drop it from ALLOW`);
  }
});
