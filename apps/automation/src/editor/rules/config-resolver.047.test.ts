/** Spec 047 FR-005: one resolver card per channel — a waiting playbook draft, junk rules, conflicts; the owner unticks items. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybookSchema, type Playbook } from '../network/playbook';
import { ConfigConflictsService, conflictKey } from './config-conflicts.service';
import { lintOwnerRule } from '../agents/rule-lint';

const TG = 'telegram:@loko';
const ORCH: any = { id: 'o1', handle: 'loko', kind: 'orchestrator', scope: 'resource', scopeId: TG, parentId: null };

const pb = (hashtags: boolean): Playbook => PlaybookSchema.parse({
  platforms: [{
    resource_ref: TG, role: 'core', formats: { text: 1 }, per_day: { min: 1, max: 3 },
    ...(hashtags ? { hashtag_policy: { vocab: ['#ai'], min: 3, max: 5 } } : {}),
  }],
});

function setup() {
  const state = {
    active: { version: 6, body: pb(true) } as { version: number; body: Playbook },
    pending: { id: 'pb7', version: 7, rationale: 'Fallback chain + grounding rule', createdAt: new Date('2026-10-12T00:00:00Z'), body: pb(true) } as any,
    rules: [
      { id: 3, kind: 'rule', text: 'Без хештегів', evidence: null, createdBy: 'owner', createdAt: new Date() },
      { id: 15, kind: 'rule', text: 'Ці правила завжди виконуються для всіх постів', evidence: null, createdBy: 'owner', createdAt: new Date() },
      { id: 21, kind: 'rule', text: 'Власник прибрав емодзі', evidence: { source: 'approval' }, createdBy: 'owner', createdAt: new Date() },
    ] as any[],
    decided: [] as string[],
    retired: [] as number[],
    patches: 0,
  };
  const svc = new ConfigConflictsService({
    memory: {
      listActive: async () => state.rules,
      retireByOwner: async (_k: string, id: number) => { state.retired.push(id); state.rules = state.rules.filter((r) => r.id !== id); return true; },
    } as any,
    network: {
      groupOfChannel: async () => null, groupResources: async () => [],
      activePlaybook: async () => state.active,
      pendingPlaybook: async () => state.pending,
      decidePlaybook: async (id: string) => { state.decided.push(id); state.active = { version: state.pending.version, body: state.pending.body }; const v = state.pending.version; state.pending = null; return { version: v }; },
      applyOwnerPatch: async (_id: string, patch: (p: Playbook) => Playbook | null) => {
        const next = patch(state.active.body);
        if (!next) return { noop: true, row: { version: state.active.version } };
        state.patches++;
        state.active = { version: state.active.version + 1, body: next };
        return { noop: false, row: { version: state.active.version } };
      },
    } as any,
    channels: { get: async () => ({ style: null, slang: false, pollsPerWeek: null, hashtags: [], hashtagMin: 0 }), setHashtagMin: async () => true } as any,
    profiles: { get: async () => null, patchFormat: async () => ({ ok: true }), setProfile: async () => {} } as any,
    ruleLint: (text) => lintOwnerRule(text),
  });
  return { svc, state };
}

test('the resolver lists the waiting playbook draft, the junk rule and the conflict, in the order Apply runs them', async () => {
  const { svc } = setup();
  const items = await svc.resolverFor(ORCH);
  assert.deepEqual(items.map((i) => i.kind), ['pending_playbook', 'junk_rule', 'conflict']);
  assert.match(items[0].detail, /^Playbook v7 waits for your approval since 2026-10-12: Fallback chain/);
  assert.equal(items[1].key, 'rule:15');
  assert.match(items[1].detail, /Retire rule #15 «Ці правила/);
  assert.equal(items[2].key, conflictKey({ code: 'hashtags_off_playbook', ref: TG }));
});

test('Apply: v7 goes live, the junk rule is retired, the conflict is fixed on the new live playbook', async () => {
  const { svc, state } = setup();
  const r = await svc.resolve(ORCH);
  assert.equal(r.playbook_approved, 7);
  assert.deepEqual(r.rules_retired, [15]);
  assert.deepEqual(r.applied, ['hashtags_off_playbook']);
  assert.equal(r.playbook_version, 8, 'the fix is a new version on top of v7');
  assert.deepEqual(r.remaining, []);
  assert.deepEqual(state.decided, ['pb7']);
});

test('unticked items stay as they are', async () => {
  const { svc, state } = setup();
  const r = await svc.resolve(ORCH, ['playbook:pb7', 'rule:15']);
  assert.equal(r.playbook_approved, null);
  assert.deepEqual(r.rules_retired, []);
  assert.deepEqual(r.applied, ['hashtags_off_playbook'], 'the conflict is fixed on the live v6');
  assert.equal(state.pending?.id, 'pb7');
  assert.ok(state.rules.some((x) => x.id === 15));

  const none = setup();
  const r2 = await none.svc.resolve(ORCH, [conflictKey({ code: 'hashtags_off_playbook', ref: TG })]);
  assert.deepEqual(r2.applied, []);
  assert.equal(none.state.patches, 0);
});
