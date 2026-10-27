import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocStore } from './doc-store';
import { fetchDocument } from './doc-fetch';
import { buildPlan, ImportListInput, IMPORT_LIST_KIND, payloadOf } from './import-list';
import { buildImportListTools, IMPORT_ROUTING } from './import-list-tools';
import { NANOBANANA_README, NANOBANANA_URL } from './testing/nanobanana-fixture';
import { PlaybookSchema } from '../network/playbook';
import { ScheduleService, type ScheduleScope } from '../schedule/schedule.service';
import { PendingActionsService, type PendingAction } from '../agents/pending-actions';
import { applyOwnerRule } from '../agents/agent-chat-tools';
import type { ToolContext } from '../harness/tool';

/** Spec 069 FR-002: «бери з X, не бери Y» is one card — the import with the series, the rule and the skills riding on it. */

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const MAPPING = {
  title: 'heading', prompt_text: 'first_code_block', media_url: 'last_image', author: 'link_text_after:Source', source_url: 'last_link_after:Source',
};
const TG = 'telegram:@ai_global';
const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } }],
  series: [{ name: 'Prompt of the day', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'A prompt with its picture each evening', source: { kind: 'library', table: 'prompts' } }],
});
const ORCH = { id: 'a-orch', handle: 'ai_global', kind: 'orchestrator', parentId: null } as any;
const EXEC = { id: 'a-exec', handle: 'ai_global_executor', kind: 'executor', parentId: 'a-orch' } as any;

const scope = (): ScheduleScope => ({
  agent: ORCH, card: { channelKey: '@ai_global' } as any,
  net: { playbook: BODY, playbookVersion: 3, resources: [{ ref: TG, platform: 'telegram' }], telegramFormats: ['photo', 'text'] } as any,
});

/** The real series validation over a hand-made scope. */
function scheduleFake(catalog = { tables: ['prompts'], feeds: [] as string[] }) {
  const real = new ScheduleService({ sourceCatalog: async () => catalog } as any);
  const asked: unknown[] = [];
  return Object.assign(Object.create(real), {
    scopeOf: async () => scope(),
    prepareSeriesChange: async (...a: any[]) => { asked.push(a[3]); return (real.prepareSeriesChange as any)(...a); },
    asked,
  }) as ScheduleService & { asked: unknown[] };
}

const skillEntry = (name: string, o: { agentId?: string | null; enabled?: boolean; safety?: boolean; body?: string } = {}) =>
  ({ skill: { name, agentId: o.agentId ?? null, safety: !!o.safety, body: o.body ?? '' }, enabled: o.enabled ?? true, origin: 'own' });

function rig(o: { pending?: boolean; catalog?: { tables: string[]; feeds: string[] }; skills?: any[]; listThrows?: boolean } = {}) {
  const proposed: any[] = [];
  const pool = {
    query: async (sql: string) => (/FROM pending_actions/.test(sql) ? { rows: o.pending ? [{ id: 'pa-old' }] : [] } : { rows: [] }),
  } as any;
  const docs = new DocStore();
  const schedule = scheduleFake(o.catalog);
  const skills = {
    findShared: async () => null,
    listForAgent: async () => {
      if (o.listThrows) throw new Error('db down');
      return o.skills ?? [skillEntry('prompthero-filter', { agentId: 'a-orch' }), skillEntry('prompts-chat-source', { agentId: 'a-exec' })];
    },
  };
  const agents = { children: async () => [EXEC], get: async () => ORCH };
  const tools = Object.fromEntries(buildImportListTools({
    pool, docs, actions: { propose: async (a: any) => { proposed.push(a); return { id: `pa-${proposed.length}`, ...a }; } } as any,
    schedule, agents: agents as any, skills: skills as any, handles: async () => ['ai0', 'ai_global'],
  }).map((t) => [t.name, t])) as Record<string, any>;
  return { docs, proposed, tools, schedule };
}

