import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorCrossPoster } from './editor-crosspost';
import { makeCard, makeSpec } from '../post/testing/fixtures';

const req = (over: any = {}) => ({ channelKey: '@chan', messageId: 42, spec: makeSpec({ body: [{ type: 'p', text: 'Зорі & <газ> у туманності Кільце.' }] }), card: makeCard(), prepared: {}, ...over });

test('both mechanisms get per-platform plain captions (escaped for the publishers) and a Telegram source', async () => {
  const seen: any = {};
  const poster = new EditorCrossPoster({
    crossPost: { afterPublish: async (input) => {
      seen.cp = { ig: input.render!('instagram', 'https://t.me/chan/42'), th: input.render!('threads', 'https://t.me/chan/42'), key: input.channelKey, mid: input.messageId };
      return [{ platform: 'threads', status: 'ok' }];
    } },
    groupFanOut: { fanOut: async (source, content) => {
      seen.gf = { source, tg: content.render!('telegram'), fb: content.render!('facebook') };
      return [];
    } },
    postLink: (k, m) => `https://t.me/${k.slice(1)}/${m}`,
  });
  const warnings = await poster.fanOut(req());
  assert.deepEqual(warnings, []);
  assert.equal(seen.cp.key, '@chan');
  assert.equal(seen.cp.mid, 42);
  assert.match(seen.cp.ig.caption, /Зорі &amp; &lt;газ&gt;/);
  assert.match(seen.cp.ig.caption, /Посилання в біо/);
  assert.match(seen.cp.th.caption, /↗ https:\/\/t\.me\/chan\/42/);
  assert.deepEqual(seen.cp.ig.imageUrls, ['https://images.nasa.gov/ring.jpg']);
  assert.equal(seen.gf.source.platform, 'telegram');
  assert.equal(seen.gf.source.targetId, '@chan');
  assert.equal(seen.gf.tg, null);
  assert.match(seen.gf.fb.caption, /↗ https:\/\/t\.me\/chan\/42/);
});

test('poll: Instagram rendered as null (skipped) by both paths', async () => {
  let ig: unknown = 'unset';
  const poster = new EditorCrossPoster({
    crossPost: { afterPublish: async (input) => { ig = input.render!('instagram', null); return []; } },
    groupFanOut: { fanOut: async () => [] },
    postLink: () => null,
  });
  await poster.fanOut(req({ spec: makeSpec({ format: 'poll', media: [], body: [], poll: { question: 'Що краще?', options: ['A', 'B'] } }) }));
  assert.equal(ig, null);
});

test('failures and thrown errors become crosspost warnings, never exceptions', async () => {
  const poster = new EditorCrossPoster({
    crossPost: { afterPublish: async () => [{ platform: 'instagram', status: 'failed', detail: 'media expired' }, { platform: 'facebook', status: 'skipped', detail: 'cooldown' }] },
    groupFanOut: { fanOut: async () => { throw new Error('db down'); } },
    postLink: () => null,
  });
  assert.deepEqual(await poster.fanOut(req()), ['crosspost: instagram: media expired', 'crosspost: group: db down']);
});
