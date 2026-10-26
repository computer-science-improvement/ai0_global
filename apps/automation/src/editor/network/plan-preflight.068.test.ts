// Spec 068 FR-007: submit_network_plan runs the cheap pre-flight checks on the validated slots; a refused slot comes back as a
// plan_invalid line and nothing is stored. A derived (duplicate / adapt) slot is never judged. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNetworkTools, type NetworkToolDeps } from './network-tools';
import { PlaybookSchema } from './playbook';
import type { NetworkCtx } from './network-context';
import type { IdeaRow } from './network.repository';
import { makeCard } from '../post/testing/fixtures';

const TG = 'telegram:@space';
const IG = 'instagram:ig1';
const I1 = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-04T05:00:00Z');                 // Sunday 08:00 Kyiv
const card = makeCard({ channelKey: '@space', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60 });

const net: NetworkCtx = {
  orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: '@space', groupId: 'g1', groupName: 'Космос', mode: 'independent',
  resources: [{ ref: TG, platform: 'telegram' }, { ref: IG, platform: 'instagram', tz: 'Europe/Kyiv' }], telegramFormats: ['text', 'photo', 'longread'], playbookVersion: 1,
  playbook: PlaybookSchema.parse({
    platforms: [
      { resource_ref: TG, role: 'core', formats: { longread: 0.6, photo: 0.4 }, per_day: { min: 0, max: 3 } },
      { resource_ref: IG, role: 'discovery', formats: { ig_photo: 1 }, per_day: { min: 0, max: 2 } },
    ],
  }),
};
const idea = (sources: string[]): IdeaRow => ({
  id: I1, agentId: 'o1', title: 'Ідея з бібліотеки', angle: null, sources, variants: [{ resource_ref: TG, format: 'longread' }], why: null, evidence: null,
  origin: 'orchestrator', originRef: null, expiresAt: new Date(), status: 'accepted', revisions: 0, review: null, createdAt: new Date(), updatedAt: new Date(),
});

function tool(o: { sources: string[]; refuse?: (hints: string[]) => string | null }) {
  const created: any[][] = [];
  const asked: any[] = [];
  const d = {
    repo: { listIdeas: async () => [idea(o.sources)], decidedElsewhere: async () => new Map(), updateIdea: async () => {} },
    plans: { reservedSlots: async () => [], createNetworkPlan: async (...a: any[]) => { created.push(a); return 'plan-1'; } },
    memory: {}, inbox: {},
    preflight: {
      assessPlanned: async (slot: any) => {
        asked.push(slot);
        const reason = o.refuse?.(slot.sourceHints);
        return reason ? { code: 'preflight_no_material' as const, reason } : null;
      },
    },
    now: () => NOW,
  } as unknown as NetworkToolDeps;
  const submit = buildNetworkTools(d).find((t) => t.name === 'submit_network_plan')!;
  const ctx = { runId: 'run-1', role: 'planner' as const, channelKey: '@space', slotId: null, extras: { network: net, card, planDate: '2026-10-04' } };
  const plan = {
    rationale: 'Один пост із бібліотеки', slots: [{ resource_ref: TG, time: '10:00', format: 'longread', topic: 'Ідея з бібліотеки', idea_id: I1, source_hints: [], reason: 'Ядро мережі: лонгріди' }],
    skips: [{ idea_id: I1, resource_ref: IG, reason: 'Профіль IG — візуал, тут лише текст', reason_code: 'format_unfit' }],
  };
  return { submit, ctx, plan, created, asked };
}

test('a refused slot is a plan_invalid line with its resource and time; nothing is stored', async () => {
  const t = tool({ sources: ['data://prompts/7'], refuse: (h) => (h.includes('data://prompts/7') ? 'рядок data://prompts/7 без prompt_text' : null) });
  const r: any = await t.submit.execute(t.plan as any, t.ctx as any);
  assert.equal(r.error, 'plan_invalid');
  assert.deepEqual(r.details, ['слот 1 (telegram:@space 10:00): рядок data://prompts/7 без prompt_text — заміни джерело/рядок або постав skipped_series з cause no_material / short_day']);
  assert.equal(t.created.length, 0);
  // The anchor channel's slot is judged as the channel itself; the idea's sources are part of its hints.
  assert.deepEqual([t.asked[0].channelKey, t.asked[0].resourceRef ?? null, t.asked[0].format, t.asked[0].sourceHints, t.asked[0].ideaId], ['@space', null, 'longread', ['data://prompts/7'], I1]);
});

test('a slot that passes is stored as before, with the empty-day records', async () => {
  const t = tool({ sources: ['https://news.example/a'], refuse: () => null });
  const r: any = await t.submit.execute(t.plan as any, t.ctx as any);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(t.created.length, 1);
  assert.deepEqual(t.created[0].at(-1), [], 'no empty day here');
});
