/** Spec 048 FR-002: get_artifact / update_artifact — a live artifact or owner rules only through a card; a draft at once. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifactTools, applyUpdateArtifact, UPDATE_ARTIFACT_KIND } from './artifact-tools';
import type { ArtifactDetail, ArtifactRow, ArtifactType } from './artifact.types';

const row = (type: ArtifactType, id: string, live: boolean, status = 'active'): ArtifactRow => ({
  type, id, title: `${type} ${id}`, agent: 'news', channel: '@news', target: 'telegram:@news', status, version: 1,
  updatedAt: '2026-10-18T10:00:00.000Z', summary: 's', live,
});

function fixture() {
  const store = new Map<string, ArtifactDetail>([
    ['steering:live', { row: row('steering', 'live', true), body: { rules: [] }, versions: [], actions: [] }],
    ['steering:draft', { row: row('steering', 'draft', false, 'ready'), body: { rules: [] }, versions: [], actions: [] }],
    ['rules:@news', { row: row('rules', '@news', false), body: { rules: [] }, versions: [], actions: [] }],
    ['playbook:agent-1', { row: row('playbook', 'agent-1', true), body: { big: 'x'.repeat(9000) }, versions: [], actions: [] }],
  ]);
  const calls = { list: [] as unknown[], edit: [] as unknown[], propose: [] as any[] };
  const svc = {
    list: async (q: unknown) => { calls.list.push(q); return { rows: [...store.values()].map((d) => d.row) }; },
    find: async (type: ArtifactType, id: string) => store.get(`${type}:${id}`) ?? null,
    check: async (_t: ArtifactType, _id: string, patch: unknown) =>
      (patch as { bad?: boolean }).bad ? { ok: false as const, error: 'rule_invalid', details: ['meta'] } : { ok: true as const },
    edit: async (type: ArtifactType, id: string, patch: unknown, by: unknown) => {
      calls.edit.push({ type, id, patch, by });
      const d = store.get(`${type}:${id}`)!;
      return { ok: true as const, detail: { ...d, row: { ...d.row, version: 2 } } };
    },
  };
  const actions = { propose: async (a: any) => { calls.propose.push(a); return { id: 'card-1', ...a } as any; } };
  const [get, update] = buildArtifactTools({ artifacts: () => svc as any, actions: actions as any });
  return { get, update, calls };
}

const ctx = (agentIntent = true): any => ({
  runId: 'r', role: 'composer', channelKey: null,
  extras: { chat: { chatId: 'chat-1', channelKey: '@news' }, agentIntent, ownerText: 'x', agent: { id: 'agent-1', handle: 'news' } },
});

test('get_artifact lists the agent\'s artifacts and reads one; a bare type takes the chat\'s channel or agent', async () => {
  const { get, calls } = fixture();
  const list = await get.execute({}, ctx()) as any;
  assert.deepEqual(calls.list[0], { agent: 'news', limit: 40 });
  assert.ok(list.artifacts.some((a: any) => a.ref === 'steering:live'));
  const rules = await get.execute({ ref: 'rules' }, ctx()) as any;
  assert.equal(rules.ref, 'rules:@news');
  const pb = await get.execute({ ref: 'playbook' }, ctx()) as any;
  assert.equal(pb.ref, 'playbook:agent-1');
  assert.equal(pb.body.truncated, true, 'a big body is clipped');
  assert.equal((await get.execute({ ref: 'steering' }, ctx()) as any).error, 'needs_id');
  assert.equal((await get.execute({ ref: 'nope:1' }, ctx()) as any).error, 'invalid_ref');
  assert.equal((await get.execute({ ref: 'steering:gone' }, ctx()) as any).error, 'artifact_not_found');
});

test('update_artifact: live → a card; owner rules → a card even with none; a draft changes at once only on the owner\'s request', async () => {
  const { update, calls } = fixture();
  const live = await update.execute({ ref: 'steering:live', patch: { remove: ['s1'] }, reason: 'owner asked to drop s1' }, ctx()) as any;
  assert.equal(live.pending_action, 'card-1');
  assert.equal(calls.propose[0].kind, UPDATE_ARTIFACT_KIND);
  assert.deepEqual(calls.propose[0].payload, { type: 'steering', id: 'live', patch: { remove: ['s1'] }, reason: 'owner asked to drop s1', agentId: 'agent-1', title: 'steering live' });
  assert.equal(calls.edit.length, 0);

  const rules = await update.execute({ ref: 'rules', patch: { add: ['Пиши коротко'] }, reason: 'owner said so' }, ctx()) as any;
  assert.equal(rules.pending_action, 'card-1');
  assert.equal(calls.edit.length, 0);

  const bad = await update.execute({ ref: 'steering:live', patch: { bad: true }, reason: 'owner asked' }, ctx()) as any;
  assert.equal(bad.error, 'rule_invalid', 'a change the type refuses never becomes a card');
  assert.equal(calls.propose.length, 2);

  assert.equal((await update.execute({ ref: 'steering:draft', patch: { remove: ['s1'] }, reason: 'just because' }, ctx(false)) as any).error, 'needs_explicit_request');
  const draft = await update.execute({ ref: 'steering:draft', patch: { remove: ['s1'] }, reason: 'owner asked' }, ctx()) as any;
  assert.equal(draft.ok, true);
  assert.equal(draft.version, 2);
  assert.deepEqual((calls.edit[0] as any).by, { author: 'agent', agentId: 'agent-1', reason: 'owner asked' });
});

test('the card\'s Apply edits as the agent and throws the type\'s refusal', async () => {
  const edits: unknown[] = [];
  const ok = await applyUpdateArtifact({
    edit: async (type, id, patch, by) => { edits.push({ type, id, patch, by }); return { ok: true, detail: { row: row(type, id, true), body: {}, versions: [], actions: [] } }; },
  }, { type: 'rules', id: '@news', patch: { add: ['x'] }, reason: 'asked', agentId: 'agent-1', title: 't' });
  assert.equal(ok.ref, 'rules:@news');
  assert.deepEqual((edits[0] as any).by, { author: 'agent', agentId: 'agent-1', reason: 'asked (applied by the owner)' });
  await assert.rejects(applyUpdateArtifact({ edit: async () => ({ ok: false, error: 'rule_not_found', details: [5] }) }, { type: 'rules', id: '@news', patch: {}, reason: 'r' }), /rule_not_found: \[5\]/);
  await assert.rejects(applyUpdateArtifact(undefined, { type: 'rules', id: '@news' }), /artifacts_not_ready/);
});
