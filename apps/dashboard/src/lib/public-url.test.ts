// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PUBLIC_URL, PUBLIC_URL_TOKEN, applyPublicUrl, resolvePublicUrl } from './public-url';

test('VITE_PUBLIC_URL resolves to an origin without a trailing slash', () => {
  assert.equal(resolvePublicUrl({}), DEFAULT_PUBLIC_URL);
  assert.equal(resolvePublicUrl({ VITE_PUBLIC_URL: '  ' }), DEFAULT_PUBLIC_URL);
  assert.equal(resolvePublicUrl({ VITE_PUBLIC_URL: 'https://ai0.example/' }), 'https://ai0.example');
  assert.equal(resolvePublicUrl({ VITE_PUBLIC_URL: 'https://example.org/landing//' }), 'https://example.org/landing');
  assert.throws(() => resolvePublicUrl({ VITE_PUBLIC_URL: 'ai0.example' }), /not a URL/);
  assert.throws(() => resolvePublicUrl({ VITE_PUBLIC_URL: 'ftp://ai0.example' }), /http/);
  assert.throws(() => resolvePublicUrl({ VITE_PUBLIC_URL: 'https://ai0.example/?x=1' }), /origin/);
});

test('index.html has no hardcoded host: every absolute link uses the placeholder', () => {
  const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
  assert.ok(!html.includes('dev.ai0.global'), 'the host comes from VITE_PUBLIC_URL');
  assert.ok(html.includes(`content="${PUBLIC_URL_TOKEN}/og.png"`));
  const out = applyPublicUrl(html, 'https://ai0.example');
  assert.ok(!out.includes(PUBLIC_URL_TOKEN));
  assert.ok(out.includes('<meta property="og:url" content="https://ai0.example/" />'));
  assert.match(out, /<title>[^<]*run by AI agents[^<]*<\/title>/);
});
