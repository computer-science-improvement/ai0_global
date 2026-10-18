import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildComposeTools } from '../tools/compose-tools';
import { buildRoleTools } from '../tools/role-tools';
import { buildPlatformTools } from '../platform/platform-tools';
import { toToolSpec, type EditorTool } from '../harness/tool';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { buildSystemPrompt, WRITER_MEMORY_CHARS, WRITER_MEMORY_MAX, WRITER_SKILL_HINT_CHARS } from './prompts';
import { EXECUTOR_DENY, executorTools } from './editor-runner.service';
import type { MemoryEntry } from '../repo/editor-memory.repository';

/** Spec 053 FR-001: the writer's every step re-sends its tools and prompt — one PostSpec schema, no idle tools, a short prompt. */

const specChars = (t: EditorTool) => JSON.stringify(toToolSpec(t)).length;
const ctx: any = { runId: 'r', role: 'executor', channelKey: '@chan', extras: { card: makeCard() } };

test('lint_post / preview_post / lint_platform_post carry no PostSpec schema; publish_post still does', () => {
  const compose = Object.fromEntries(buildComposeTools().map((t) => [t.name, t]));
  const platform = Object.fromEntries(buildPlatformTools({ pool: { query: async () => ({ rows: [] }) } as any, publish: {} as any, plans: {} as any }).map((t) => [t.name, t]));
  const publish = buildRoleTools({} as any).find((t) => t.name === 'publish_post')!;
  for (const t of [compose.lint_post, compose.preview_post, platform.lint_platform_post]) {
    assert.ok(specChars(t) < 1_000, `${t.name}: ${specChars(t)}`);
    assert.match(t.description + JSON.stringify(toToolSpec(t).parameters), /publish_(platform_)?post/, 'it says where the schema is');
  }
  assert.ok(specChars(publish) > 10_000, 'the terminal tool keeps the full schema');
  assert.doesNotMatch(publish.description, /обовʼязково lint_post/);
});

test('the schemaless check tools validate the spec themselves: invalid_args with spec.* paths, JSON-string repair', async () => {
  const lint = buildComposeTools().find((t) => t.name === 'lint_post')!;
  const ok: any = await lint.execute({ spec: makeSpec() }, ctx);
  assert.ok(!ok.error, JSON.stringify(ok));
  assert.ok('errors' in ok || 'ok' in ok || 'warnings' in ok);
  const bad: any = await lint.execute({ spec: { format: 'photo', body: 'не масив' } }, ctx);
  assert.equal(bad.error, 'invalid_args');
  assert.ok(bad.details.every((d: any) => d.path.startsWith('spec')), JSON.stringify(bad.details));
  // A model that sends the body as a JSON string gets the loop's repair, not an error.
  const spec = makeSpec();
  const repaired: any = await lint.execute({ spec: { ...spec, body: JSON.stringify(spec.body) } }, ctx);
  assert.notEqual(repaired.error, 'invalid_args');
});

test('the executor loses the tools its prompt already answers, unless the channel allowlist names them', () => {
  const tool = (name: string) => ({ name }) as EditorTool;
  const all = ['sql_readonly', 'get_channel_card', 'get_channel_memory', 'list_skills', 'web_fetch', 'publish_post'].map(tool);
  assert.deepEqual(executorTools('executor', all, null).map((t) => t.name), ['web_fetch', 'publish_post']);
  assert.deepEqual(executorTools('executor', all, ['sql_readonly']).map((t) => t.name), ['sql_readonly', 'web_fetch', 'publish_post']);
  assert.equal(executorTools('reviewer', all, null).length, all.length, 'the reviewer keeps SQL and memory');
  assert.equal(EXECUTOR_DENY.size, 4);
});

test('the writer prompt: compact card, the newest 15 lessons each clipped, short skill hints; the planner keeps all', () => {
  const memory: MemoryEntry[] = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1, kind: 'insight', text: `Урок ${i + 1}: ${'довгий висновок '.repeat(40)}`, evidence: null, createdBy: 'reviewer', createdAt: new Date(),
  }) as MemoryEntry);
  const skills = {
    list: () => [{ name: 'format-series', description: 'Серії та рубрики: '.repeat(20), roles: ['executor', 'planner'] }],
    get: () => undefined,
  } as any;
  const card = makeCard();
  const writer = buildSystemPrompt('executor', card, memory, skills);
  const planner = buildSystemPrompt('planner', card, memory, skills);
  assert.ok(writer.includes(JSON.stringify({ channel: card.channelKey }).slice(0, -1)), 'one-line card JSON');
  assert.ok(!writer.includes('\n "channel"'), 'no pretty-printed card');
  const lessons = writer.split('\n').filter((l) => l.startsWith('- [insight'));
  assert.equal(lessons.length, WRITER_MEMORY_MAX);
  assert.ok(lessons.every((l) => l.length <= WRITER_MEMORY_CHARS + 30), String(Math.max(...lessons.map((l) => l.length))));
  const hint = writer.split('\n').find((l) => l.startsWith('- format-series:'))!;
  assert.ok(hint.length <= WRITER_SKILL_HINT_CHARS + '- format-series: '.length);
  assert.equal(planner.split('\n').filter((l) => l.startsWith('- [insight')).length, 25);
  const sum = (p: string) => p.split('\n').filter((l) => l.startsWith('- [insight')).reduce((n, l) => n + l.length, 0);
  assert.ok(sum(writer) < sum(planner) / 3, `${sum(writer)} vs ${sum(planner)}`);
});
