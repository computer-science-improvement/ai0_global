/**
 * Spec 078 D5 (unit, fakes): mark-unread (`POST /api/agents/inbox/unread`, the Undo after Dismiss) and gap #3,
 * `POST /api/agents/:handle/series-pauses {action:'pause', key, label}`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OwnerInbox } from '../agents/owner-inbox';
import { ID, RULE, service, status } from './testing/inbox-service.078';

test('OwnerInbox.markUnread clears read_at and only the dashboard stamp of the notes\' cards', async () => {
  const seen: Array<{ text: string; params: unknown[] }> = [];
  const pool = { query: async (text: string, params: unknown[] = []) => { seen.push({ text, params }); return { rows: [], rowCount: /agent_inbox/.test(text) ? 2 : 1 }; } } as any;
  assert.equal(await new OwnerInbox(pool).markUnread([4, 5]), 2);
  assert.match(seen[0].text, /UPDATE agent_inbox SET read_at = NULL WHERE id = ANY\(\$1::bigint\[\]\) AND read_at IS NOT NULL/);
  assert.deepEqual(seen[0].params, [[4, 5]]);
  assert.match(seen[1].text, /UPDATE owner_cards SET resolved_by = NULL WHERE kind = 'inbox' AND ref_id = ANY\(\$1::text\[\]\) AND resolved_by LIKE 'dashboard:%'/);
  assert.deepEqual(seen[1].params, [['4', '5']]);
  // A failing card update does not fail the Undo.
  const flaky = { query: async (text: string) => { if (/owner_cards/.test(text)) throw new Error('boom'); return { rows: [], rowCount: 1 }; } } as any;
  assert.equal(await new OwnerInbox(flaky).markUnread([4]), 1);
});

test('mark-unread: ids are validated; the inbox gets them', async () => {
  const { svc, calls } = service();
  assert.deepEqual(await svc.markUnread({ ids: [3, 4] }), { marked: 2 });
  assert.deepEqual(calls, ['unread:3,4']);
  for (const bad of [undefined, {}, { ids: [] }, { ids: 'all' }, { ids: [0] }, { ids: [1.5] }, { ids: ['1'] }, { ids: [1], x: 1 }, { ids: Array.from({ length: 501 }, (_, i) => i + 1) }]) {
    await assert.rejects(svc.markUnread(bad), (e: any) => status(e) === 400, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.deepEqual(calls, ['unread:3,4']);
});

test('series-pauses {action:"pause"}: an owner pause on a series or a pin of the agent\'s channel; resource keys, junk and agents without a channel are refused', async () => {
  const { svc, calls } = service();
  await svc.seriesPauseAction('c1', { action: 'pause', key: 'series:Prompt', label: '  Prompt ' });
  await svc.seriesPauseAction('c1', { action: 'pause', key: `rule:${RULE}`, label: 'fixed slot "Morning"' });
  assert.deepEqual(calls, ['pause:@c1:series:Prompt:Prompt:null:dashboard', `pause:@c1:rule:${RULE}:fixed slot "Morning":null:dashboard`]);
  for (const bad of [
    { action: 'pause', key: 'resource:telegram:@c1', label: 'x' }, { action: 'pause', key: 'series:', label: 'x' }, { action: 'pause', key: 'rule:not-a-uuid', label: 'x' },
    { action: 'pause', key: 'series:A', label: '' }, { action: 'pause', key: 'series:A', label: 'x'.repeat(201) }, { action: 'pause', key: 'series:A' }, { action: 'pause', label: 'x' },
    { action: 'delete', id: ID }, { action: 'resume' }, {},
  ]) {
    await assert.rejects(svc.seriesPauseAction('c1', bad), (e: any) => status(e) === 400, JSON.stringify(bad));
  }
  await assert.rejects(svc.seriesPauseAction('nobody', { action: 'pause', key: 'series:A', label: 'A' }), (e: any) => status(e) === 404);
  const noChannel = service({ agent: { id: 'a2', parentId: null, scope: 'system', scopeId: null, handle: 'c1', kind: 'manager' } });
  await assert.rejects(noChannel.svc.seriesPauseAction('c1', { action: 'pause', key: 'series:A', label: 'A' }), (e: any) => status(e) === 404 && e.getResponse().error === 'no_channel');
  assert.equal(calls.length, 2, 'refused bodies paused nothing');
});

test('series-pauses {action:"pause"}: a series that is paused already is a 409', async () => {
  const { svc, calls } = service();
  calls.push('taken');
  await assert.rejects(svc.seriesPauseAction('c1', { action: 'pause', key: 'series:A', label: 'A' }), (e: any) => status(e) === 409 && e.getResponse().error === 'already_paused');
});
