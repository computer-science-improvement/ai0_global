/**
 * Spec 037 T12 (FR-012): the critic gets the writer's skills — the resource tone, the format and the topic skills of
 * the content type, compressed to rules within a budget — and the critic model stays what the owner set. Pure
 * functions, scripted fake LLMs only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { SkillLibrary, SkillView } from '../skills/skill-library';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { CriticGate } from './critic-gate';
import { CriticService, criticSystemPrompt, type CriticRequest } from './critic.service';
import {
  compressSkill, CRITIC_SKILLS_BUDGET, CRITIC_SYSTEM_MAX, criticSkillNames, criticSkillsSection, detectContentTypes,
  inlineCompressedSkills, selectPostSkills, slotSkillsContext,
} from './critic-skills';

const NOW = new Date('2026-10-10T09:00:00Z');
const lib = new SkillLibrary();

/** A poll in Біржа Ігор: the gaming tone attached to the agent, a giveaway from GamerPower. */
function birzhaPoll(o: Partial<CriticRequest> = {}): CriticRequest {
  const spec = makeSpec({
    format: 'poll', title: 'Роздача тижня в Epic', body: [{ type: 'p', text: 'Epic роздає Spooky Cats до 16 жовтня.' }],
    poll: { question: 'Заберете Spooky Cats?', options: ['Так', 'Ні', 'Вже маю'], anonymous: true }, source: undefined,
  } as any);
  return {
    channelKey: '@birzha_ihor', slotId: 's1', mode: 'live', card: { models: {}, dailyBudgetUsd: null },
    resourceRef: 'telegram:@birzha_ihor', platform: 'telegram', format: 'poll', topic: 'Роздача тижня в Epic',
    text: 'Epic роздає Spooky Cats до 16 жовтня.\n\nОпитування: Заберете Spooky Cats?', spec, voice: {}, slopWarnings: [],
    skills: { resource: ['tone-gaming'], signals: { sources: ['api:gamerpower_giveaways'], live: true } },
    ...o,
  };
}

// ── selection ───────────────────────────────────────────────────────────────

test('content type: deals by fetch_api source, store domain or words; news by feed, live slot, web source or words; deterministic', () => {
  assert.deepEqual(detectContentTypes({ sources: ['api:gamerpower_giveaways'], live: true }), ['deals'], 'a live deal source is not news');
  assert.deepEqual(detectContentTypes({ sources: ['steam_deals'] }), ['deals']);
  assert.deepEqual(detectContentTypes({ sourceUrl: 'https://store.steampowered.com/app/1/' }), ['deals']);
  assert.deepEqual(detectContentTypes({ sourceUrl: 'https://www.gamerpower.com/spooky-cats' }), ['deals']);
  assert.deepEqual(detectContentTypes({ text: ['Знижки тижня в GOG'] }), ['deals']);
  assert.deepEqual(detectContentTypes({ sources: ['feed:verge'] }), ['news']);
  assert.deepEqual(detectContentTypes({ sources: ['api:spaceflight_news'] }), ['news']);
  assert.deepEqual(detectContentTypes({ live: true }), ['news']);
  assert.deepEqual(detectContentTypes({ sourceUrl: 'https://techcrunch.com/2026/10/13/x' }), ['news']);
  assert.deepEqual(detectContentTypes({ text: ['Capcom анонсувала Monster Hunter'] }), ['news']);
  assert.deepEqual(detectContentTypes({ sources: ['feed:ign'], text: ['Роздача в Epic'] }), ['deals', 'news'], 'both may hold');
  assert.deepEqual(detectContentTypes({ sourceUrl: 'data://recipes/42', text: ['Сирники за 4 кроки'] }), [], 'a library row is neither');
  assert.deepEqual(detectContentTypes({}), []);
});

