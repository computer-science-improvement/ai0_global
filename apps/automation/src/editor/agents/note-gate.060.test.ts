// Spec 060 FR-003 on fakes: the repeat rule (pure), the merge of series_missed + dark_day, the gates the producers pass,
// and closing the cards of superseded notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysUk, decideNote, noteRepeatDays, partsKey, stillWording, type PastNote } from './note-gate';
import { evaluateSilentDays, mergeDayNotes, missSubject, criticSubject, SilentDaysWatch, type WatchSlot } from '../silent/silent-days';
import { runConnectionKeeper, type KeeperDeps } from '../../config/connection-keeper';
import { ResourceHealthService } from '../platform/resource-health.service';
import { OwnerBotService } from '../owner-bot/owner-bot.service';
import type { BotApi } from '../owner-bot/bot-api';
import type { OwnerCard } from '../owner-bot/owner-cards.repository';

const DAY = 86_400_000;
const NOW = new Date('2026-10-22T15:00:00Z');
const past = (daysAgo: number, parts: string[] | null): PastNote => ({ parts, createdAt: new Date(NOW.getTime() - daysAgo * DAY) });

/** The decision without the run (spec 069 adds `runLength` / `runSince`; note-gate.069.test.ts checks them). */
const decide = (...a: Parameters<typeof decideNote>) => {
  const { runLength: _l, runSince: _s, ...d } = decideNote(...a);
  return d;
};

test('repeat rule: first, new part, same quiet, repeat after N days with the run length', () => {
  assert.deepEqual(decide([], ['streak:3'], NOW, 3), { fire: true, why: 'first' });
  assert.deepEqual(decide([past(0.1, ['streak:3'])], ['streak:3'], NOW, 3), { fire: false });
  assert.deepEqual(decide([past(2.9, ['streak:3'])], ['streak:3'], NOW, 3), { fire: false });
  // Spec 069: a number is news only when it grew by a whole step (the critic streak N, 3); a smaller one never is.
  assert.deepEqual(decide([past(0.5, ['streak:3'])], ['streak:4'], NOW, 3), { fire: false }, 'one more is not news');
  assert.deepEqual(decide([past(0.5, ['streak:3'])], ['streak:6'], NOW, 3), { fire: true, why: 'changed' }, 'a whole step bigger is');
  assert.deepEqual(decide([past(0.5, ['streak:4'])], ['streak:3'], NOW, 3), { fire: false }, 'a decrease never fires');
  assert.deepEqual(decide([past(0.5, ['a', 'b'])], ['a'], NOW, 3), { fire: false }, 'saying less than the last note is not new');
  assert.deepEqual(decide([past(0.5, ['a'])], ['a', 'c'], NOW, 3), { fire: true, why: 'changed' });
  assert.deepEqual(decide([past(0.5, null)], ['a'], NOW, 3), { fire: true, why: 'changed' }, 'a note without parts says nothing');
  // Still going: the run is every note that already said all of it.
  const run = decide([past(3, ['x']), past(6, ['x']), past(9, ['x', 'y']), past(12, ['z'])], ['x'], NOW, 3);
  assert.deepEqual(run, { fire: true, why: 'repeat', stillDays: 9 });
  assert.deepEqual(decide([past(3, ['x'])], ['x'], NOW, 3), { fire: true, why: 'repeat', stillDays: 3 });
  assert.deepEqual(decide([past(3, ['x'])], ['x'], NOW, 7), { fire: false }, 'OWNER_NOTE_REPEAT_DAYS = 7');
});

test('settings and wording', () => {
  const env = (v: string | undefined) => (k: string) => (k === 'OWNER_NOTE_REPEAT_DAYS' ? v : undefined);
  assert.deepEqual([undefined, '', '0', 'x', '5', '2.9'].map((v) => noteRepeatDays(env(v))), [3, 3, 3, 3, 5, 2]);
  assert.deepEqual([1, 2, 5, 11, 21].map(daysUk), ['день', 'дні', 'днів', 'днів', 'день']);
  assert.equal(partsKey(['b', 'a', 'a']), partsKey(['a', 'b']));
  assert.notEqual(partsKey(['a']), partsKey(['b']));
  assert.deepEqual(stillWording('Critic rejected 3', 'Критик відхилив 3', 4), { title: 'Critic rejected 3 — still going, 4 days', alertTitle: 'Критик відхилив 3 — досі, 4 дні' });
  assert.equal(stillWording('T', null, 1).title, 'T — still going, 1 day');
  assert.equal(stillWording('T', null, 1).alertTitle, null);
});

