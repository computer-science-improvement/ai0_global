/**
 * Spec 012 T2 (AI0-238): the daily summary — Kyiv time and the due rule, the channel / spend / health lines, the text,
 * the once-per-day claim with retries, /today and the "Що чекає" button. Fakes only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BudgetStatus } from '../../spend/spend.service';
import type { NetworkHealth } from '../health/network-health';
import { OwnerReports, channelText, dailyDue, healthLines, isoWeek, kyivDate, kyivHM, kyivWeekday, spendLines, weeklyDue } from './owner-reports';
import { OwnerBotService } from './owner-bot.service';

test('Kyiv time: date, HH:MM, weekday, ISO week', () => {
  const d = new Date('2026-10-19T21:30:00Z'); // 00:30 Kyiv, Tuesday 20 Oct
  assert.equal(kyivDate(d), '2026-10-20');
  assert.equal(kyivHM(d), '00:30');
  assert.equal(kyivWeekday(d), 'Tue');
  assert.equal(isoWeek('2026-10-19'), '2026-W43');
  assert.equal(isoWeek('2026-01-01'), '2026-W01');
  assert.equal(isoWeek('2027-01-01'), '2026-W53');
  assert.equal(isoWeek('2024-12-30'), '2025-W01');
});

test('due: the daily summary from its time on that Kyiv day; off and bad values never', () => {
  assert.equal(dailyDue(new Date('2026-10-19T17:59:00Z'), '21:00'), null);         // 20:59 Kyiv
  assert.equal(dailyDue(new Date('2026-10-19T18:00:00Z'), '21:00'), '2026-10-19'); // 21:00
  assert.equal(dailyDue(new Date('2026-10-19T18:00:00Z'), undefined), '2026-10-19');
  assert.equal(dailyDue(new Date('2026-10-19T20:59:00Z'), '21:00'), '2026-10-19'); // 23:59
  assert.equal(dailyDue(new Date('2026-10-19T21:00:00Z'), '21:00'), null);         // 00:00 next day
  assert.equal(dailyDue(new Date('2026-10-19T18:00:00Z'), 'off'), null);
  assert.equal(dailyDue(new Date('2026-10-19T18:00:00Z'), '9pm'), null);
  assert.equal(weeklyDue(new Date('2026-10-19T06:00:00Z'), 'Mon 09:00'), '2026-W43');
  assert.equal(weeklyDue(new Date('2026-10-19T05:59:00Z'), 'Mon 09:00'), null);
  assert.equal(weeklyDue(new Date('2026-10-20T06:00:00Z'), 'Mon 09:00'), null);
  assert.equal(weeklyDue(new Date('2026-10-19T06:00:00Z'), 'off'), null);
});

test('channel line: published always, the rest only when there is something', () => {
  assert.equal(channelText({ ref: 'telegram:@a', title: 'A <1>', published: 3, skipped: 0, skipWhy: null, failed: 0, awaiting: 0, subs: null }),
    '• <b>A &lt;1&gt;</b>: ✅ 3');
  assert.equal(channelText({ ref: 'telegram:@a', title: 'A', published: 1, skipped: 2, skipWhy: 'критик', failed: 1, awaiting: 4, subs: -3 }),
    '• <b>A</b>: ✅ 1 · ⏭ 2 (критик) · ❌ 1 · ⏳ 4 на схвалення · 👥 -3');
  assert.match(channelText({ ref: 'telegram:@a', title: 'A', published: 0, skipped: 0, skipWhy: null, failed: 0, awaiting: 0, subs: 12 }), /👥 \+12/);
});

const budget = (p: Partial<BudgetStatus>): BudgetStatus => ({
  id: 1, scopeKind: 'global', scopeKey: '', label: 'x', dailyUsd: 10, monthlyUsd: null, alertPct: 80, enforce: true, seededFrom: null, updatedAt: null,
  spentTodayUsd: 2.5, spentMonthUsd: 10, pct: 25, state: 'ok', ...p,
} as BudgetStatus);

test('spend: the agents cap and the whole account', () => {
  assert.deepEqual(spendLines([
    budget({ scopeKind: 'feature_prefix', scopeKey: 'editor.', dailyUsd: 3, spentTodayUsd: 3.1, pct: 103, state: 'blocked' as any }),
    budget({ scopeKind: 'feature_prefix', scopeKey: 'editor.chat' }),
    budget({}),
  ]), ['Агенти: $3.10 з $3.00 (103%) — зупинено', 'Весь акаунт: $2.50 з $10.00 (25%)']);
  assert.deepEqual(spendLines([budget({ dailyUsd: null, pct: null })]), ['Весь акаунт: $2.50']);
  assert.deepEqual(spendLines([]), []);
});

const health = (p: Partial<NetworkHealth> = {}): NetworkHealth => ({
  generatedAt: '', connections: [], sources: [], budget: { lines: [], blocking: [], slotsHit: 0 } as any, stuck: [], problems: 0, ...p,
});

test('health: all clear, or the connections, sources, blocking caps and stuck work', () => {
  assert.deepEqual(healthLines(health()), ['Все гаразд ✓']);
  assert.deepEqual(healthLines(null), ['Не вдалося перевірити']);
  const lines = healthLines(health({
    connections: [{ ref: 'telegram:@a', title: '@a', state: 'no_access', muted: false } as any, { ref: 'x', title: 'x', state: 'rate_limited', muted: true } as any],
    sources: [{ channelKey: '@a' } as any, { channelKey: '@a' } as any],
    stuck: [{ kind: 'slot_overdue', label: 'Overdue posts', count: 3 } as any],
  }));
  assert.deepEqual(lines, ['🔌 Підключення: @a — нема доступу', '📡 Джерела з проблемами: 2 (@a)', '⏱ Прострочені пости: 3']);
});

/** A pool that answers the report's queries. */
function reportPool(o: { slots?: any[]; waiting?: any[]; subs?: any[]; info?: number } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string, params: any[] = []) {
      calls.push(sql.trim().split(/\s+/).slice(0, 4).join(' '));
      if (/date_trunc\('day'/.test(sql)) return { rows: [{ from_at: '2026-10-18T21:00:00.000Z' }] };
      if (/s.status IN \('published'/.test(sql)) return { rows: o.slots ?? [] };
      if (/status = 'awaiting_approval' GROUP BY/.test(sql)) return { rows: o.waiting ?? [] };
      if (/unnest\(\$1::text\[\]\)/.test(sql)) return { rows: (o.subs ?? []).filter((r) => params[0].includes(r.key)) };
      if (/FROM agent_inbox WHERE severity = 'info'/.test(sql)) return { rows: [{ n: o.info ?? 0 }] };
      throw new Error(`unexpected: ${sql}`);
    },
  } as any;
}

