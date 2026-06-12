import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CuratedPromptsStrategy } from './curated-prompts.strategy';

function row(over = {}) {
  return {
    id: 'm1', category: 'Photorealism & Aesthetics', title: 'Crowd',
    prompt_text: 'Create a hyper-realistic cover.', source: '@seb',
    media_url: 'https://x/i.jpg', media_type: 'image', ...over,
  };
}

function build(over = {}) {
  const calls = { photo: [] as any[], video: [] as any[], posted: [] as string[], errored: [] as string[] };
  const registry = { register() {} };
  const publisher = {
    publishPrompt: async (p: any) => { calls.photo.push(p); return '10'; },
    publishVideo:  async (p: any) => { calls.video.push(p); return '11'; },
  };
  const repo = {
    getNext: async () => ('row' in (over as any) ? (over as any).row : row()),
    markPosted: async (id: string) => { calls.posted.push(id); },
    markError:  async (id: string) => { calls.errored.push(id); },
  };
  const notifier = { notifyPublished: async () => {} };
  const publications = { insert: async () => {} };
  const crossPost = { afterPublish: async () => {} };
  const dispatcher = { publish: async () => 'x' };
  const s = new CuratedPromptsStrategy(registry as any, publisher as any, repo as any, notifier as any, publications as any, crossPost as any, dispatcher as any);
  (s as any).downloadImage = async () => Buffer.from('img');
  return { s, calls };
}

test('image row → publishPrompt, caption has prompt + hashtag, marks posted', async () => {
  const { s, calls } = build();
  await s.execute('@chan', {});
  assert.equal(calls.photo.length, 1);
  assert.equal(calls.video.length, 0);
  assert.match(calls.photo[0].caption, /hyper-realistic cover/);
  assert.match(calls.photo[0].caption, /#photorealism/i);
  assert.deepEqual(calls.posted, ['m1']);
});

test('video row → publishVideo with the media URL', async () => {
  const { s, calls } = build({ row: row({ id: 'v1', media_type: 'video', media_url: 'https://x/v.mp4' }) });
  await s.execute('@chan', {});
  assert.equal(calls.video.length, 1);
  assert.equal(calls.video[0].videoUrl, 'https://x/v.mp4');
  assert.deepEqual(calls.posted, ['v1']);
});

test('long prompt → short caption + prompt in reply', async () => {
  const long = 'X'.repeat(1200);
  const { s, calls } = build({ row: row({ prompt_text: long }) });
  await s.execute('@chan', {});
  const p = calls.photo[0];
  assert.ok(p.caption.length <= 1024);
  assert.ok(p.replyText && p.replyText.includes(long.slice(0, 50)));
});

test('caption HTML-escapes the prompt', async () => {
  const { s, calls } = build({ row: row({ prompt_text: 'a < b & c > d' }) });
  await s.execute('@chan', {});
  assert.match(calls.photo[0].caption, /a &lt; b &amp; c &gt; d/);
});

test('image download failure (transient) → no markPosted, no markError', async () => {
  const { s, calls } = build();
  (s as any).downloadImage = async () => { throw new Error('net'); };
  await s.execute('@chan', {});
  assert.equal(calls.posted.length, 0);
  assert.equal(calls.errored.length, 0);
});

test('media gone (404) → markError, not retried', async () => {
  const { s, calls } = build();
  (s as any).downloadImage = async () => { const e: any = new Error('Request failed'); e.response = { status: 404 }; throw e; };
  await s.execute('@chan', {});
  assert.equal(calls.posted.length, 0);
  assert.deepEqual(calls.errored, ['m1']);
});

test('overflow with null title+category → caption still passes the 20-char floor', async () => {
  const long = 'Y'.repeat(1200);
  const { s, calls } = build({ row: row({ title: null, category: null, prompt_text: long }) });
  await s.execute('@chan', {});
  assert.equal(calls.photo.length, 1);
  assert.ok(calls.photo[0].caption.replace(/<[^>]*>/g, '').trim().length >= 20);
  assert.ok(calls.photo[0].replyText.includes(long.slice(0, 50)));
});

test('no rows → no-op', async () => {
  const { s, calls } = build({ row: null });
  await s.execute('@chan', {});
  assert.equal(calls.photo.length, 0);
  assert.equal(calls.video.length, 0);
});

test('meta destination publishes image row via dispatcher; video skipped', async () => {
  const calls = { dispatch: null as any, posted: [] as any[] };
  const make = (media_type: string) => ({
    repo: {
      getNext: async (_f: any, _k?: string) => ({ id: 'c1', category: 'art', title: 't', prompt_text: 'p', source: null, media_url: 'https://img/a.png', media_type }),
      markPosted: async (id: string, key?: string) => { calls.posted.push([id, key]); },
      markError: async () => {},
    },
    dispatcher: { publish: async (...a: any[]) => { calls.dispatch = a; return 'ig-3'; } },
  });
  const dest = { platform: 'instagram', targetId: 'ig-target', token: 'tok', metaAccountId: 'acct-1', postedKey: 'IG:acct-1', throttleKey: 'meta:acct-1' };

  // Constructor order: registry, publisher, repo, notifier, publications, crossPost, dispatcher
  const construct = (m: any) => new CuratedPromptsStrategy(
    { register() {} } as any,                                                 // registry
    { publishPrompt: async () => '1', publishVideo: async () => '1' } as any, // publisher
    m.repo as any,                                                            // repo
    { notifyPublished: async () => {} } as any,                              // notifier
    { insert: async () => {} } as any,                                       // publications
    { afterPublish: async () => {} } as any,                                 // crossPost
    m.dispatcher as any,                                                     // dispatcher (last)
  );

  // image row → published
  let m = make('image');
  let s = construct(m);
  await s.execute('', {}, dest as any);
  assert.equal(calls.dispatch[1].imageUrl, 'https://img/a.png');
  assert.deepEqual(calls.posted, [['c1', 'IG:acct-1']]);

  // video row → skipped, no dispatch, no markPosted
  calls.dispatch = null; calls.posted.length = 0;
  m = make('video');
  s = construct(m);
  await s.execute('', {}, dest as any);
  assert.equal(calls.dispatch, null);
  assert.deepEqual(calls.posted, []);
});
