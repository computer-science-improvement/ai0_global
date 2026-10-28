/**
 * Spec 078 D5 against a throwaway Postgres (its own migrated database, created and dropped here): a note's buttons pressed
 * in the dashboard (`AgentsService.inboxAction`) on real rows, next to the Telegram path of the owner bot.
 * - the list returns subject, parts and the English actions; the action leaves "from the dashboard" in the trace;
 * - the card of the note is stamped `dashboard:owner`, the sweep's close keeps the stamp, a Telegram press is not stamped;
 * - the A10 demotion counts the stamp as a reaction (`repeatingSubjects`, `postOnce`).
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AgentsService } from '../agents/agents.service';
import { OwnerInbox } from '../agents/owner-inbox';
import { repeatingSubjects } from '../agents/note-runs';
import { inboxSource, type SourceDeps } from '../owner-bot/card-sources';
import { OwnerCardsRepository } from '../owner-bot/owner-cards.repository';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';
import { pauseActions, pausedActions } from './note-actions';
import { SeriesPauseActions } from './pause-actions';
import { SeriesPausesRepository } from './series-pauses.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pga078';
let db: FreshDb;
let repo: SeriesPausesRepository;
let inbox: OwnerInbox;
let actions: SeriesPauseActions;
let cards: OwnerCardsRepository;
let svc: AgentsService;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'a078');
  repo = new SeriesPausesRepository(db.pool);
  inbox = new OwnerInbox(db.pool as any, async () => {});
  actions = new SeriesPauseActions({ pool: db.pool, repo, now: () => new Date('2026-10-28T10:00:00Z') });
  cards = new OwnerCardsRepository(db.pool);
  const orch = { id: 'a1', parentId: null, scope: 'resource', scopeId: `telegram:${CH}`, handle: 'pga078', kind: 'orchestrator' } as any;
  svc = new AgentsService({
    pool: db.pool, agents: { getByHandle: async (h: string) => (h === 'pga078' ? orch : null), get: async () => null } as any,
    skills: {} as any, inbox, setChannelMode: async () => undefined, runNow: async () => ({ started: false, what: '' }), memory: async () => [],
    pauses: actions,
  });
  await db.pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ($1, 'pga078', 'pga078', true)`, [CH]);
  await db.pool.query(`INSERT INTO editor_channels (channel_key, mode, plan_hour, formats) VALUES ($1, 'live', 0, '{"text":1}')`, [CH]);
});
after(async () => {
  if (!url) return;
  await db.drop();
});

const note = async (id: number) => (await db.pool.query(`SELECT title, body, read_at, actions FROM agent_inbox WHERE id = $1`, [id])).rows[0];
const sentCard = async (noteId: number) => {
  const c = (await cards.insert({ kind: 'inbox', refId: String(noteId), title: 'pga078', buttons: [], link: null }))!;
  await cards.markSent(c.id, '42', 1000 + c.id);
  return c;
};

/** A breaker pause and its note with Resume / Keep paused, the way `SeriesBreaker` makes them. */
async function breakerPause(series: string): Promise<{ pauseId: string; noteId: number }> {
  const p = (await repo.insertOpen({ channelKey: CH, key: `series:${series}`, label: series, cause: 'no_material', reason: 'no text', streak: 3 }))!;
  const noteId = await inbox.post({ kind: 'series_paused', severity: 'action', title: `pga078 ${series} paused`, refType: 'series_pause', refId: p.id, actions: pausedActions(p.id) });
  return { pauseId: p.id, noteId };
}

test('the list returns subject, parts and the English actions of a gated note; a plain note has none', { skip }, async () => {
  const acts = pauseActions([{ channelKey: CH, key: 'series:PgL', label: 'PgL' }]);
  const gated = await inbox.post({
    kind: 'series_missed', severity: 'action', title: 'pga078 list', refType: 'resource_day', refId: 'telegram:@pga078|2026-10-28', actions: acts,
    gate: { subject: 'silent:telegram:@pga078:miss', parts: ['series:PgL'] },
  });
  const plain = await inbox.post({ kind: 'skill_self_edit', title: 'pga078 plain' });
  const items = (await svc.inbox(false)).items;
  const g = items.find((i) => i.id === gated)!;
  assert.equal(g.subject, 'silent:telegram:@pga078:miss');
  assert.deepEqual(g.parts, ['series:PgL']);
  assert.deepEqual(g.actions.map((a) => [a.type, a.label, a.key]), [['pause', 'Pause series', acts[0].key]]);
  assert.deepEqual(g.actions[0].target, { channelKey: CH, seriesKey: 'series:PgL', label: 'PgL' });
  const p = items.find((i) => i.id === plain)!;
  assert.deepEqual([p.subject, p.parts, p.actions], [null, null, []]);
  assert.equal((await note(gated)).actions[0].label, 'Пауза серії', 'the stored label is still the Telegram one');
});