test('selection: tone → platform → format → topic → proper-nouns-terms → other resource skills; workflows and voice-core never', () => {
  assert.deepEqual(
    selectPostSkills({ resourceSkills: ['grammar-ua', 'tone-gaming', 'editor-executor-workflow', 'voice-core'], format: 'poll', signals: { sources: ['api:steam_deals'] } }),
    ['tone-gaming', 'format-poll-quiz', 'deals-giveaways', 'proper-nouns-terms', 'grammar-ua']);
  assert.deepEqual(selectPostSkills({ format: 'quiz', contentTypes: ['news'] }), ['format-poll-quiz', 'news-followups', 'fact-check', 'proper-nouns-terms']);
  assert.deepEqual(selectPostSkills({ format: 'longread' }), ['format-longread', 'proper-nouns-terms']);
  assert.deepEqual(selectPostSkills({ format: 'carousel' }), ['format-carousel', 'proper-nouns-terms']);
  assert.deepEqual(selectPostSkills({ format: 'album' }), ['format-album-slider', 'proper-nouns-terms']);
  assert.deepEqual(selectPostSkills({ format: 'video' }), ['format-video', 'proper-nouns-terms']);
  assert.deepEqual(selectPostSkills({ format: 'text' }), ['proper-nouns-terms']);
  assert.deepEqual(selectPostSkills({ format: 'ig_carousel', platform: 'instagram', resourceSkills: ['tone-recipes'] }),
    ['tone-recipes', 'platform-instagram', 'format-carousel', 'proper-nouns-terms']);
  // Every name the selection can produce is a real skill.
  for (const f of ['poll', 'quiz', 'longread', 'carousel', 'album', 'video', 'ig_carousel', 'th_carousel', 'fb_album']) {
    for (const n of selectPostSkills({ format: f, contentTypes: ['deals', 'news'] })) assert.ok(lib.get(n), `${f}: ${n} exists`);
  }
  for (const p of ['instagram', 'facebook', 'threads', 'tiktok', 'youtube']) assert.ok(lib.get(`platform-${p}`), p);
});

test('selection for the critic: the post title, topic and source URL are signals too', () => {
  const spec = makeSpec({ title: 'Valve знизила ціни', source: { url: 'https://store.steampowered.com/sale/autumn' } } as any);
  assert.deepEqual(criticSkillNames({ platform: 'telegram', format: 'photo', spec }), ['deals-giveaways', 'proper-nouns-terms']);
  assert.deepEqual(criticSkillNames({ platform: 'telegram', format: 'text', topic: 'OpenAI представила GPT-6', spec: {} }),
    ['news-followups', 'fact-check', 'proper-nouns-terms']);
  assert.deepEqual(criticSkillNames({ platform: 'telegram', format: 'text', spec: {}, source: { url: 'data://facts/1' } }), ['proper-nouns-terms']);
});

// ── compression ─────────────────────────────────────────────────────────────

test('compression: code fences, example sections and lines, long tables and the H1 go; headings, bullets, anti-patterns stay', () => {
  const body = [
    '# Заголовок', '', 'Правило-абзац.', '', '## Що обрати', '- **Питання на знання** — тільки quiz.', '- Добре: «Так пишемо».',
    '- Погано: «Стім».', '', '```json', '{"format":"quiz"}', '```', '', '## Приклад quiz', 'Текст прикладу.', '### Підрозділ прикладу', 'ще',
    '', '## Таблиця', '| a | b |', '|---|---|', '| 1 | 2 |', '', '## Довга', ...Array.from({ length: 8 }, (_, i) => `| ${i} | x |`), '',
    '## Межі', '1. question ≤ 300', 'Наприклад: «щось».',
  ].join('\n');
  const c = compressSkill(body);
  assert.equal(c, [
    'Правило-абзац.', '', '## Що обрати', '- **Питання на знання** — тільки quiz.', '- Погано: «Стім».', '', '## Таблиця', '| a | b |', '|---|---|',
    '| 1 | 2 |', '', '## Довга', '', '## Межі', '1. question ≤ 300',
  ].join('\n'));
  assert.equal(compressSkill(body), c, 'deterministic');
  // Real skills: no code fences or example sections survive, and the rules do.
  const poll = compressSkill(lib.get('format-poll-quiz')!.body);
  assert.ok(!poll.includes('```') && !/Приклад/.test(poll));
  assert.match(poll, /тільки \*\*quiz\*\*/);
  assert.match(poll, /Не розкривай відповідь/);
  assert.ok(poll.length < lib.get('format-poll-quiz')!.body.length);
});

