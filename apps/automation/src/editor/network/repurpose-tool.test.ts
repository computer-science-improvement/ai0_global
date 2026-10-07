/**
 * Spec 024 T4 (FR-008): repurpose_post — every error code, the daily cap,
 * the executor's own slot ("after this is published"), shadow → shadow and
 * the chat's Apply card. A fake pool answers the service's queries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepurposeTools, REPURPOSE_CALLS_PER_DAY, RepurposeInput, RepurposeService } from './repurpose-tool';
import { PlaybookSchema } from './playbook';
import type { NetworkCtx } from './network-context';
import { isPlaceholderPlan, REPURPOSE_RATIONALE, RESERVED_ONLY_RATIONALE } from '../repo/editor-plans.repository';

const NOW = new Date('2026-10-05T09:00:00Z'); // 12:00 Kyiv, 05:00 New York
const SLOT = '20000000-0000-4000-8000-000000000001';
const IDEA = '30000000-0000-4000-8000-000000000001';
const card = { channelKey: '@space', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8 };
const net = (o: Partial<NetworkCtx> = {}): NetworkCtx => ({
  orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: '@space', groupId: 'g1', groupName: 'Космос', mode: 'independent',
  resources: [
    { ref: 'telegram:@space', platform: 'telegram', tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 } },
    { ref: 'instagram:ig1', platform: 'instagram', tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 } },
    { ref: 'threads:ny', platform: 'threads', tz: 'America/New_York', quiet: { start: 0, end: 6 } },
    { ref: 'tiktok:tt', platform: 'tiktok', tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 } },
  ],
  playbook: PlaybookSchema.parse({ platforms: [
    { resource_ref: 'telegram:@space', role: 'core', formats: { photo: 1 }, per_day: { min: 0, max: 3 } },
    { resource_ref: 'instagram:ig1', role: 'discovery', formats: { ig_carousel: 0.6, ig_photo: 0.4 }, per_day: { min: 0, max: 2 } },
    { resource_ref: 'threads:ny', role: 'discovery', formats: { th_text: 1 }, per_day: { min: 0, max: 2 } },
  ] }),
  playbookVersion: 1, telegramFormats: ['photo', 'text'], ...o,
});

interface World {
  calls?: number;
  slot?: Record<string, unknown> | null;
  pp?: Record<string, unknown> | null;
  tg?: Record<string, unknown> | null;
  decided?: string[];
  day?: Record<string, number>;
  race?: boolean;
}
function setup(w: World = {}) {
  const writes: any[] = [];
  const pool = {
    query: async (sql: string, p: any[] = []) => {
      if (/COUNT\(DISTINCT call_id\)/.test(sql)) return { rows: [{ n: w.calls ?? 0 }] };
      if (/FROM editor_slots s JOIN editor_plans p/.test(sql)) return { rows: w.slot ? [w.slot] : [] };
      if (/FROM platform_posts WHERE id/.test(sql)) return { rows: w.pp ? [w.pp] : [] };
      if (/FROM published_posts WHERE id/.test(sql)) return { rows: w.tg ? [w.tg] : [] };
      if (/SELECT idea_id FROM editor_slots/.test(sql)) return { rows: [{ idea_id: null }] };
      if (/FROM content_decisions WHERE/.test(sql)) return { rows: (w.decided ?? []).includes(p[1]) ? [{ '?column?': 1 }] : [] };
      if (/COUNT\(\*\)::int AS n FROM editor_slots/.test(sql)) return { rows: [{ n: w.day?.[p[1]] ?? 0 }] };
      throw new Error(`unexpected SQL ${sql}`);
    },
  };
  const plans = {
    createRepurpose: async (i: any) => {
      writes.push(i);
      return w.race ? null : i.targets.map((t: any, k: number) => ({ id: `new-${k}`, resourceRef: t.resourceRef, scheduledAt: t.scheduledAt }));
    },
  };
  return { svc: new RepurposeService({ pool: pool as any, plans, now: () => NOW }), writes };
}
const slotRow = (o: Record<string, unknown> = {}) => ({
  id: SLOT, channel_key: '@space', resource_ref: null, status: 'published', treatment: 'unique', format: 'photo', post_spec: { format: 'photo' },
  scheduled_at: new Date('2026-10-05T07:00:00Z'), updated_at: new Date('2026-10-05T07:01:00Z'), idea_id: IDEA, topic: 'Туманність Кільце',
  plan_date: '2026-10-05', plan_status: 'active', ...o,
});
const R = 'Та сама аудиторія, фото пасує';
const target = (o: Record<string, unknown> = {}) => ({ resource_ref: 'instagram:ig1', treatment: 'duplicate' as const, reason: R, ...o });
const req = (targets: any[], source: Record<string, unknown> = { slot_id: SLOT }) => RepurposeInput.parse({ source, targets });
const err = (r: any) => (r && 'error' in r ? r.error : null);

test('input: exactly one source, at or delay_min (0–1440), 1–5 targets', () => {
  assert.equal(RepurposeInput.safeParse({ source: {}, targets: [target()] }).success, false);
  assert.equal(RepurposeInput.safeParse({ source: { slot_id: SLOT, platform_post_id: 1 }, targets: [target()] }).success, false);
  assert.equal(RepurposeInput.safeParse({ source: { slot_id: SLOT }, targets: [target({ at: '10:00', delay_min: 5 })] }).success, false);
  assert.equal(RepurposeInput.safeParse({ source: { slot_id: SLOT }, targets: [target({ delay_min: 1441 })] }).success, false);
  assert.equal(RepurposeInput.safeParse({ source: { slot_id: SLOT }, targets: [] }).success, false);
  assert.equal(RepurposeInput.safeParse({ source: { slot_id: SLOT }, targets: Array(6).fill(target()) }).success, false);
  assert.equal(RepurposeInput.safeParse({ source: { slot_id: SLOT }, targets: [target({ reason: 'коротко' })] }).success, false);
});

test('a published slot → a duplicate at gap 0 (as soon as possible) and an adapt at HH:MM in the target zone', async () => {
  const { svc, writes } = setup({ slot: slotRow() });
  const r: any = await svc.run(net(), card, req([target({ delay_min: 0 }), target({ resource_ref: 'threads:ny', treatment: 'adapt', at: '09:30', format_notes: 'коротко' })]), { decidedBy: 'orchestrator', runId: 'run-1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const w = writes[0];
  assert.deepEqual([w.channelKey, w.agentId, w.decidedBy, w.sourceKey, w.ideaId], ['@space', 'o1', 'orchestrator', `slot:${SLOT}`, IDEA]);
  assert.match(w.callId, /^[0-9a-f-]{36}$/);
  // The source went out at 07:01Z: delay 0 means "now" for a published source, never in the past.
  assert.equal(w.targets[0].scheduledAt.toISOString(), '2026-10-05T09:01:00.000Z');
  assert.equal(w.targets[0].format, 'ig_photo', 'the first playbook format a photo can carry (a carousel needs 2+ images)');
  assert.equal(w.targets[0].derivedFromSlotId, SLOT);
  assert.equal(w.targets[1].scheduledAt.toISOString(), '2026-10-05T13:30:00.000Z', '09:30 New York');
  assert.deepEqual([w.targets[1].format, w.targets[1].formatNotes, w.targets[1].planDate], ['th_text', 'коротко', '2026-10-05']);
  assert.deepEqual(r.decisions.map((d: any) => d.decision), ['duplicate', 'adapt']);
});

test('the executor duplicates its own running slot: the derived post goes out after it (delay from the slot time)', async () => {
  const { svc, writes } = setup({ slot: slotRow({ status: 'running', scheduled_at: new Date('2026-10-05T10:00:00Z') }) });
  const r: any = await svc.run(net(), card, req([target({ delay_min: 30 })]), { decidedBy: 'executor', ownSlotId: SLOT });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(writes[0].targets[0].scheduledAt.toISOString(), '2026-10-05T10:30:00.000Z');
  assert.equal(err(await setup({ slot: slotRow() }).svc.run(net(), card, req([target()]), { decidedBy: 'executor', ownSlotId: 'other' })), 'not_own_slot');
});

test('source errors: no network, not found, not in the network, not eligible', async () => {
  assert.equal(err(await setup({ slot: slotRow() }).svc.run(net({ mode: 'single', groupId: null }), card, req([target()]), { decidedBy: 'orchestrator' })), 'no_network');
  assert.equal(err(await setup({ slot: null }).svc.run(net(), card, req([target()]), { decidedBy: 'orchestrator' })), 'source_not_found');
  assert.equal(err(await setup({ slot: slotRow({ channel_key: '@other' }) }).svc.run(net(), card, req([target()]), { decidedBy: 'orchestrator' })), 'source_not_in_network');
  const old = slotRow({ updated_at: new Date('2026-10-01T07:00:00Z') });
  assert.equal(err(await setup({ slot: old }).svc.run(net(), card, req([target()]), { decidedBy: 'orchestrator' })), 'source_not_eligible');
  assert.equal(err(await setup({ slot: slotRow({ treatment: 'duplicate' }) }).svc.run(net(), card, req([target()]), { decidedBy: 'orchestrator' })), 'source_not_eligible');
  assert.equal(err(await setup({ slot: slotRow({ status: 'planned', plan_date: '2026-10-06' }) }).svc.run(net(), card, req([target()]), { decidedBy: 'orchestrator' })), 'source_not_eligible');
  assert.equal(err(await setup({ slot: slotRow({ status: 'failed' }) }).svc.run(net(), card, req([target()]), { decidedBy: 'orchestrator' })), 'source_not_eligible');
  const pp = { id: 7, resource_ref: 'instagram:elsewhere', platform: 'instagram', format: 'ig_photo', status: 'published', posted_at: NOW, spec: { title: 'x' } };
  assert.equal(err(await setup({ pp }).svc.run(net(), card, req([target({ resource_ref: 'threads:ny' })], { platform_post_id: 7 }), { decidedBy: 'orchestrator' })), 'source_not_in_network');
  assert.equal(err(await setup({ pp: null }).svc.run(net(), card, req([target()], { platform_post_id: 7 }), { decidedBy: 'orchestrator' })), 'source_not_found');
  const tgOld = { id: 9, channel_id: '@space', format: 'photo', title: 'Старий', posted_at: new Date('2026-10-01T07:00:00Z') };
  assert.equal(err(await setup({ tg: tgOld }).svc.run(net(), card, req([target()], { published_post_id: 9 }), { decidedBy: 'orchestrator' })), 'source_not_eligible');
});

test('target errors: not in the network, same resource, twice, no playbook section, already decided, unsupported format', async () => {
  const run = async (t: any[], w: World = {}) => setup({ slot: slotRow(), ...w }).svc.run(net(), card, req(t), { decidedBy: 'orchestrator' });
  assert.equal(err(await run([target({ resource_ref: 'facebook:fb' })])), 'not_in_network');
  assert.equal(err(await run([target({ resource_ref: 'telegram:@space' })])), 'same_resource');
  assert.equal(err(await run([target(), target()])), 'duplicate_target');
  assert.equal(err(await run([target({ resource_ref: 'tiktok:tt' })])), 'no_playbook_section');
  assert.equal(err(await run([target()], { decided: ['instagram:ig1'] })), 'already_decided');
  assert.equal(err(await run([target({ format: 'ig_carousel' })])), 'unsupported_format');
  assert.equal(err(await run([target({ format: 'ig_reel' })])), 'unsupported_format');
  // A Threads text source cannot be duplicated to Instagram at all (no image to carry).
  const pp = { id: 7, resource_ref: 'threads:ny', platform: 'threads', format: 'th_text', status: 'published', posted_at: NOW, spec: { title: 'x' } };
  const r: any = await setup({ pp }).svc.run(net(), card, req([target()], { platform_post_id: 7 }), { decidedBy: 'orchestrator' });
  assert.equal(r.error, 'unsupported_format');
  assert.match(r.details[0].details, /nothing on instagram can carry th_text/);
  // …and the race: the decision appeared between the check and the write.
  assert.equal(err(await setup({ slot: slotRow(), race: true }).svc.run(net(), card, req([target()]), { decidedBy: 'orchestrator' })), 'already_decided');
});

test('time errors: DST gap, passed, before the source, quiet hours in the target zone; caps: per_day and the daily call limit', async () => {
  const run = async (t: any[], w: World = {}, n = net(), by: any = { decidedBy: 'orchestrator' }) => setup({ slot: slotRow(), ...w }).svc.run(n, card, req(t), by);
  // 2026-03-08 02:30 does not exist in New York.
  const dst = setup({ slot: slotRow({ updated_at: new Date('2026-03-08T05:00:00Z') }) });
  (dst.svc as any).d.now = () => new Date('2026-03-08T06:00:00Z');
  assert.equal(err(await dst.svc.run(net(), card, req([target({ resource_ref: 'threads:ny', at: '02:30' })]), { decidedBy: 'orchestrator' })), 'invalid_time');
  assert.equal(err(await run([target({ at: '08:30' })])), 'time_passed');
  const planned = slotRow({ status: 'planned', scheduled_at: new Date('2026-10-05T15:00:00Z') });
  assert.equal(err(await run([target({ at: '13:00' })], { slot: planned })), 'before_source');
  assert.equal(err(await run([target({ resource_ref: 'threads:ny', at: '00:30' })])), 'time_passed', '00:30 NY already passed today');
  assert.equal(err(await run([target({ resource_ref: 'threads:ny', delay_min: 1440 })])), 'quiet_hours', '+24 h = 03:01 NY, quiet 0→6 there');
  assert.equal(err(await run([target()], { day: { 'instagram:ig1': 2 } })), 'daily_cap');
  assert.equal(err(await run([target()], { calls: REPURPOSE_CALLS_PER_DAY })), 'daily_limit');
  // The owner's Apply is outside the agent's daily call limit.
  assert.notEqual(err(await run([target()], { calls: REPURPOSE_CALLS_PER_DAY }, net(), { decidedBy: 'owner' })), 'daily_limit');
});

test('a dry run validates without writing; a repurpose-only plan is a placeholder for the scheduler', async () => {
  const { svc, writes } = setup({ slot: slotRow() });
  const r: any = await svc.run(net(), card, req([target()]), { decidedBy: 'owner', dryRun: true });
  assert.equal(r.dry_run, true);
  assert.equal(writes.length, 0);
  assert.equal(isPlaceholderPlan(REPURPOSE_RATIONALE), true);
  assert.equal(isPlaceholderPlan(RESERVED_ONLY_RATIONALE), true);
  assert.equal(isPlaceholderPlan('Звичайний план дня'), false);
});

test('tools: repurpose_post for orchestrator / planner / executor; chat agents only propose an Apply card', async () => {
  const { svc, writes } = setup({ slot: slotRow() });
  const proposals: any[] = [];
  const [tool, propose] = buildRepurposeTools({
    service: svc,
    networkFor: async () => net(),
    chatNetwork: async () => ({ net: net(), card: card as any }),
    actions: { propose: async (a: any) => { proposals.push(a); return { id: 'act-1', ...a }; } },
  });
  assert.deepEqual(tool.roles, ['orchestrator', 'planner', 'executor']);
  assert.deepEqual(propose.roles, ['composer']);
  // The executor has no ctx.extras.network: the tool builds it from the orchestrator and the card.
  const r: any = await tool.execute(req([target()]), { runId: 'r', role: 'executor', channelKey: '@space', slotId: SLOT, extras: { card, orchestrator: { id: 'o1' } } } as any);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(writes[0].decidedBy, 'executor');
  const p: any = await propose.execute(req([target()]), {
    runId: 'r', role: 'composer', channelKey: null,
    extras: { agent: { id: 'a1', handle: 'kira' }, chat: { chatId: 'c1' }, agentIntent: true },
  } as any);
  assert.equal(p.pending_action, 'act-1');
  assert.equal(proposals[0].kind, 'repurpose');
  assert.equal(proposals[0].payload.handle, 'kira');
  assert.match(proposals[0].summary, /^Repurpose slot .* → instagram:ig1 \(duplicate\)$/);
  assert.equal(writes.length, 1, 'proposing writes nothing');
});