const OWNER = 'Бери промпти з awesome-nanobanana-pro. Промпти з PromptHero більше не бери.';
const ctx = (extras: any = {}): ToolContext => ({
  runId: 'r', role: 'composer', channelKey: null,
  extras: { chat: { chatId: 'chat-1', channelKey: '@ai_global' }, agent: ORCH, ownerText: OWNER, ownerRecent: [OWNER], ...extras },
});

async function fixtureDoc(docs: DocStore) {
  const r: any = await fetchDocument(NANOBANANA_URL, { docs, http: { lookup, get: async () => ({ status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, data: NANOBANANA_README }) } });
  return r.doc;
}

const call = async (r: ReturnType<typeof rig>, extra: Record<string, unknown>, c = ctx()) => {
  const doc = await fixtureDoc(r.docs);
  return r.tools.import_list.execute(ImportListInput.parse({ doc_id: doc.id, dataset: 'nanobanana_prompts', mapping: MAPPING, filter: { has_code_block: true }, ...extra }), c);
};

test('import_list with series, stop_using and disable_skills: one card with three follow-ups, in the order they run', async () => {
  const r = rig();
  const out = await call(r, { series: 'Prompt of the day', stop_using: 'Не бери промпти з PromptHero', disable_skills: ['prompthero-filter'] });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(r.proposed.length, 1, 'one card');
  const card = r.proposed[0];
  assert.equal(card.kind, IMPORT_LIST_KIND);
  const then = card.payload.then;
  assert.deepEqual(then.map((t: any) => [t.key, t.kind]), [['series', 'series_change'], ['rule', 'owner_rule'], ['detach:prompthero-filter', 'detach_skill']]);

  const [series, rule, detach] = then;
  assert.equal(series.requires, 'main_rows', 'the series waits for rows');
  assert.deepEqual(series.payload.fields.source, { kind: 'library', table: 'nanobanana_prompts' });
  assert.equal(series.payload.fields.source_mode, 'required');
  assert.equal(series.payload.fields.name, 'Prompt of the day');
  assert.equal(series.payload.op, 'update');
  assert.equal(series.payload.agent_id, 'a-orch');
  assert.ok(series.payload.before, 'the staleness key of the series');
  assert.match(series.summary, /^Series change for @ai_global: .*nanobanana_prompts/);

  assert.deepEqual([rule.payload.channel, rule.payload.kind, rule.payload.text], ['@ai_global', 'avoid', 'Не бери промпти з PromptHero']);
  assert.ok(rule.payload.quotes.length >= 1, 'with the owner\'s words');
  assert.deepEqual(detach.payload, { handle: 'ai_global', skill: 'prompthero-filter' }, 'the handle of the agent that owns the skill');

  assert.deepEqual(out.follow_ups.map((f: any) => f.key), ['series', 'rule', 'detach:prompthero-filter']);
  assert.match(card.summary, /Then, in this order: bind the series to the dataset \(required\); save the rule; disable skill “prompthero-filter”\./);
  assert.ok(card.summary.length <= 2000);
});

test('the series is checked against the dataset the card still has to create', async () => {
  const r = rig({ catalog: { tables: ['prompts'], feeds: [] } });
  await call(r, { series: 'Prompt of the day' });
  assert.deepEqual(r.schedule.asked, [{ pendingTables: ['nanobanana_prompts'], pendingEntities: { nanobanana_prompts: 'entry' } }]);
  assert.equal(r.proposed.length, 1);
});

test('an unknown series is an error at propose time and nothing is proposed', async () => {
  const r = rig();
  const out = await call(r, { series: 'No such series' });
  assert.equal(out.error, 'series_not_found');
  assert.ok(out.preview, 'the preview still comes back');
  assert.equal(r.proposed.length, 0);
});

test('the pending-card dedup still holds with a bundle', async () => {
  const r = rig({ pending: true });
  const out = await call(r, { series: 'Prompt of the day' });
  assert.equal(out.error, 'already_pending');
  assert.equal(r.proposed.length, 0);
});

