import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { Ai0PromptsStrategy } from './ai0-prompts.strategy';

test('meta destination publishes prompthero image url via dispatcher', async () => {
  mock.method(axios, 'get', async () => ({ data: '<html></html>' }));

  const calls = { dispatch: null as any, posted: [] as any[] };
  const scraper = {
    extractMeta: () => ({ prompt: 'x'.repeat(80) }),
    buildMessage: () => ({ isError: false, caption: 'A caption', replyText: null }),
  };
  const db = {
    getNext: async (_cat: string, _key?: string) => ({
      id: 'https://img/p.png', prompt_source: 'https://prompthero/p',
      category: 'art', status: null, posted: null,
    }),
    markPosted: async (id: string, key?: string) => { calls.posted.push([id, key]); },
    markError: async () => {},
  };
  const dispatcher = { publish: async (...a: any[]) => { calls.dispatch = a; return 'ig-7'; } };

  // Constructor order: registry, telegram, db, scraper, notifier, publications, crossPost, dispatcher
  const s = new Ai0PromptsStrategy(
    { register() {} } as any,                  // registry
    { publishPrompt: async () => '1' } as any, // telegram
    db as any,                                 // db
    scraper as any,                            // scraper
    { notifyPublished: async () => {} } as any,// notifier
    { insert: async () => {} } as any,         // publications
    { afterPublish: async () => {} } as any,   // crossPost
    dispatcher as any,                         // dispatcher (last)
  );

  const dest = {
    platform: 'instagram', targetId: 'ig-target', token: 'tok',
    metaAccountId: 'acct-1', postedKey: 'IG:acct-1', throttleKey: 'meta:acct-1',
  };
  await s.execute('', {}, dest as any);

  assert.ok(calls.dispatch, 'dispatcher.publish called');
  assert.equal(calls.dispatch[0], 'instagram');
  assert.equal(calls.dispatch[1].imageUrl, 'https://img/p.png');
  assert.deepEqual(calls.posted, [['https://img/p.png', 'IG:acct-1']]);
});