test('budget: skills inline in order while they fit; a skill over the budget is named, a smaller later one still fits', () => {
  const get = (n: string) => lib.get(n);
  const all = inlineCompressedSkills(['tone-gaming', 'format-poll-quiz', 'deals-giveaways', 'proper-nouns-terms', 'nope'], get);
  assert.deepEqual(all.inlined, ['tone-gaming', 'format-poll-quiz', 'deals-giveaways', 'proper-nouns-terms']);
  assert.deepEqual(all.missing, ['nope']);
  assert.ok(all.used <= CRITIC_SKILLS_BUDGET);
  const tight = inlineCompressedSkills(['news-followups', 'format-poll-quiz', 'tone-gaming'], get, 4_000);
  assert.deepEqual(tight.inlined, ['news-followups']);
  assert.deepEqual(tight.notInlined, ['format-poll-quiz', 'tone-gaming']);
  assert.ok(tight.used <= 4_000);
  const skip = inlineCompressedSkills(['anti-slop', 'tone-gaming'], get, 3_000);
  assert.deepEqual([skip.inlined, skip.notInlined], [['tone-gaming'], ['anti-slop']]);
  const sec = criticSkillsSection({ platform: 'telegram', format: 'text', spec: {}, skills: { resource: ['anti-slop'] } }, 2_100);
  assert.match(sec.lines.join('\n'), /Not inlined: anti-slop/);
});

// ── the critic prompt ───────────────────────────────────────────────────────

