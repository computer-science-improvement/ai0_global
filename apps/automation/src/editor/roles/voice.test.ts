/**
 * Spec 034 FR-001/FR-002: voice-core is in every writer prompt (Telegram,
 * platform and derived executors, the composer), outside the 8k inline
 * budget, with the resource's humour/slang line; human-voice / anti-slop are
 * attached budget-aware; planner and reviewer prompts stay without it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComposerSystemPrompt, buildSystemPrompt, INLINE_SKILLS_BUDGET } from './prompts';
import { attachVoiceSkills, VOICE_CORE, voiceCoreBody, voiceSettingsLine } from './voice';
import { EditorRunnerService } from './editor-runner.service';
import { derivedPrompts } from '../network/derived-slots';
import { SkillLibrary, SkillView, type Skill } from '../skills/skill-library';
import { lintSkill } from '../agents/skill-lint';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import type { EditorSlot } from '../repo/editor-plans.repository';

const lib = new SkillLibrary();
const NOW = new Date('2026-10-08T09:00:00Z');
const CORE = voiceCoreBody();
const HUMOR_OFF = 'Гумор: вимкнено — жодних жартів, мемів, гри слів';

test('voice-core skill: ≤ 2 500 chars, Ukrainian, writer + critic roles, passes skill-lint, no backticked identifiers', () => {
  const s = lib.get(VOICE_CORE);
  assert.ok(s, 'editor-skills/voice-core.md exists');
  assert.ok(s!.body.length <= 2_500, `${s!.body.length}`);
  assert.deepEqual([...s!.appliesTo].sort(), ['checker', 'composer', 'executor', 'reviewer']);
  assert.ok(lintSkill({ name: s!.name, description: s!.description, appliesTo: s!.appliesTo, body: s!.body }).ok);
  assert.ok(!s!.body.includes('`'), 'no backticks (the skills test checks backticked tool names)');
  for (const w of ['format_prefs.humor', 'format_prefs.slang', 'Гумор', 'сленг', 'ʼ', 'Факти замість прикметників']) assert.ok(s!.body.includes(w), w);
  assert.equal(CORE, s!.body, 'prompts use the repo body');
});

test('humour / slang line: off by default, explicit when the owner allows them', () => {
  assert.match(voiceSettingsLine(null), /Гумор: вимкнено — жодних жартів, мемів, гри слів/);
  assert.match(voiceSettingsLine(null), /Сленг: ні/);
  assert.match(voiceSettingsLine({ humor: 'none', slang: false }), /Гумор: вимкнено.*Сленг: ні/);
  const on = voiceSettingsLine({ humor: 'light', slang: true });
  assert.match(on, /Гумор: легкий \(дозволив власник\)/);
  assert.match(on, /Сленг: дозволено власником/);
});

test('Telegram executor prompt: voice-core + humour line, human-voice inline, anti-slop referenced; planner and reviewer without it', () => {
  const p = buildSystemPrompt('executor', makeCard(), [], lib);
  assert.ok(p.includes(CORE), 'voice-core inlined');
  assert.ok(p.includes(HUMOR_OFF));
  assert.match(p, /### skill: editor-executor-workflow/);
  assert.match(p, /### skill: human-voice/);
  assert.match(p, /Повні правила голосу \(anti-slop\)/);
  assert.ok(!p.includes(`- ${VOICE_CORE}:`), 'voice-core is not also listed for load_skill');
  assert.match(p, /- anti-slop:/, 'anti-slop stays loadable');
  const light = buildSystemPrompt('executor', makeCard({ humor: 'light', slang: true }), [], lib);
  assert.match(light, /Гумор: легкий/);
  for (const role of ['planner', 'reviewer'] as const) {
    const q = buildSystemPrompt(role, makeCard(), [], lib);
    assert.ok(!q.includes(CORE), `${role} has no voice-core`);
    assert.ok(!q.includes('### skill: human-voice'), `${role} has no attached voice skills`);
  }
});

test('voice-core never competes with the 8k inline budget: a full budget still keeps it', () => {
  const big = (name: string, n: number): Skill => ({ name, description: 'd'.repeat(20), appliesTo: ['executor'], body: 'х'.repeat(n) });
  const skills = new SkillView([lib.get('editor-executor-workflow')!, big('own-a', INLINE_SKILLS_BUDGET - lib.get('editor-executor-workflow')!.body.length)], ['own-a']);
  const p = buildSystemPrompt('executor', makeCard(), [], skills);
  assert.ok(p.includes(CORE));
  assert.match(p, /### skill: own-a/);
  assert.ok(!p.includes('### skill: human-voice'), 'no budget left for human-voice');
  assert.match(p, /Повні правила голосу \(human-voice, anti-slop\)/);
  // Even an agent view without voice-core (disabled toggle) gets it from the repo.
  const none = buildSystemPrompt('executor', makeCard(), [], new SkillView([]));
  assert.ok(none.includes(CORE));
});

test('attachVoiceSkills: in order while the budget allows, skipping names already inline', () => {
  const a = attachVoiceSkills(lib, 4_000);
  assert.deepEqual(a.names, ['human-voice']);
  assert.deepEqual(a.missing, ['anti-slop']);
  const all = attachVoiceSkills(lib, 20_000);
  assert.deepEqual(all.names, ['human-voice', 'anti-slop']);
  assert.deepEqual(attachVoiceSkills(lib, 20_000, ['human-voice']).names, ['anti-slop']);
});

test('composer prompt: voice-core with the channel humour line (and without a channel)', () => {
  const p = buildComposerSystemPrompt({ now: NOW, card: makeCard({ slang: true }), hasCard: true, memory: [], skills: lib });
  assert.ok(p.includes(CORE));
  assert.match(p, /Сленг: дозволено власником/);
  assert.match(p, /### skill: editor-composer-workflow/);
  const noChannel = buildComposerSystemPrompt({ now: NOW, card: null, hasCard: false, memory: [], skills: lib });
  assert.ok(noChannel.includes(CORE) && noChannel.includes(HUMOR_OFF));
});

const IG = 'instagram:ig1';
const SRC = '10000000-0000-4000-8000-000000000001';
const derivedSlot = (o: Partial<EditorSlot> = {}): EditorSlot => ({
  id: 'd1', planId: 'p1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'ig_photo', topic: 'Туманність Кільце', angle: null,
  sourceHints: [], isExperiment: false, status: 'running', attempts: 1, runId: null, publishedPostId: null, postSpec: null, renderedPreview: null, error: null,
  resourceRef: IG, ideaId: null, treatment: 'adapt', treatmentReason: null, derivedFromSlotId: SRC, sourcePost: null, ...o,
});
const ready = (treatment: 'duplicate' | 'adapt') => ({
  kind: 'ready' as const, treatment, source: { platform: 'telegram' as const, spec: makeSpec() }, sourceRef: 'telegram:@chan', shadow: false,
  slideUrls: [], formatNotes: null, sourceSlotId: SRC,
});

test('derived prompt (duplicate and adapt): voice-core and the target humour line', () => {
  for (const t of ['duplicate', 'adapt'] as const) {
    const p = derivedPrompts({
      slot: derivedSlot({ treatment: t }), ready: ready(t), targetRef: IG, targetPlatform: 'instagram', profile: null, formatPrefs: null,
      playbook: null, memory: '', mode: 'live', voice: { humor: 'light' },
    });
    assert.ok(p.system.includes(CORE), t);
    assert.match(p.system, /Гумор: легкий/);
  }
});

function runner(o: { voiceOf?: (ref: string) => Promise<any> } = {}) {
  const runs: any[] = [];
  const tools = ['publish_post', 'lint_post', 'publish_platform_post', 'lint_platform_post', 'skip_slot', 'web_fetch'].map((name) => ({ name, kind: 'read', execute: async () => ({ ok: true }) }));
  const r = new EditorRunnerService({
    loop: { run: async (i: any) => { runs.push(i); return { runId: 'r', status: 'ok', terminalTool: 'publish_platform_post' } as any; } },
    registry: { forRole: () => tools as any },
    skills: lib,
    plans: { reservedSlots: async () => [], getSlot: async () => ({ ...derivedSlot(), status: 'published' }) as any, updateSlot: async () => {} },
    memory: { listActive: async () => [] },
    platformContext: async () => ({ profile: 'Тема: космос', playbook: null, maxPerDay: 2, vocabulary: [] }),
    env: () => undefined, notify: async () => {}, now: () => NOW,
    derived: { resolve: async (s: EditorSlot) => ready(s.treatment as 'duplicate' | 'adapt') as any, formatPrefs: async () => null },
    ...(o.voiceOf ? { voiceOf: o.voiceOf } : {}),
  });
  return { r, runs };
}

test('every writer run of the runner carries voice-core: Telegram, platform, duplicate, adapt', async () => {
  const t = runner({ voiceOf: async (ref) => (ref === IG ? { humor: 'none', slang: true, emoji: 'none' } : null) });
  const tgSlot: any = { id: 's1', channelKey: '@chan', scheduledAt: NOW, format: 'photo', topic: 'Тема', angle: null, sourceHints: [], isExperiment: false, attempts: 1 };
  await t.r.runExecutor(tgSlot, makeCard({ humor: 'light' }));
  await t.r.runExecutor(derivedSlot({ treatment: null, derivedFromSlotId: null, format: 'ig_carousel' }), makeCard({ mode: 'live' }));
  await t.r.runExecutor(derivedSlot({ treatment: 'duplicate' }), makeCard({ mode: 'live' }));
  await t.r.runExecutor(derivedSlot({ treatment: 'adapt' }), makeCard({ mode: 'live' }));
  assert.equal(t.runs.length, 4);
  for (const [i, run] of t.runs.entries()) {
    assert.ok(run.system.includes(CORE), `run ${i} has voice-core`);
  }
  assert.match(t.runs[0].system, /Гумор: легкий/, 'Telegram: the card setting');
  for (const run of t.runs.slice(1)) assert.match(run.system, /Гумор: вимкнено.*Сленг: дозволено власником/, 'platform targets: voiceOf(target)');
  assert.match(t.runs[1].system, /### skill: human-voice/, 'platform executor: human-voice attached');
  assert.ok(!t.runs[2].system.includes('### skill: human-voice'), 'a duplicate keeps the source text: no extra skills');
  assert.match(t.runs[3].system, /### skill: human-voice/, 'adapt: human-voice attached');
  assert.deepEqual(t.runs[1].extras.platformSlot.voice, { humor: 'none', slang: true, emoji: 'none' }, 'the platform lint gets the voice');
});
