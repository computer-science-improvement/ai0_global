import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybookSchema, type Playbook } from '../network/playbook';
import { configConflicts, patchPlaybook, toneWithoutSlang } from './config-conflicts';
import { ConfigConflictsService } from './config-conflicts.service';
import { buildBuilderTools, FIX_CONFIG_CONFLICTS_KIND } from '../agents/builder-tools';
import { memoryWithoutRules, ownerRulesOf, ownerRulesSection } from './owner-rules-prompt';
import { buildSystemPrompt } from '../roles/prompts';
import { makeCard } from '../post/testing/fixtures';
import { criticOwnerRulesLines, criticUserPrompt, normalizeOwnerRules } from '../critic/critic.service';
import { criticLine, CritiqueInput, decideVerdict } from '../critic/critic';

/** Spec 040 FR-011: rules reach the writers — rules-vs-config, the fix card, owner rules in the executor and critic. */

const TG = 'telegram:@loko';
const IG = 'instagram:ig1';

function playbook(over: Partial<Record<string, any>> = {}): Playbook {
  return PlaybookSchema.parse({
    platforms: [
      { resource_ref: TG, role: 'core', formats: { text: 1, poll: 0.3 }, per_day: { min: 1, max: 3 }, tone: 'Дружньо, легкий сленг, з гумором.', hashtag_policy: { vocab: ['#ai'], min: 3, max: 5 } },
      { resource_ref: IG, role: 'discovery', formats: { image: 1 }, per_day: { min: 0, max: 1 } },
    ],
    series: [
      { name: 'Ранкове опитування', cadence: 'daily@09:00', resource_ref: TG, format: 'poll', brief: 'Опитування дня для читачів каналу' },
      { name: 'Вікторина пʼятниці', cadence: 'weekly:fri@18:00', resource_ref: TG, format: 'quiz', brief: 'Пʼятнична вікторина про ШІ' },
      { name: 'Огляд тижня', cadence: 'weekly:sun@12:00', resource_ref: TG, format: 'text', brief: 'Підсумки тижня в мережі' },
    ],
    ...over,
  });
}

const rule = (id: number, text: string) => ({ id, text });

test('rules-vs-config: hashtags off, poll cap, slang, audience — each conflict with its fix', () => {
  const out = configConflicts({
    rules: [rule(3, 'Без хештегів у постах'), rule(4, 'Без сленгу, пиши нормативною мовою'), rule(5, 'Пишемо для розробників-початківців')],
    playbook: playbook(),
    resources: [{
      ref: TG, style: null, slang: false, pollsPerWeek: 3,
      profile: { tone: 'Тепло, легкий сленг', audience: { who: 'маркетологи великих брендів' }, format_prefs: { hashtags: { count: 2 } } },
    }],
  });
  const codes = out.map((c) => c.code).sort();
  assert.deepEqual(codes, ['audience_mismatch', 'hashtags_off_playbook', 'hashtags_off_profile', 'poll_series_over_cap', 'slang_in_tone', 'slang_in_tone']);
  const hash = out.find((c) => c.code === 'hashtags_off_playbook')!;
  assert.equal(hash.rule_id, 3);
  assert.match(hash.detail, /3–5 hashtags.*owner rule #3/);
  const polls = out.find((c) => c.code === 'poll_series_over_cap')!;
  assert.match(polls.detail, /8 posts a week/);
  // The busiest series is paused first; the quiz (1/week) then fits the cap of 3.
  assert.deepEqual(polls.fix, { target: 'playbook', op: 'pause_series', names: ['Ранкове опитування'] });
  const aud = out.find((c) => c.code === 'audience_mismatch')!;
  assert.deepEqual(aud.fix, { target: 'profile', op: 'audience', ref: TG, who: 'Пишемо для розробників-початківців' });
});

test('rules-vs-config: a consistent config has no conflicts; the style sheet alone turns hashtags off', () => {
  const clean = playbook({
    platforms: [{ resource_ref: TG, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 2 }, tone: 'Спокійно, без сленгу.', hashtag_policy: { vocab: [], min: 0, max: 0 } }],
    series: [],
  });
  assert.deepEqual(configConflicts({ rules: [rule(3, 'Без хештегів')], playbook: clean, resources: [{ ref: TG, slang: false, pollsPerWeek: 2 }] }), []);
  // Slang allowed on the resource and no rule against it: a slang tone is fine.
  const slangy = configConflicts({ rules: [], playbook: playbook({ series: [] }), resources: [{ ref: TG, slang: true, style: { hashtags: 'off' } as any }] });
  assert.deepEqual(slangy.map((c) => c.code), ['hashtags_off_playbook']);
  assert.match(slangy[0].detail, /hashtags are off in the resource style/);
});

test('toneWithoutSlang keeps the rest of the tone and a negated mention', () => {
  assert.equal(toneWithoutSlang('Дружньо, легкий сленг, з гумором.'), 'Дружньо, з гумором.');
  assert.equal(toneWithoutSlang('Спокійно, без сленгу.'), 'Спокійно, без сленгу.');
  assert.equal(toneWithoutSlang('Сленг і меми'), '');
});