test('stop_using needs a channel and a real rule; nothing is proposed otherwise', async () => {
  const r = rig();
  const noChannel = await call(r, { stop_using: 'Не бери промпти з PromptHero' }, { ...ctx(), extras: { ...ctx().extras, chat: { chatId: 'c', channelKey: null } } } as ToolContext);
  assert.equal(noChannel.error, 'no_channel');
  const vague = await call(r, { stop_using: 'ці правила завжди виконуються' });
  assert.equal(vague.error, 'rule_lint_failed');
  assert.equal(r.proposed.length, 0);
});

test('disable_skills: the owner of the skill is resolved over the orchestrator and its children; protected, unknown and already-off skills are not detached', async () => {
  const r = rig({ skills: [skillEntry('a', { agentId: 'a-orch' }), skillEntry('prompts-chat-source', { agentId: 'a-exec' }), skillEntry('shared-skill', { agentId: null }),
    skillEntry('already-off', { agentId: 'a-orch', enabled: false }), skillEntry('anti-slop', { safety: true })] });
  const ok = await call(r, { disable_skills: ['prompts-chat-source', 'shared-skill', 'already-off'] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(r.proposed[0].payload.then.map((t: any) => t.payload), [
    { handle: 'ai_global_executor', skill: 'prompts-chat-source' },
    { handle: 'ai_global', skill: 'shared-skill' },
  ]);
  assert.deepEqual(ok.follow_up_notes, ['скіл "already-off" уже вимкнений']);

  assert.equal((await call(r, { disable_skills: ['nope-skill'] })).error, 'unknown_skill');
  assert.equal((await call(r, { disable_skills: ['anti-slop'] })).error, 'safety_skill');
  assert.equal(r.proposed.length, 1);
});

// ── FR-003 / A7: the skills that still tell the agent to use what the owner dropped ─────────────────────────────────────

const FILTER = '# Джерело промптів\nФільтр provider=prompthero: бери лише рядки цього провайдера, інші рядки датасету пропускай.';
const DROP = 'Не бери промпти з PromptHero';

test('stop_using finds the skill that still filters by the dropped source and adds a ticked detach after the rule', async () => {
  const r = rig({ skills: [skillEntry('prompthero-filter', { agentId: 'a-exec', body: FILTER }), skillEntry('voice-notes', { agentId: 'a-orch', body: 'Пиши коротко, без емодзі.' })] });
  const out = await call(r, { series: 'Prompt of the day', stop_using: DROP });
  assert.equal(out.ok, true, JSON.stringify(out));
  const then = r.proposed[0].payload.then;
  assert.deepEqual(then.map((t: any) => t.key), ['series', 'rule', 'detach:prompthero-filter']);
  assert.deepEqual(then[2].payload, { handle: 'ai_global_executor', skill: 'prompthero-filter' }, 'the handle of the agent that owns it');
  assert.equal(then[2].ticked, undefined, 'a hard conflict is ticked');
  assert.match(then[2].summary, /^Disable skill "prompthero-filter" for @ai_global_executor: it tells the agent to use "prompthero"/);
  assert.match(out.follow_up_notes[0], /prompthero-filter.*суперечить правилу.*відміченим/);
  assert.match(r.proposed[0].summary, /disable skill “prompthero-filter”/);
});

test('«не бери Y, тепер бери з X» copied whole into stop_using never switches off the skill for X (the dataset the card imports)', async () => {
  const usage = skillEntry('nanobanana-usage', { agentId: 'a-orch', body: 'Рядки беремо з library:nanobanana_prompts, по одному на пост.' });
  const hero = skillEntry('prompthero-filter', { agentId: 'a-exec', body: FILTER });
  const r = rig({ skills: [usage, hero] });
  const out = await call(r, { series: 'Prompt of the day', stop_using: 'Не бери промпти з PromptHero, тепер бери з nanobanana замість нього' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(r.proposed[0].payload.then.map((t: any) => t.key), ['series', 'rule', 'detach:prompthero-filter']);
});

test('a skill the owner already named in disable_skills is not added twice; a stop_using without a conflict adds nothing', async () => {
  const skills = [skillEntry('prompthero-filter', { agentId: 'a-orch', body: FILTER })];
  const named = rig({ skills });
  await call(named, { stop_using: DROP, disable_skills: ['prompthero-filter'] });
  assert.deepEqual(named.proposed[0].payload.then.map((t: any) => t.key), ['rule', 'detach:prompthero-filter']);

  const none = rig({ skills: [skillEntry('voice-notes', { agentId: 'a-orch', body: 'Пиши коротко, без емодзі.' })] });
  const out = await call(none, { stop_using: DROP });
  assert.deepEqual(none.proposed[0].payload.then.map((t: any) => t.key), ['rule']);
  assert.equal(out.follow_up_notes, undefined);
});

test('the conflicts fill only what is left of the 8 follow-ups of a card', async () => {
  const plain = ['skill-1', 'skill-2', 'skill-3', 'skill-4', 'skill-5'].map((n) => skillEntry(n, { agentId: 'a-orch' }));
  const conflicting = ['filter-1', 'filter-2', 'filter-3'].map((n) => skillEntry(n, { agentId: 'a-orch', body: FILTER }));
  const r = rig({ skills: [...plain, ...conflicting] });
  const out = await call(r, { series: 'Prompt of the day', stop_using: DROP, disable_skills: ['skill-1', 'skill-2', 'skill-3', 'skill-4', 'skill-5'] });
  assert.equal(out.ok, true, JSON.stringify(out));
  const keys = r.proposed[0].payload.then.map((t: any) => t.key);
  assert.equal(keys.length, 8);
  assert.deepEqual(keys.slice(0, 7), ['series', 'rule', 'detach:skill-1', 'detach:skill-2', 'detach:skill-3', 'detach:skill-4', 'detach:skill-5']);
  assert.equal(keys[7], 'detach:filter-1');
});

test('a failing skill lookup never stops the import card; it is told in the notes', async () => {
  const r = rig({ listThrows: true });
  const out = await call(r, { stop_using: DROP });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(r.proposed[0].payload.then.map((t: any) => t.key), ['rule']);
  assert.match(out.follow_up_notes[0], /конфлікти зі скілами не перевірено: db down/);
});

test('without the new inputs the card is the plain import card (no follow-ups)', async () => {
  const r = rig();
  const doc = await fixtureDoc(r.docs);
  const out = await r.tools.import_list.execute(ImportListInput.parse({ doc_id: doc.id, dataset: 'nanobanana_prompts', mapping: MAPPING, filter: { has_code_block: true } }), ctx());
  assert.equal(out.ok, true);
  assert.equal('then' in r.proposed[0].payload, false);
  assert.equal(out.follow_ups, undefined);
  const plan = buildPlan(doc, { dataset: 'nanobanana_prompts', mapping: MAPPING, filter: { has_code_block: true } }, null);
  assert.deepEqual(r.proposed[0].payload, payloadOf(plan, 'nanobanana_prompts'));
});

test('the description leads with the routing sentence; the tool stays chat-only for the composer, so a loadout never hides it', () => {
  const t = buildImportListTools({ pool: {} as any, docs: new DocStore() }).find((x) => x.name === 'import_list')!;
  assert.ok(t.description.startsWith(IMPORT_ROUTING));
  assert.match(t.description, /бери з X.*не бери Y/);
  assert.match(t.description, /ніколи не пиши скіл про джерело контенту/);
  assert.match(t.description, /Перетворити сторінку-список/, 'the rest of the description is kept');
  assert.equal(t.chatOnly, true);
  assert.ok(t.roles.includes('composer'));
});

// ── Apply: the card runs the import, then the follow-ups ─────────────────────────────────────────────────────────────

function applyRig(imported: { inserted: number; updated: number; skipped: number }, o: { failSeries?: boolean } = {}) {
  const rows = new Map<string, PendingAction>();
  const repo: any = {
    create: async (a: any) => { const id = `00000000-0000-4000-8000-${String(rows.size + 1).padStart(12, '0')}`; const x = { ...a, id, status: 'pending', result: null, error: null, createdAt: new Date(), decidedAt: null, agentId: a.agentId ?? null }; rows.set(id, x); return x; },
    get: async (id: string) => rows.get(id) ?? null,
    decide: async (id: string, status: any, result?: unknown, error?: string | null) => {
      const x = rows.get(id); if (!x || x.status !== 'pending') return null;
      const u = { ...x, status, result: result ?? null, error: error ?? null, decidedAt: new Date() }; rows.set(id, u); return u;
    },
  };
  const svc = new PendingActionsService(repo);
  const log: string[] = [];
  const stored: any[] = [];
  svc.register(IMPORT_LIST_KIND, async () => { log.push('import'); return { dataset: 'nanobanana_prompts', created_dataset: true, ...imported }; });
  svc.register('series_change', async (p) => { log.push('series_change'); if (o.failSeries) throw new Error('stale: series "Prompt of the day" changed since this card was proposed'); return { version: 4, diff: String((p.fields as any).source_mode) }; });
  svc.register('owner_rule', async (p) => { log.push('owner_rule'); return applyOwnerRule({ add: async (...a: any[]) => { stored.push(a); return 17; } } as any, p); });
  svc.register('detach_skill', async (p) => { log.push(`detach_skill:${String(p.skill)}`); return { ok: true }; });
  return { svc, log, stored };
}

async function bundleCard(a: ReturnType<typeof applyRig>) {
  const r = rig();
  const out = await call(r, { series: 'Prompt of the day', stop_using: 'Не бери промпти з PromptHero', disable_skills: ['prompthero-filter'] });
  assert.equal(out.ok, true, JSON.stringify(out));
  return a.svc.propose({ chatId: 'chat-1', kind: IMPORT_LIST_KIND, payload: r.proposed[0].payload, summary: r.proposed[0].summary });
}

test('Apply: the import runs, then the series change, then the rule, then the detach', async () => {
  const a = applyRig({ inserted: 4, updated: 0, skipped: 0 });
  const card = await a.svc.apply((await bundleCard(a)).id);
  assert.equal(card.status, 'applied');
  assert.deepEqual(a.log, ['import', 'series_change', 'owner_rule', 'detach_skill:prompthero-filter']);
  assert.deepEqual((card.result as any).then.map((t: any) => [t.key, t.ok]), [['series', true], ['rule', true], ['detach:prompthero-filter', true]]);
  assert.equal(a.stored[0][1], 'avoid', 'the rule is stored as an avoid rule of the channel');
  assert.equal(a.stored[0][0], '@ai_global');
});

test('Apply: an unticked item is not run', async () => {
  const a = applyRig({ inserted: 4, updated: 0, skipped: 0 });
  const card = await a.svc.apply((await bundleCard(a)).id, { skip_then: ['rule'] });
  assert.deepEqual(a.log, ['import', 'series_change', 'detach_skill:prompthero-filter']);
  assert.deepEqual((card.result as any).then.map((t: any) => [t.key, t.ok, t.error ?? null]), [['series', true, null], ['rule', false, 'skipped'], ['detach:prompthero-filter', true, null]]);
});

test('Apply: a failing item is shown while the card stays applied', async () => {
  const a = applyRig({ inserted: 4, updated: 0, skipped: 0 }, { failSeries: true });
  const card = await a.svc.apply((await bundleCard(a)).id);
  assert.equal(card.status, 'applied');
  assert.deepEqual(a.log, ['import', 'series_change', 'owner_rule', 'detach_skill:prompthero-filter']);
  const first = (card.result as any).then[0];
  assert.equal(first.ok, false);
  assert.match(first.error, /stale/);
});

test('Apply: an import that wrote nothing skips the series (import_empty), an unchanged list does not', async () => {
  const empty = applyRig({ inserted: 0, updated: 0, skipped: 0 });
  const card = await empty.svc.apply((await bundleCard(empty)).id);
  assert.deepEqual(empty.log, ['import', 'owner_rule', 'detach_skill:prompthero-filter']);
  assert.deepEqual((card.result as any).then[0], { key: 'series', ok: false, error: 'import_empty' });

  const unchanged = applyRig({ inserted: 0, updated: 0, skipped: 4 });
  await unchanged.svc.apply((await bundleCard(unchanged)).id);
  assert.deepEqual(unchanged.log, ['import', 'series_change', 'owner_rule', 'detach_skill:prompthero-filter']);
});
