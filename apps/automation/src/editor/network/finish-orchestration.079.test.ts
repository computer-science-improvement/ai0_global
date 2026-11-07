/** Spec 079 FR-006: the «УВАГА ВЛАСНИКУ» lines of finish_orchestration's summary become one Inbox note. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetworkTools, ownerAttentionLines } from './network-tools';
import { kyivDay } from '../../common/ai/usage/kyiv-day';
import type { ToolContext } from '../harness/tool';

const ORCH = { id: 'o-1', handle: 'nova', kind: 'orchestrator' };
const ctx: ToolContext = { runId: 'r', role: 'orchestrator', channelKey: '@nova', slotId: null, extras: { network: { orchestrator: ORCH } } as any };

function setup(inbox: any) {
  const tool = buildNetworkTools({ repo: {} as any, plans: {} as any, memory: { add: async () => 1 }, inbox }).find((t) => t.name === 'finish_orchestration')!;
  return (summary: string) => tool.execute(tool.input.parse({ summary }), ctx) as Promise<any>;
}

test('a summary with «УВАГА ВЛАСНИКУ» lines posts one gated action note with a Ukrainian alert on «ви»', async () => {
  const once: any[] = [];
  const run = setup({ post: async () => 1, postOnce: async (i: any) => { once.push(i); return 5; } });
  const r = await run([
    'У пулі 4 ідеї, директиви прийнято.',
    '⚠️ УВАГА ВЛАСНИКУ: джерело zakon.rada.gov.ua віддає 403 третій день.',
    '**Увага, власнику:** потрібне ваше рішення щодо серії.',
    '- !УВАГА ВЛАСНИКОВІ — ще один рядок',
    'Звичайний рядок про УВАГА ВЛАСНИКУ посередині.',
  ].join('\n'));
  assert.equal(r.ok, true);
  assert.equal(r.owner_note, true);
  assert.equal(once.length, 1, 'all lines of one call are one note');
  const n = once[0];
  assert.equal(n.kind, 'orchestrator_owner_attention');
  assert.equal(n.severity, 'action');
  assert.equal(n.agentId, 'o-1');
  assert.deepEqual([n.refType, n.refId], ['agent', `nova|${kyivDay(new Date())}`]);
  assert.equal(n.title, '@nova asks for your attention');
  assert.match(n.body, /zakon\.rada\.gov\.ua віддає 403/);
  assert.match(n.body, /рішення щодо серії/);
  assert.match(n.body, /ще один рядок/);
  assert.doesNotMatch(n.body, /посередині/);
  assert.equal(n.alert.title, '@nova просить вашої уваги');
  assert.match(n.alert.title, /вашої/);
  assert.equal(n.alert.body, n.body);
  assert.equal(n.gate.subject, 'owner_attention:o-1');
  assert.equal(n.gate.parts.length, 3);
  assert.ok(n.gate.parts.every((p: string) => p === p.toLowerCase()));
});

test('without the marker nothing is posted; a duplicate (gate says no) is not reported as posted', async () => {
  let posted = 0;
  const run = setup({ post: async () => { posted++; return 1; }, postOnce: async () => { posted++; return null; } });
  const r = await run('У пулі 4 ідеї. Усе гаразд, власник може не втручатися.');
  assert.equal(r.owner_note, undefined);
  assert.equal(posted, 0);
  const dup = await run('УВАГА ВЛАСНИКУ: те саме, що вчора.');
  assert.equal(dup.ok, true);
  assert.equal(dup.owner_note, undefined, 'the gate suppressed it');
  assert.equal(posted, 1);
});

test('an inbox without postOnce gets post; a throwing inbox still returns ok', async () => {
  const posts: any[] = [];
  const plain = setup({ post: async (i: any) => { posts.push(i); return 1; } });
  assert.equal((await plain('УВАГА ВЛАСНИКУ: потрібен ключ API.')).owner_note, true);
  assert.equal(posts.length, 1);

  const boom = setup({ post: async () => { throw new Error('db down'); }, postOnce: async () => { throw new Error('db down'); } });
  const r = await boom('УВАГА ВЛАСНИКУ: потрібен ключ API.');
  assert.equal(r.ok, true);
  assert.equal(r.owner_note, undefined);
});

test('ownerAttentionLines: the marker forms, case, and a marker with no text', () => {
  assert.deepEqual(ownerAttentionLines('Увага власнику: а\nУВАГА, ВЛАСНИКУ — б\n# 🔴 увага власникові! в\nУвага власнику:'), ['Увага власнику: а', 'УВАГА, ВЛАСНИКУ — б', '# 🔴 увага власникові! в']);
  assert.deepEqual(ownerAttentionLines('Нема чого казати'), []);
});

test('the tool description tells the orchestrator about the marker', () => {
  const tool = buildNetworkTools({ repo: {} as any, plans: {} as any, memory: { add: async () => 1 }, inbox: { post: async () => 1 } as any }).find((t) => t.name === 'finish_orchestration')!;
  assert.match(tool.description, /УВАГА ВЛАСНИКУ:/);
});
