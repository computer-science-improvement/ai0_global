/**
 * Spec 090 FR-007: the safe sections of an unanswered setup proposal are applied by code; the rest wait for the TTL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../agents/agent.types';
import { makeCard } from '../post/testing/fixtures';
import { SETUP_SECTIONS } from './setup-analysis';
import { sectionBaseline, type ApplyWriters, type ChannelState } from './setup-apply';
import { SETUP_OWNER_SECTIONS, SETUP_SAFE_SECTIONS } from './setup-silence';
import { ChannelSetupService } from './setup.service';
import type { ChannelSetupRepository, SetupProposal } from './setup.repository';
import { samplePosts, validSetup } from './testing/setup-fixtures';

const KEY = '@tips_ua';
const REF = `telegram:${KEY}`;
const NOW = new Date('2026-11-07T12:00:00Z');
const HOUR = 3_600_000;

const agent: Agent = {
  id: 'a-tips', kind: 'orchestrator', scope: 'resource', scopeId: REF, parentId: null, name: 'Tips', handle: 'tips', emoji: null,
  description: null, mode: 'approve', status: 'active', pausedUntil: null, model: null, reasoningEffort: null, schedule: {},
  dailyBudgetUsd: null, shadowUntil: null, createdBy: 'sync', createdAt: new Date(), updatedAt: new Date(),
} as Agent;
const state = (): ChannelState => ({ card: makeCard({ channelKey: KEY, brief: 'Старий бриф', formats: { text: 1, photo: 1 } }), agent, profile: null, locks: [], playbook: null, voice: null });

test('the safe list is closed: formatting and examples_voice, and every other section is left for the owner', () => {
  assert.deepEqual([...SETUP_SAFE_SECTIONS], ['formatting', 'examples_voice']);
  assert.deepEqual([...SETUP_OWNER_SECTIONS], ['brief_profile', 'format_mix', 'series_pillars', 'schedule']);
  for (const s of SETUP_SAFE_SECTIONS) assert.ok((SETUP_SECTIONS as readonly string[]).includes(s), `${s} is a real section`);
  assert.equal(SETUP_SAFE_SECTIONS.length + SETUP_OWNER_SECTIONS.length, SETUP_SECTIONS.length);
});

function rig(o: { updatedHoursAgo?: number; hours?: string; silence?: string; failFormatting?: boolean; status?: SetupProposal['status'] } = {}) {
  const proposal: SetupProposal = {
    id: '00000000-0000-4000-9000-000000000001', channelKey: KEY, resourceRef: REF, agentId: agent.id, status: o.status ?? 'ready', reason: null, retryAt: null,
    postIds: samplePosts().map((p) => p.id), metrics: null, sections: validSetup() as unknown as Record<string, unknown>,
    sectionStatus: Object.fromEntries(SETUP_SECTIONS.map((s) => [s, 'pending'])), baseline: sectionBaseline(state(), REF) as unknown as Record<string, unknown>,
    runId: null, costUsd: 0, createdBy: 'owner', createdAt: new Date(NOW.getTime() - 100 * HOUR),
    updatedAt: new Date(NOW.getTime() - (o.updatedHoursAgo ?? 80) * HOUR), appliedAt: null,
  };
  const repo = {
    get: async () => proposal,
    readyBefore: async () => (proposal.status === 'ready' ? [proposal] : []),
    update: async (_id: string, p: Record<string, unknown>) => { Object.assign(proposal, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))); return proposal; },
  };
  const calls: string[] = [];
  const writers: ApplyWriters = {
    upsertCard: async () => { calls.push('upsertCard'); },
    getCard: async () => makeCard({ channelKey: KEY }),
    ensureAgent: async () => agent,
    setProfile: async () => { calls.push('setProfile'); },
    patchFormat: async () => { calls.push('patchFormat'); return o.failFormatting ? { error: 'invalid_patch', details: 'length' } : { ok: true }; },
    onBrief: async () => { calls.push('onBrief'); },
    putPlaybook: async () => { calls.push('putPlaybook'); },
    putVoiceSkill: async () => { calls.push('putVoiceSkill'); },
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM tracked_posts WHERE id = ANY')) {
        return { rows: samplePosts().map((p) => ({ id: p.id, tg_message_id: p.msgId, text: p.text, has_media: p.hasMedia, media_type: p.mediaType, posted_at: p.postedAt, views: p.views, forwards: p.forwards, reactions_total: p.reactionsTotal, comments_count: p.comments })) };
      }
      return { rows: [] };
    },
  };
  const rows: any[] = [];
  const env = (k: string) => ({ SETUP_PROPOSAL_APPLY_HOURS: o.hours, OWNER_SILENCE: o.silence } as Record<string, string | undefined>)[k];
  const svc = new ChannelSetupService({
    pool: pool as any, repo: repo as unknown as ChannelSetupRepository, loop: { run: async () => { throw new Error('unused'); } },
    collect: async () => { throw new Error('unused'); }, model: async () => { throw new Error('unused'); },
    state: async () => state(), writers, env, decisions: { record: async (d: any) => { rows.push(d); return rows.length; } }, now: () => NOW,
  });
  return { svc, proposal, calls, rows };
}

test('a ready proposal older than 72 h gets only its safe sections applied; it becomes partially_applied with one decision row', async () => {
  const r = rig();
  assert.equal(await r.svc.applyOnSilence(), 1);
  assert.equal(r.proposal.status, 'partially_applied');
  assert.deepEqual(Object.entries(r.proposal.sectionStatus).filter(([, v]) => v === 'applied').map(([k]) => k).sort(), ['examples_voice', 'formatting']);
  for (const s of SETUP_OWNER_SECTIONS) assert.equal(r.proposal.sectionStatus[s], 'pending', `${s} waits for the TTL`);
  assert.ok(!r.calls.includes('setProfile') && !r.calls.includes('onBrief'), 'the brief is not touched');
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].gate, 'setup_proposal');
  assert.equal(r.rows[0].action, 'applied');
  assert.equal(r.rows[0].channelKey, KEY);
  assert.equal(r.rows[0].undo, null, 'setup-apply keeps no faithful copy of the previous values');
  assert.match(r.rows[0].summary, /formatting, examples_voice/);
  assert.match(r.rows[0].summary, /brief_profile, format_mix, series_pillars, schedule left for you/);
  // A second pass finds a partially_applied proposal, not a ready one: nothing more happens.
  assert.equal(await r.svc.applyOnSilence(), 0);
  assert.equal(r.rows.length, 1);
});

test('a younger proposal, SETUP_PROPOSAL_APPLY_HOURS=0 and OWNER_SILENCE=wait leave it ready', async () => {
  for (const r of [rig({ updatedHoursAgo: 71 }), rig({ hours: '0' }), rig({ silence: 'wait' })]) {
    assert.equal(await r.svc.applyOnSilence(), 0);
    assert.equal(r.proposal.status, 'ready');
    assert.equal(r.rows.length, 0);
    assert.equal(r.calls.length, 0);
  }
  const shorter = rig({ updatedHoursAgo: 13, hours: '12' });
  assert.equal(await shorter.svc.applyOnSilence(), 1, 'the setting is read live');
});

test('a section the owner changed since the analysis is not overwritten, and nothing is logged for it', async () => {
  const r = rig();
  r.proposal.baseline = { ...r.proposal.baseline, formatting: { changed: true }, examples_voice: { changed: true } };
  assert.equal(await r.svc.applyOnSilence(), 0);
  assert.equal(r.proposal.status, 'ready');
  assert.equal(r.calls.length, 0);
  assert.equal(r.rows.length, 0);
});

test('a failed apply is logged once as failed and not tried again', async () => {
  const r = rig({ failFormatting: true });
  assert.equal(await r.svc.applyOnSilence(), 0);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].action, 'failed');
  assert.match(r.proposal.reason ?? '', /^silence apply failed: formatting/);
  assert.equal(r.proposal.status, 'ready');
  assert.equal(await r.svc.applyOnSilence(), 0);
  assert.equal(r.rows.length, 1, 'no second row');
});