const TZ = 'Europe/Kyiv';
const REF = 'telegram:@prompts';
const slot = (o: Partial<WatchSlot> & { id: string; scheduledAt: Date }): WatchSlot => ({
  ref: REF, updatedAt: o.scheduledAt, status: 'skipped', error: 'no_fresh_item: x', format: 'text', topic: 'T', seriesName: 'Prompt', scheduleRuleId: null, criticVerdict: null, fallback: null, ...o,
});
const rejected = (id: string, at: string) => slot({ id, scheduledAt: new Date(at), seriesName: null, status: 'skipped', error: 'critic_rejected: reject', criticVerdict: 'reject' });

test('silent days: series_missed and dark_day of one resource and day are one note; the streak keeps its own subject', () => {
  const now = new Date('2026-10-22T16:00:00Z');                                    // 19:00 Kyiv: past the dark-day hour
  const alerts = evaluateSilentDays({ now, resources: [{ ref: REF, tz: TZ, minPerDay: 1 }], slots: [slot({ id: 'a', scheduledAt: new Date('2026-10-22T06:00:00Z') })] });
  assert.deepEqual(alerts.map((a) => a.kind), ['dark_day'], 'merged');
  const a = alerts[0];
  assert.equal(a.subject, missSubject(REF));
  assert.deepEqual(a.parts, ['dark', 'dark:nothing_fresh', 'missed:Prompt:nothing_fresh']);
  assert.match(a.body, /Planned today: 1; out: 0/);
  assert.match(a.body, /1 series \/ fixed slot\(s\) did not go out/);
  assert.match(a.alert.title, /Тихий день: на telegram:@prompts до 18:00 нічого не вийшло/);
  assert.match(a.alert.body, /Не вийшло: 1/);
  assert.deepEqual(a.slotIds, ['a']);

  // Before the dark-day hour only the series note exists.
  const early = evaluateSilentDays({ now: new Date('2026-10-22T08:00:00Z'), resources: [{ ref: REF, tz: TZ, minPerDay: 1 }], slots: [slot({ id: 'a', scheduledAt: new Date('2026-10-22T06:00:00Z') })] });
  assert.deepEqual(early.map((x) => [x.kind, x.subject, x.parts]), [['series_missed', missSubject(REF), ['missed:Prompt:nothing_fresh']]]);

  // A miss of another day stays its own note (it merges only with a dark day of the same day).
  const two = evaluateSilentDays({ now, resources: [{ ref: REF, tz: TZ, minPerDay: 1 }], slots: [slot({ id: 'a', scheduledAt: new Date('2026-10-22T06:00:00Z') }), slot({ id: 'y', scheduledAt: new Date('2026-10-21T06:00:00Z') })] });
  assert.deepEqual(two.map((x) => x.kind).sort(), ['dark_day', 'series_missed']);

  const streak = evaluateSilentDays({ now, resources: [{ ref: REF, tz: TZ, minPerDay: 0 }], slots: [rejected('1', '2026-10-22T05:00:00Z'), rejected('2', '2026-10-22T06:00:00Z'), rejected('3', '2026-10-22T07:00:00Z')] })
    .filter((x) => x.kind === 'critic_reject_streak');
  assert.equal(streak.length, 1);
  assert.equal(streak[0].subject, criticSubject(REF));
  assert.deepEqual(streak[0].parts, ['streak:3']);
  assert.match(streak[0].alert.title, /Критик відхилив пости поспіль на telegram:@prompts: 3/);

  // mergeDayNotes leaves notes of other resources alone.
  const other = { ...a, ref: 'telegram:@x', kind: 'series_missed' as const };
  assert.equal(mergeDayNotes([a, other]).length, 2);
});

test('silent days: the watch posts every note with its gate and the Telegram wording', async () => {
  const posted: any[] = [];
  const slots = [slot({ id: 'a', scheduledAt: new Date('2026-10-22T06:00:00Z') })];
  const pool = {
    query: async (sql: string) => {
      if (/FROM editor_slots/.test(sql)) {
        return { rows: slots.map((s) => ({ id: s.id, ref: s.ref, channel_key: '@prompts', scheduled_at: s.scheduledAt, updated_at: s.updatedAt, status: s.status, error: s.error, format: 'text', topic: 'T', series_name: s.seriesName, schedule_rule_id: null, verdict: null, fallback: null })) };
      }
      if (/resource_tz/.test(sql)) return { rows: [{ ref: REF, tz: TZ }] };
      if (/FROM agents/.test(sql)) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const watch = new SilentDaysWatch({ pool: pool as any, inbox: { postOnce: async (i: any) => { posted.push(i); return posted.length; } }, everyMs: 0 });
  await watch.check([], new Date('2026-10-22T08:00:00Z'));
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].gate, { subject: missSubject(REF), parts: ['missed:Prompt:nothing_fresh'] });
  assert.equal(posted[0].refType, 'resource_day');
  assert.ok(posted[0].alert.title.startsWith('Серія чи слот за розкладом не вийшли'));
});