test('snapshot: a poll in Біржа Ігор — the critic prompt carries tone-gaming, format-poll-quiz, deals-giveaways and proper-nouns-terms within the limit', () => {
  const r = birzhaPoll();
  const base = criticSystemPrompt();
  const s = criticSystemPrompt(r);
  assert.ok(s.startsWith(base), 'rubric and voice-core first, unchanged');
  const section = s.slice(base.length);
  const heads = [...section.matchAll(/^### skill: (\S+)$/gmu)].map((m) => m[1]);
  assert.deepEqual(heads, ['tone-gaming', 'format-poll-quiz', 'deals-giveaways', 'proper-nouns-terms']);
  assert.match(section, /Скіли автора для цього поста/);
  assert.match(section, /питання на знання тільки як quiz|Питання на знання/iu);
  assert.match(section, /deal_expired/);
  assert.match(section, /address_mixed/);
  assert.ok(!section.includes('```'), 'no code examples');
  assert.ok(!/Not inlined/.test(section));
  assert.ok(section.length <= CRITIC_SKILLS_BUDGET + 400, `skills section ${section.length}`);
  assert.ok(s.length <= CRITIC_SYSTEM_MAX, `system prompt ${s.length}`);
  assert.equal(criticSystemPrompt(birzhaPoll()), s, 'deterministic: the same resource, format and type give the same prompt (it caches)');
  // The section itself (names and order) — the snapshot of what the critic reads.
  assert.deepEqual(criticSkillsSection(r).inlined, heads);
});

test('the critic prompt stays within the limit for every format and the fullest selection; no request keeps the old prompt', () => {
  const resource = lib.all().map((s) => s.name);
  for (const format of ['text', 'photo', 'poll', 'quiz', 'longread', 'carousel', 'album', 'video']) {
    for (const platform of ['telegram', 'instagram']) {
      const s = criticSystemPrompt({ platform, format, spec: {}, skills: { resource, signals: { sources: ['api:steam_deals', 'feed:x'] } } });
      assert.ok(s.length <= CRITIC_SYSTEM_MAX, `${platform}/${format}: ${s.length}`);
      assert.match(s, /Not inlined: /);
    }
  }
  assert.doesNotMatch(criticSystemPrompt(), /Скіли автора/);
});

test('the service sends the skills in the system prompt; the critic model is never set by code', async () => {
  const run = async (criticModel: string | null, skills: CriticRequest['skills']) => {
    const llm = new FakeLlm([{ calls: [{ name: 'submit_critique', args: { scores: { ai_likeness: 5, sense: 5, voice: 5, grounding: 5, audience_asks: 5, format_fit: 5, language: 5 }, verdict: 'pass', notes: 'Добре.' } }] }]);
    const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
    const service = new CriticService({ loop, env: () => undefined, defaultModel: async () => 'z-ai/glm-5.3-flash', criticModel: async () => criticModel, now: () => NOW });
    const r = await service.review(birzhaPoll({ skills }));
    assert.ok(r.ok);
    return { model: llm.requests[0].model, system: llm.requests[0].messages[0].content as string };
  };
  const withSkills = await run(null, birzhaPoll().skills);
  const without = await run(null, null);
  assert.equal(withSkills.model, without.model, 'the skills never change the model');
  assert.equal(withSkills.model, 'z-ai/glm-5.3-flash', 'no critic setting → the writer\'s resolution (the global default)');
  assert.match(withSkills.system, /### skill: deals-giveaways/);
  assert.equal((await run('anthropic/claude-sonnet-4.5', birzhaPoll().skills)).model, 'anthropic/claude-sonnet-4.5', 'the owner\'s optional setting');
  // Nothing in the T12 code path names or writes the critic model setting.
  for (const f of ['critic-skills.ts']) {
    const src = readFileSync(join(__dirname, f), 'utf8');
    assert.doesNotMatch(src, /critic_model|criticModel|resolveModel|\bmodel\s*:/, f);
  }
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('runner: the critic gate carries the resource tone skills of the agent, the card skills and the slot signals', async () => {
  const runs: any[] = [];
  const view = new SkillView(['tone-gaming', 'deals-giveaways', 'format-poll-quiz', 'proper-nouns-terms', 'grammar-ua'].map((n) => lib.get(n)!), ['grammar-ua']);
  const mk = (skills: SkillView | null) => new EditorRunnerService({
    loop: { run: async (i: any) => { runs.push(i); return { runId: 'r', status: 'ok', terminalTool: 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0 } } as any; } },
    registry: { forRole: () => [{ name: 'publish_post', execute: async () => ({}) }] as any },
    skills: lib,
    ...(skills ? { runtime: { forChannel: async () => ({ agent: null, orchestrator: null, skills, paused: false }) } } : {}),
    plans: { reservedSlots: async () => [], getSlot: async () => ({ id: 's1', status: 'published' } as any), updateSlot: async () => {} },
    memory: { listActive: async () => [] },
    env: () => undefined, notify: async () => {}, now: () => NOW,
    critic: { service: { review: async () => ({ ok: false, error: 'x', runIds: [], costUsd: 0 }) } },
  });
  const slot: any = {
    id: 's1', channelKey: '@birzha_ihor', scheduledAt: NOW, format: 'poll', topic: 'Роздача', angle: null, sourceHints: ['series:freebies'],
    isExperiment: false, attempts: 1, seriesName: 'freebies',
  };
  await mk(view).runExecutor(slot, makeCard({ channelKey: '@birzha_ihor', mode: 'live', skills: ['format-hashtags'] } as any));
  const gate = runs[0].extras.critic as CriticGate;
  assert.ok(gate instanceof CriticGate);
  assert.deepEqual(gate.c.skills!.resource, ['tone-gaming', 'format-hashtags', 'grammar-ua']);
  assert.deepEqual(gate.c.skills!.signals, { sources: ['series:freebies'], text: [undefined, 'freebies'], live: false });
  assert.equal(gate.c.skills!.source, view);
  // Without a recorded agent the file library lists no tone skill (none is attached).
  await mk(null).runExecutor(slot, makeCard({ mode: 'live' }));
  assert.deepEqual((runs[1].extras.critic as CriticGate).c.skills!.resource, []);
  // The gate hands the context to the critic request.
  let seen: CriticRequest | null = null;
  const gate2 = new CriticGate(
    { critic: { review: async (r) => { seen = r; return { ok: false, error: 'x', runIds: [], costUsd: 0 }; } }, plans: { updateSlot: async () => {} } },
    { slotId: 's1', channelKey: '@c', mode: 'approve', resourceRef: 'telegram:@c', platform: 'telegram', voice: {}, skills: slotSkillsContext(slot, { skills: [] }, view) },
  );
  await gate2.check({ text: 't', spec: makeSpec(), format: 'poll', warnings: [] });
  assert.deepEqual(seen!.skills!.resource, ['tone-gaming', 'grammar-ua']);
});
