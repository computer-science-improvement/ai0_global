import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerStep, offerText, SWITCH_NOTE } from './network-offers';
import { buildNetworkModeTool } from './network-mode-tool';

const base = { mode: 'legacy_duplicate', hasPlaybook: false, offerStatus: null, hadPlaybook: null, reofferedAt: null } as const;

test('offerStep: offer once, re-offer once on the first playbook, Keep / Switch are final, independent closes an open offer', () => {
  assert.equal(offerStep(base), 'offer');
  assert.equal(offerStep({ ...base, hasPlaybook: true }), 'offer');
  assert.equal(offerStep({ ...base, offerStatus: 'open', hadPlaybook: false }), 'none');
  assert.equal(offerStep({ ...base, offerStatus: 'open', hadPlaybook: false, hasPlaybook: true }), 'reoffer');
  assert.equal(offerStep({ ...base, offerStatus: 'open', hadPlaybook: false, hasPlaybook: true, reofferedAt: new Date() }), 'none');
  assert.equal(offerStep({ ...base, offerStatus: 'open', hadPlaybook: true, hasPlaybook: true }), 'none', 'offered with a playbook: no re-offer');
  assert.equal(offerStep({ ...base, offerStatus: 'kept', hadPlaybook: false, hasPlaybook: true }), 'none', 'Keep never re-offers');
  assert.equal(offerStep({ ...base, offerStatus: 'switched', hadPlaybook: false, hasPlaybook: true }), 'none');
  assert.equal(offerStep({ ...base, mode: 'independent' }), 'none', 'an independent group is never offered');
  assert.equal(offerStep({ ...base, mode: 'independent', offerStatus: 'open' }), 'close_switched');
});

test('offerText: English checklist for the dashboard, Ukrainian alert, the shadow note', () => {
  const t = offerText({ groupName: 'Space', handle: 'nova' }, {
    playbook: 'pending', orchestratorMode: 'approve', paused: true,
    strategies: [{ type: 'recipe-carousel', extId: 'rc1', platform: 'instagram' }], autoDuplicateSource: 'facebook',
  }, false);
  assert.match(t.title, /^🕸 Network "Space": switch to independent resources\?$/);
  assert.match(t.body, /Playbook: a draft waits for your approval/);
  assert.match(t.body, /Orchestrator mode: approve \(paused\)/);
  assert.match(t.body, /recipe-carousel \(rc1, instagram\) — they publish on their own/);
  assert.match(t.body, /Auto-duplicate source: Facebook/);
  assert.ok(t.body.endsWith(SWITCH_NOTE));
  assert.doesNotMatch(`${t.title}\n${t.body}`, /[Ѐ-ӿ]|mirror/i);
  assert.match(t.alert.title, /Мережа «Space»/);
  const r = offerText({ groupName: 'Space', handle: 'nova' }, { playbook: 'active', orchestratorMode: 'live', paused: false, strategies: [], autoDuplicateSource: 'telegram' }, true);
  assert.match(r.title, /has its first playbook/);
  assert.match(r.body, /Strategies on members: none/);
});

test('set_network_mode (@ai0): proposes an Apply card for the orchestrator; errors for unknown, non-network and same-mode', async () => {
  const proposed: any[] = [];
  const orch = { id: 'o1', handle: 'nova', kind: 'orchestrator', parentId: null };
  const child = { id: 'c1', handle: 'nova_planner', kind: 'planner', parentId: 'o1' };
  let group: any = { id: 'g1', name: 'Space', mode: 'legacy_duplicate' };
  const [tool] = buildNetworkModeTool({
    agents: { getByHandle: async (h: string) => (h === 'nova' ? orch : h === 'nova_planner' ? child : null), get: async () => orch } as any,
    actions: { propose: async (a: any) => { proposed.push(a); return { id: 'pa1', ...a }; } } as any,
    groupOf: async () => group,
  });
  const ctx = (intent = true) => ({ extras: { chat: { chatId: 'ch1', channelKey: null }, agentIntent: intent, ownerText: 'switch' } }) as any;
  assert.equal(tool.name, 'set_network_mode');
  const r: any = await tool.execute({ handle: '@nova_planner', mode: 'independent' }, ctx());
  assert.equal(r.ok, true);
  assert.equal(proposed[0].kind, 'set_network_mode');
  assert.deepEqual(proposed[0].payload, { handle: 'nova', mode: 'independent' });
  assert.equal(proposed[0].agentId, 'o1');
  assert.match(proposed[0].summary, /In shadow the agent records decisions as previews/);
  assert.equal(((await tool.execute({ handle: 'nova', mode: 'independent' }, ctx(false))) as any).error, 'needs_explicit_request');
  assert.equal(((await tool.execute({ handle: 'ghost', mode: 'independent' }, ctx())) as any).error, 'unknown_agent');
  assert.equal(((await tool.execute({ handle: 'nova', mode: 'legacy_duplicate' }, ctx())) as any).error, 'already_in_mode');
  group = null;
  assert.equal(((await tool.execute({ handle: 'nova', mode: 'independent' }, ctx())) as any).error, 'no_network');
  assert.equal(proposed.length, 1);
});