test('health notes carry a subject: the keeper once per connection, the resource check once per resource', async () => {
  const notes: any[] = [];
  const d = {
    meta: { list: async () => [] }, bots: { list: async () => [{ id: 'b1', active: true, token_env: 'X', verify_error: null }], markVerified: async () => {}, markVerifyError: async () => {} },
    graph: {}, getMe: async () => { throw new Error('401'); }, telegraph: { list: async () => [] }, tiktok: { list: async () => [] }, mtproto: { list: async () => [] },
    token: () => 'tok', encrypt: (p: string) => p, inbox: { postOnce: async (i: any) => { notes.push(i); return notes.length; } }, day: () => '2026-10-22', retryMs: 0,
  } as unknown as KeeperDeps;
  await runConnectionKeeper(d, NOW);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'connection_broken');
  assert.deepEqual(notes[0].gate, { subject: `connection:${notes[0].refId.split('|')[0]}`, parts: ['broken'] });

  const posts: any[] = [];
  const once: any[] = [];
  let state: any = 'token_invalid';
  const svc = new ResourceHealthService({
    catalog: { access: async () => ({ state, detail: 'expired' }), list: async () => [] } as any,
    profiles: { get: async () => ({ health: posts.length ? { state: 'token_invalid', checkedAt: '2026-10-21T00:00:00Z', since: '2026-10-19T00:00:00Z' } : null }), setHealth: async () => {} } as any,
    inbox: { post: async (i: any) => { posts.push(i); return 1; }, postOnce: async (i: any) => { once.push(i); return 1; } } as any,
    now: () => NOW,
  } as any);
  await svc.check('threads:t1');                                                    // the change note
  await svc.check('threads:t1');                                                    // the daily reminder
  assert.deepEqual(posts[0].gate, { subject: 'resource:threads:t1', parts: ['state:token_invalid'] });
  assert.deepEqual(once[0].gate, { subject: 'resource:threads:t1', parts: ['state:token_invalid'] });
  state = 'ok';
  await svc.check('threads:t1');
  assert.deepEqual(posts[1].gate, { subject: 'resource:threads:t1', parts: ['state:ok'] }, 'the all-clear supersedes the open warnings');
});

test('owner bot: the cards of superseded notes close with "replaced by a newer one"; others stay', async () => {
  const cards: OwnerCard[] = [1, 2, 3].map((n) => ({
    id: n, kind: n === 3 ? 'approval' : 'inbox', refId: n === 3 ? '2' : String(n), status: n === 2 ? 'done' : 'open', critical: false, title: 't', body: null, buttons: [], link: null,
    chatId: '42', messageId: 100 + n, outcome: null, resolvedBy: null, attempts: 0, lastError: null, createdAt: NOW, sentAt: NOW, resolvedAt: null,
  }));
  const edits: any[] = [];
  const api = { send: async () => 1, edit: async (c: string, m: number, t: string, kb: any) => { edits.push({ m, t, kb }); }, answer: async () => {} } as unknown as BotApi;
  const repo = {
    byRefs: async (kind: string, refs: string[]) => cards.filter((c) => c.kind === kind && refs.includes(c.refId)),
    resolve: async (id: number, status: string, outcome: string) => {
      const c = cards.find((x) => x.id === id && (x.status === 'open' || x.status === 'queued'));
      if (!c) return null;
      Object.assign(c, { status, outcome });
      return { ...c };
    },
  };
  const bot = new OwnerBotService({ pool: {} as any, repo: repo as any, api, sources: [], env: (k) => ({ TELEGRAM_OWNER_ID: '42' } as Record<string, string>)[k] });
  assert.equal(await bot.supersedeCards([1, 2, 3]), 1, 'card 2 was already answered, card 3 is another kind');
  assert.equal(cards[0].status, 'closed');
  assert.equal(cards[0].outcome, 'Замінено новішою карткою');
  assert.equal(cards[1].status, 'done');
  assert.equal(cards[2].status, 'open');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].kb, null);
  assert.match(edits[0].t, /Замінено новішою карткою/);
  assert.equal(await bot.supersedeCards([]), 0);
});
