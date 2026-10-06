// Spec 023 T3: the orchestrator's series tools through the one submit path — locked series, structural
// changes to the owner (pending + Inbox card), a 60-min shift at once (live / shadow), approve mode,
// the 5-change budget, the agent's own draft as the base, a migration draft, submit_playbook's guard and
// the manager's pause_series directive on a locked series.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeriesTools, MAX_SERIES_CHANGES_PER_RUN } from './series-tools';
import { buildNetworkTools } from './network-tools';
import { Playbook, PlaybookSchema } from './playbook';
import type { NetworkCtx } from './network-context';
import type { PlaybookRow } from './network.repository';
import { lockOwnerSeries } from './series-edit';
import { buildDirectiveTools } from '../manager/directive-tools';
import type { ToolContext } from '../harness/tool';

const RES = [{ ref: 'telegram:@food', platform: 'telegram' as const }, { ref: 'instagram:ig1', platform: 'instagram' as const }];
const BODY = PlaybookSchema.parse({
  platforms: [
    { resource_ref: 'telegram:@food', role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } },
    { resource_ref: 'instagram:ig1', role: 'discovery', formats: { ig_photo: 1 }, per_day: { min: 0, max: 2 } },
  ],
  series: [
    { name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: 'telegram:@food', format: 'photo', brief: 'Рецепт з бібліотеки щовечора', source: { kind: 'library', table: 'recipes' } },
    { name: 'Неділя', cadence: 'weekly:sun@11:00', resource_ref: 'telegram:@food', format: 'text', brief: 'Недільне меню на тиждень' },
  ],
});

function world(o: { mode?: 'shadow' | 'approve' | 'live'; body?: Playbook; pending?: Partial<PlaybookRow> | null } = {}) {
  const rows: PlaybookRow[] = [];
  let v = 1;
  const row = (status: PlaybookRow['status'], body: Playbook, createdBy: any = 'orchestrator'): PlaybookRow => ({
    id: `pb${v}`, agentId: 'o1', version: v++, status, brief: null, body, review: null, rationale: null, createdBy, createdAt: new Date(), decidedAt: null,
  });
  rows.push(row('active', o.body ?? BODY));
  if (o.pending) rows.push({ ...row('pending_owner', (o.pending.body as Playbook) ?? BODY, o.pending.createdBy ?? 'orchestrator') });
  const inbox: any[] = [];
  const repo = {
    pendingPlaybook: async () => rows.find((r) => r.status === 'pending_owner') ?? null,
    activePlaybook: async () => rows.find((r) => r.status === 'active') ?? null,
    insertPlaybook: async (p: any) => {
      for (const r of rows) if ((p.status === 'active' && r.status === 'active') || (p.status === 'pending_owner' && r.status === 'pending_owner')) r.status = 'superseded';
      const r = row(p.status, p.body);
      rows.push(r);
      return r;
    },
  };
  const net: NetworkCtx = {
    orchestrator: { id: 'o1', handle: 'chef', mode: o.mode ?? 'live' } as any, anchorKey: '@food', groupId: 'g1', groupName: 'Їжа', mode: 'orchestrated',
    resources: RES, playbook: (o.body ?? BODY), playbookVersion: 1, telegramFormats: ['text', 'photo', 'carousel'],
  };
  const card = { mode: o.mode ?? 'live', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, sources: [{ id: 's1', kind: 'rss', ref: 'https://feed/rss' }] };
  const deps = { repo: repo as any, inbox: { post: async (i: any) => { inbox.push(i); return inbox.length; } }, sourceCatalog: async () => ({ tables: ['recipes', 'facts'], feeds: ['s1', 'https://feed/rss'] }) };
  const tools = Object.fromEntries(buildSeriesTools(deps).map((t) => [t.name, t]));
  const netTools = Object.fromEntries(buildNetworkTools({ ...deps, plans: {} as any, memory: {} as any }).map((t) => [t.name, t]));
  const ctx = (runId = 'run-1'): ToolContext => ({ runId, role: 'orchestrator', channelKey: '@food', extras: { network: net, card } });
  return { rows, inbox, net, tools, netTools, ctx };
}

test('list_series shows origin, lock, source and the rules', async () => {
  const w = world({ body: lockOwnerSeries(BODY, { ...BODY, series: [BODY.series[0], { ...BODY.series[1], brief: 'Недільне меню від власника' }] }) });
  const r: any = await w.tools.list_series.execute({}, w.ctx());
  assert.deepEqual(r.series.map((s: any) => [s.name, s.origin, s.locked, s.source]), [['Рецепт дня', 'agent', false, 'library:recipes'], ['Неділя', 'agent', true, null]]);
  assert.equal(r.mode, 'live');
  assert.match(r.rules, /90 хв/);
});