test('patchPlaybook applies only the playbook fixes; nothing to change → null', () => {
  const pb = playbook();
  const next = patchPlaybook(pb, [
    { target: 'playbook', op: 'hashtags_off', ref: TG },
    { target: 'playbook', op: 'pause_series', names: ['Ранкове опитування'] },
    { target: 'playbook', op: 'tone', ref: TG, tone: 'Дружньо, з гумором.' },
    { target: 'profile', op: 'hashtags_off', ref: TG },
  ])!;
  const tg = next.platforms.find((p) => p.resource_ref === TG)!;
  assert.deepEqual(tg.hashtag_policy, { vocab: [], min: 0, max: 0 });
  assert.equal(tg.tone, 'Дружньо, з гумором.');
  assert.equal(next.series.find((s) => s.name === 'Ранкове опитування')!.active, false);
  assert.equal(next.series.find((s) => s.name === 'Огляд тижня')!.active, true);
  assert.equal(pb.platforms[0].hashtag_policy.max, 5, 'the input is not mutated');
  assert.equal(patchPlaybook(next, [{ target: 'playbook', op: 'hashtags_off', ref: TG }]), null);
});

function service(pb: Playbook) {
  const state = { pb, profile: { tone: 'Тепло, легкий сленг', format_prefs: { hashtags: { count: 2 } } } as any, patches: [] as any[], profiles: [] as any[] };
  const svc = new ConfigConflictsService({
    memory: { listActive: async () => [
      { id: 3, kind: 'rule', text: 'Без хештегів', evidence: null, createdBy: 'owner', createdAt: new Date() },
      { id: 9, kind: 'insight', text: 'Без хештегів охоплення не впало', evidence: null, createdBy: 'reviewer', createdAt: new Date() },
    ] } as any,
    network: {
      groupOfChannel: async () => ({ id: 'g1' }),
      groupResources: async () => [{ ref: TG }, { ref: IG }],
      activePlaybook: async () => ({ body: state.pb }),
      applyOwnerPatch: async (_id: string, patch: (p: Playbook) => Playbook | null, rationale: string) => {
        const next = patch(state.pb);
        state.patches.push(rationale);
        if (!next) return { noop: true, row: { version: 8 } };
        state.pb = next;
        return { noop: false, row: { version: 9 } };
      },
    } as any,
    channels: { get: async () => ({ style: null, slang: false, pollsPerWeek: null }) } as any,
    profiles: {
      get: async (ref: string) => (ref === TG ? { profile: state.profile } : null),
      patchFormat: async (ref: string, patch: any) => {
        state.profiles.push([ref, patch]);
        if ('hashtags' in patch) state.profile = { ...state.profile, format_prefs: {} };
        return { ok: true };
      },
      setProfile: async (ref: string, next: any) => { state.profiles.push([ref, 'set']); state.profile = next; },
    } as any,
  });
  return { svc, state };
}

const ORCH: any = { id: 'a1', handle: 'loko', scope: 'resource', scopeId: TG, status: 'active' };

test('the service reads owner rules only (not reviewer insights) and the card applies every fix', async () => {
  const { svc, state } = service(playbook({ series: [] }));
  const found = await svc.forAgent(ORCH);
  assert.deepEqual(found.map((c) => `${c.code} ${c.ref}`).sort(), [
    `hashtags_off_playbook ${IG}`, `hashtags_off_playbook ${TG}`, `hashtags_off_profile ${TG}`, `slang_in_tone ${TG}`, `slang_in_tone ${TG}`,
  ], 'an owner rule of the channel covers every resource of its network');

  const r = await svc.apply(ORCH);
  assert.equal(r.playbook_version, 9);
  assert.deepEqual(r.remaining, []);
  assert.equal(r.applied.length, 5);
  assert.deepEqual(state.pb.platforms.map((p) => p.hashtag_policy.max), [0, 0]);
  assert.equal(state.profile.tone, 'Тепло');
  assert.deepEqual(await svc.forAgent({ ...ORCH, scope: 'network', scopeId: null }), [], 'no telegram anchor → nothing to check');
});

test('fix_config_conflicts proposes one card with the conflicts; none → no card', async () => {
  const proposed: any[] = [];
  let conflicts: any[] = [{ code: 'slang_in_tone', ref: TG, detail: 'Playbook tone of telegram:@loko asks for slang', rule_id: 4, fix: {} }];
  const tool = buildBuilderTools({
    agents: { getByHandle: async (h: string) => (h === 'loko' ? ORCH : null) } as any,
    catalog: {} as any, profiles: {} as any, creator: {} as any, skills: {} as any,
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa1', ...a }; } } as any,
    conflicts: { forAgent: async () => conflicts },
  }).find((t) => t.name === 'fix_config_conflicts')!;
  const ctx: any = { runId: 'r', role: 'builder', channelKey: null, extras: { chat: { chatId: 'c1' }, agentIntent: true } };
  const r: any = await tool.execute({ handle: 'loko' }, ctx);
  assert.equal(r.pending_action, 'pa1');
  assert.equal(proposed[0].kind, FIX_CONFIG_CONFLICTS_KIND);
  assert.deepEqual(proposed[0].payload, { handle: 'loko', conflicts: [{ code: 'slang_in_tone', ref: TG, detail: 'Playbook tone of telegram:@loko asks for slang', rule_id: 4 }] });
  assert.match(proposed[0].summary, /1 conflict$/);

  conflicts = [];
  const none: any = await tool.execute({ handle: 'loko' }, ctx);
  assert.deepEqual(none.conflicts, []);
  assert.equal(proposed.length, 1);
  const unknown: any = await tool.execute({ handle: 'nobody' }, ctx);
  assert.equal(unknown.error, 'unknown_agent');
});

