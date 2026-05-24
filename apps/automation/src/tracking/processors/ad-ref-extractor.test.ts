import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAdRefs } from './ad-ref-extractor';

test('extractAdRefs: captures forward source', () => {
  const refs = extractAdRefs({
    text: 'Some content',
    forwardFromUsername: 'somenews',
    entities: [],
  });
  assert.deepEqual(refs, [{ kind: 'tg_channel', username: 'somenews', forward: true }]);
});

test('extractAdRefs: captures @mention', () => {
  const refs = extractAdRefs({
    text: 'Підпишись на @awesome_channel — там круто',
    entities: [{ type: 'mention', offset: 13, length: 16 }],
  });
  assert.deepEqual(refs, [{ kind: 'tg_channel', username: 'awesome_channel' }]);
});

test('extractAdRefs: parses t.me/<u>/<id> URL with post id', () => {
  const refs = extractAdRefs({
    text: 'Дивись https://t.me/foochan/42',
    entities: [{ type: 'url', offset: 7, length: 23 }],
  });
  assert.deepEqual(refs, [{ kind: 'tg_channel', username: 'foochan', target_post_id: 42 }]);
});

test('extractAdRefs: parses t.me/<u> URL without post id', () => {
  const refs = extractAdRefs({
    text: 'Цей канал → https://t.me/barchan',
    entities: [{ type: 'url', offset: 12, length: 20 }],
  });
  assert.deepEqual(refs, [{ kind: 'tg_channel', username: 'barchan' }]);
});

test('extractAdRefs: captures instagram.com link', () => {
  const refs = extractAdRefs({
    text: 'Insta: https://instagram.com/cool.brand',
    entities: [{ type: 'url', offset: 7, length: 32 }],
  });
  assert.deepEqual(refs, [{ kind: 'instagram', username: 'cool.brand' }]);
});

test('extractAdRefs: captures generic web link by domain', () => {
  const refs = extractAdRefs({
    text: 'See https://example.com/page',
    entities: [{ type: 'url', offset: 4, length: 24 }],
  });
  assert.deepEqual(refs, [{ kind: 'web', domain: 'example.com' }]);
});

test('extractAdRefs: deduplicates same target across mention + url', () => {
  const refs = extractAdRefs({
    text: 'See @foochan or https://t.me/foochan',
    entities: [
      { type: 'mention', offset: 4, length: 8 },
      { type: 'url',     offset: 16, length: 20 },
    ],
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, 'tg_channel');
});

test('extractAdRefs: returns empty array when no refs', () => {
  const refs = extractAdRefs({ text: 'plain text', entities: [] });
  assert.deepEqual(refs, []);
});

test('extractAdRefs: lowercases tg usernames', () => {
  const refs = extractAdRefs({
    text: '@FooChannel',
    entities: [{ type: 'mention', offset: 0, length: 11 }],
  });
  assert.equal((refs[0] as any).username, 'foochannel');
});

test('extractAdRefs: parses t.me/+<hash> invite link', () => {
  const refs = extractAdRefs({
    text: 'Приєднуйся https://t.me/+EfjMN-0iNnpjOGUy',
    entities: [{ type: 'url', offset: 11, length: 30 }],
  });
  assert.deepEqual(refs, [{ kind: 'tg_invite', hash: 'EfjMN-0iNnpjOGUy' }]);
});

test('extractAdRefs: parses legacy t.me/joinchat/<hash> invite', () => {
  const refs = extractAdRefs({
    text: 'old https://t.me/joinchat/AAAABBBBCCCC',
    entities: [{ type: 'url', offset: 4, length: 34 }],
  });
  assert.deepEqual(refs, [{ kind: 'tg_invite', hash: 'AAAABBBBCCCC' }]);
});

test('extractAdRefs: invite link does not also count as web (dedup)', () => {
  // The same URL shouldn't produce both tg_invite + web — the explicit
  // tg_invite branch should match first and `continue` past GENERIC_RE.
  const refs = extractAdRefs({
    text: 'https://t.me/+abcd1234',
    entities: [{ type: 'url', offset: 0, length: 22 }],
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, 'tg_invite');
});
