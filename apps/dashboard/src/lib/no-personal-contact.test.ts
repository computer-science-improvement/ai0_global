// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 026 FR-009: the public pages carry no personal contact. Ads are ordered through
// the Telegram ad account or the request form; the owner's own address is never
// shipped in the bundle. This guard (and the CI grep in .github/workflows/ci-feature.yml)
// fails when a mail link or a webmail address appears in the dashboard sources,
// index.html or public/. The patterns are split so this file does not match itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const APP = join(SRC, '..');

const MAIL_LINK = new RegExp(['mail', 'to:'].join(''), 'i');
const WEBMAIL = new RegExp(`@(${['gmail', 'googlemail', 'ukr', 'i.ua', 'yahoo', 'outlook', 'hotmail', 'icloud', 'proton'].join('|')})\\.`, 'i');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx|js|jsx|html|css|json|svg|txt|webmanifest)$/.test(name) ? [p] : [];
  });
}

test('the patterns catch what they are meant to catch', () => {
  assert.ok(MAIL_LINK.test(`href="${'mail'}${'to'}:someone@example.com"`));
  assert.ok(WEBMAIL.test(`owner${'@'}gmail.com`));
  assert.ok(!WEBMAIL.test('support@example.com'));
});

test('no mail links or personal webmail addresses in the dashboard sources, index.html or public/', () => {
  const files = [...walk(SRC), join(APP, 'index.html'), ...(existsSync(join(APP, 'public')) ? walk(join(APP, 'public')) : [])];
  const self = fileURLToPath(import.meta.url);
  const problems: string[] = [];
  for (const f of files) {
    if (f === self) continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (MAIL_LINK.test(line) || WEBMAIL.test(line)) problems.push(`${relative(APP, f)}:${i + 1}`);
    });
  }
  // Only file:line is printed, never the matched text.
  assert.deepEqual(problems, [], `Personal contact found (spec 026 FR-009):\n${problems.join('\n')}`);
});
