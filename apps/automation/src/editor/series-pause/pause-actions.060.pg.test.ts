/**
 * Spec 060 T3 against a throwaway Postgres: the breaker's note is stored with its buttons, the swept card gets them, and
 * each action does its work on real rows and is logged on the Inbox row — Відновити (resumed_by 'owner', the note read,
 * a second press says "already"), Залишити на паузі (the pause stays), Пауза серії (an owner pause, planned slots
 * skipped with series_paused), Заглушити на 7 днів (the health dismiss). Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { OwnerInbox } from '../agents/owner-inbox';
import { inboxSource, type SourceDeps } from '../owner-bot/card-sources';
import { SeriesPauseActions } from './pause-actions';
import { SeriesPausesRepository } from './series-pauses.repository';
import { SeriesBreaker } from './series-breaker';
import { pauseActions } from './note-actions';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '093_series_pauses.sql'), 'utf8');
const CH = '@pgz060act';
const HOUR = 3600_000;
let pool: Pool;
let repo: SeriesPausesRepository;
let inbox: OwnerInbox;
let actions: SeriesPauseActions;
const health = new Map<string, any>();

const cleanup = async () => {
  await pool.query(`DELETE FROM agent_inbox WHERE title LIKE '%pgz060act%' OR ref_id LIKE '%pgz060act%'`);
  await pool.query(`DELETE FROM series_pauses WHERE channel_key LIKE '@pgz060act%'`);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key LIKE '@pgz060act%'`);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key LIKE '@pgz060act%'`);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key LIKE '@pgz060act%'`);
};

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query(MIGRATION);
  await cleanup();
  repo = new SeriesPausesRepository(pool);
  inbox = new OwnerInbox(pool as any, async () => {});
  actions = new SeriesPauseActions({
    pool, repo, now: () => new Date('2026-10-22T10:00:00Z'),
    profiles: { get: async (r: string) => (health.has(r) ? { health: health.get(r) } as any : null), setHealth: async (r: string, h: any) => { health.set(r, h); return null as any; } },
  });
  await pool.query(`INSERT INTO tracked_channels (channel_key, username, title, is_mine) VALUES ($1, 'pgz060act', 'pgz060act', true)`, [CH]);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, plan_hour, formats) VALUES ($1, 'live', 0, '{"text":1}')`, [CH]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const note = async (id: number) => (await pool.query(`SELECT title, body, read_at, actions FROM agent_inbox WHERE id = $1`, [id])).rows[0];
const inboxCards = () => inboxSource({
  pool, approvals: {} as any, directives: {} as any, actions: {} as any, steering: {} as any, setup: {} as any, playbooks: {} as any,
  inbox, setupSections: [], noteActions: actions,
} as SourceDeps);

/** A pause the way the breaker makes it: three no-material skips of the series, the note with its buttons. */
let planDay = 0;
async function breakerPause(series: string): Promise<{ pauseId: string; noteId: number }> {
  const day = `2026-11-${String(1 + planDay++).padStart(2, '0')}`;
  const planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale, status) VALUES ($1, $2, 'pgz060act', 'superseded') RETURNING id`, [CH, day])).rows[0].id;
  const base = new Date('2026-10-21T06:00:00Z').getTime();
  for (let i = 0; i < 3; i++) {
    await pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, status, error, series_name, updated_at) VALUES ($1, $2, $3, 'content', 'text', 'pgz060act', 'skipped', 'no_fresh_item: x', $4, $3)`,
      [planId, CH, new Date(base + i * HOUR), series]);
  }
  const b = new SeriesBreaker({
    repo: Object.assign(Object.create(repo), {
      closedSlots: async (now: Date) => (await repo.closedSlots(now)).filter((s) => s.channelKey === CH && s.seriesName === series),
      open: async () => (await repo.open()).filter((p) => p.channelKey === CH),
    }),
    inbox, threshold: () => 3,
  });
  assert.equal(await b.check(new Date('2026-10-21T12:00:00Z'), true), 1);
  const p = (await repo.open(CH)).find((x) => x.key === `series:${series}`)!;
  const n = (await pool.query(`SELECT id::int FROM agent_inbox WHERE kind = 'series_paused' AND ref_id = $1`, [p.id])).rows[0];
  return { pauseId: p.id, noteId: n.id };
}

test('the breaker\'s note is stored with Відновити and Залишити на паузі, and the swept card shows them before Прочитано and Відкрити', { skip }, async () => {
  const { pauseId, noteId } = await breakerPause('PgtA');
  const n = await note(noteId);
  assert.deepEqual(n.actions.map((a: any) => a.label), ['Відновити', 'Залишити на паузі']);
  const card = (await inboxCards().waiting(new Date())).find((w) => w.refId === String(noteId))!;
  assert.deepEqual(card.buttons.map((b) => b.label), ['Відновити', 'Залишити на паузі', '✓ Прочитано', 'Відкрити']);
  assert.equal(card.buttons[0].key, `resume:${pauseId}`);
});

