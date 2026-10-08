// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTACT_HINT, contactError, contactKind, lengthError, parseResourceLinks, utmFrom, whiteLabelVisible } from './lead-form';
import { SINGLE_TENANT_STATEMENT } from './white-label-copy';

test('contactKind matches the server rules (Telegram with @ or a t.me link, email, phone)', () => {
  assert.equal(contactKind('@ann_ads'), 'telegram');
  assert.equal(contactKind('https://t.me/ann_ads'), 'telegram');
  assert.equal(contactKind('ann@example.com'), 'email');
  assert.equal(contactKind('+380 67 123 45 67'), 'phone');
  assert.equal(contactKind('ann_ads'), null);
  assert.equal(contactKind('12'), null);
  assert.equal(contactError(''), CONTACT_HINT);
  assert.equal(contactError('x'.repeat(201) + '@a.co').startsWith('The contact is longer'), true);
  assert.equal(contactError('@ann_ads'), null);
  assert.equal(lengthError('abc', 2, 'The name'), 'The name is longer than 2 characters.');
});

test('parseResourceLinks splits lines, dedups, and reports the first bad or extra link', () => {
  assert.deepEqual(parseResourceLinks('https://t.me/a\nhttps://t.me/a, https://instagram.com/b'), { links: ['https://t.me/a', 'https://instagram.com/b'], error: null });
  assert.match(parseResourceLinks('t.me/a').error ?? '', /not a full link/);
  assert.match(parseResourceLinks('javascript:alert(1)').error ?? '', /not a full link/);
  assert.match(parseResourceLinks(Array.from({ length: 11 }, (_, i) => `https://t.me/c${i}`).join('\n')).error ?? '', /at most 10/);
  assert.deepEqual(parseResourceLinks('   '), { links: [], error: null });
});

test('the white-label UI shows only when the config says the flag is on', () => {
  assert.equal(whiteLabelVisible(undefined), false, 'hidden while the config loads');
  assert.equal(whiteLabelVisible({ whiteLabelEnabled: false }), false);
  assert.equal(whiteLabelVisible({ whiteLabelEnabled: true }), true);
});

test('utmFrom keeps utm_* only', () => {
  assert.deepEqual(utmFrom('?utm_source=tg&utm_campaign=x&ref=y'), { utm_source: 'tg', utm_campaign: 'x' });
  assert.equal(utmFrom('?a=b'), undefined);
});

test('the single-tenant statement is present on the #white-label section and the /white-label page', () => {
  assert.match(SINGLE_TENANT_STATEMENT, /single-tenant/);
  assert.match(SINGLE_TENANT_STATEMENT, /separate deployment/);
  assert.match(SINGLE_TENANT_STATEMENT, /no shared cabinet/);
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  // The section renders SingleTenantNote (which renders the statement); the page renders it too.
  assert.match(src('../components/landing/WhiteLabel.tsx'), /\{SINGLE_TENANT_STATEMENT\}/);
  assert.match(src('../components/landing/WhiteLabel.tsx'), /export function WhiteLabelSection[\s\S]*<SingleTenantNote \/>/);
  assert.match(src('../routes/white-label.tsx'), /<SingleTenantNote \/>/);
  // Both are gated on the flag.
  assert.match(src('../routes/index.tsx'), /\{whiteLabel && <WhiteLabelSection \/>\}/);
  assert.match(src('../routes/white-label.tsx'), /const visible = whiteLabelVisible\(config\.data\)/);
});
