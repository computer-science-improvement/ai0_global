/**
 * Spec 059 T1: propose_skill_edit stores an edit of a live skill for the probe and says so (fakes only, no database).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentSkillTools, type AgentSkillToolDeps } from './agent-skill-tools';
import type { WriteSkillInput } from './skill-store';

const NOW = new Date('2030-05-06T09:00:00Z');
const AGENT = { id: 'a1', handle: 'kira', parentId: null, scope: 'resource', scopeId: 'telegram:@k' } as any;
const PREV = { id: 's1', name: 'seasonal-hooks', description: 'Сезонні гачки для постів', appliesTo: ['executor'], body: 'Старий текст скіла.' } as any;

function harness(o: { prev?: any; probe?: AgentSkillToolDeps['probe'] } = {}) {
  const writes: WriteSkillInput[] = [];
  const posts: any[] = [];
  const [tool] = buildAgentSkillTools({
    agents: { getByHandle: async () => null, get: async () => null, children: async () => [] },
    skills: {
      selfEditsToday: async () => 0, findForAgent: async () => o.prev ?? null, findShared: async () => null,
      writeAgentSkill: async (i: WriteSkillInput) => {
        writes.push(i);
        return { ok: true as const, skill: { id: 's1' } as any, version: 2, lint: { ok: true, errors: [], warnings: [] }, ...(i.probing ? { probing: true } : {}) };
      },
    },
    kpi: { primary: async () => null }, inbox: { post: async (i: any) => { posts.push(i); return 1; } }, now: () => NOW, probe: o.probe,
  });
  const input = { skill: 'seasonal-hooks', description: 'Сезонні гачки для постів', applies_to: ['executor'], body: 'Новий текст скіла з правилом про сезон.', reason: 'пости з сезонним першим рядком мали більше переглядів' };
  return { tool, writes, posts, run: () => tool.execute(input, { runId: 'r', role: 'reviewer', channelKey: '@k', extras: { agent: AGENT } } as any) as Promise<any> };
}

test('an edit of a live skill is written as probing, returns probing with the Ukrainian line, and the note says it is being checked', async () => {
  const h = harness({ prev: PREV, probe: { enabled: () => true, samples: () => 3 } });
  const r = await h.run();
  assert.equal(r.ok, true);
  assert.equal(r.probing, true);
  assert.equal(r.version, 2);
  assert.equal(r.message, 'зміну перевіряю на 3 недавніх постах, рішення — у наступному прогоні');
  assert.equal(r.review_in_days, undefined);
  assert.equal(h.writes[0].probing, true);
  assert.equal(h.writes[0].probe?.verdict, 'probing');
  assert.match(h.posts[0].title, /proposed a change to skill "seasonal-hooks" \(v2\), checking it on 3 recent posts/);
  assert.match(h.posts[0].alert.title, /запропонував зміну скіла «seasonal-hooks» \(v2\), перевіряю на 3 останніх постах/);
  assert.doesNotMatch(h.posts[0].body, /Roll back/);
});

test('a new skill, probes off or no probe wiring: the edit applies at once as before', async () => {
  const fresh = harness({ probe: { enabled: () => true, samples: () => 3 } });
  const a = await fresh.run();
  assert.equal(a.probing, undefined);
  assert.equal(a.review_in_days, 7);
  assert.equal(fresh.writes[0].probing, false);
  assert.equal(fresh.writes[0].probe?.verdict, 'unprobed');
  assert.match(fresh.writes[0].probe!.reason!, /new skill/);
  assert.match(fresh.posts[0].title, /changed skill "seasonal-hooks"/);

  const off = harness({ prev: PREV, probe: { enabled: () => false, samples: () => 3 } });
  const b = await off.run();
  assert.equal(b.probing, undefined);
  assert.equal(off.writes[0].probe?.verdict, 'unprobed');
  assert.match(off.writes[0].probe!.reason!, /switched off/);

  const none = harness({ prev: PREV });
  const c = await none.run();
  assert.equal(c.review_in_days, 7);
  assert.equal(none.writes[0].probing, false);
  assert.equal(none.writes[0].probe, undefined, 'without probe wiring the version row is exactly what it was');
});
