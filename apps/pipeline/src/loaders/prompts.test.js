import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isSinglePromptUrl, mapItems, mapRow, rejectReason, REFRESH_FIELDS } from './prompts.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'normalized', 'prompts');

const ITEM = {
  href: 'https://prompthero.com/prompt/b9557d0c84a-flux-portrait',
  src: 'https://prompthero.com/_next/image?url=x&w=1920&q=75',
  realImage: 'https://cdn.prompthero.com/lmmvwo5w4zzirrctdoo0kntpkujq',
  category: 'flux',
  scrapedAt: '2026-01-31T12:26:53.666Z',
  pageUrl: 'https://prompthero.com/flux-prompts',
};

test('isSinglePromptUrl: a /prompt/<id> page only — never a gallery, search or listing page', () => {
  assert.ok(isSinglePromptUrl(ITEM.href));
  assert.ok(isSinglePromptUrl('http://www.prompthero.com/prompt/abc'));
  for (const u of ['https://prompthero.com/flux-prompts', 'https://prompthero.com/interior-design-prompts', 'https://prompthero.com/featured',
    'https://prompthero.com/search?q=model', 'https://prompthero.com/prompt/', 'https://example.com/prompt/abc', '', null, undefined]) {
    assert.equal(isSinglePromptUrl(u), false, String(u));
  }
});

test('mapRow: page_url is the prompt page (href), media_url the image; the gallery pageUrl is not stored', () => {
  assert.deepEqual(mapRow(ITEM), {
    id: ITEM.realImage, prompt_source: ITEM.href, page_url: ITEM.href, media_url: ITEM.realImage, media_type: 'image',
    category: 'flux', provider: 'prompthero', scraped_at: ITEM.scrapedAt,
  });
  assert.ok(!Object.values(mapRow(ITEM)).includes(ITEM.pageUrl));
  assert.deepEqual(REFRESH_FIELDS, ['page_url', 'media_url', 'media_type']);
});

test('items without a single-prompt link or an image are skipped and counted by reason', () => {
  const { rows, skipped } = mapItems([
    ITEM,
    { ...ITEM, href: ITEM.pageUrl },
    { ...ITEM, href: undefined },
    { ...ITEM, realImage: '' },
    null,
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(skipped, { 'no single-prompt link (href)': 2, 'no image (realImage)': 1, 'not an object': 1 });
  assert.equal(rejectReason(ITEM), null);
});

test('the committed scrape files map to postable rows only (page_url a /prompt/ page, media_url set)', () => {
  let n = 0;
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
    const { rows } = mapItems(JSON.parse(readFileSync(join(DIR, f), 'utf8')));
    for (const r of rows) {
      assert.ok(isSinglePromptUrl(r.page_url), `${f}: ${r.page_url}`);
      assert.ok(r.media_url, `${f}: media_url`);
    }
    n += rows.length;
  }
  assert.ok(n > 0, 'the scrape files are present');
});
