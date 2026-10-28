/**
 * Spec 078 D5 gap #2 (unit, fakes): `POST /api/agents/inbox/:id/actions` (`AgentsService.inboxAction`): the 404/400 codes, the
 * stored-key rule, `execute` called with 'dashboard'; the outcome `code`s of `SeriesPauseActions`; and the Telegram path
 * untouched — `run` defaults to 'telegram', answers the same Ukrainian string, traces "from a Telegram card" and never
 * stamps the card. The A10 rule counts a dashboard-stamped card as a reaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pauseActions } from './note-actions';
import { SeriesPauseActions, type PauseActionsDeps } from './pause-actions';
import type { SeriesPause } from './series-pauses.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { inboxSource, type SourceDeps } from '../owner-bot/card-sources';
import { ID, service, status, noteItem } from './testing/inbox-service.078';

// ── SeriesPauseActions: via, codes, the stamp ────────────────────────────

const pauseRow = (o: Partial<SeriesPause> = {}): SeriesPause => ({
  id: ID, channelKey: '@c', key: 'series:Prompt', label: 'Prompt', cause: 'no_material', reason: 'x', streak: 3,
  pausedAt: new Date('2026-10-20T10:00:00Z'), resumedAt: null, resumedBy: null, ...o,
});

function actionsHarness(o: { open?: boolean; known?: boolean; profiles?: PauseActionsDeps['profiles']; planned?: number; insertNull?: boolean } = {}) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const inserted: any[] = [];
  const state = { pause: pauseRow(o.open === false ? { resumedAt: new Date('2026-10-21T10:00:00Z'), resumedBy: 'owner' } : {}) };
  const pool = { query: async (text: string, params: unknown[] = []) => { queries.push({ text, params }); return { rows: [] }; } } as any;
  const repo = {
    get: async () => (o.known === false ? null : state.pause),
    list: async () => [state.pause],
    open: async () => [],
    resume: async () => (state.pause.resumedAt ? null : Object.assign(state.pause, { resumedAt: new Date(), resumedBy: 'owner' })),
    insertOpen: async (p: any) => { inserted.push(p); return o.insertNull ? null : pauseRow({ key: p.key, label: p.label, cause: 'owner', channelKey: p.channelKey }); },
    skipPlanned: async () => o.planned ?? 0,
  } as any;
  const actions = new SeriesPauseActions({ pool, repo, profiles: o.profiles, now: () => new Date('2026-10-28T10:00:00Z') });
  const bodies = () => queries.filter((q) => /SET read_at = COALESCE\(read_at, now\(\)\), body/.test(q.text)).map((q) => String(q.params[1]));
  const stamps = () => queries.filter((q) => /INSERT INTO owner_cards[\s\S]*'dashboard:owner'[\s\S]*ON CONFLICT/.test(q.text));
  return { actions, queries, inserted, bodies, stamps };
}

test('the Telegram path is as before: run() answers the Ukrainian string, traces "from a Telegram card", never stamps a card', async () => {
  const h = actionsHarness();
  assert.equal(await h.actions.run(41, `resume:${ID}`), '✅ Відновлено: Prompt');
  assert.match(h.bodies()[0], /Owner action: resumed "Prompt" on @c from a Telegram card /);
  const k = actionsHarness();
  assert.equal(await k.actions.run(41, `keep:${ID}`), '⏸ Залишено на паузі: Prompt');
  assert.match(k.bodies()[0], /kept "Prompt" on @c paused \(Telegram card\)/);
  const p = actionsHarness({ planned: 2 });
  const pk = pauseActions([{ channelKey: '@c', key: 'series:Prompt', label: 'Prompt' }])[0].key;
  assert.equal(await p.actions.run(41, pk), '⏸ Призупинено: Prompt (слотів пропущено: 2)');
  assert.equal(p.inserted[0].reason, 'Paused by the owner from a Telegram card');
  assert.match(p.bodies()[0], /paused "Prompt" on @c from a Telegram card; 2 planned slot\(s\) skipped/);
  assert.equal(h.stamps().length + k.stamps().length + p.stamps().length, 0, 'a Telegram press does not touch owner_cards');
});

test('the Telegram path through the owner bot\'s inbox source still passes "telegram" (no via argument from the card)', async () => {
  const h = actionsHarness();
  const calls: unknown[][] = [];
  const spy = Object.create(h.actions);
  spy.run = (...a: unknown[]) => { calls.push(a); return h.actions.run(a[0] as number, a[1] as string); };
  const src = inboxSource({
    pool: { query: async () => ({ rows: [] }) } as any, approvals: {} as any, directives: {} as any, actions: {} as any, steering: {} as any, setup: {} as any,
    playbooks: {} as any, inbox: { markRead: async () => 1 } as any, setupSections: [], noteActions: spy,
  } as SourceDeps);
  assert.match(await src.act('41', `resume:${ID}`), /^✅ Відновлено: Prompt · /);
  assert.deepEqual(calls, [[41, `resume:${ID}`]]);
  assert.match(h.bodies()[0], /from a Telegram card/);
  assert.equal(h.stamps().length, 0);
});

test('execute(…, "dashboard"): the same actions, the trace and reason say the dashboard did it, every outcome has a code, the card is stamped', async () => {
  const resume = actionsHarness();
  const r = await resume.actions.execute(41, `resume:${ID}`, 'dashboard');
  assert.deepEqual(r, { outcome: '✅ Відновлено: Prompt', changed: true, code: 'resumed' });
  assert.match(resume.bodies()[0], /resumed "Prompt" on @c from the dashboard /);
  assert.equal(resume.stamps().length, 1);
  assert.deepEqual(resume.stamps()[0].params, [41]);

  assert.equal((await actionsHarness({ open: false }).actions.execute(41, `resume:${ID}`, 'dashboard')).code, 'already_resumed');
  assert.equal((await actionsHarness({ known: false, open: false }).actions.execute(41, `resume:${ID}`, 'dashboard')).code, 'not_found');

  const keep = actionsHarness();
  assert.equal((await keep.actions.execute(41, `keep:${ID}`, 'dashboard')).code, 'kept');
  assert.match(keep.bodies()[0], /kept "Prompt" on @c paused \(dashboard\)/);
  assert.equal((await actionsHarness({ open: false }).actions.execute(41, `keep:${ID}`, 'dashboard')).code, 'already_resumed');
  assert.equal((await actionsHarness({ known: false }).actions.execute(41, `keep:${ID}`, 'dashboard')).code, 'not_found');

  const pk = pauseActions([{ channelKey: '@c', key: 'series:Prompt', label: 'Prompt' }])[0].key;
  const pause = actionsHarness({ planned: 1 });
  assert.deepEqual(await pause.actions.execute(41, pk, 'dashboard'), { outcome: '⏸ Призупинено: Prompt (слотів пропущено: 1)', changed: true, code: 'paused' });
  assert.equal(pause.inserted[0].reason, 'Paused by the owner from the dashboard');
  assert.match(pause.bodies()[0], /paused "Prompt" on @c from the dashboard; 1 planned slot\(s\) skipped/);
  assert.equal((await actionsHarness({ insertNull: true }).actions.execute(41, pk, 'dashboard')).code, 'already_paused');

  const mute = actionsHarness({ profiles: { get: async () => ({ health: { state: 'token_invalid', checkedAt: '2026-10-28T09:00:00Z' } }) as any, setHealth: async () => null as any } });
  assert.equal((await mute.actions.execute(41, 'mute:telegram:@c', 'dashboard')).code, 'muted');
  assert.match(mute.bodies()[0], /muted the daily connection reminders for telegram:@c for 7 days \(dashboard\)/);
  const fine = actionsHarness({ profiles: { get: async () => ({ health: { state: 'ok', checkedAt: '2026-10-28T09:00:00Z' } }) as any, setHealth: async () => null as any } });
  assert.equal((await fine.actions.execute(41, 'mute:telegram:@c', 'dashboard')).code, 'not_broken');
  assert.equal((await actionsHarness().actions.execute(41, 'mute:telegram:@c', 'dashboard')).code, 'unavailable');

  await assert.rejects(resume.actions.execute(41, 'read', 'dashboard'), /unknown button/);
});

test('a refused or repeated dashboard press still reads the note (as a Telegram one does)', async () => {
  const h = actionsHarness({ open: false });
  await h.actions.execute(41, `resume:${ID}`, 'dashboard');
  assert.ok(h.queries.some((q) => /SET read_at = COALESCE\(read_at, now\(\)\) WHERE id = \$1/.test(q.text) && q.params[0] === 41));
});

// ── the owner bot's A10 rule counts the dashboard ────────────────────────

test('the A10 lookups count a dashboard-stamped card as a reaction, next to a Telegram one', async () => {
  const day = 86_400_000;
  const post = async (reacted: boolean) => {
    const seen: Array<{ text: string; params: unknown[] }> = [];
    const pool = {
      query: async (text: string, params: unknown[] = []) => {
        seen.push({ text, params });
        if (/FROM agent_inbox WHERE subject/.test(text)) return { rows: [{ parts: ['x'], created_at: new Date(Date.now() - 3 * day) }, { parts: ['x'], created_at: new Date(Date.now() - 6 * day) }] };
        if (/owner_cards/.test(text)) return { rows: reacted ? [{ one: 1 }] : [] };
        return { rows: [{ id: 5 }] };
      },
    } as any;
    await new OwnerInbox(pool).postOnce({
      kind: 'series_missed', severity: 'action', title: 't', refType: 'resource_day', refId: 'telegram:@x|2026-10-28',
      gate: { subject: 'silent:telegram:@x:miss', parts: ['x'] },
    });
    return {
      lookup: seen.find((q) => /owner_cards/.test(q.text))!.text,
      severity: seen.find((q) => /INSERT INTO agent_inbox/.test(q.text))!.params[6],
    };
  };
  const quiet = await post(false);
  assert.match(quiet.lookup, /\(c\.resolved_by LIKE 'telegram:%' OR c\.resolved_by LIKE 'dashboard:%'\)/);
  assert.equal(quiet.severity, 'info', 'the third note with no reaction is demoted');
  assert.equal((await post(true)).severity, 'action', 'a card of the run was resolved (Telegram) or stamped (dashboard): not demoted');
});

// ── the service: gap #2 ──────────────────────────────────────────────────

test('inboxAction: runs a stored key through execute(…, "dashboard") and answers outcome, code and the refreshed note', async () => {
  const { svc, calls } = service();
  const r = await svc.inboxAction(41, { key: `resume:${ID}` });
  assert.deepEqual(calls, [`execute:41:resume:${ID}:dashboard`]);
  assert.equal(r.outcome, '✅ Відновлено: Prompt');
  assert.equal(r.code, 'resumed');
  assert.equal(r.changed, true);
  assert.ok(r.item?.readAt, 'the note as it is after the action');
  assert.deepEqual(r.item?.actions.map((a) => a.label), ['Resume', 'Keep paused']);
});

test('inboxAction: 404 for no such note, 400 for a key the note does not carry (also a well-formed one), 400 for a bad body, 404 without the actions dependency', async () => {
  const { svc, calls } = service();
  await assert.rejects(svc.inboxAction(99, { key: `resume:${ID}` }), (e: any) => status(e) === 404 && e.getResponse().error === 'note_not_found');
  await assert.rejects(svc.inboxAction(41, { key: 'resume:11111111-1111-4111-8111-111111111111' }), (e: any) => status(e) === 400 && e.getResponse().error === 'unknown_action');
  await assert.rejects(svc.inboxAction(41, { key: 'read' }), (e: any) => status(e) === 400 && e.getResponse().error === 'unknown_action');
  await assert.rejects(svc.inboxAction(41, { key: `mute:telegram:@c` }), (e: any) => status(e) === 400);
  for (const bad of [undefined, {}, { key: '' }, { key: 5 }, { key: 'x'.repeat(601) }, { key: `resume:${ID}`, via: 'telegram' }]) {
    await assert.rejects(svc.inboxAction(41, bad), (e: any) => status(e) === 400, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.deepEqual(calls, [], 'nothing ran');
  const none = service({ pauses: false });
  await assert.rejects(none.svc.inboxAction(41, { key: `resume:${ID}` }), (e: any) => status(e) === 404 && e.getResponse().error === 'not_available');
});

test('inboxAction: a note without stored actions refuses every key', async () => {
  const { svc, calls } = service({ note: noteItem({ actions: [] }) });
  await assert.rejects(svc.inboxAction(41, { key: `resume:${ID}` }), (e: any) => status(e) === 400);
  assert.deepEqual(calls, []);
});