function memReports() {
  const claimed = new Set<string>();
  return {
    claimed,
    async claimReport(kind: string, period: string) { const k = `${kind}:${period}`; if (claimed.has(k)) return false; claimed.add(k); return true; },
    async releaseReport(kind: string, period: string) { claimed.delete(`${kind}:${period}`); },
    async lastReports() { return { daily: null, weekly: null }; },
  };
}

function reports(o: { now?: string; env?: Record<string, string>; pool?: any } = {}) {
  const env: Record<string, string> = { DASHBOARD_URL: 'https://dash.example', ...o.env };
  const repo = memReports();
  const r = new OwnerReports({
    pool: o.pool ?? reportPool({
      slots: [
        { ref: 'telegram:@a', channel_key: '@a', title: 'Канал А', status: 'published', error: null, verdict: null },
        { ref: 'telegram:@a', channel_key: '@a', title: 'Канал А', status: 'skipped', error: 'critic_rejected: weak', verdict: 'reject' },
        { ref: 'telegram:@a', channel_key: '@a', title: 'Канал А', status: 'skipped', error: 'superseded by a new plan', verdict: null },
        { ref: 'instagram:1', channel_key: '@a', title: 'Канал А', status: 'failed', error: 'boom', verdict: null },
      ],
      waiting: [{ ref: 'telegram:@b', channel_key: '@b', title: null, n: 2 }],
      subs: [{ key: '@a', now_subs: 120, before_subs: 100 }, { key: '@b', now_subs: null, before_subs: 5 }],
      info: 3,
    }),
    repo, env: (k) => env[k],
    budgets: async () => ({ rows: [budget({})] }),
    health: async () => health(),
    waiting: async () => [{ label: 'Пост на схвалення', emoji: '📝', n: 2 }],
    now: () => new Date(o.now ?? '2026-10-19T18:00:00Z'),
  });
  return { r, repo, env };
}

