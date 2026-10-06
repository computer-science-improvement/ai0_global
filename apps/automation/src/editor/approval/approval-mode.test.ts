/** Spec 031 T1: the approve mode, its ordering, the new-resource default and "agents never change a mode". */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_MODES, effectiveMode, minMode, type ChannelMode } from '../card';
import { toToolSpec, type EditorTool } from '../harness/tool';
import { buildBuilderTools } from '../agents/builder-tools';
import { buildAgentChatTools } from '../agents/agent-chat-tools';
import { buildAgentSkillTools } from '../agents/agent-skill-tools';
import { buildDirectiveTools } from '../manager/directive-tools';
import { buildNetworkTools } from '../network/network-tools';
import { buildPlatformTools } from '../platform/platform-tools';
import { buildRoleTools } from '../tools/role-tools';
import { buildReadTools } from '../tools/read-tools';
import { buildComposeTools } from '../tools/compose-tools';
import { buildComposerTools } from '../chat/composer-tools';
import { CARD_DEFAULTS, mergeCard } from '../api/card-input';
import { NEW_RESOURCE_MODE } from '../agents/agent-creator';
import { AgentCreator } from '../agents/agent-creator';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { makeCard } from '../post/testing/fixtures';
import type { EditorSlot } from '../repo/editor-plans.repository';
import { buildEditorMcpTools, type EditorApi } from '../mcp/editor-mcp-tools';

const makeSlot = (o: Partial<EditorSlot> = {}): EditorSlot => ({
  id: 's1', planId: 'p1', channelKey: '@chan', scheduledAt: new Date('2030-03-04T10:00:00Z'), kind: 'content', format: 'photo',
  topic: 'Туманність', angle: null, sourceHints: [], isExperiment: false, status: 'running', attempts: 1, runId: null,
  publishedPostId: null, postSpec: null, renderedPreview: null, error: null, ...o,
});

test('mode ladder: off < shadow < approve < live; the effective mode is the lower one', () => {
  assert.deepEqual([...CHANNEL_MODES], ['off', 'shadow', 'approve', 'live']);
  const cases: Array<[ChannelMode, ChannelMode, ChannelMode]> = [
    ['live', 'live', 'live'],
    ['live', 'approve', 'approve'],
    ['approve', 'live', 'approve'],
    ['approve', 'approve', 'approve'],
    ['shadow', 'approve', 'shadow'],
    ['approve', 'shadow', 'shadow'],
    ['off', 'live', 'off'],
    ['live', 'off', 'off'],
  ];
  for (const [a, b, want] of cases) {
    assert.equal(minMode(a, b), want, `${a} ∧ ${b}`);
    assert.equal(effectiveMode(a, b), want, `orchestrator ${a}, card ${b}`);
  }
  assert.equal(effectiveMode(null, 'approve'), 'approve', 'no orchestrator: the card decides');
  assert.equal(effectiveMode(undefined, 'live'), 'live');
  assert.equal(minMode('bogus' as any, 'live'), 'off', 'an unknown value counts as off');
});

test('a new resource starts in approve: API card defaults, the creator constant', () => {
  assert.equal(NEW_RESOURCE_MODE, 'approve');
  assert.equal(CARD_DEFAULTS.mode, 'approve');
  const created = mergeCard('@fresh', null, { brief: 'Новий канал' });
  assert.ok(created.ok);
  assert.equal(created.ok && created.card.mode, 'approve', 'a card created without a mode waits for approval');
  const existing = mergeCard('@old', makeCard({ channelKey: '@old', mode: 'live' }), { brief: 'інший бриф' });
  assert.equal(existing.ok && existing.card.mode, 'live', 'an existing card keeps its mode');
  const picked = mergeCard('@new', null, { mode: 'approve' });
  assert.equal(picked.ok && picked.card.mode, 'approve', 'approve is a valid card mode');
});

test('agent-creator: the orchestrator and its card start in approve, without a shadow period', async () => {
  const inserted: any[] = [];
  const cards: any[] = [];
  const creator = new AgentCreator({
    agents: {
      findTop: async () => null, handleTaken: async () => false,
      insert: async (a: any) => { inserted.push(a); return { ...a, id: 'a1', parentId: null } as any; },
    },
    registry: { ensureChildren: async () => 4 } as any,
    catalog: { list: async () => [{ ref: 'telegram:@new_res', platform: 'telegram', agent: null, groupId: null }] as any },
    profiles: { setProfile: async () => {} } as any,
    channels: { get: async () => null, insertIfMissing: async (c: any) => { cards.push(c); return true; } },
  });
  const r = await creator.create({
    resource_ref: 'telegram:@new_res', name: 'Нова', handle: 'nova_res',
    profile: { topic: 'Космос', audience: { who: 'новачки' }, goals: ['growth'] },
  });
  assert.ok(!('error' in r), JSON.stringify(r));
  assert.equal(inserted[0].mode, 'approve');
  assert.equal(inserted[0].shadowUntil, null);
  assert.equal(cards[0].mode, 'approve');
});

/** Every enum under a property named `mode` in a tool's JSON schema. */
function modeEnums(schema: unknown, out: string[][] = []): string[][] {
  if (!schema || typeof schema !== 'object') return out;
  const s = schema as Record<string, any>;
  if (s.properties && typeof s.properties === 'object') {
    for (const [k, v] of Object.entries<any>(s.properties)) {
      if (k === 'mode') {
        const vals = [v?.enum, ...(v?.anyOf ?? []).map((x: any) => x?.enum)].filter(Array.isArray).flat();
        out.push(vals.map(String));
      }
      modeEnums(v, out);
    }
  }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties']) {
    const v = s[key];
    if (Array.isArray(v)) v.forEach((x) => modeEnums(x, out));
    else if (v && typeof v === 'object') modeEnums(v, out);
  }
  return out;
}