test('a 60-min shift applies at once in live and shadow; in approve it waits for the owner with a card', async () => {
  for (const mode of ['live', 'shadow'] as const) {
    const w = world({ mode });
    const r: any = await w.tools.update_series.execute({ name: 'Рецепт дня', patch: { cadence: 'daily@20:00' }, rationale: 'Вечірні пости після 20:00 мають +30 % переглядів' }, w.ctx());
    assert.equal(r.status, 'active', mode);
    assert.equal(w.rows.at(-1)!.body.series[0].cadence, 'daily@20:00');
    assert.equal(w.net.playbook!.series[0].cadence, 'daily@20:00', 'the run sees the new version');
    assert.equal(w.inbox[0].kind, 'playbook_updated');
  }
  const w = world({ mode: 'approve' });
  const r: any = await w.tools.update_series.execute({ name: 'Рецепт дня', patch: { cadence: 'daily@20:00' }, rationale: 'Вечірні пости після 20:00 мають +30 % переглядів' }, w.ctx());
  assert.equal(r.status, 'pending_owner');
  assert.equal(w.inbox[0].kind, 'playbook_pending');
  assert.equal(w.inbox[0].severity, 'action');
  assert.match(w.inbox[0].body, /shift 60 min/);
});

test('structural changes (new series, other days, retire, source kind) go to the owner with a card', async () => {
  const w = world();
  const def: any = await w.tools.define_series.execute({
    name: 'Факт тижня', cadence: 'weekly:mon,thu@12:00', resource_ref: 'telegram:@food', format: 'text', brief: 'Цікавий факт про продукти',
    source: { kind: 'library', table: 'facts' }, rationale: 'Факти дають найбільше пересилань у мережі',
  }, w.ctx());
  assert.equal(def.status, 'pending_owner', JSON.stringify(def));
  assert.match(def.changes.join(), /new series "Факт тижня"/);
  assert.equal(w.inbox.at(-1).kind, 'playbook_pending');
  // The next change builds on the agent's own pending draft, so the new series is kept.
  const upd: any = await w.tools.update_series.execute({ name: 'Факт тижня', patch: { brief: 'Цікавий факт про продукти з джерелом' }, rationale: 'Уточнюю бриф: факт завжди з джерелом' }, w.ctx());
  assert.equal(upd.based_on, 'твоя чернетка, що чекає власника');
  assert.equal(w.rows.filter((r) => r.status === 'pending_owner').length, 1);
  assert.ok(w.rows.find((r) => r.status === 'pending_owner')!.body.series.some((s) => s.name === 'Факт тижня'));

  const w2 = world();
  assert.equal(((await w2.tools.retire_series.execute({ name: 'Неділя', reason: 'Недільне меню не читають — 2 перегляди' }, w2.ctx())) as any).status, 'pending_owner');
  const w3 = world();
  const days: any = await w3.tools.update_series.execute({ name: 'Рецепт дня', patch: { cadence: 'weekly:mon,tue,wed,thu,fri@19:00' }, rationale: 'Лише будні: у вихідні рецепти не читають' }, w3.ctx());
  assert.equal(days.status, 'pending_owner');
  const w4 = world();
  const src: any = await w4.tools.update_series.execute({ name: 'Рецепт дня', patch: { source: { kind: 'library', table: 'recipes', category: 'soup' } }, rationale: 'Восени супи читають найкраще' }, w4.ctx());
  assert.equal(src.status, 'active', 'a source change within its kind is minor');
});

test('validation and errors: unknown dataset, quiet hours, unknown series, existing name, no change', async () => {
  const w = world();
  const bad: any = await w.tools.update_series.execute({ name: 'Рецепт дня', patch: { source: { kind: 'library', table: 'nope' } }, rationale: 'Пробую інший датасет для рецептів' }, w.ctx());
  assert.equal(bad.error, 'playbook_invalid');
  assert.match(bad.details.join(), /датасету nope немає/);
  const quiet: any = await w.tools.update_series.execute({ name: 'Рецепт дня', patch: { cadence: 'daily@23:30' }, rationale: 'Пізні рецепти для сов — тест' }, w.ctx());
  assert.match(quiet.details.join(), /тихі години/);
  assert.equal(((await w.tools.update_series.execute({ name: 'Нема', patch: { brief: 'Такої серії не існує взагалі' }, rationale: 'Перевірка помилки для неіснуючої' }, w.ctx())) as any).error, 'series_not_found');
  assert.equal(((await w.tools.define_series.execute({ name: 'Неділя', cadence: 'daily@10:00', resource_ref: 'telegram:@food', format: 'text', brief: 'Дубль назви серії тут', rationale: 'Перевірка дубля назви серії' }, w.ctx())) as any).error, 'series_exists');
  assert.equal(((await w.tools.set_series_active.execute({ name: 'Неділя', active: true, reason: 'Вже активна серія' }, w.ctx())) as any).error, 'no_change');
});