test('daily summary: channels, spend, what waits, info notes since the last one, health, buttons', async () => {
  const { r } = reports();
  const { text, keyboard } = await r.daily();
  assert.equal(text.split('\n')[0], '📊 <b>Підсумок дня · 19.10</b>');
  assert.match(text, /• <b>Канал А<\/b>: ✅ 1 · ⏭ 1 \(критик\) · 👥 \+20/);
  assert.match(text, /• <b>Канал А · instagram<\/b>: ✅ 0 · ❌ 1/);
  assert.match(text, /• <b>@b<\/b>: ✅ 0 · ⏳ 2 на схвалення/);
  assert.match(text, /Весь акаунт: \$2\.50 з \$10\.00/);
  assert.match(text, /📝 Пост на схвалення: 2/);
  assert.match(text, /ℹ️ 3 нові інфо-сповіщення в Inbox/);
  assert.match(text, /Все гаразд ✓$/);
  assert.deepEqual(keyboard, [[{ text: 'Що чекає', data: 'oc:waiting' }], [{ text: 'Відкрити дашборд', url: 'https://dash.example/app' }]]);
});

test('a quiet day says so', async () => {
  const { r } = reports({ pool: reportPool() });
  const { text } = await r.daily();
  assert.match(text, /Сьогодні постів не було/);
  assert.match(text, /📝 Пост на схвалення: 2/);
});

test('the schedule: sent once a day; a failed send is retried up to 5 times; off sends nothing', async () => {
  const { r, repo, env } = reports();
  const sent: string[] = [];
  assert.deepEqual(await r.tick(async (t) => { sent.push(t); return true; }), ['daily:2026-10-19']);
  assert.deepEqual(await r.tick(async (t) => { sent.push(t); return true; }), []);
  assert.equal(sent.length, 1);

  const f = reports();
  let tries = 0;
  for (let i = 0; i < 7; i++) await f.r.tick(async () => { tries++; return false; });
  assert.equal(tries, 5);
  assert.equal(f.repo.claimed.size, 0, 'a failed period is released');

  const off = reports({ env: { OWNER_DAILY_REPORT_AT: 'off' } });
  assert.deepEqual(await off.r.tick(async () => true), []);
  const early = reports({ now: '2026-10-19T10:00:00Z' });
  assert.deepEqual(await early.r.tick(async () => true), []);
  void repo; void env;
});

test('/today sends the summary; the "Що чекає" button runs /waiting', async () => {
  const sent: Array<{ text: string; kb: unknown }> = [];
  const api = {
    async send(_c: string, text: string, kb?: unknown) { sent.push({ text, kb }); return 1; },
    async edit() {}, async answer() {},
  };
  const env: Record<string, string> = { TELEGRAM_OWNER_ID: '42' };
  const pool = { async query() { return { rows: [] }; } } as any;
  const bot = new OwnerBotService({
    pool, repo: { byRefs: async () => [] } as any, api, sources: [], env: (k) => env[k],
    reports: { today: async () => ({ text: 'ПІДСУМОК', keyboard: [[{ text: 'Що чекає', data: 'oc:waiting' }]] }) },
  });
  assert.equal(await bot.command({ chatId: 42, chatType: 'private', fromId: 42, text: '/today' }), true);
  assert.equal(sent[0].text, 'ПІДСУМОК');
  assert.ok(bot.help().includes('/today — підсумок дня'));
  await bot.callback({ id: 'c', fromId: 42, chatId: 42, chatType: 'private', messageId: 5, data: 'oc:waiting' });
  assert.equal(sent[1].text, 'Нічого не чекає ✓');
});
