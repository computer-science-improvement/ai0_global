/**
 * Spec 073 FR-013 (A47): a skill the card (or the agent) asked for that does not fit the inline budget is listed once with the
 * on-demand skills («Інші скіли», load_skill) in the executor and the composer prompts, and named in one line for the agent's
 * own skills. Before, it was in neither place: not inline and not listed. The voice skills never overflow (they have their
 * own reference line).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentInlineSkills, buildComposerSystemPrompt, buildSystemPrompt, INLINE_SKILLS_BUDGET, moreSkillsLine, WRITER_SKILL_HINT_CHARS } from './prompts';
import { EditorRunnerService } from './editor-runner.service';
import { SkillLibrary, SkillView } from '../skills/skill-library';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import type { EditorSlot } from '../repo/editor-plans.repository';

const skill = (name: string, body: string, description = `${name} skill`, appliesTo: any[] = ['executor', 'composer']) => ({ name, description, appliesTo, body });
const HEADER = '## Інші скіли (завантаж через load_skill, коли потрібні)';
const BIG = 'Довгий скіл. '.padEnd(INLINE_SKILLS_BUDGET + 500, 'x');

const listedSection = (prompt: string) => prompt.slice(prompt.indexOf(HEADER));
const occurrences = (text: string, what: string) => text.split(what).length - 1;

const view = (extra: ReturnType<typeof skill>[] = [], inline: string[] = []) => new SkillView([
  skill('small-guide', 'Короткий скіл каналу.'),
  skill('big-guide', BIG, 'Великий скіл: правила серії, які не вмістилися у бюджет і мають бути доступні через load_skill'),
  skill('other-skill', 'Інший скіл.', 'Інший скіл для довідки'),
  ...extra,
], inline);

test('executor: an over-budget card skill is listed once, with its own (clipped) description, and is not inline', () => {
  const card = makeCard({ skills: ['small-guide', 'big-guide'] });
  const prompt = buildSystemPrompt('executor', card, [], view());
  const listed = listedSection(prompt);
  assert.equal(occurrences(prompt, '- big-guide:'), 1, 'exactly once in the whole prompt');
  assert.ok(listed.includes('- big-guide:'), 'and after the listed-skills header');
  assert.ok(listed.includes('- other-skill: Інший скіл для довідки'), 'the ordinary listed skill stays');
  assert.ok(!prompt.includes('### skill: big-guide'), 'its body is not inline');
  assert.ok(prompt.includes('### skill: small-guide'), 'a skill that fits stays inline');
  assert.ok(!listed.includes('- small-guide:'), 'and is not listed');
  const line = listed.split('\n').find((l) => l.startsWith('- big-guide:'))!;
  assert.ok(line.length <= '- big-guide: '.length + WRITER_SKILL_HINT_CHARS, 'the writer prompt clips the hint like the others');
});

test('planner and reviewer list it in full', () => {
  const card = makeCard({ skills: ['small-guide', 'big-guide'] });
  for (const role of ['planner', 'reviewer'] as const) {
    const prompt = buildSystemPrompt(role, card, [], view());
    assert.equal(occurrences(prompt, '- big-guide:'), 1, role);
    assert.ok(listedSection(prompt).includes('- big-guide: Великий скіл: правила серії, які не вмістилися у бюджет і мають бути доступні через load_skill'), role);
  }
});

test('composer: the same, once', () => {
  const card = makeCard({ skills: ['small-guide', 'big-guide'] });
  const prompt = buildComposerSystemPrompt({ now: new Date('2026-10-29T10:00:00Z'), card, hasCard: true, memory: [], skills: view() });
  assert.equal(occurrences(prompt, '- big-guide:'), 1);
  assert.ok(listedSection(prompt).includes('- big-guide: Великий скіл'));
  assert.ok(!prompt.includes('### skill: big-guide'));
  assert.ok(prompt.includes('### skill: small-guide'));
});

test('an over-budget agent inline skill is listed too (the agent view), and a skill the role does not list is still reached', () => {
  const only = skill('executor-only-big', BIG, 'Скіл лише для виконавця', ['executor']);
  const skills = view([only], ['executor-only-big']);
  const prompt = buildComposerSystemPrompt({ now: new Date('2026-10-29T10:00:00Z'), card: makeCard({ skills: [] }), hasCard: true, memory: [], skills });
  assert.equal(occurrences(prompt, '- executor-only-big:'), 1, 'asked for through the agent: listed even though its roles do not include the composer');
});

test('a card skill that does not exist is neither inline nor listed; the voice skills never overflow', () => {
  const skills = view([skill('human-voice', BIG, 'Голос')]);
  const card = makeCard({ skills: ['no-such-skill', 'human-voice', 'big-guide'] });
  const prompt = buildSystemPrompt('executor', card, [], skills);
  assert.ok(!prompt.includes('no-such-skill:'), 'unknown names are not invented');
  assert.ok(!listedSection(prompt).includes('- human-voice:'), 'a voice skill is never listed as overflow');
  assert.match(prompt, /Повні правила голосу \(human-voice/, 'it keeps its own reference line');
  assert.equal(occurrences(prompt, '- big-guide:'), 1);
});

test('nothing over budget: the listed section is unchanged', () => {
  const card = makeCard({ skills: ['small-guide'] });
  const prompt = buildSystemPrompt('executor', card, [], view());
  const lines = listedSection(prompt).split('\n').slice(1);
  assert.deepEqual(lines.map((l) => l.split(':')[0]), ['- big-guide', '- other-skill'], 'the on-demand skills, each once, in list order');
});

test('agentInlineSkills reports what did not fit; moreSkillsLine names it in one line', () => {
  const skills = view([skill('voice-core', 'v'), skill('anti-slop', BIG)], ['small-guide', 'big-guide', 'voice-core', 'anti-slop', 'platform-instagram', 'missing-one']);
  const got = agentInlineSkills(skills, ['platform-instagram']);
  assert.deepEqual(got.names, ['small-guide']);
  assert.deepEqual(got.overflow, ['big-guide'], 'a skill that exists and does not fit; not voice-core, not a voice skill, not a missing name');
  assert.equal(moreSkillsLine(got.overflow), 'Ще скіли (load_skill): big-guide');
  assert.equal(moreSkillsLine(['a', 'b']), 'Ще скіли (load_skill): a, b');
  assert.equal(moreSkillsLine([]), null);
  assert.deepEqual(agentInlineSkills({ get: () => undefined, list: () => [] } as any, []), { inline: [], names: [], overflow: [] });
});

// ── the runner's two prompts that carry the agent's own skills ─────────────

const NOW = new Date('2026-10-05T09:00:00Z');
const IG = 'instagram:ig1';
const slotOf = (o: Partial<EditorSlot> = {}): EditorSlot => ({
  id: 's1', planId: 'p1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'ig_carousel', topic: 'Туманність Кільце', angle: null,
  sourceHints: [], isExperiment: false, status: 'running', attempts: 1, runId: null, publishedPostId: null, postSpec: null, renderedPreview: null, error: null,
  resourceRef: IG, ideaId: null, treatment: null, treatmentReason: null, derivedFromSlotId: null, sourcePost: null, ...o,
});

function runnerWith(skills: SkillView, derived?: any) {
  const runs: any[] = [];
  const tools = ['publish_platform_post', 'lint_platform_post', 'skip_slot', 'web_fetch'].map((name) => ({ name, kind: name.startsWith('publish') || name === 'skip_slot' ? 'terminal' : 'read', execute: async () => ({ ok: true }) }));
  const r = new EditorRunnerService({
    loop: { run: async (i: any) => { runs.push(i); return { runId: 'r', status: 'ok', terminalTool: 'publish_platform_post' } as any; } },
    registry: { forRole: () => tools as any },
    skills: new SkillLibrary(),
    runtime: { forChannel: async () => ({ agent: null, orchestrator: null, skills, paused: false }) },
    plans: { reservedSlots: async () => [], getSlot: async () => ({ ...slotOf(), status: 'published' }) as any, updateSlot: async () => {} },
    memory: { listActive: async () => [] },
    platformContext: async () => ({ playbook: null, profile: 'Тема: космос', maxPerDay: 2, vocabulary: [] }),
    env: () => undefined, notify: async () => {}, now: () => NOW,
    ...(derived ? { derived } : {}),
  } as any);
  return { r, runs };
}

test('native platform post: an over-budget agent skill is named in one line, unless the executor list already has it', async () => {
  // appliesTo has no executor: it is not in the list, so the line names it.
  const hidden = runnerWith(view([skill('hidden-big', BIG, 'x', ['composer'])], ['small-guide', 'hidden-big']));
  await hidden.r.runExecutor(slotOf(), makeCard({ mode: 'live' }));
  const sys = hidden.runs[0].system as string;
  assert.equal(occurrences(sys, 'Ще скіли (load_skill): hidden-big'), 1);
  assert.ok(!sys.includes('### skill: hidden-big'));
  assert.ok(sys.includes('### skill: small-guide'), 'what fits stays inline');
  // appliesTo has executor: the list below already carries it, so there is no second mention.
  const listed = runnerWith(view([], ['small-guide', 'big-guide']));
  await listed.r.runExecutor(slotOf(), makeCard({ mode: 'live' }));
  const sys2 = listed.runs[0].system as string;
  assert.equal(occurrences(sys2, '- big-guide:'), 1);
  assert.ok(!sys2.includes('Ще скіли (load_skill)'));
});

test('derived adapt: the line sits with the agent\'s inline skills; a duplicate carries none', async () => {
  const ready = (treatment: 'adapt' | 'duplicate') => async () => ({
    kind: 'ready', treatment, source: { platform: 'telegram', spec: makeSpec() }, sourceRef: 'telegram:@chan', shadow: false,
    slideUrls: [], formatNotes: null, sourceSlotId: 'src-1',
  });
  const derivedDeps = (treatment: 'adapt' | 'duplicate') => ({ resolve: ready(treatment), formatPrefs: async () => 'Емодзі: none', released: async () => {}, inbox: async () => {} });
  const adapt = runnerWith(view([], ['small-guide', 'big-guide']), derivedDeps('adapt'));
  await adapt.r.runExecutor(slotOf({ format: 'ig_photo', treatment: 'adapt', derivedFromSlotId: 'src-1' }), makeCard({ mode: 'live' }));
  const sys = adapt.runs[0].system as string;
  assert.equal(occurrences(sys, 'Ще скіли (load_skill): big-guide'), 1);
  assert.ok(sys.indexOf('### skill: small-guide') < sys.indexOf('Ще скіли (load_skill)'), 'after the inline skills');
  const dup = runnerWith(view([], ['small-guide', 'big-guide']), derivedDeps('duplicate'));
  await dup.r.runExecutor(slotOf({ format: 'ig_photo', treatment: 'duplicate', derivedFromSlotId: 'src-1' }), makeCard({ mode: 'live' }));
  assert.ok(!(dup.runs[0].system as string).includes('Ще скіли'), 'a duplicate keeps the source text and carries no agent skills');
});
