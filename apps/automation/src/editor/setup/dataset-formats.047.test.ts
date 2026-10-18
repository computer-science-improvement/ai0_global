/**
 * Spec 047 FR-007: the onboarder allows and requires the formats a bound dataset needs (@pdr: quiz_question → quiz), a
 * series sourced from such a dataset uses that format, and a role agent shows the mode its runs really follow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from './setup-metrics';
import { allowedFormats, checkSetup, datasetsNote, onboarderUserPrompt } from './setup-analysis';
import { boundDatasets } from './setup.repository';
import { datasetFormat, seriesSourceErrors } from '../network/series';
import { PlaybookSchema } from '../network/playbook';
import { AgentsService } from '../agents/agents.service';
import { samplePosts, validSetup } from './testing/setup-fixtures';

const PDR = [{ key: 'pdr_questions', entity: 'quiz_question' }];

test('a quiz_question dataset allows quiz and the proposal must weight it; other datasets change nothing', async () => {
  const posts = samplePosts();
  const metrics = computeMetrics(posts, 'Europe/Kyiv');
  assert.ok(!allowedFormats(metrics.formatMix).has('quiz'));
  assert.ok(allowedFormats(metrics.formatMix, PDR).has('quiz'));
  assert.equal(datasetFormat('quiz_question'), 'quiz');
  assert.equal(datasetFormat('recipe'), null);

  const errors = (await checkSetup(validSetup(), { posts, metrics, datasets: PDR })).join('\n');
  assert.match(errors, /format_mix: канал публікує з датасету pdr_questions \(quiz_question\) — потрібен формат quiz/);
  const withQuiz = validSetup();
  withQuiz.format_mix.formats = { ...withQuiz.format_mix.formats, quiz: 0.3 };
  assert.deepEqual(await checkSetup(withQuiz, { posts, metrics, datasets: PDR }), []);
  assert.deepEqual(await checkSetup(validSetup(), { posts, metrics, datasets: [{ key: 'recipes', entity: 'recipe' }] }), []);
});

test('the onboarder is told which datasets the channel publishes from and the format they need', () => {
  assert.equal(datasetsNote([]), null);
  assert.match(datasetsNote(PDR)!, /pdr_questions \(quiz_question\) → формат quiz/);
  const prompt = onboarderUserPrompt({
    channelKey: '@pdr', title: null, about: null, subscribers: null, posts: samplePosts(), metrics: computeMetrics(samplePosts(), 'Europe/Kyiv'),
    lockedFormat: [], lockedSeries: [], current: { brief: null, profile: null }, datasets: PDR,
  });
  assert.match(prompt, /Канал публікує з датасетів: pdr_questions \(quiz_question\)/);
});

test('a series from a quiz dataset must be a quiz (post 1725 went out as a poll with no correct answer)', () => {
  const cat = { tables: ['pdr_questions'], feeds: [], entities: { pdr_questions: 'quiz_question' } };
  const src = { kind: 'library' as const, table: 'pdr_questions' };
  assert.match(seriesSourceErrors('Тест ПДР', src, cat, 'poll')[0], /датасет pdr_questions \(quiz_question\) публікується форматом quiz, не poll/);
  assert.deepEqual(seriesSourceErrors('Тест ПДР', src, cat, 'quiz'), []);
  assert.deepEqual(seriesSourceErrors('Тест ПДР', src, { tables: ['pdr_questions'], feeds: [] }, 'poll'), [], 'no entities → not checked');
});

test('bound datasets: the series library sources of this resource and the ledger', async () => {
  const pb = PlaybookSchema.parse({
    platforms: [{ resource_ref: 'telegram:@pdr', role: 'core', formats: { quiz: 1 }, per_day: { min: 1, max: 3 } }],
    series: [
      { name: 'Тест', resource_ref: 'telegram:@pdr', cadence: 'daily@10:00', format: 'quiz', brief: 'Питання з ПДР щодня зранку.', source: { kind: 'library', table: 'pdr_questions' } },
      { name: 'Інше', resource_ref: 'telegram:@other', cadence: 'daily@10:00', format: 'text', brief: 'Не цей канал взагалі.', source: { kind: 'library', table: 'recipes' } },
    ],
  });
  const calls: unknown[][] = [];
  const pool = { query: async (_sql: string, params: unknown[]) => { calls.push(params); return { rows: [{ key: 'pdr_questions', entity: 'quiz_question' }] }; } };
  assert.deepEqual(await boundDatasets(pool as any, 'telegram:@pdr', pb), PDR);
  assert.deepEqual(calls[0], ['telegram:@pdr', ['pdr_questions'], 90]);
});

test('a role agent shows its orchestrator\'s channel mode and refuses a mode of its own', async () => {
  const orch: any = { id: 'o', kind: 'orchestrator', handle: 'pdr', name: 'PDR', emoji: null, scope: 'resource', scopeId: 'telegram:@pdr', parentId: null, mode: 'approve', status: 'active', pausedUntil: null };
  const planner: any = { ...orch, id: 'p', kind: 'planner', handle: 'pdr_planner', parentId: 'o', mode: 'off' };
  const all = [orch, planner];
  const svc = new AgentsService({
    pool: { query: async () => ({ rows: [] }) } as any,
    agents: {
      getByHandle: async (h: string) => all.find((a) => a.handle === h) ?? null, get: async (id: string) => all.find((a) => a.id === id) ?? null,
      list: async () => all, children: async (id: string) => all.filter((a) => a.parentId === id), activity: async () => new Map(),
      update: async () => { throw new Error('no update expected'); },
    } as any,
    skills: {} as any, inbox: {} as any,
    setChannelMode: async () => {}, channelMode: async () => 'live', runNow: async () => ({ started: false, what: '' }), memory: async () => [],
  });
  const one = await svc.get('pdr_planner');
  assert.equal((one.agent as any).effectiveMode, 'live', 'the card is live: the planner runs live whatever its own column says');
  assert.equal((await svc.get('pdr')).children[0].effectiveMode, 'live');
  const tree = await svc.tree();
  assert.equal(tree.agents[0].children[0].effectiveMode, 'live');
  await assert.rejects(svc.patch('pdr_planner', { mode: 'live' }), (e: any) => e.response?.error === 'mode_follows_orchestrator');
});
