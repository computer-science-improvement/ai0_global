/**
 * Spec 069 FR-004 against a throwaway Postgres (its own database, created and dropped here): the card `retarget` (one
 * guarded UPDATE that keeps the card and its message), and `repeatingSubjects` on real Inbox and card rows (the run rule and
 * the "resolved from Telegram" exception). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { repeatingSubjects } from '../agents/note-runs';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';
import { OwnerCardsRepository } from './owner-cards.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let db: FreshDb;
let repo: OwnerCardsRepository;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'o069');
  repo = new OwnerCardsRepository(db.pool);
});
after(async () => {
  if (!url) return;
  await db.drop();
});

const BUTTONS = [{ key: 'read', label: '✓ Прочитано' }, { key: 'open', label: 'Відкрити', url: 'https://dash.example/app/agents/inbox' }];

test('retarget: an open card moves to the new note and keeps its id, message and sent time', { skip }, async () => {
  const card = (await repo.insert({ kind: 'inbox', refId: '1001', title: 'Old', body: 'old body', buttons: BUTTONS, link: null }))!;
  await repo.markSent(card.id, '42', 555);
  const moved = await repo.retarget(card.id, '1002', { title: 'New', body: 'new body', buttons: [BUTTONS[0]], link: 'https://dash.example/x' });
  assert.ok(moved);
  assert.equal(moved!.id, card.id);
  assert.equal(moved!.refId, '1002');
  assert.equal(moved!.title, 'New');
  assert.equal(moved!.body, 'new body');
  assert.equal(moved!.messageId, 555);
  assert.equal(moved!.chatId, '42');
  assert.equal(moved!.status, 'open');
  assert.deepEqual(moved!.buttons, [BUTTONS[0]]);
  assert.deepEqual((await repo.byRefs('inbox', ['1001'])).length, 0, 'the old ref has no card now');
  assert.equal((await repo.byRefs('inbox', ['1002']))[0].id, card.id);
});

test('retarget: a queued, resolved or closed card is not moved, and neither is one onto a ref that has a card', { skip }, async () => {
  const queued = (await repo.insert({ kind: 'inbox', refId: '2001', title: 'Q', buttons: [], link: null }))!;
  assert.equal(await repo.retarget(queued.id, '2002', { title: 'x', body: null, buttons: [], link: null }), null, 'not sent yet: nothing to edit');

  const done = (await repo.insert({ kind: 'inbox', refId: '2003', title: 'D', buttons: [], link: null }))!;
  await repo.markSent(done.id, '42', 600);
  await repo.resolve(done.id, 'done', 'ok', 'telegram:42');
  assert.equal(await repo.retarget(done.id, '2004', { title: 'x', body: null, buttons: [], link: null }), null, 'resolved');

  const a = (await repo.insert({ kind: 'inbox', refId: '2005', title: 'A', buttons: [], link: null }))!;
  await repo.markSent(a.id, '42', 601);
  await repo.insert({ kind: 'inbox', refId: '2006', title: 'B', buttons: [], link: null });
  assert.equal(await repo.retarget(a.id, '2006', { title: 'x', body: null, buttons: [], link: null }), null, 'the new ref already has a card');
  assert.equal((await repo.get(a.id))!.refId, '2005', 'the card is untouched');

  // Another kind may use the same ref: the unique key is (kind, ref_id).
  const b = (await repo.insert({ kind: 'inbox', refId: '2007', title: 'C', buttons: [], link: null }))!;
  await repo.markSent(b.id, '42', 602);
  await repo.insert({ kind: 'approval', refId: '2008', title: 'other kind', buttons: [], link: null });
  assert.ok(await repo.retarget(b.id, '2008', { title: 'x', body: null, buttons: [], link: null }));
});

async function note(subject: string, daysAgo: number, severity = 'action'): Promise<number> {
  const { rows } = await db.pool.query(
    `INSERT INTO agent_inbox (kind, severity, title, subject, parts, created_at)
     VALUES ('series_missed', $2, $1, $1, ARRAY['x'], now() - ($3 || ' days')::interval) RETURNING id::int`,
    [subject, severity, String(daysAgo)]);
  return rows[0].id;
}

test('repeatingSubjects on real rows: a run of three notes is listed; a card resolved from Telegram removes it', { skip }, async () => {
  const s = 'silent:telegram:@pg069:miss';
  const first = await note(s, 7);
  await note(s, 4);
  await note(s, 1, 'info');
  const now = new Date();
  const got = (await repeatingSubjects(db.pool, now, 3)).filter((r) => r.subject === s);
  assert.equal(got.length, 1);
  assert.equal(got[0].count, 3);

  // The owner pressed a button on the card of the first note, from Telegram.
  const card = (await repo.insert({ kind: 'inbox', refId: String(first), title: 'x', buttons: [], link: null }))!;
  await repo.markSent(card.id, '42', 700);
  await repo.resolve(card.id, 'done', 'ok', 'telegram:42');
  assert.deepEqual((await repeatingSubjects(db.pool, now, 3)).filter((r) => r.subject === s), []);
});

test('repeatingSubjects on real rows: a card closed by a sweep or the dashboard is not a reaction', { skip }, async () => {
  const s = 'silent:telegram:@pg069b:miss';
  const first = await note(s, 7);
  await note(s, 4);
  await note(s, 1, 'info');
  const card = (await repo.insert({ kind: 'inbox', refId: String(first), title: 'x', buttons: [], link: null }))!;
  await repo.markSent(card.id, '42', 701);
  await repo.resolve(card.id, 'closed', 'Замінено новішою карткою', null);
  assert.equal((await repeatingSubjects(db.pool, new Date(), 3)).filter((r) => r.subject === s).length, 1);
});