test('agents and MANAGER can never change a mode: no agent tool accepts a working mode', () => {
  const any = {} as any;
  const tools: EditorTool[] = [
    ...buildBuilderTools({ agents: any, catalog: any, profiles: any, creator: any, skills: any, actions: any }),
    ...buildAgentChatTools({ pool: any, memory: any, skills: any, actions: any }),
    ...buildAgentSkillTools({ agents: any, skills: any, kpi: any, inbox: any }),
    ...buildDirectiveTools({ repo: any, agents: any, inbox: any, memory: any, actions: any, digest: any, channelKeyOf: async () => null }),
    ...buildNetworkTools({ repo: any, plans: any, memory: any, inbox: any }),
    ...buildPlatformTools({ pool: any, publish: any, plans: any }),
    ...buildRoleTools({ pool: any, plans: any, memory: any, channels: any, publisher: any, recordPublish: () => {} }),
    ...buildReadTools({ pool: any, readonly: any, skills: any }),
    ...buildComposeTools(),
    ...buildComposerTools({ drafts: any, repo: any }),
  ];
  assert.ok(tools.length > 30, 'the sweep covers the agent tool sets');
  for (const t of tools) {
    for (const vals of modeEnums(toToolSpec(t).parameters)) {
      const working = vals.filter((v) => (CHANNEL_MODES as readonly string[]).includes(v) && v !== 'off');
      assert.deepEqual(working, [], `${t.name} exposes a mode switch: ${vals.join('/')}`);
    }
  }
  // The @ai0 builder's update_agent rejects a mode outright (strict patch), so no card can carry one.
  const update = tools.find((t) => t.name === 'update_agent')!;
  assert.equal(update.input.safeParse({ handle: 'kira', patch: { mode: 'live' } }).success, false);
  assert.equal(update.input.safeParse({ handle: 'kira', patch: { mode: 'approve' } }).success, false);
  assert.equal(update.input.safeParse({ handle: 'kira', patch: { name: 'Кіра' } }).success, true);
});

test('runner: an orchestrator in approve lowers a live card to approve for the executor tools', async () => {
  const seen: any[] = [];
  const runner = new EditorRunnerService({
    loop: { run: async (i: any) => { seen.push(i); return { runId: 'r1', status: 'ok', terminalTool: 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0 } } as any; } },
    registry: { forRole: () => [] },
    skills: { get: () => null, list: () => [] } as any,
    runtime: { forChannel: async () => ({ agent: null, orchestrator: { id: 'o', handle: 'kira', mode: 'approve' } as any, skills: { get: () => null, list: () => [] } as any, paused: false }) },
    plans: { reservedSlots: async () => [], getSlot: async () => ({ ...makeSlot(), status: 'awaiting_approval' }), updateSlot: async () => {} },
    memory: { listActive: async () => [] },
    env: () => undefined,
    notify: async () => {},
  });
  await runner.runExecutor(makeSlot(), makeCard({ mode: 'live' }));
  assert.equal(seen[0].extras.card.mode, 'approve');
  assert.match(seen[0].user, /Режим апруву/);

  await runner.runExecutor({ ...makeSlot(), resourceRef: 'instagram:ig1' }, makeCard({ mode: 'live' }));
  assert.equal(seen[1].extras.platformSlot.mode, 'approve', 'platform slots too');
});

test('T5: the owner\'s approve ⇄ live switch is reachable from no agent or MCP tool', async () => {
  const any = {} as any;
  const agentTools: EditorTool[] = [
    ...buildBuilderTools({ agents: any, catalog: any, profiles: any, creator: any, skills: any, actions: any }),
    ...buildAgentChatTools({ pool: any, memory: any, skills: any, actions: any }),
    ...buildAgentSkillTools({ agents: any, skills: any, kpi: any, inbox: any }),
    ...buildDirectiveTools({ repo: any, agents: any, inbox: any, memory: any, actions: any, digest: any, channelKeyOf: async () => null }),
    ...buildNetworkTools({ repo: any, plans: any, memory: any, inbox: any }),
    ...buildPlatformTools({ pool: any, publish: any, plans: any }),
    ...buildRoleTools({ pool: any, plans: any, memory: any, channels: any, publisher: any, recordPublish: () => {} }),
  ];
  for (const t of agentTools) {
    assert.ok(!/autonomy|set_mode|switch_mode/i.test(t.name), `${t.name} looks like a mode switch`);
    const params = JSON.stringify(toToolSpec(t).parameters);
    assert.ok(!/approve_waiting/.test(params), `${t.name} carries the switch dialog's choice`);
  }

  // The MCP surface (the owner's operator tools): set_mode lowers only; live and approve never reach the API.
  const calls: string[] = [];
  const api: EditorApi = {
    get: async (path) => { calls.push(`GET ${path}`); return path === '/api/editor/tools' ? [] : { channelKey: '@x', mode: 'approve' }; },
    post: async (path, body) => { calls.push(`POST ${path} ${JSON.stringify(body ?? null)}`); return {}; },
    put: async (path, body) => { calls.push(`PUT ${path} ${JSON.stringify(body ?? null)}`); return {}; },
  };
  const mcp = await buildEditorMcpTools(api);
  const setMode = mcp.find((t) => t.name === 'set_mode')!;
  for (const mode of ['live', 'approve']) await assert.rejects(setMode.call({ channel: '@x', mode }), /human-only/);
  assert.ok(!mcp.some((t) => /autonomy/i.test(t.name)), 'no MCP tool for the switch');
  assert.ok(!calls.some((c) => /approvals\/autonomy|"mode":"(live|approve)"/.test(c)), calls.join('\n'));
});
