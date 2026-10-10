/** Spec 034 T5: playbook examples, fitting-format warnings, few-shot in the writer prompts, the critic's reference. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPlaybookChange, examplesPromptSection, MAX_PLAYBOOK_EXAMPLES, mergeExamples, type Playbook, PlaybookSchema, playbookWarnings,
  renderExamples, renderSection, validatePlaybook,
} from './playbook';
import { playbookBuildPrompt } from './network-prompts';
import { derivedPrompts } from './derived-slots';
import { buildSystemPrompt } from '../roles/prompts';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { criticUserPrompt } from '../critic/critic.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { buildRoleTools, type RoleToolDeps } from '../tools/role-tools';

const NOW = new Date('2026-10-10T09:00:00Z');
const TG = 'telegram:@chan';
const resources = [{ ref: TG, platform: 'telegram' as const }];

const body = (over: Partial<Playbook> = {}): Playbook => PlaybookSchema.parse({
  platforms: [{
    resource_ref: TG, role: 'core', formats: { text: 1, photo: 0.8 }, per_day: { min: 1, max: 3 },
    format_reasons: { text: 'короткі пояснення термінів', photo: 'знімки неба — головне на каналі' },
  }],
  ...over,
});

const EX = [
  { format: 'photo', verdict: 'good', text: 'Марс сьогодні за 62 мільйони кілометрів від Землі. Шукайте помаранчеву точку на сході.', note: 'фото і одна цифра' },
  { format: 'text', verdict: 'good', text: 'Перигелій — точка орбіти, де планета найближче до Сонця. Земля проходить її в січні.' },
  { format: 'text', verdict: 'good', text: 'Сонячне затемнення 12 серпня буде видно з Іспанії, з України — лише частково.' },
  { format: 'text', verdict: 'good', text: 'Четвертий добрий приклад, який у промпт уже не потрапить, бо добрих лише три.' },
  { format: 'text', verdict: 'bad', text: 'ВИ НЕ ПОВІРИТЕ, що знайшли на Марсі!', note: 'Клікбейт: новачки перестають довіряти' },
  { format: 'text', verdict: 'bad', text: 'Марсіани знову сховали воду, хитрюги 😂', note: 'Вимушений гумор' },
  { format: 'text', verdict: 'bad', text: 'Третій поганий приклад, який теж не потрапить у промпт.', note: 'інше' },
] as const;

test('schema: examples ≤ 12, good ones without AI clichés; format reasons are stored', () => {
  const ok = body({ examples: EX.map((e) => ({ ...e })) as any });
  assert.deepEqual(validatePlaybook(ok, resources, ['text', 'photo']), []);
  assert.equal(ok.platforms[0].format_reasons!.photo, 'знімки неба — головне на каналі');
  const slop = body({ examples: [{ format: 'text', verdict: 'good', text: 'Варто зазначити, що у сучасному світі Марс відіграє ключову роль.' }] as any });
  assert.match(validatePlaybook(slop, resources, ['text', 'photo']).join('\n'), /приклад 1 .*AI-штампи «варто зазначити»/);
  const badOk = body({ examples: [{ format: 'text', verdict: 'bad', text: 'Варто зазначити, що у сучасному світі Марс важливий.', note: 'штампи' }] as any });
  assert.deepEqual(validatePlaybook(badOk, resources, ['text', 'photo']), [], 'a bad example may show the cliché');
  const foreign = body({ examples: [{ format: 'text', verdict: 'bad', text: 'Чужий ресурс у прикладі', resource_ref: 'instagram:x' }] as any });
  assert.match(validatePlaybook(foreign, resources, ['text', 'photo']).join('\n'), /не в цій мережі/);
  assert.equal(PlaybookSchema.safeParse({ platforms: body().platforms, examples: Array.from({ length: 13 }, (_, i) => ({ format: 'text', verdict: 'bad', text: `Приклад номер ${i} для ліміту` })) }).success, false);
  assert.equal(PlaybookSchema.parse({ platforms: body().platforms }).examples.length, 0, 'old bodies parse with no examples');
});

test('warnings: more than 4 formats or a format without a reason — never an error', () => {
  const wide = body({ platforms: [{ ...body().platforms[0], formats: { text: 1, photo: 1, album: 0.5, carousel: 0.5, longread: 0.3 }, format_reasons: { text: 'так' } }] });
  assert.deepEqual(validatePlaybook(wide, resources, ['text', 'photo', 'album', 'carousel', 'longread']), []);
  const w = playbookWarnings(wide);
  assert.deepEqual(w.map((x) => x.code), ['too_many_formats', 'format_reason_missing']);
  assert.match(w[0].uk, /увімкнено 5 форматів/);
  assert.match(w[0].en, /5 formats enabled/);
  assert.match(w[1].uk, /photo, album, carousel, longread/);
  assert.deepEqual(playbookWarnings(body()), []);
  assert.match(renderSection(body().platforms[0]), /Чому ці формати: text — короткі пояснення термінів; photo — знімки неба/);
});

test('classify: examples and format reasons apply at once (not structural)', () => {
  const prev = body();
  const next = body({ examples: [EX[0]] as any, platforms: [{ ...prev.platforms[0], format_reasons: { text: 'інша причина', photo: 'фото' } }] });
  assert.deepEqual(classifyPlaybookChange(prev, next, { mode: 'approve' }), { structural: false, reasons: [] });
});

test('merge: new first, duplicates by normalised text dropped, capped at 12', () => {
  const old = EX.map((e) => ({ ...e })) as any[];
  const merged = mergeExamples([{ format: 'text', verdict: 'good', text: 'перигелій — ТОЧКА орбіти, де планета найближче до Сонця. Земля проходить її в січні!' }], old);
  assert.equal(merged.length, EX.length, 'the re-sent example is not duplicated');
  assert.match(merged[0].text, /^перигелій/);
  const many = Array.from({ length: 20 }, (_, i) => ({ format: 'text', verdict: 'bad' as const, text: `Окремий приклад номер ${i} про небо` }));
  assert.equal(mergeExamples(many, old).length, MAX_PLAYBOOK_EXAMPLES);
});

test('renderExamples: up to 3 good + 2 bad of the resource, slot format first, within the budget', () => {
  const r = renderExamples(EX as any, { resourceRef: TG, format: 'photo' })!;
  assert.equal((r.match(/\[ДОБРЕ/g) ?? []).length, 3);
  assert.equal((r.match(/\[ПОГАНО/g) ?? []).length, 2);
  assert.ok(r.indexOf('[ДОБРЕ, photo]') < r.indexOf('[ДОБРЕ, text]'), 'the slot format first');
  assert.ok(!r.includes('Четвертий добрий') && !r.includes('Третій поганий'));
  const tight = renderExamples(EX as any, { resourceRef: TG, budget: 260 })!;
  assert.ok(tight.length <= 260 && /ДОБРЕ/.test(tight) && /ПОГАНО/.test(tight), tight);
  assert.equal(renderExamples([{ ...EX[0], resource_ref: 'instagram:x' }] as any, { resourceRef: TG }), null, 'another resource');
  assert.equal(renderExamples([], { resourceRef: TG }), null);
  assert.deepEqual(examplesPromptSection(null), []);
});

test('writer prompts: the Telegram executor carries the examples right after voice-core; planner and reviewer do not', () => {
  const block = renderExamples(EX as any, { resourceRef: TG })!;
  const lib = new SkillLibrary();
  const sys = buildSystemPrompt('executor', makeCard(), [], lib, [], { examples: block });
  const voice = sys.indexOf('## Голос (voice-core');
  const ex = sys.indexOf('## Приклади постів цього ресурсу');
  assert.ok(voice > 0 && ex > voice && ex < sys.indexOf('## Картка каналу'));
  assert.match(sys, /ВИ НЕ ПОВІРИТЕ/);
  assert.ok(!buildSystemPrompt('planner', makeCard(), [], lib, [], { examples: block }).includes('## Приклади постів'));
  assert.ok(!buildSystemPrompt('executor', makeCard(), [], lib).includes('## Приклади постів'), 'none without examples');
});

test('runner: platformContext examples reach the Telegram executor, the platform executor and the critic gate', async () => {
  const runs: any[] = [];
  const ctxCalls: any[] = [];
  const block = renderExamples(EX as any, { resourceRef: TG })!;
  const slot: any = { id: 's1', channelKey: '@chan', scheduledAt: NOW, format: 'photo', topic: 'Марс у протистоянні', angle: null, sourceHints: [], isExperiment: false, attempts: 1 };
  const runner = new EditorRunnerService({
    loop: { run: async (i: any) => { runs.push(i); return { runId: 'r', status: 'ok', terminalTool: 'publish_post' } as any; } },
    registry: { forRole: () => [] as any },
    skills: new SkillLibrary(),
    plans: { reservedSlots: async () => [], getSlot: async () => ({ ...slot, status: 'published' }), updateSlot: async () => {} },
    memory: { listActive: async () => [] },
    platformContext: async (s: any) => { ctxCalls.push(s.resourceRef); return { examples: block, playbook: 'секція' }; },
    critic: { service: { review: async () => ({ ok: false, error: 'x', runIds: [], costUsd: 0 }) } as any },
    env: () => undefined, notify: async () => {}, now: () => NOW,
  } as any);
  await runner.runExecutor(slot, makeCard({ mode: 'approve' }));
  assert.match(runs[0].system, /## Приклади постів цього ресурсу[\s\S]*Марс сьогодні за 62 мільйони/);
  assert.equal(runs[0].extras.critic.c.examples, block, 'the critic gate has the examples');
  assert.ok(ctxCalls.includes(TG), 'the Telegram resource context is read by its ref');

  runs.length = 0;
  await runner.runExecutor({ ...slot, resourceRef: 'instagram:ig1', format: 'ig_photo' }, makeCard({ mode: 'approve' }));
  assert.match(runs[0].system, /## Приклади постів цього ресурсу/);
  assert.ok(runs[0].system.indexOf('## Приклади постів') > runs[0].system.indexOf('## Голос (voice-core'));
});

test('critic prompt: examples are the reference; taboo topics are named', () => {
  const p = criticUserPrompt({
    channelKey: '@chan', slotId: 's1', mode: 'approve', resourceRef: TG, platform: 'telegram', format: 'text', text: 'Пост', spec: {},
    voice: {}, profile: 'Тема: космос\nТабу-теми (не писати про них): астрологія', examples: renderExamples(EX as any, { resourceRef: TG }), slopWarnings: [],
  });
  assert.match(p, /### Приклади постів ресурсу \(еталон власника\)[\s\S]*ВИ НЕ ПОВІРИТЕ/);
  assert.match(p, /Табу-теми з профілю — це теми/);
  const none = criticUserPrompt({ channelKey: null, slotId: null, mode: 'draft', resourceRef: TG, platform: 'telegram', format: 'text', text: 'x', spec: {}, voice: {}, slopWarnings: [] });
  assert.ok(!none.includes('Приклади постів ресурсу'));
});

test('adapt prompt carries the examples; a duplicate does not', () => {
  const source = { platform: 'telegram' as const, spec: makeSpec() };
  const base = { slot: { id: 's2', scheduledAt: NOW, format: 'ig_photo', ideaId: null } as any, targetRef: 'instagram:ig1', targetPlatform: 'instagram' as const, profile: null, formatPrefs: null, playbook: null, memory: '', mode: 'approve' as const, examples: 'EXAMPLES-BLOCK' };
  const adapt = derivedPrompts({ ...base, ready: { kind: 'ready', treatment: 'adapt', source, sourceRef: TG, slideUrls: [], formatNotes: null } as any });
  assert.match(adapt.system, /EXAMPLES-BLOCK/);
  const dup = derivedPrompts({ ...base, ready: { kind: 'ready', treatment: 'duplicate', source, sourceRef: TG, slideUrls: [], formatNotes: null } as any });
  assert.ok(!dup.system.includes('EXAMPLES-BLOCK'));
});

test('playbook build prompt: a fitting subset with a reason per format, examples are the owner\'s', () => {
  const p = playbookBuildPrompt({ net: { playbook: null, playbookVersion: 0 } as any, brief: 'Космос щодня', now: NOW, tz: 'Europe/Kyiv' });
  assert.match(p, /НЕ всі доступні, а 1–4/);
  assert.match(p, /format_reasons/);
  assert.match(p, /format-longread, format-carousel/);
  assert.match(p, /Приклади постів \(examples\) погоджує власник/);
});

test('reviewer: an unfitting format drops to 0 in one step only with evidence; increases stay ±0.2', async () => {
  const calls: any[] = [];
  const mem: any[] = [];
  const d = {
    pool: { query: async () => ({ rows: [] }) } as any,
    plans: {} as any,
    memory: { listActive: async () => [], add: async (...a: any[]) => { mem.push(a); return 1; }, retireByReviewer: async () => false },
    channels: { setFormatWeights: async (_k: string, w: any, o?: any) => { calls.push([w, o]); return w; } },
    publisher: { send: async () => ({ messageIds: [] }) }, recordPublish: () => {}, now: () => NOW,
  } as unknown as RoleToolDeps;
  const tools = Object.fromEntries(buildRoleTools(d).map((t) => [t.name, t]));
  const c: any = { runId: 'r', role: 'reviewer', channelKey: '@chan', slotId: null, extras: { card: makeCard({ formats: { text: 1, photo: 1, longread: 0.6 } }) } };
  assert.equal(((await tools.set_format_weights.execute({ weights: { longread: 0 } }, c)) as any).error, 'drop_needs_reason');
  assert.equal(((await tools.set_format_weights.execute({ weights: { longread: 0.2 } }, c)) as any).error, 'step_too_big');
  const r: any = await tools.set_format_weights.execute({ weights: { longread: 0 }, drop_reasons: { longread: 'власник відхилив 3 лонгріди на апруві: «не для новин»' } }, c);
  assert.equal(r.ok, true);
  assert.deepEqual(r.dropped, ['longread']);
  assert.deepEqual(calls[0][1], { drop: ['longread'] });
  assert.match(mem[0][2], /Формат longread прибрано/);
  assert.equal(((await tools.set_format_weights.execute({ weights: { text: 0.6 } }, c)) as any).error, 'step_too_big', 'increase/decrease still ±0.2');
  const only: any = { ...c, extras: { card: makeCard({ formats: { text: 1 } }) } };
  assert.equal(((await tools.set_format_weights.execute({ weights: { text: 0 }, drop_reasons: { text: 'причина достатньо довга для перевірки' } }, only)) as any).error, 'last_format');
});