test('Відновити: the pause is resumed by the owner, the note is read and says so; a second press says it is already resumed', { skip }, async () => {
  const { pauseId, noteId } = await breakerPause('PgtB');
  const out = await inboxCards().act(String(noteId), `resume:${pauseId}`);
  assert.match(out, /^✅ Відновлено: PgtB · /);
  const p = await repo.get(pauseId);
  assert.ok(p?.resumedAt);
  assert.equal(p?.resumedBy, 'owner');
  const n = await note(noteId);
  assert.ok(n.read_at);
  assert.match(n.body, /Owner action: resumed "PgtB" on @pgz060act from a Telegram card/);
  assert.match(await inboxCards().act(String(noteId), `resume:${pauseId}`), /^Вже відновлено · /);
  assert.equal((await note(noteId)).body.match(/Owner action/g).length, 1, 'logged once');
});

test('Залишити на паузі: the pause stays open, the note is read and says so', { skip }, async () => {
  const { pauseId, noteId } = await breakerPause('PgtC');
  assert.match(await inboxCards().act(String(noteId), `keep:${pauseId}`), /^⏸ Залишено на паузі: PgtC · /);
  assert.equal((await repo.get(pauseId))?.resumedAt, null);
  const n = await note(noteId);
  assert.ok(n.read_at);
  assert.match(n.body, /Owner action: kept "PgtC" on @pgz060act paused/);
});

test('Відновити from the dashboard marks the pause\'s note read too (the card then closes as decided in the dashboard)', { skip }, async () => {
  const { pauseId, noteId } = await breakerPause('PgtD');
  const r = await actions.resume(pauseId, 'dashboard');
  assert.equal(r.changed, true);
  const n = await note(noteId);
  assert.ok(n.read_at);
  assert.match(n.body, /resumed "PgtD" on @pgz060act from the dashboard/);
  assert.ok(!(await inboxCards().waiting(new Date())).some((w) => w.refId === String(noteId)));
});

test('Пауза серії on a silent-day note: an owner pause is opened, planned slots of the series are skipped with series_paused, a second press says it is paused', { skip }, async () => {
  const planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale, status) VALUES ($1, '2026-10-29', 'pgz060act', 'superseded') RETURNING id`, [CH])).rows[0].id;
  const planned = (await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, status, series_name) VALUES ($1, $2, '2026-10-29T12:00:00Z', 'content', 'text', 'pgz060act', 'planned', 'PgtE') RETURNING id`, [planId, CH])).rows[0].id;
  const acts = pauseActions([{ channelKey: CH, key: 'series:PgtE', label: 'PgtE' }]);
  const noteId = await inbox.post({ kind: 'series_missed', severity: 'action', title: 'pgz060act missed', actions: acts });
  assert.deepEqual((await note(noteId)).actions, acts);
  const out = await inboxCards().act(String(noteId), acts[0].key);
  assert.match(out, /^⏸ Призупинено: PgtE \(слотів пропущено: 1\) · /);
  const p = (await repo.open(CH)).find((x) => x.key === 'series:PgtE');
  assert.equal(p?.cause, 'owner');
  assert.equal(p?.streak, 0);
  const s = (await pool.query(`SELECT status, error FROM editor_slots WHERE id = $1`, [planned])).rows[0];
  assert.equal(s.status, 'skipped');
  assert.match(s.error, /^series_paused:/);
  const n = await note(noteId);
  assert.ok(n.read_at);
  assert.match(n.body, /Owner action: paused "PgtE" on @pgz060act from a Telegram card; 1 planned slot\(s\) skipped/);
  const again = await inbox.post({ kind: 'series_missed', severity: 'action', title: 'pgz060act missed again', actions: acts });
  assert.match(await inboxCards().act(String(again), acts[0].key), /^Вже на паузі · /);
  assert.ok((await note(again)).read_at, 'a repeated press still answers the note');
  // The owner can resume it from the page like any other pause.
  assert.equal((await actions.resume(p!.id, 'dashboard')).changed, true);
});

test('Заглушити на 7 днів: the health dismiss on the resource; a resource that is fine says so', { skip }, async () => {
  const ref = 'telegram:@pgz060act_h';
  health.set(ref, { state: 'token_invalid', detail: 'expired', checkedAt: '2026-10-22T09:00:00Z', since: '2026-10-20T09:00:00Z' });
  const noteId = await inbox.post({ kind: 'resource_health', severity: 'critical', title: 'pgz060act broken', refType: 'resource', refId: ref, actions: [{ key: `mute:${ref}`, label: 'Заглушити на 7 днів' }] });
  assert.match(await inboxCards().act(String(noteId), `mute:${ref}`), /^🔕 Заглушено на 7 днів: telegram:@pgz060act_h · /);
  assert.equal(health.get(ref).dismissedAt, '2026-10-22T10:00:00.000Z');
  assert.match((await note(noteId)).body, /muted the daily connection reminders for telegram:@pgz060act_h for 7 days/);
  health.set(ref, { state: 'ok', checkedAt: '2026-10-22T09:00:00Z' });
  const second = await inbox.post({ kind: 'resource_health', severity: 'critical', title: 'pgz060act broken 2', refType: 'resource', refId: ref });
  assert.match(await inboxCards().act(String(second), `mute:${ref}`), /^Ресурс уже в порядку · /);
  assert.ok((await note(second)).read_at);
});
