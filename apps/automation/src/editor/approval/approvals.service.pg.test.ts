/**
 * Spec 031 T3: the owner's decisions against a real throwaway Postgres —
 * single-flight approve (409), edit → lint again, bulk without warnings,
 * late approve, reschedule rules, reject with one replacement.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { renderTelegram } from '../post/render-telegram';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { ApprovalsRepository } from './approvals.repository';
import { ApprovalsService } from './approvals.service';
import { syncAgentsFor } from './pg-test-agents';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@apv_service_pg';
// Fri 2030-04-05 12:00 Kyiv (UTC+3).
const NOW = new Date('2030-04-05T09:00:00Z');
let pool: Pool;
let planId: string;

async function cleanup() {
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await new EditorChannelsRepository(pool).upsert(makeCard({ channelKey: CH, mode: 'approve', minGapMinutes: 60 }));
  await syncAgentsFor(pool, [CH]);
  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale) VALUES ($1, '2030-04-06', 'Ранковий пік і вечір') RETURNING id`, [CH])).rows[0].id;
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const card = () => makeCard({ channelKey: CH, mode: 'approve' });

async function waiting(at: Date, o: { warnings?: string[]; topic?: string } = {}): Promise<string> {
  const spec = makeSpec({ title: o.topic ?? 'Туманність', source: { url: `https://src.example/${Math.random()}`, label: 'NASA' } });
  const r = renderTelegram(spec, card());
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, angle, status, post_spec, rendered_preview, render_messages, lint_warnings)
     VALUES ($1, $2, $3, 'photo', $4, 'кут', 'awaiting_approval', $5, $6, $7, $8) RETURNING id`,
    [planId, CH, at, o.topic ?? 'Туманність', JSON.stringify(spec), r.preview,
      JSON.stringify({ kind: 'telegram', messages: r.messages, primary: r.primary }), JSON.stringify(o.warnings ?? [])]);
  return rows[0].id;
}

function svc(now = NOW) {
  const channels = new EditorChannelsRepository(pool);
  return new ApprovalsService({ repo: new ApprovalsRepository(pool), card: (k) => channels.get(k), now: () => now });
}

test('single-flight approve: two tabs at once → one wins, the other gets 409 already_decided', { skip }, async () => {
  const id = await waiting(new Date('2030-04-06T07:00:00Z'));
  const s = svc();
  const results = await Promise.allSettled([s.approve(id), s.approve(id)]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(ok.length, 1);
  assert.equal(lost.length, 1);
  assert.ok(lost[0].reason instanceof ConflictException);
  assert.equal((lost[0].reason.getResponse() as any).error, 'already_decided');
  const card0 = (ok[0] as PromiseFulfilledResult<any>).value.card;
  assert.equal(card0.status, 'approved');
  assert.ok(card0.approvedAt);
  assert.equal(card0.rationale.plan, 'Ранковий пік і вечір');
  assert.equal(card0.localTime, '10:00');
});

test('edit and approve: the edited spec passes lint again; owner_edited, a fresh render', { skip }, async () => {
  const id = await waiting(new Date('2030-04-06T10:00:00Z'));
  const s = svc();
  const bad = makeSpec({ hashtags: ['невідомий'] });
  await assert.rejects(s.edit(id, { spec: bad }), (e: any) => e instanceof BadRequestException && (e.getResponse() as any).error === 'lint_failed');
  assert.equal((await s.list({ channel: CH })).items.find((c) => c.id === id)!.status, 'awaiting_approval', 'a failed edit changes nothing');

  const edited = makeSpec({ body: [{ type: 'lead', text: 'Коротший вступ від власника' }, { type: 'p', text: 'Туманність Кільце — рештки зорі, схожої на Сонце.' }] });
  const r = await s.edit(id, { spec: edited });
  assert.equal(r.card.status, 'approved');
  assert.equal(r.card.ownerEdited, true);
  assert.match(r.card.preview!, /Коротший вступ від власника/);
  assert.deepEqual((r.card.render as any).messages, renderTelegram(edited, card()).messages, 'the stored render follows the edit');

  // Locked 2 minutes before the slot.
  const late = svc(new Date('2030-04-06T09:59:00Z'));
  await assert.rejects(late.edit(id, { spec: edited }), ConflictException);
});

test('bulk approve a day: posts with lint warnings are never included', { skip }, async () => {
  const a = await waiting(new Date('2030-04-06T13:00:00Z'), { topic: 'Пост А' });
  const b = await waiting(new Date('2030-04-06T15:00:00Z'), { topic: 'Пост Б', warnings: ['хештег поза словником'] });
  const r = await svc().bulk({ channel: CH, date: '2030-04-06' });
  assert.ok(r.ids.includes(a));
  assert.ok(!r.ids.includes(b));
  assert.equal(r.skippedWithWarnings, 1);
  const st = async (id: string) => (await pool.query(`SELECT status FROM editor_slots WHERE id = $1`, [id])).rows[0].status;
  assert.equal(await st(a), 'approved');
  assert.equal(await st(b), 'awaiting_approval');
  await assert.rejects(svc().bulk({ date: '2030-04-06' }), BadRequestException, 'a bulk needs a resource, channel or idea');
});

test('late approve: under 2 h stays (published now); later moves to the next free time', { skip }, async () => {
  const soon = await waiting(new Date('2030-04-05T08:30:00Z'), { topic: 'Пів години тому' });
  const r1 = await svc().approve(soon);
  assert.equal(r1.movedTo, null);
  assert.equal(r1.card.scheduledAt.toISOString(), '2030-04-05T08:30:00.000Z');
  const old = await waiting(new Date('2030-04-05T05:30:00Z'), { topic: 'Три години тому' });
  const r2 = await svc().approve(old);
  assert.ok(r2.movedTo && r2.movedTo.getTime() >= NOW.getTime() + 10 * 60_000);
  assert.equal(r2.card.scheduledAt.toISOString(), r2.movedTo!.toISOString());
  assert.equal(r2.card.status, 'approved');
});

test('reschedule: future, outside quiet hours, away from the other slots of the series', { skip }, async () => {
  const id = await waiting(new Date('2030-04-07T09:00:00Z'), { topic: 'Неділя' });
  await waiting(new Date('2030-04-07T12:00:00Z'), { topic: 'Сусід' });
  const s = svc();
  const code = async (at: string) => s.reschedule(id, { at }).then(() => 'ok', (e: any) => (e.getResponse?.() as any)?.error ?? String(e));
  assert.equal(await code('2030-04-05T09:01:00Z'), 'too_soon');
  assert.equal(await code('2030-04-07T21:30:00Z'), 'quiet_hours');       // 00:30 Kyiv
  assert.equal(await code('2030-04-07T12:30:00Z'), 'too_close');
  assert.equal(await code('2030-04-07T14:00:00Z'), 'ok');
  assert.equal((await pool.query(`SELECT scheduled_at FROM editor_slots WHERE id = $1`, [id])).rows[0].scheduled_at.toISOString(), '2030-04-07T14:00:00.000Z');
});

test('reject: skipped with the reason; one replacement when there is time, never a second', { skip }, async () => {
  const id = await waiting(new Date('2030-04-06T17:00:00Z'), { topic: 'Вчорашня тема' });
  const s = svc();
  const r = await s.reject(id, { reason: 'тему постили вчора' });
  assert.equal(r.card.status, 'skipped');
  const row = (await pool.query(`SELECT reject_reason, error FROM editor_slots WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(row, { reject_reason: 'тему постили вчора', error: 'rejected by owner' });
  assert.ok(r.replacementId);
  const rep = (await pool.query(`SELECT status, scheduled_at, angle, replaces_slot_id FROM editor_slots WHERE id = $1`, [r.replacementId])).rows[0];
  assert.equal(rep.status, 'planned', 'the replacement is written and waits for approval like any slot');
  assert.equal(rep.replaces_slot_id, id);
  assert.match(rep.angle, /тему постили вчора/);
  await assert.rejects(s.reject(id, {}), ConflictException, 'a rejected post cannot be rejected twice');

  // The replacement, once written and rejected, gets no replacement of its own.
  await pool.query(`UPDATE editor_slots SET status = 'awaiting_approval' WHERE id = $1`, [r.replacementId]);
  const again = await s.reject(r.replacementId!, { reason: 'теж ні' });
  assert.equal(again.replacementId, null);

  // Too close to the slot: no replacement.
  const close = await waiting(new Date('2030-04-05T10:30:00Z'), { topic: 'За півтори години' });
  assert.equal((await s.reject(close, {})).replacementId, null);
});
