/**
 * Spec 090 FR-011 / FR-002 item 5 on fakes: «Зроблено без вас» in the daily report (with and without decisions, failed first, up to 5
 * lines), the weekly family lines and «Чекає саме на вас», the timeout_applied / timeout_dropped lines, and the sweep's closing words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AutonomyDecision, DecisionAction } from '../autonomy/autonomy-decisions.repository';
import { OwnerReports, weekWorkLines, type WeekWork } from './owner-reports';
import { ageUk, foldCounts, humanOnlyItems, humanOnlyLines, pickDecisionLines, GATE_FAMILY_UK } from './autonomy-report';
import { OwnerBotService, AUTO_APPLIED_UK, AUTO_DROPPED_UK } from './owner-bot.service';

const dec = (id: number, gate: string, action: DecisionAction, summary: string, at = '2026-10-19T10:00:00Z', channelKey: string | null = '@a'): AutonomyDecision => ({
  id, gate, refType: 'directive', refId: String(id), channelKey, action, summary, undo: null, decidedAt: new Date(at), undoneAt: null, undoneBy: null,
});

function repoOf(list: AutonomyDecision[]) {
  return {
    async list(o: { since?: Date; limit?: number } = {}) { return list.filter((d) => !o.since || d.decidedAt >= o.since); },
    async counts(since: Date, until: Date) {
      const m = new Map<string, number>();
      for (const d of list) if (d.decidedAt >= since && d.decidedAt < until) { const k = `${d.gate.split(':')[0]}|${d.action}`; m.set(k, (m.get(k) ?? 0) + 1); }
      return [...m].map(([k, n]) => { const [family, action] = k.split('|'); return { family, action: action as DecisionAction, n }; });
    },
  };
}

function reportPool(extra: (sql: string) => any[] | undefined = () => undefined) {
  return {
    async query(sql: string) {
      const x = extra(sql);
      if (x) return { rows: x };
      if (/date_trunc\('day'/.test(sql)) return { rows: [{ from_at: '2026-10-18T21:00:00.000Z' }] };
      if (/FROM agent_inbox WHERE severity = 'info'/.test(sql)) return { rows: [{ n: 0 }] };
      if (/FROM agent_directives WHERE NOT shadow/.test(sql)) return { rows: [{ filed: 0, applied: 0, declined: 0, open: 0, timeout_applied: 4, timeout_dropped: 2 }] };
      if (/llm_usage/.test(sql)) return { rows: [{ memory: 0, skills: 0, steering: 0, rules: 0, spend: 0 }] };
      if (/editor_v_post_performance/.test(sql)) return { rows: [] };
      if (/editor_slots s/.test(sql)) return { rows: [] };
      throw new Error(`unexpected: ${sql.slice(0, 60)}`);
    },
  } as any;
}

function reports(list: AutonomyDecision[] | null, pool = reportPool()) {
  return new OwnerReports({
    pool, repo: { async claimReport() { return true; }, async releaseReport() {}, async lastReports() { return { daily: null, weekly: null }; } } as any,
    budgets: async () => ({ rows: [] }), health: async () => ({ connections: [], sources: [], budget: { blocking: [] }, stuck: [], problems: 0 } as any),
    waiting: async () => [], env: () => undefined, now: () => new Date('2026-10-19T18:00:00Z'),
    ...(list ? { decisions: repoOf(list) } : {}),
  });
}

test('daily: «Зроблено без вас» sits after «Канали» with family counts and lines, failed first', async () => {
  const { text } = await reports([
    dec(1, 'directive:frequency', 'applied', 'Posting 3 times a day'),
    dec(2, 'pending_action:change_source', 'failed', 'Source change failed: 404'),
    dec(3, 'playbook', 'applied', 'Playbook v4 activated'),
    dec(4, 'directive:cross_promo', 'dropped', 'Cross-promo expired'),
  ]).daily();
  const lines = text.split('\n');
  const i = lines.indexOf('<b>Зроблено без вас</b>');
  assert.ok(i > lines.indexOf('<b>Канали</b>'), 'after Канали');
  assert.ok(i < lines.findIndex((l) => l.startsWith('<b>Чекає на вас')), 'before the waiting block');
  assert.equal(lines[i + 1], 'директиви: 2');
  assert.equal(lines[i + 2], 'картки агентів: 0 · ❌ помилок: 1');
  assert.equal(lines[i + 3], 'плейбуки: 1');
  assert.match(lines[i + 4], /^❌ <b>@a<\/b>: Source change failed: 404$/, 'the failed decision is the first line');
});

test('daily: no decisions (or no log) leaves the section out', async () => {
  assert.doesNotMatch((await reports([]).daily()).text, /Зроблено без вас/);
  assert.doesNotMatch((await reports(null).daily()).text, /Зроблено без вас/);
  assert.doesNotMatch((await reports([dec(1, 'directive:task', 'applied', 'x', '2026-10-10T10:00:00Z')]).daily()).text, /Зроблено без вас/);
});

test('daily: at most 5 decision lines, and a pointer to the rest', async () => {
  const many = Array.from({ length: 8 }, (_, i) => dec(i + 1, 'directive:task', 'applied', `Task ${i + 1}`, `2026-10-19T0${i}:00:00Z`));
  const { text } = await reports(many).daily();
  assert.equal((text.match(/^✅ /gm) ?? []).length, 5);
  assert.match(text, /… всього 8/);
});

test('picking: undone rows never show; failed first then the newest', () => {
  const list = [dec(1, 'directive:a', 'applied', 'a'), dec(2, 'directive:b', 'undone', 'b'), dec(3, 'directive:c', 'failed', 'c')];
  assert.deepEqual(pickDecisionLines(list).map((d) => d.id), [3, 1]);
});

test('foldCounts: done = applied + dropped + resumed; unknown families keep their key; every known family has a label', () => {
  const f = foldCounts([
    { family: 'series_pause', action: 'resumed', n: 2 }, { family: 'directive', action: 'applied', n: 3 }, { family: 'directive', action: 'dropped', n: 1 },
    { family: 'directive', action: 'undone', n: 1 }, { family: 'zzz', action: 'applied', n: 1 },
  ]);
  assert.deepEqual(f.map((c) => [c.family, c.done, c.failed, c.undone]), [['directive', 4, 0, 1], ['series_pause', 2, 0, 0], ['zzz', 1, 0, 0]]);
  for (const k of ['directive', 'pending_action', 'playbook', 'audit_fix', 'readiness_fix', 'series_pause', 'setup_proposal', 'launch_graduation']) assert.ok(GATE_FAMILY_UK[k], k);
});

test('weekly: one line per family, the owner-only list with ages, and the timeout lines apart', async () => {
  const old = new Date('2026-10-16T18:00:00Z').toISOString(); // 3 days before the report
  const pool = reportPool((sql) => {
    if (/kind = 'connection_broken'/.test(sql)) return [{ n: 1, oldest: old }];
    if (/kind = 'budget_blocked'/.test(sql)) return [{ n: 0, oldest: null }];
    if (/FROM editor_slots WHERE status = 'awaiting_approval'/.test(sql)) return [{ n: 2, oldest: '2026-10-19T12:00:00Z' }];
    if (/FROM channel_launches/.test(sql)) throw new Error('relation does not exist');
    return undefined;
  });
  const { text } = await reports([dec(1, 'playbook', 'applied', 'Playbook v4 activated', '2026-10-15T10:00:00Z'), dec(2, 'directive:task', 'applied', 'T', '2026-10-17T10:00:00Z')], pool).weekly();
  assert.match(text, /<b>Зроблено без вас<\/b>\nдирективи: 1\nплейбуки: 1/);
  assert.match(text, /<b>Чекає саме на вас<\/b>\n• Підключення й токени: 1 \(найстаріше — 3 дні\)\n• Пости на схвалення: 2 \(найстаріше — 6 год\)/);
  assert.doesNotMatch(text, /Бюджет зупинив роботу/, 'a zero count is not listed');
  assert.match(text, /Застосовано через вашу тишу: 4\nЗнято за браком відповіді: 2/);
});

test('weekly: nothing silent and nothing waiting leaves both sections out', async () => {
  const { text } = await reports([]).weekly();
  assert.doesNotMatch(text, /Зроблено без вас|Чекає саме на вас/);
});

test('weekWorkLines: timeout_applied and timeout_dropped are two separate lines', () => {
  const w: WeekWork = { filed: 5, applied: 3, declined: 1, open: 1, measured: { worked: 0, no_effect: 0, hurt: 0, inconclusive: 0 }, memory: 0, skills: 0, steering: 0, rules: 0, spendUsd: 1, timeoutApplied: 7, timeoutDropped: 2 };
  const m = weekWorkLines(w, 0).manager;
  assert.ok(m.includes('Застосовано через вашу тишу: 7'));
  assert.ok(m.includes('Знято за браком відповіді: 2'));
});

test('ageUk and humanOnlyLines', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  assert.equal(ageUk(new Date('2026-10-19T11:40:00Z'), now), '20 хв');
  assert.equal(ageUk(new Date('2026-10-19T07:00:00Z'), now), '5 год');
  assert.equal(ageUk(new Date('2026-10-16T12:00:00Z'), now), '3 дні');
  assert.deepEqual(humanOnlyLines([], now), []);
  assert.deepEqual(humanOnlyLines([{ label: 'X <y>', n: 0, oldest: now }], now), []);
  assert.deepEqual(humanOnlyLines([{ label: 'X <y>', n: 2, oldest: now }], now), ['<b>Чекає саме на вас</b>', '• X &lt;y&gt;: 2 (найстаріше — 0 хв)']);
});

test('humanOnlyItems skips a failed probe and keeps the rest', async () => {
  const items = await humanOnlyItems({
    async query(sql: string) {
      if (/steering_sets/.test(sql)) return { rows: [{ n: 1, oldest: '2026-10-01T00:00:00Z' }] };
      throw new Error('no such table');
    },
  });
  assert.deepEqual(items.map((i) => i.label), ['Стиль за референсом (steering)']);
});

// ── the sweep's closing words ─────────────────────────────────────────────────

function bot(latest: Record<string, AutonomyDecision | null>, pool: any = { async query() { return { rows: [] }; } }) {
  return new OwnerBotService({
    pool, repo: {} as any, api: null, sources: [], env: () => undefined,
    decisions: { async latestFor(t: string, id: string) { return latest[`${t}:${id}`] ?? null; } },
  });
}

test('sweep wording: applied/resumed → «Застосовано автоматично», dropped → «Скасовано автоматично», failed/none → the default', async () => {
  const b = bot({
    'directive:d1': dec(1, 'directive:frequency', 'applied', 's'),
    'directive:d2': dec(2, 'directive:cross_promo', 'dropped', 's'),
    'pending_action:a1': dec(3, 'pending_action:change_source', 'applied', 's'),
    'playbook:p1': dec(4, 'playbook', 'applied', 's'),
    'setup_proposal:s1': dec(5, 'setup_proposal', 'applied', 's'),
    'pending_action:a2': dec(6, 'pending_action:change_source', 'failed', 's'),
  });
  assert.equal(AUTO_APPLIED_UK, 'Застосовано автоматично');
  assert.equal(AUTO_DROPPED_UK, 'Скасовано автоматично');
  assert.equal(await b.silentOutcome({ kind: 'directive', refId: 'd1' }), AUTO_APPLIED_UK);
  assert.equal(await b.silentOutcome({ kind: 'contested', refId: 'd2:contested' }), AUTO_DROPPED_UK);
  assert.equal(await b.silentOutcome({ kind: 'action', refId: 'a1' }), AUTO_APPLIED_UK);
  assert.equal(await b.silentOutcome({ kind: 'playbook', refId: 'p1' }), AUTO_APPLIED_UK);
  assert.equal(await b.silentOutcome({ kind: 'setup', refId: 's1' }), AUTO_APPLIED_UK);
  assert.equal(await b.silentOutcome({ kind: 'action', refId: 'a2' }), null, 'a failed silent decision keeps the default wording');
  assert.equal(await b.silentOutcome({ kind: 'action', refId: 'unknown' }), null);
  assert.equal(await b.silentOutcome({ kind: 'approval', refId: 'x' }), null, 'posts for approval are never silent');
});

test('sweep wording: a series_pause Inbox note card reads the decision of its pause; a throwing log falls back', async () => {
  const pool: any = { async query(_s: string, p: any[] = []) { return { rows: p[0] === 41 ? [{ ref_type: 'series_pause', ref_id: 'pz1' }] : [{ ref_type: 'resource', ref_id: 'x' }] }; } };
  const b = bot({ 'series_pause:pz1': dec(9, 'series_pause:no_material', 'resumed', 's') }, pool);
  assert.equal(await b.silentOutcome({ kind: 'inbox', refId: '41' }), AUTO_APPLIED_UK);
  assert.equal(await b.silentOutcome({ kind: 'inbox', refId: '42' }), null);
  const bad = new OwnerBotService({ pool, repo: {} as any, api: null, sources: [], env: () => undefined, decisions: { async latestFor() { throw new Error('no table'); } } });
  assert.equal(await bad.silentOutcome({ kind: 'directive', refId: 'd1' }), null);
});
