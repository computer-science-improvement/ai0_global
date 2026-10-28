// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 A3: how an Inbox note's refType / refId are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionLink, firstTelegramRef, flattenTree, nodeByHandle, nodeById, nodeByScope, parseEscalationRef, parseHostRef, parseRefId,
  parseResourceRef, parseSeriesRef, replanChannel, resolveHandle, resourceRefOf, telegramChannelOf, type TreeNode,
} from './inbox-ref';

const node = (over: Partial<TreeNode> & { id: string; handle: string }): TreeNode => ({ kind: 'orchestrator', scopeId: null, children: [], ...over });

const TREE: TreeNode[] = [
  node({ id: 'm1', handle: 'manager', kind: 'manager', children: [
    node({ id: 'o1', handle: 'space', scopeId: 'telegram:@space', children: [node({ id: 'p1', handle: 'space_planner', kind: 'planner', scopeId: 'telegram:@space' })] }),
    node({ id: 'o2', handle: 'recipes', scopeId: 'telegram:@recipes' }),
    node({ id: 'o3', handle: 'net_food', scopeId: 'network:g1' }),
  ] }),
];

test('parseRefId: the base is the ref without #hash and |suffix', () => {
  assert.deepEqual(parseRefId('abc'), { raw: 'abc', base: 'abc', suffix: null, day: null, hash: null });
  assert.deepEqual(parseRefId('threads:u1#ab12cd34'), { raw: 'threads:u1#ab12cd34', base: 'threads:u1', suffix: null, day: null, hash: 'ab12cd34' });
  const d = parseRefId('telegram:@space|2026-10-28#ab12cd34');
  assert.equal(d?.base, 'telegram:@space');
  assert.equal(d?.day, '2026-10-28');
  assert.equal(d?.hash, 'ab12cd34');
  // event_not_covered: a story id and a time, not a day
  const e = parseRefId('story-9|2026-10-28T09:30:00.000Z');
  assert.equal(e?.base, 'story-9');
  assert.equal(e?.suffix, '2026-10-28T09:30:00.000Z');
  assert.equal(e?.day, null);
  // the old rule, kept as the definition
  for (const raw of ['x', 'a#h', 'a|d', 'a|d#h', 'bot:u|2026-01-01#h']) assert.equal(parseRefId(raw)?.base, raw.split('#')[0].split('|')[0]);
  assert.equal(parseRefId(''), null);
  assert.equal(parseRefId(null), null);
  assert.equal(parseRefId(undefined), null);
  assert.equal(parseRefId('#h'), null);
});

test('parseResourceRef: split at the first colon only', () => {
  assert.deepEqual(parseResourceRef('telegram:@space'), { platform: 'telegram', id: '@space' });
  assert.deepEqual(parseResourceRef('threads:0f9c'), { platform: 'threads', id: '0f9c' });
  assert.deepEqual(parseResourceRef('youtube:a:b:c'), { platform: 'youtube', id: 'a:b:c' });
  assert.equal(parseResourceRef('plain'), null);
  assert.equal(parseResourceRef(':x'), null);
  assert.equal(parseResourceRef('telegram:'), null);
  assert.equal(parseResourceRef(null), null);
});

test('telegramChannelOf: only telegram refs have a channel key', () => {
  assert.equal(telegramChannelOf('telegram:@space'), '@space');
  assert.equal(telegramChannelOf('telegram:space_news'), 'space_news');
  assert.equal(telegramChannelOf('instagram:u1'), null);
  assert.equal(telegramChannelOf(null), null);
});

test('series, escalation and host refs', () => {
  assert.deepEqual(parseSeriesRef('space:Daily facts'), { owner: 'space', series: 'Daily facts' });
  // a series name may contain ':'
  assert.deepEqual(parseSeriesRef('space:Recipe: soups'), { owner: 'space', series: 'Recipe: soups' });
  assert.deepEqual(parseSeriesRef('space:Q&A | weekly #2'), { owner: 'space', series: 'Q&A | weekly #2' });
  assert.equal(parseSeriesRef('nocolon'), null);
  assert.deepEqual(parseEscalationRef('escalation:space:dark_streak|2026-10-28#ab12cd34'), { handle: 'space', kind: 'dark_streak' });
  assert.deepEqual(parseEscalationRef('escalation:space:a:b'), { handle: 'space', kind: 'a:b' });
  assert.equal(parseEscalationRef('space:dark'), null);
  assert.deepEqual(parseHostRef('@space/example.com'), { channelKey: '@space', host: 'example.com' });
  assert.deepEqual(parseHostRef('a/b/example.com#h'), { channelKey: 'a/b', host: 'example.com' });
  assert.equal(parseHostRef('example.com'), null);
});

test('firstTelegramRef: reads the resource lines of an event note', () => {
  const body = 'The event "Launch" (28 Oct) was announced.\n• telegram:@space: announced 2 time(s), e.g. «see you»\n• instagram:u1: announced 1 time(s)';
  assert.equal(firstTelegramRef(body), 'telegram:@space');
  assert.equal(firstTelegramRef('• instagram:u1: announced 1 time(s)'), null);
  assert.equal(firstTelegramRef(null), null);
  assert.equal(firstTelegramRef('no refs here'), null);
});