const mem = (id: number, text: string, createdBy: 'owner' | 'reviewer', evidence: unknown = null) =>
  ({ id, kind: 'rule' as const, text, evidence, createdBy, createdAt: new Date() });

test('the executor sees owner rules as their own block above the playbook; approval preferences are not rules', () => {
  const memory = [mem(3, 'Без хештегів', 'owner'), mem(7, 'Власник прибрав емодзі', 'owner', { source: 'approval' }), mem(9, 'Короткі пости заходять краще', 'reviewer')];
  assert.deepEqual(ownerRulesOf(memory), [{ id: 3, text: 'Без хештегів' }]);
  assert.deepEqual(memoryWithoutRules(memory).map((m) => m.id), [7, 9]);
  assert.deepEqual(ownerRulesSection([]), []);

  const skills: any = { get: () => undefined, list: () => [] };
  const exec = buildSystemPrompt('executor', makeCard(), memory, skills);
  assert.match(exec, /## Правила власника \(обовʼязкові\)\nВажливіші за плейбук[^\n]*\n- #3 Без хештегів/);
  assert.equal(exec.split('Без хештегів').length - 1, 1, 'the rule is not repeated in the memory list');
  assert.match(exec, /- \[rule\] Короткі пости заходять краще/);
  const planner = buildSystemPrompt('planner', makeCard(), memory, skills);
  assert.doesNotMatch(planner, /## Правила власника \(обовʼязкові\)/);
  assert.match(planner, /- \[rule, власник\] Без хештегів/);
});

const scores = { ai_likeness: 5, sense: 5, voice: 5, grounding: 5, audience_asks: 5, format_fit: 5 };

test('critic: owner_rules ≤ 2 rejects and names the broken rule; a named rule caps the axis; unknown ids are dropped', () => {
  const rules = [rule(3, 'Без хештегів'), rule(4, 'Без сленгу')];
  const c = CritiqueInput.parse({ scores: { ...scores, owner_rules: 5 }, broken_rules: [3, 99], verdict: 'pass', notes: '#3: у пості три хештеги' });
  const n = normalizeOwnerRules(c, rules);
  assert.equal(n.scores.owner_rules, 2);
  assert.deepEqual(n.broken_rules, [3]);
  assert.deepEqual(decideVerdict(n), { verdict: 'reject', reason: 'score_le_2: owner_rules (#3)' });

  const ok = normalizeOwnerRules(CritiqueInput.parse({ scores: { ...scores, owner_rules: 5 }, verdict: 'pass', notes: 'Ок.' }), rules);
  assert.deepEqual(decideVerdict(ok), { verdict: 'pass', reason: 'scores_ok' });
  const three = normalizeOwnerRules(CritiqueInput.parse({ scores: { ...scores, owner_rules: 3 }, verdict: 'pass', notes: 'Майже.' }), rules);
  assert.deepEqual(decideVerdict(three), { verdict: 'revise', reason: 'score_le_3: owner_rules' });
  assert.match(criticLine({ verdict: 'revise', scores: three.scores, notes: 'Майже.' }), /owner_rules 3/);

  // No rules in the prompt: the axis and the ids are dropped, an older six-axis answer still parses.
  const none = normalizeOwnerRules(CritiqueInput.parse({ scores: { ...scores, owner_rules: 1 }, broken_rules: [3], verdict: 'pass', notes: 'Ок.' }), []);
  assert.equal(none.scores.owner_rules, undefined);
  assert.equal(none.broken_rules, undefined);
  assert.deepEqual(decideVerdict(none), { verdict: 'pass', reason: 'scores_ok' });
  assert.ok(CritiqueInput.safeParse({ scores, verdict: 'pass', notes: 'Ок.' }).success);
});

test('critic prompt lists the owner rules and says they outrank the playbook', () => {
  assert.deepEqual(criticOwnerRulesLines(null), []);
  const prompt = criticUserPrompt({
    channelKey: '@loko', slotId: 's1', mode: 'live', resourceRef: TG, platform: 'telegram', format: 'text',
    text: 'Пост #ai #ml', spec: {}, voice: {}, slopWarnings: [], playbook: 'hashtag_policy: 3–5',
    ownerRules: [rule(3, 'Без хештегів')],
  });
  assert.match(prompt, /### Правила власника каналу \(обовʼязкові, важливіші за плейбук, профіль і приклади\)\n- #3 Без хештегів\nОціни owner_rules/);
  assert.match(prompt, /broken_rules/);
});