test('Resume from the dashboard: the pause is resumed by the owner, the trace says the dashboard, the card is stamped and the sweep keeps the stamp', { skip }, async () => {
  const { pauseId, noteId } = await breakerPause('PgA');
  const card = await sentCard(noteId);
  const r = await svc.inboxAction(noteId, { key: `resume:${pauseId}` });
  assert.deepEqual([r.code, r.changed, r.outcome], ['resumed', true, '✅ Відновлено: PgA']);
  assert.ok(r.item?.readAt, 'the answer carries the note as it is now');
  assert.deepEqual(r.item?.actions.map((a) => a.label), ['Resume', 'Keep paused']);
  const p = await repo.get(pauseId);
  assert.ok(p?.resumedAt);
  assert.equal(p?.resumedBy, 'owner');
  assert.match((await note(noteId)).body, /Owner action: resumed "PgA" on @pga078 from the dashboard/);

  let live = (await cards.get(card.id))!;
  assert.equal(live.status, 'open', 'the card stays live until the minute sweep');
  assert.equal(live.resolvedBy, 'dashboard:owner');
  // The sweep: the note is read, so the card is closed as decided in the dashboard (resolved_by null) and keeps the stamp.
  assert.ok(await cards.resolve(card.id, 'closed', 'Вирішено в дашборді', null));
  live = (await cards.get(card.id))!;
  assert.deepEqual([live.status, live.resolvedBy], ['closed', 'dashboard:owner']);

  const again = await svc.inboxAction(noteId, { key: `resume:${pauseId}` });
  assert.equal(again.code, 'already_resumed');
  assert.equal((await note(noteId)).body.match(/Owner action/g).length, 1, 'logged once');
});

test('the stamp reaches a card the sweep closed before the press, but never one a Telegram press resolved', { skip }, async () => {
  const early = await breakerPause('PgB');
  const closed = await sentCard(early.noteId);
  await cards.resolve(closed.id, 'closed', 'Вирішено в дашборді', null);
  await svc.inboxAction(early.noteId, { key: `keep:${early.pauseId}` });
  assert.equal((await cards.get(closed.id))!.resolvedBy, 'dashboard:owner');

  const tg = await breakerPause('PgC');
  const done = await sentCard(tg.noteId);
  await cards.resolve(done.id, 'done', 'ok', 'telegram:42');
  await svc.inboxAction(tg.noteId, { key: `keep:${tg.pauseId}` });
  assert.equal((await cards.get(done.id))!.resolvedBy, 'telegram:42');
});

test('the Telegram path is unchanged: the card button runs through run(), the trace says a Telegram card, nothing is stamped, the resolve keeps telegram:<id>', { skip }, async () => {
  const { pauseId, noteId } = await breakerPause('PgT');
  const card = await sentCard(noteId);
  const src = inboxSource({
    pool: db.pool, approvals: {} as any, directives: {} as any, actions: {} as any, steering: {} as any, setup: {} as any, playbooks: {} as any,
    inbox, setupSections: [], noteActions: actions,
  } as SourceDeps);
  assert.match(await src.act(String(noteId), `resume:${pauseId}`), /^✅ Відновлено: PgT · /);
  assert.match((await note(noteId)).body, /resumed "PgT" on @pga078 from a Telegram card/);
  assert.equal((await cards.get(card.id))!.resolvedBy, null, 'a Telegram press stamps nothing; the bot resolves the card itself');
  assert.equal((await cards.resolve(card.id, 'done', '✅', 'telegram:42'))!.resolvedBy, 'telegram:42');
});

test('A10: a run of notes the owner pressed a button on in the dashboard is no longer "repeating", and the next note is not demoted', { skip }, async () => {
  const day = 86_400_000;
  const run = async (subject: string, press: boolean) => {
    const pk = pauseActions([{ channelKey: CH, key: `series:${subject.slice(-4)}`, label: subject.slice(-4) }]);
    const ids: number[] = [];
    for (const [n, ago] of [[0, 7], [1, 4], [2, 1]] as const) {
      const { rows } = await db.pool.query(
        `INSERT INTO agent_inbox (kind, severity, title, ref_type, ref_id, subject, parts, actions, created_at)
         VALUES ('series_missed', 'action', $1, 'resource_day', $2, $3, ARRAY['x'], $4::jsonb, now() - ($5 || ' days')::interval) RETURNING id::int`,
        [`pga078 ${subject} ${n}`, `${subject}|d${n}`, subject, JSON.stringify(pk), String(ago)]);
      ids.push(rows[0].id);
    }
    assert.equal((await repeatingSubjects(db.pool, new Date(), 3)).filter((x) => x.subject === subject).length, 1, 'listed before any reaction');
    if (press) {
      await sentCard(ids[0]);
      await svc.inboxAction(ids[0], { key: pk[0].key });
    }
    const listed = (await repeatingSubjects(db.pool, new Date(), 3)).filter((x) => x.subject === subject).length;
    const next = await inbox.postOnce({
      kind: 'series_missed', severity: 'action', title: `pga078 ${subject} next`, refType: 'resource_day', refId: `${subject}|next`,
      gate: { subject, parts: ['y:new'] },
    });
    const sev = (await db.pool.query(`SELECT severity FROM agent_inbox WHERE id = $1`, [next])).rows[0]?.severity;
    return { listed, sev };
  };
  void day;
  assert.deepEqual(await run('silent:telegram:@pga078:Ctrl', false), { listed: 1, sev: 'info' }, 'no reaction: the third note is demoted');
  assert.deepEqual(await run('silent:telegram:@pga078:Dash', true), { listed: 0, sev: 'action' }, 'a dashboard press is a reaction');
});