test('connectionLink: the Connections section and tab of every platform', () => {
  const l = (p: string) => connectionLink(p);
  assert.deepEqual(l('telegram'), { to: '/app/connections', search: { section: 'telegram' } });
  assert.deepEqual(l('youtube'), { to: '/app/connections', search: { section: 'telegram' } });
  assert.deepEqual(l('bot'), { to: '/app/connections', search: { section: 'telegram', tab: 'bots' } });
  assert.deepEqual(l('mtproto'), { to: '/app/connections', search: { section: 'telegram', tab: 'sessions' } });
  assert.deepEqual(l('telegraph'), { to: '/app/connections', search: { section: 'telegram', tab: 'telegraph' } });
  assert.deepEqual(l('threads'), { to: '/app/connections', search: { section: 'meta', tab: 'threads' } });
  assert.deepEqual(l('instagram'), { to: '/app/connections', search: { section: 'meta', tab: 'instagram' } });
  assert.deepEqual(l('facebook'), { to: '/app/connections', search: { section: 'meta', tab: 'facebook' } });
  assert.deepEqual(l('tiktok'), { to: '/app/connections', search: { section: 'tiktok' } });
  assert.deepEqual(l('something-new'), { to: '/app/connections', search: { section: 'telegram' } });
});

test('tree helpers: flatten, by handle / id / scope (the orchestrator wins over its planner)', () => {
  assert.deepEqual(flattenTree(TREE).map((n) => n.handle), ['manager', 'space', 'space_planner', 'recipes', 'net_food']);
  assert.deepEqual(flattenTree(undefined), []);
  assert.equal(nodeByHandle(TREE, 'recipes')?.id, 'o2');
  assert.equal(nodeByHandle(TREE, 'nope'), null);
  assert.equal(nodeById(TREE, 'p1')?.handle, 'space_planner');
  assert.equal(nodeByScope(TREE, 'telegram:@space')?.handle, 'space');
  assert.equal(nodeByScope(TREE, 'telegram:@none'), null);
  assert.equal(nodeByScope(TREE, null), null);
});

test('resourceRefOf: only resource and resource_day refs', () => {
  assert.equal(resourceRefOf({ refType: 'resource', refId: 'threads:u1' }), 'threads:u1');
  assert.equal(resourceRefOf({ refType: 'resource_day', refId: 'telegram:@space|2026-10-28#ab' }), 'telegram:@space');
  assert.equal(resourceRefOf({ refType: 'slot', refId: 's1' }), null);
});

test('resolveHandle: agentId first, then the ref matched against the tree', () => {
  const it = (over: object) => ({ agentId: null, refType: null, refId: null, ...over });
  assert.equal(resolveHandle(it({ agentId: 'o2' }), TREE), 'recipes');
  assert.equal(resolveHandle(it({ agentId: 'o2', refType: 'agent', refId: 'space' }), TREE), 'recipes');
  assert.equal(resolveHandle(it({ refType: 'agent', refId: 'space' }), TREE), 'space');
  assert.equal(resolveHandle(it({ refType: 'agent', refId: 'ghost' }), TREE), null);
  assert.equal(resolveHandle(it({ refType: 'agent', refId: null }), TREE), null);
  assert.equal(resolveHandle(it({ refType: 'escalation', refId: 'escalation:recipes:dark|2026-10-28#ab' }), TREE), 'recipes');
  assert.equal(resolveHandle(it({ refType: 'resource', refId: 'telegram:@space' }), TREE), 'space');
  assert.equal(resolveHandle(it({ refType: 'resource_day', refId: 'telegram:@recipes|2026-10-28#ab' }), TREE), 'recipes');
  assert.equal(resolveHandle(it({ refType: 'resource', refId: 'threads:u1' }), TREE), null);
  assert.equal(resolveHandle(it({ refType: 'series', refId: 'space:Daily facts' }), TREE), 'space');
  assert.equal(resolveHandle(it({ refType: 'series', refId: '@unknown:Daily facts' }), TREE), null);
  assert.equal(resolveHandle(it({ refType: 'slot', refId: 's1' }), TREE), null);
});

test('resolveHandle: with the tree not loaded, a handle the ref names is trusted, a scope cannot be matched', () => {
  const it = (over: object) => ({ agentId: null, refType: null, refId: null, ...over });
  for (const tree of [undefined, null, []]) {
    assert.equal(resolveHandle(it({ refType: 'agent', refId: 'space' }), tree), 'space');
    assert.equal(resolveHandle(it({ refType: 'escalation', refId: 'escalation:space:dark' }), tree), 'space');
    assert.equal(resolveHandle(it({ refType: 'series', refId: 'space:Daily' }), tree), 'space');
    assert.equal(resolveHandle(it({ refType: 'resource', refId: 'telegram:@space' }), tree), null);
    assert.equal(resolveHandle(it({ agentId: 'o1' }), tree), null);
  }
});

test('replanChannel: the telegram resource of the note, else the Telegram scope of its agent', () => {
  const it = (over: object) => ({ agentId: null, refType: null, refId: null, ...over });
  assert.equal(replanChannel(it({ refType: 'resource_day', refId: 'telegram:@space|2026-10-28#ab' }), TREE), '@space');
  assert.equal(replanChannel(it({ refType: 'resource_day', refId: 'instagram:u1|2026-10-28#ab', agentId: 'o2' }), TREE), '@recipes');
  assert.equal(replanChannel(it({ refType: 'resource_day', refId: 'instagram:u1|2026-10-28#ab', agentId: 'o3' }), TREE), null);
  assert.equal(replanChannel(it({ refType: 'resource_day', refId: 'instagram:u1|2026-10-28#ab' }), TREE), null);
  assert.equal(replanChannel(it({}), undefined), null);
});
