/**
 * Spec 037 T6: web_fetch / fetch_feed decode a page in the charset it declares. axios' `text` response always read
 * UTF-8, so a windows-1251 page came back as U+FFFD in every Cyrillic letter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declaredCharset, decodeBody, safeGet } from './safe-http';
import { findBrokenChars } from '../post/text-hygiene';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
/** «Привіт, світ» in windows-1251. */
const CP1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2, 0x2c, 0x20, 0xf1, 0xe2, 0xb3, 0xf2]);

test('the charset comes from the header, then a BOM, then <meta charset> / <?xml encoding>', () => {
  assert.equal(declaredCharset('text/html; charset=Windows-1251', Buffer.from('')), 'windows-1251');
  assert.equal(declaredCharset('text/html', Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'utf-8');
  assert.equal(declaredCharset('text/html', Buffer.from('<html><head><meta charset="koi8-u"></head>')), 'koi8-u');
  assert.equal(declaredCharset('text/html', Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">')), 'windows-1251');
  assert.equal(declaredCharset('application/rss+xml', Buffer.from('<?xml version="1.0" encoding="windows-1251"?><rss/>')), 'windows-1251');
  assert.equal(declaredCharset('text/html', Buffer.from('<p>no charset</p>')), null);
});

test('a windows-1251 page decodes to clean Cyrillic (it used to be U+FFFD); unknown labels fall back to UTF-8', () => {
  assert.equal(decodeBody(CP1251, 'text/html; charset=windows-1251'), 'Привіт, світ');
  assert.ok(findBrokenChars(CP1251.toString('utf8')).length > 0, 'the old UTF-8 read was broken');
  assert.equal(decodeBody(Buffer.from('Привіт', 'utf8'), 'text/html; charset=x-unknown'), 'Привіт');
  assert.equal(decodeBody(Buffer.from('﻿Привіт', 'utf8'), 'text/html'), 'Привіт', 'a UTF-8 BOM is dropped');
});

test('safeGet asks for bytes and decodes them; a string answer from a test seam passes through', async () => {
  const cfgs: any[] = [];
  const html = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1251"></head><body><p>'), CP1251, Buffer.from('</p></body></html>')]);
  const res = await safeGet('https://example.ua/news', {
    lookup: publicLookup,
    get: async (_u, cfg) => { cfgs.push(cfg); return { status: 200, headers: { 'content-type': 'text/html' }, data: html }; },
  });
  assert.equal(cfgs[0].responseType, 'arraybuffer');
  assert.match(res.body, /<p>Привіт, світ<\/p>/);
  const utf8 = await safeGet('https://example.com/', { lookup: publicLookup, get: async () => ({ status: 200, headers: {}, data: Buffer.from('<p>Київ</p>') }) });
  assert.equal(utf8.body, '<p>Київ</p>');
  const str = await safeGet('https://example.com/', { lookup: publicLookup, get: async () => ({ status: 200, headers: {}, data: 'plain' }) });
  assert.equal(str.body, 'plain');
});
