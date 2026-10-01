import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComposeTools } from './compose-tools';
import { makeCard, makeSpec } from '../post/testing/fixtures';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const get = async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: '<meta property="og:image" content="https://i.example/og.jpg"><article><img src="https://i.example/1.jpg"></article>' });
const tools = Object.fromEntries(buildComposeTools({ http: { lookup, get } }).map((t) => [t.name, t]));
const ctx: any = { runId: 'r', role: 'executor', channelKey: '@chan', extras: { card: makeCard() } };

test('get_channel_card returns summary with capabilities', async () => {
  const r: any = await tools.get_channel_card.execute({}, ctx);
  assert.equal(r.channel, '@chan');
  assert.ok(r.capabilities.formats.album);
});

test('lint_post and preview_post', async () => {
  const l: any = await tools.lint_post.execute({ spec: makeSpec() }, ctx);
  assert.equal(l.ok, true);
  const p: any = await tools.preview_post.execute({ spec: makeSpec() }, ctx);
  assert.deepEqual(p.messages, ['sendPhoto']);
  assert.match(p.preview, /<b>Телескоп/);
});

test('extract_images', async () => {
  const r: any = await tools.extract_images.execute({ url: 'https://news.example/a' }, ctx);
  assert.equal(r.og_image, 'https://i.example/og.jpg');
  assert.deepEqual(r.images, ['https://i.example/1.jpg']);
});

test('missing card is an error', async () => {
  await assert.rejects(tools.get_channel_card.execute({}, { ...ctx, extras: {} }), /no channel card/);
});
