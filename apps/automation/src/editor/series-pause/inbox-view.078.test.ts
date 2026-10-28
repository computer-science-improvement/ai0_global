/**
 * Spec 078 D5 gap #1 (unit, fakes): what the Inbox list returns for a note's buttons — `actionViews` (English labels, targets,
 * the stored key kept, foreign keys dropped; the stored Telegram labels stay Ukrainian) and `OwnerInbox.list/get` returning
 * `subject`, `parts` and `actions`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionView, actionViews, muteAction, pauseActions, pausedActions } from './note-actions';
import { OwnerInbox } from '../agents/owner-inbox';

const ID = '3f2b8c1e-7a41-4d52-9b6e-0c1d2e3f4a5b';
const RULE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

// ── gap #1: the dashboard's view of a note's buttons ─────────────────────

test('actionViews: English labels, the key kept, a target per type; the Telegram labels are not touched', () => {
  const stored = [...pausedActions(ID), ...pauseActions([{ channelKey: '@c', key: 'series:Prompt', label: 'Prompt' }]), muteAction('telegram:@c')];
  assert.deepEqual(actionViews(stored), [
    { key: `resume:${ID}`, type: 'resume', label: 'Resume', target: { pauseId: ID } },
    { key: `keep:${ID}`, type: 'keep', label: 'Keep paused', target: { pauseId: ID } },
    { key: stored[2].key, type: 'pause', label: 'Pause series', target: { channelKey: '@c', seriesKey: 'series:Prompt', label: 'Prompt' } },
    { key: 'mute:telegram:@c', type: 'mute', label: 'Mute for 7 days', target: { ref: 'telegram:@c' } },
  ]);
  assert.deepEqual(stored.map((a) => a.label), ['Відновити', 'Залишити на паузі', 'Пауза серії', 'Заглушити на 7 днів'], 'the stored labels stay Ukrainian');
});

test('actionViews: two pause buttons are named after their series (cut like the Telegram ones); a pin keeps its label', () => {
  const two = actionViews(pauseActions([
    { channelKey: '@c', key: 'series:A', label: 'A' },
    { channelKey: '@c', key: `rule:${RULE}`, label: 'fixed slot "A very long evening slot name"' },
  ]));
  assert.deepEqual(two.map((a) => a.label), ['Pause: A', 'Pause: fixed slot "A very long…']);
  assert.ok(two[1].label.length <= 'Pause: '.length + 24);
  assert.deepEqual(two[1].target, { channelKey: '@c', seriesKey: `rule:${RULE}`, label: 'fixed slot "A very long evening slot name"' });
});

test('actionViews: nothing usable (null, junk, a resource pause, foreign keys) gives an empty list; actionView says null for a foreign key', () => {
  assert.deepEqual(actionViews(null), []);
  assert.deepEqual(actionViews('x'), []);
  assert.deepEqual(actionViews([{ key: 'rm -rf', label: 'x' }, 7, { key: 'pause:["@c","resource:telegram:@c","x"]', label: 'x' }, { label: 'no key' }]), []);
  assert.equal(actionView({ key: 'read' }), null);
});

function listPool(rows: any[], seen: Array<{ text: string; params: unknown[] }> = []) {
  return { query: async (text: string, params: unknown[] = []) => { seen.push({ text, params }); return { rows }; } } as any;
}

const row = (o: Record<string, unknown> = {}) => ({
  id: '41', agent_id: null, kind: 'series_paused', title: 'Paused', body: 'b', ref_type: 'series_pause', ref_id: ID, severity: 'action',
  read_at: null, created_at: new Date('2026-10-28T10:00:00Z'), subject: null, parts: null, actions: null, ...o,
});

test('OwnerInbox.list returns subject, parts and the actions in English; a note without them gets null / []', async () => {
  const rows = [
    row({ id: '2', subject: 'silent:telegram:@c:miss', parts: ['streak:3'], actions: pausedActions(ID) }),
    row({ id: '1', actions: [{ key: 'bad', label: 'x' }] }),
  ];
  const [a, b] = await new OwnerInbox(listPool(rows)).list();
  assert.equal(a.id, 2);
  assert.equal(a.subject, 'silent:telegram:@c:miss');
  assert.deepEqual(a.parts, ['streak:3']);
  assert.deepEqual(a.actions.map((x) => [x.type, x.label]), [['resume', 'Resume'], ['keep', 'Keep paused']]);
  assert.equal(b.subject, null);
  assert.equal(b.parts, null);
  assert.deepEqual(b.actions, [], 'an invalid stored action is dropped');
});

test('OwnerInbox.get: one note by id, or null', async () => {
  const seen: Array<{ text: string; params: unknown[] }> = [];
  const hit = await new OwnerInbox(listPool([row({ id: '9', actions: pausedActions(ID) })], seen)).get(9);
  assert.equal(hit?.id, 9);
  assert.equal(hit?.actions.length, 2);
  assert.deepEqual(seen[0].params, [9]);
  assert.equal(await new OwnerInbox(listPool([])).get(9), null);
});