test('an owner-locked series → series_locked from every tool and from submit_playbook', async () => {
  const locked = lockOwnerSeries(BODY, { ...BODY, series: [{ ...BODY.series[0], cadence: 'daily@20:30' }, BODY.series[1]] });
  const w = world({ body: locked });
  const calls: Array<[string, any]> = [
    ['update_series', { name: 'Рецепт дня', patch: { cadence: 'daily@20:00' }, rationale: 'Хочу повернути старий час серії' }],
    ['set_series_active', { name: 'Рецепт дня', active: false, reason: 'Директива менеджера на паузу' }],
    ['retire_series', { name: 'Рецепт дня', reason: 'Серія більше не потрібна мережі' }],
  ];
  for (const [name, args] of calls) assert.equal(((await w.tools[name].execute(args, w.ctx())) as any).error, 'series_locked', name);
  const sneaky = structuredClone(locked);
  sneaky.series[0].brief = 'Агент переписує бриф серії власника';
  const r: any = await w.netTools.submit_playbook.execute({ body: sneaky, rationale: 'Повна перебудова плейбука агентом' }, w.ctx());
  assert.equal(r.error, 'series_locked');
  assert.equal(w.rows.length, 1, 'nothing stored');
  // The unlocked series is still the agent's to change.
  assert.equal(((await w.tools.set_series_active.execute({ name: 'Неділя', active: false, reason: 'Директива менеджера: пауза на тиждень' }, w.ctx())) as any).status, 'active');
});

test('at most 5 mutating series calls per run; a migration draft blocks changes', async () => {
  const w = world();
  for (let i = 0; i < MAX_SERIES_CHANGES_PER_RUN; i++) {
    const r: any = await w.tools.update_series.execute({ name: 'Неділя', patch: { brief: `Недільне меню, версія ${i}` }, rationale: 'Ітерація брифу недільної серії' }, w.ctx());
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  assert.equal(((await w.tools.update_series.execute({ name: 'Неділя', patch: { brief: 'Шоста спроба брифу тут' }, rationale: 'Ітерація брифу недільної серії' }, w.ctx())) as any).error, 'too_many_series_changes');
  assert.equal(((await w.tools.update_series.execute({ name: 'Неділя', patch: { brief: 'Новий прогін — новий ліміт' }, rationale: 'Ітерація брифу недільної серії' }, w.ctx('run-2'))) as any).ok, true);

  const m = world({ pending: { createdBy: 'migration' as any } });
  assert.equal(((await m.tools.update_series.execute({ name: 'Неділя', patch: { brief: 'Бриф поки чекає міграція' }, rationale: 'Перевірка блоку міграції' }, m.ctx())) as any).error, 'migration_pending');
  assert.equal(((await m.netTools.submit_playbook.execute({ body: BODY, rationale: 'Повна перебудова під час міграції' }, m.ctx())) as any).error, 'migration_pending');
});

test('pause_series directive on an owner-locked series is refused as an owner rule', async () => {
  const dir = { id: 'd1', toAgentId: 'o1', kind: 'pause_series', status: 'new', shadow: false, params: { series: 'Рецепт дня' } };
  const tools = Object.fromEntries(buildDirectiveTools({
    repo: { get: async () => dir, update: async () => {} } as any, agents: {} as any, digest: {} as any, inbox: {} as any, memory: { listActive: async () => [] } as any,
    actions: {} as any, channelKeyOf: async () => '@food', seriesLocked: async (_o, name) => name === 'Рецепт дня',
  }).map((t) => [t.name, t]));
  const ctx: ToolContext = { runId: 'r', role: 'orchestrator', channelKey: '@food', extras: { orchestrator: { id: 'o1' } } };
  const r: any = await tools.accept_directive.execute({ id: '00000000-0000-4000-8000-000000000001', plan: 'Поставлю серію на паузу на тиждень', conflicting_rule_ids: [] }, ctx);
  assert.equal(r.error, 'owner_rule_conflict');
  dir.params = { series: 'Неділя' };
  const ok: any = await tools.accept_directive.execute({ id: '00000000-0000-4000-8000-000000000001', plan: 'Поставлю серію на паузу на тиждень', conflicting_rule_ids: [] }, ctx);
  assert.equal(ok.ok, true);
});
