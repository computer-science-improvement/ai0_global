// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 A3: every kind the backend writes has a "why it matters" and steps that lead somewhere real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  INBOX_KINDS, healthState, inboxActionMessage, isAlreadyDecided, isSettledCode, planNote, planSteps, stepKey,
  type NoteItem, type NoteStep,
} from './inbox-kinds';
import type { TreeNode } from './inbox-ref';
import { fullPathsFromRouteTree } from '../nav/routes';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const ROUTES = fullPathsFromRouteTree(readFileSync(`${SRC}routeTree.gen.ts`, 'utf8'));

const TREE: TreeNode[] = [{
  id: 'm1', handle: 'manager', kind: 'manager', scopeId: null, children: [
    { id: 'o1', handle: 'space', kind: 'orchestrator', scopeId: 'telegram:@space', children: [] },
    { id: 'o2', handle: 'recipes', kind: 'orchestrator', scopeId: 'telegram:@recipes', children: [] },
    { id: 'o3', handle: 'net_food', kind: 'orchestrator', scopeId: 'network:g1', children: [] },
  ],
}];

const PAUSE_ID = '0f6a2b6e-1111-4222-8333-444455556666';
const note = (over: Partial<NoteItem> & { kind: string }): NoteItem => ({
  id: 7, agentId: null, title: 'Title', body: null, refType: null, refId: null, severity: 'action', readAt: null, ...over,
});
const act = (key: string, type: 'resume' | 'keep' | 'pause' | 'mute', label: string) => ({ key, type, label });
const PAUSE_KEY = (series: string) => `pause:${JSON.stringify(['@space', `series:${series}`, series])}`;

/** One realistic note per kind: the ref formats the backend writes (research/inbox.md section 2). */
const FIXTURES: Record<string, Partial<NoteItem>> = {
  connection_broken: { refType: 'resource_day', refId: 'bot:b1|2026-10-28#ab12cd34', severity: 'critical', title: 'Bot b1 is broken' },
  resource_health: { refType: 'resource', refId: 'instagram:u1', severity: 'critical', title: '⚠️ instagram:u1: token_invalid', parts: ['state:token_invalid'], actions: [act('mute:instagram:u1', 'mute', 'Mute for 7 days')] },
  resource_health_daily: { refType: 'resource_day', refId: 'telegram:@space|2026-10-28#ab12cd34', severity: 'critical', title: '⚠️ telegram:@space: no_access (since 27 Oct, 1 d)', actions: [act('mute:telegram:@space', 'mute', 'Mute for 7 days')] },
  budget_blocked: { refType: 'llm_budget', refId: 'agent:space', severity: 'critical' },
  series_paused: { agentId: 'o1', refType: 'series_pause', refId: PAUSE_ID, actions: [act(`resume:${PAUSE_ID}`, 'resume', 'Resume'), act(`keep:${PAUSE_ID}`, 'keep', 'Keep paused')] },
  dark_day: { agentId: 'o1', refType: 'resource_day', refId: 'telegram:@space|2026-10-28#ab12cd34', actions: [act(PAUSE_KEY('Daily facts'), 'pause', 'Pause series')] },
  series_missed: { agentId: 'o1', refType: 'resource_day', refId: 'telegram:@space|2026-10-28#ab12cd34' },
  critic_reject_streak: { agentId: 'o1', refType: 'resource_day', refId: 'telegram:@space|2026-10-28#ab12cd34', actions: [act(PAUSE_KEY('Daily facts'), 'pause', 'Pause series')] },
  manager_escalation: { agentId: 'o1', refType: 'escalation', refId: 'escalation:space:dark_streak|2026-10-28#ab12cd34', title: 'Space cannot find material' },
  directive_structural: { refType: 'directive', refId: 'd1' },
  directive_contested: { refType: 'directive', refId: 'd1' },
  directive_ignored: { refType: 'directive', refId: 'd1' },
  directive_failed: { refType: 'directive', refId: 'd1' },
  playbook_pending: { agentId: 'o1', refType: 'playbook', refId: 'pb1' },
  network_independent_offer: { agentId: 'o3', refType: 'network_group', refId: 'g1' },
  shadow_ended: { refType: 'agent', refId: 'space' },
  landing_lead: { refType: 'landing_lead', refId: 'lead1' },
  ad_orders_stuck: { refType: 'ad_order', refId: 'ord1' },
  ad_order_unfulfilled: { refType: 'ad_order', refId: 'ord1' },
  sponsor_cutover: { agentId: 'o1', refType: 'agent', refId: 'space' },
  low_runway: { refType: 'dataset', refId: 'recipes_pool' },
  series_source_empty: { agentId: 'o1', refType: 'series', refId: 'space:Recipe: soups' },
  derived_post_failed: { refType: 'slot', refId: 'slot1' },
  critic_failed: { refType: 'slot', refId: 'slot1' },
  audit_report: { refType: 'audit', refId: 'aud1' },
  host_struck: { agentId: 'o1', refType: 'host', refId: '@space/example.com', title: 'example.com refuses us' },
  event_not_covered: { refType: 'story_event', refId: 'story1|2026-10-28T09:30:00.000Z', body: 'The event "Launch" was announced.\n• telegram:@space: announced 2 time(s)' },
  legacy_bindings_enabled: { refType: 'legacy_bindings_day', refId: '2026-10-28' },
  strategy_cutover_ready: { refType: 'channel', refId: '@space' },
  launch_graduated: { agentId: 'o1', refType: 'launch', refId: 'l1' },
  skill_self_edit: { agentId: 'o1', refType: 'skill', refId: 'sk1', severity: 'info' },
  skill_rolled_back: { agentId: 'o1', refType: 'skill', refId: 'sk1', severity: 'info' },
  skill_probe: { agentId: 'o1', refType: 'skill', refId: 'sk1', severity: 'info' },
  ready_for_autonomy: { agentId: 'o1', refType: 'channel', refId: '@space', severity: 'info' },
  approval_dedup: { refType: 'slot', refId: 'slot1', severity: 'info' },
  evergreen_fallback: { refType: 'editor_slot', refId: 'slot1', severity: 'info' },
  loadout_suggestions: { agentId: 'o1', refType: 'loadout', refId: '2026-W44', severity: 'info' },
  resource_paused: { refType: 'directive', refId: 'd1', severity: 'info' },
  resource_resumed: { agentId: 'o1', refType: 'resource', refId: 'telegram:@space', severity: 'info' },
  resource_health_ok: { refType: 'resource', refId: 'instagram:u1', severity: 'info' },
  directive_expired: { refType: 'directive', refId: 'd1', severity: 'info' },
  directive_auto_applied: { refType: 'directive', refId: 'd1', severity: 'info' },
  playbook_updated: { agentId: 'o1', refType: 'playbook', refId: 'pb1', severity: 'info' },
  network_mode: { refType: 'agent', refId: 'net_food', severity: 'info' },
  strategy_cutover: { refType: 'agent', refId: 'space', severity: 'info' },
  ad_order_placed: { refType: 'ad_order', refId: 'ord1', severity: 'info' },
  setup_expired: { refType: 'setup_proposals', refId: 'a1b2c3', severity: 'info' },
  source_failing: { refType: 'source', refId: '@space/src1', severity: 'info' },
};

/** The kinds of research/inbox.md section 2, plus critic_failed (the skeptic's correction). */
const BRIEF_KINDS = [
  'connection_broken', 'resource_health', 'resource_health_daily', 'budget_blocked',
  'series_paused', 'dark_day', 'series_missed', 'critic_reject_streak', 'manager_escalation',
  'directive_structural', 'directive_contested', 'directive_ignored', 'directive_failed', 'playbook_pending',
  'network_independent_offer', 'shadow_ended', 'landing_lead', 'ad_orders_stuck', 'ad_order_unfulfilled', 'sponsor_cutover',
  'low_runway', 'series_source_empty', 'derived_post_failed', 'audit_report', 'host_struck', 'event_not_covered',
  'legacy_bindings_enabled', 'strategy_cutover_ready', 'launch_graduated', 'critic_failed',
  'skill_self_edit', 'skill_rolled_back', 'skill_probe', 'ready_for_autonomy', 'approval_dedup', 'evergreen_fallback',
  'loadout_suggestions', 'resource_paused', 'resource_resumed', 'resource_health_ok', 'directive_expired', 'directive_auto_applied',
  'playbook_updated', 'network_mode', 'strategy_cutover', 'ad_order_placed', 'setup_expired', 'source_failing',
];

/** Cyrillic range, built from code points so this file stays free of it (lib/no-cyrillic-ui.test.ts). */
const CYRILLIC = new RegExp(`[${String.fromCharCode(0x400)}-${String.fromCharCode(0x4ff)}]`);

const plan = (kind: string, over: Partial<NoteItem> = {}, tree: readonly TreeNode[] | null = TREE) =>
  planNote(note({ kind, ...FIXTURES[kind], ...over }), { tree });
const labels = (p: ReturnType<typeof planNote>) => planSteps(p).map((s) => s.label);

test('the table covers every kind of the brief, and nothing else', () => {
  assert.deepEqual([...INBOX_KINDS].sort(), [...BRIEF_KINDS].sort());
  assert.deepEqual(Object.keys(FIXTURES).sort(), [...BRIEF_KINDS].sort());
});

test('every kind: one English sentence of why, a primary step, no Cyrillic, links that exist', () => {
  for (const kind of BRIEF_KINDS) {
    const p = plan(kind);
    assert.equal(p.known, true, kind);
    assert.ok(p.why.length > 20 && p.why.length < 220, `${kind}: why length ${p.why.length}`);
    assert.match(p.why, /[.]$/, `${kind}: why ends with a full stop`);
    assert.doesNotMatch(p.why, CYRILLIC, kind);
    assert.ok(p.primary, kind);
    const keys = planSteps(p).map(stepKey);
    assert.equal(new Set(keys).size, keys.length, `${kind}: steps are distinct`);
    for (const s of planSteps(p)) {
      assert.doesNotMatch(s.label, CYRILLIC, `${kind}: ${s.label}`);
      assert.ok(s.label.length > 0 && s.label.length <= 28, `${kind}: label "${s.label}"`);
    }
  }
});

test('every kind: the plan survives a bare note (no ref, no agent, no tree, no actions)', () => {
  for (const kind of BRIEF_KINDS) {
    const bare = planNote(note({ kind }), {});
    assert.equal(bare.known, true, kind);
    assert.ok(planSteps(bare).length >= 1, kind);
    const odd = planNote(note({ kind, refType: 'weird', refId: ':::|#' }), { tree: [] });
    assert.ok(planSteps(odd).length >= 1, kind);
  }
});

const LINKS = (p: ReturnType<typeof planNote>) => planSteps(p).filter((s): s is Extract<NoteStep, { type: 'link' }> => s.type === 'link');

// The search keys each target route's validateSearch reads (routes/*.tsx), and the values it accepts.
const agentTabs = (() => {
  const src = readFileSync(`${SRC}routes/app.agents_.$handle.tsx`, 'utf8');
  const m = /const TABS = \[([^\]]+)\] as const/.exec(src);
  return new Set([...(m?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((x) => x[1]));
})();
const SEARCH_KEYS: Record<string, string[]> = {
  '/app/agents/$handle': ['tab', 'directive'],
  '/app/connections': ['section', 'tab'],
  '/app/spend': ['tab'],
  '/app/landing': ['tab'],
  '/app/artifacts': ['type', 'open'],
  '/app/chat': ['q'],
};

test('every link of every kind points at a real route with the params it needs and a search the route accepts', () => {
  assert.ok(agentTabs.has('skills') && agentTabs.has('directives'), 'the agent TABS were parsed');
  const seen = new Set<string>();
  for (const kind of BRIEF_KINDS) {
    for (const s of LINKS(plan(kind))) {
      const { to, params = {}, search = {} } = s.link;
      seen.add(to);
      assert.ok(ROUTES.includes(to), `${kind}: ${to} is a route`);
      const need = [...to.matchAll(/\$([A-Za-z]+)/g)].map((m) => m[1]);
      assert.deepEqual(Object.keys(params).sort(), need.sort(), `${kind}: params of ${to}`);
      for (const v of Object.values(params)) assert.ok(v && !v.includes('/') || to.includes('$channel'), `${kind}: param value ${v}`);
      for (const k of Object.keys(search)) assert.ok((SEARCH_KEYS[to] ?? []).includes(k), `${kind}: ${to} accepts ?${k}`);
      if (to === '/app/agents/$handle' && search.tab) assert.ok(agentTabs.has(String(search.tab)), `${kind}: agent tab ${search.tab}`);
      if (to === '/app/connections' && search.section) assert.ok(['telegram', 'meta', 'tiktok'].includes(String(search.section)), kind);
      if (to === '/app/spend') assert.equal(search.tab, 'budgets');
      if (to === '/app/landing') assert.equal(search.tab, 'leads');
    }
  }
  // the pages the handoff names are all reached by some kind
  for (const to of ['/app/agents/$handle', '/app/connections', '/app/spend', '/app/landing', '/app/ads', '/app/data/$key', '/app/artifacts',
    '/app/chat', '/app/editor/$channel', '/app/editor/slot/$id', '/app/health', '/app/strategies']) assert.ok(seen.has(to), `${to} is linked`);
});

test('an unknown kind is "Got it" (mark read), with a page only when its refType names one', () => {
  const p = planNote(note({ kind: 'brand_new_kind', refType: 'banana', refId: 'x' }), { tree: TREE });
  assert.equal(p.known, false);
  assert.deepEqual(p.primary, { type: 'read', label: 'Got it' });
  assert.equal(p.secondary, null);
  assert.deepEqual(p.extra, []);
  assert.match(p.why, /mark it as done/i);
  const slot = planNote(note({ kind: 'brand_new_kind', refType: 'editor_slot', refId: 's9' }), { tree: TREE });
  assert.deepEqual(slot.primary, { type: 'read', label: 'Got it' });
  assert.deepEqual(slot.secondary, { type: 'link', label: 'Open slot', link: { to: '/app/editor/slot/$id', params: { id: 's9' } } });
  const run = planNote(note({ kind: 'x', refType: 'run', refId: 'r1' }), {});
  assert.deepEqual(run.secondary, { type: 'link', label: 'Open run', link: { to: '/app/editor/run/$id', params: { id: 'r1' } } });
  const dir = planNote(note({ kind: 'x', refType: 'directive', refId: 'd1' }), {});
  assert.equal(dir.secondary?.type, 'link');
});

test('health: Threads token_expiring refreshes, everything else is Reconnect (a link), MTProto is never verified', () => {
  const exp = planNote(note({ kind: 'resource_health', severity: 'action', refType: 'resource', refId: 'threads:acc1', parts: ['state:token_expiring'], actions: [act('mute:threads:acc1', 'mute', 'Mute for 7 days')] }), { tree: TREE });
  assert.deepEqual(exp.primary, { type: 'threads-refresh', label: 'Refresh token', accountId: 'acc1' });
  assert.deepEqual(exp.secondary, { type: 'action', label: 'Mute for 7 days', key: 'mute:threads:acc1', actionType: 'mute' });
  assert.equal(exp.extra[0].type, 'link');

  const inv = planNote(note({ kind: 'resource_health', severity: 'critical', refType: 'resource', refId: 'threads:acc1', parts: ['state:token_invalid'] }), { tree: TREE });
  assert.deepEqual(inv.primary, { type: 'link', label: 'Reconnect', link: { to: '/app/connections', search: { section: 'meta', tab: 'threads' } } });
  assert.equal(inv.secondary, null);

  const ig = plan('resource_health');
  assert.deepEqual(ig.primary, { type: 'link', label: 'Reconnect', link: { to: '/app/connections', search: { section: 'meta', tab: 'instagram' } } });
  assert.equal(ig.secondary?.type, 'action');

  const tg = plan('resource_health_daily');
  assert.deepEqual(tg.primary, { type: 'link', label: 'Reconnect', link: { to: '/app/connections', search: { section: 'telegram' } } });
  assert.equal(tg.handle, 'space');

  const tt = planNote(note({ kind: 'resource_health', refType: 'resource', refId: 'tiktok:t1', parts: ['state:no_access'] }), { tree: TREE });
  assert.deepEqual((tt.primary as any).link, { to: '/app/connections', search: { section: 'tiktok' } });

  // a token_expiring of a platform that cannot refresh is a reconnect too
  const igExp = planNote(note({ kind: 'resource_health', refType: 'resource', refId: 'instagram:u1', parts: ['state:token_expiring'] }), { tree: TREE });
  assert.equal(igExp.primary.type, 'link');

  const rl = planNote(note({ kind: 'resource_health', refType: 'resource', refId: 'instagram:u1', parts: ['state:rate_limited'] }), { tree: TREE });
  assert.deepEqual(rl.primary, { type: 'read', label: 'Got it' });

  for (const [ref, tab] of [['bot:b1', 'bots'], ['mtproto:s1', 'sessions'], ['telegraph:t1', 'telegraph']] as const) {
    const p = planNote(note({ kind: 'connection_broken', severity: 'critical', refType: 'resource_day', refId: `${ref}|2026-10-28#ab12cd34` }), { tree: TREE });
    assert.deepEqual(p.primary, { type: 'link', label: 'Open connections', link: { to: '/app/connections', search: { section: 'telegram', tab } } });
    assert.ok(planSteps(p).every((s) => s.type === 'link'), `${ref}: links only, no verify button`);
  }
});

test('healthState: the gate part, else the title', () => {
  assert.equal(healthState({ parts: ['state:token_invalid'], title: 'x' }), 'token_invalid');
  assert.equal(healthState({ parts: null, title: '⚠️ threads:0f9c: token_expiring (since 27 Oct, 2 d)' }), 'token_expiring');
  assert.equal(healthState({ parts: [], title: '⚠️ telegram:@space: no_access' }), 'no_access');
  assert.equal(healthState({ parts: null, title: 'Bot b1 is broken' }), null);
});

test('series_paused: the stored Resume / Keep paused, else Resume by the pause id, else a page', () => {
  const p = plan('series_paused');
  assert.deepEqual(p.primary, { type: 'action', label: 'Resume', key: `resume:${PAUSE_ID}`, actionType: 'resume' });
  assert.deepEqual(p.secondary, { type: 'action', label: 'Keep paused', key: `keep:${PAUSE_ID}`, actionType: 'keep' });
  assert.equal(p.extra[0].label, 'Open active effects');

  const old = planNote(note({ kind: 'series_paused', agentId: 'o1', refType: 'series_pause', refId: PAUSE_ID }), { tree: TREE });
  assert.deepEqual(old.primary, { type: 'resume-series', label: 'Resume', handle: 'space', pauseId: PAUSE_ID });
  assert.equal(old.secondary?.label, 'Open active effects');

  const lost = planNote(note({ kind: 'series_paused', refType: 'series_pause', refId: PAUSE_ID }), { tree: TREE });
  assert.deepEqual(lost.primary, { type: 'read', label: 'Got it' });
});

test('dark_day / series_missed: Replan tomorrow, then the pauses the note carries, then the channel', () => {
  const two = planNote(note({
    kind: 'dark_day', agentId: 'o1', refType: 'resource_day', refId: 'telegram:@space|2026-10-28#ab12cd34',
    actions: [act(PAUSE_KEY('Daily facts'), 'pause', 'Pause: Daily facts'), act(PAUSE_KEY('Recipes'), 'pause', 'Pause: Recipes')],
  }), { tree: TREE });
  assert.deepEqual(two.primary, { type: 'replan', label: 'Replan tomorrow', channel: '@space', date: 'tomorrow' });
  assert.equal(two.secondary?.label, 'Pause: Daily facts');
  assert.deepEqual(two.extra.map((s) => s.label), ['Pause: Recipes', 'Open channel']);

  const none = plan('series_missed');
  assert.equal(none.primary.type, 'replan');
  assert.deepEqual(labels(none), ['Replan tomorrow', 'Open channel']);

  // another platform: the channel comes from the agent's Telegram scope, and a network agent has none
  const ig = planNote(note({ kind: 'dark_day', agentId: 'o2', refType: 'resource_day', refId: 'instagram:u1|2026-10-28#ab' }), { tree: TREE });
  assert.deepEqual(ig.primary, { type: 'replan', label: 'Replan tomorrow', channel: '@recipes', date: 'tomorrow' });
  const net = planNote(note({ kind: 'dark_day', agentId: 'o3', refType: 'resource_day', refId: 'instagram:u1|2026-10-28#ab', actions: [act(PAUSE_KEY('Daily facts'), 'pause', 'Pause series')] }), { tree: TREE });
  assert.equal(net.primary.type, 'action');
  assert.equal(net.secondary?.label, 'Open agent');
});

test('critic_reject_streak: Open channel first, then the pause', () => {
  const p = plan('critic_reject_streak');
  assert.deepEqual(p.primary, { type: 'link', label: 'Open channel', link: { to: '/app/editor/$channel', params: { channel: '@space' } } });
  assert.equal(p.secondary?.type, 'action');
});

test('manager_escalation: Ask @manager prefills the chat', () => {
  const p = plan('manager_escalation');
  assert.equal(p.primary.type, 'link');
  const l = (p.primary as Extract<NoteStep, { type: 'link' }>).link;
  assert.equal(l.to, '/app/chat');
  assert.equal(l.search?.q, '@manager about the escalation from @space: Space cannot find material');
  assert.equal(p.secondary?.label, 'Open @space');
  const long = planNote(note({ kind: 'manager_escalation', title: 'x'.repeat(400) }), {});
  assert.ok(String((long.primary as any).link.search.q).length < 240);
  assert.ok(String((long.primary as any).link.search.q).startsWith('@manager '));
});

test('directives: decisions where the owner decides, a link where he only follows', () => {
  const st = plan('directive_structural');
  assert.deepEqual(st.primary, { type: 'directive', label: 'Approve', id: 'd1', decision: 'approve' });
  assert.deepEqual(st.secondary, { type: 'directive', label: 'Decline', id: 'd1', decision: 'decline' });
  assert.deepEqual((st.extra[0] as any).link, { to: '/app/agents/$handle', params: { handle: 'manager' }, search: { tab: 'directives', directive: 'd1' } });

  const co = plan('directive_contested');
  assert.deepEqual(co.primary, { type: 'contest', label: 'Accept refusal', id: 'd1', decision: 'accept-refusal' });
  assert.deepEqual(co.secondary, { type: 'contest', label: 'Uphold directive', id: 'd1', decision: 'uphold' });

  for (const kind of ['directive_ignored', 'directive_failed']) {
    const p = plan(kind);
    assert.equal(p.primary.label, 'Open directive', kind);
  }
  for (const kind of ['directive_expired', 'directive_auto_applied']) {
    const p = plan(kind);
    assert.equal(p.primary.type, 'read', kind);
    assert.equal(p.secondary?.label, 'Open directive', kind);
  }
  // no ref: the board itself
  const bare = planNote(note({ kind: 'directive_structural' }), {});
  assert.equal(bare.primary.label, 'Open directives');
});

test('playbook_pending: Approve / Reject, with the playbook one click away', () => {
  const p = plan('playbook_pending');
  assert.deepEqual(p.primary, { type: 'playbook', label: 'Approve', id: 'pb1', decision: 'approve' });
  assert.deepEqual(p.secondary, { type: 'playbook', label: 'Reject', id: 'pb1', decision: 'reject' });
  assert.deepEqual((p.extra[0] as any).link, { to: '/app/agents/$handle', params: { handle: 'space' }, search: { tab: 'playbook' } });
});

test('modes and offers: Go live, Choose mode, the offer buttons; each falls back to a page', () => {
  const live = plan('ready_for_autonomy');
  assert.deepEqual(live.primary, { type: 'autonomy', label: 'Go live', channel: '@space', handle: 'space' });
  assert.equal(live.secondary?.label, 'Open agent');
  const mode = plan('shadow_ended');
  assert.deepEqual(mode.primary, { type: 'mode', label: 'Choose mode', handle: 'space' });
  assert.deepEqual(plan('shadow_ended', { refId: null, refType: null }).primary, { type: 'read', label: 'Got it' });
  const offer = plan('network_independent_offer');
  assert.deepEqual(offer.primary, { type: 'network-offer', label: 'Choose', groupId: 'g1', handle: 'net_food' });
  const lonely = planNote(note({ kind: 'network_independent_offer', refType: 'network_group', refId: 'g1' }), { tree: TREE });
  assert.deepEqual(lonely.primary, { type: 'read', label: 'Got it' });
});

test('series_source_empty: the schedule of the agent, and a pause by the series name (which may hold a colon)', () => {
  const p = plan('series_source_empty');
  assert.deepEqual(p.primary, { type: 'link', label: 'Open schedule', link: { to: '/app/agents/$handle', params: { handle: 'space' }, search: { tab: 'schedule' } } });
  assert.deepEqual(p.secondary, { type: 'pause-series', label: 'Pause series', handle: 'space', key: 'series:Recipe: soups', seriesLabel: 'Recipe: soups' });
  // not the data page
  assert.ok(LINKS(p).every((s) => s.link.to !== '/app/data/$key'));
  // the owner part of the ref is a channel key, not a handle: the channel page, no pause
  const chan = planNote(note({ kind: 'series_source_empty', refType: 'series', refId: '@lone:Daily' }), { tree: TREE });
  assert.deepEqual(chan.primary, { type: 'link', label: 'Open channel', link: { to: '/app/editor/$channel', params: { channel: '@lone' } } });
  assert.equal(chan.secondary, null);
  // the tree not loaded: the ref's owner is trusted as the handle
  const early = planNote(note({ kind: 'series_source_empty', refType: 'series', refId: 'space:Daily' }), {});
  assert.equal(early.secondary?.type, 'pause-series');
});

test('slot kinds are keyed by kind: slot and editor_slot both open the slot', () => {
  for (const [kind, refType] of [['critic_failed', 'slot'], ['derived_post_failed', 'slot'], ['approval_dedup', 'slot'], ['evergreen_fallback', 'editor_slot']] as const) {
    const p = plan(kind, { refType });
    assert.deepEqual(p.primary, { type: 'link', label: 'Open slot', link: { to: '/app/editor/slot/$id', params: { id: 'slot1' } } }, kind);
  }
  assert.equal(plan('critic_failed').secondary, null);
  assert.equal(plan('approval_dedup').secondary?.type, 'read');
  // a gated ref's hash is not part of the slot id
  assert.deepEqual((plan('critic_failed', { refId: 'slot1#ab12cd34' }).primary as any).link.params, { id: 'slot1' });
});

test('skills, loadout and playbook updates open the agent tab; without a handle they are "Got it"', () => {
  for (const kind of ['skill_self_edit', 'skill_rolled_back', 'skill_probe']) {
    const p = plan(kind);
    assert.deepEqual((p.primary as any).link, { to: '/app/agents/$handle', params: { handle: 'space' }, search: { tab: 'skills' } }, kind);
    assert.equal(p.secondary?.type, 'read', kind);
    assert.deepEqual(planNote(note({ kind, refType: 'skill', refId: 'sk1' }), { tree: TREE }).primary, { type: 'read', label: 'Got it' }, kind);
  }
  assert.deepEqual((plan('loadout_suggestions').primary as any).link.search, { tab: 'loadout' });
});

test('event_not_covered: plan a recap on the channel the note names, else Got it', () => {
  const p = plan('event_not_covered');
  assert.deepEqual(p.primary, { type: 'replan', label: 'Plan a recap today', channel: '@space', date: 'today' });
  assert.deepEqual(p.secondary, { type: 'read', label: 'Skip recap' });
  const none = plan('event_not_covered', { body: '• instagram:u1: announced 1 time(s)' });
  assert.deepEqual(none.primary, { type: 'read', label: 'Got it' });
  assert.equal(none.secondary, null);
});

test('pages with one obvious target', () => {
  assert.deepEqual((plan('budget_blocked').primary as any).link, { to: '/app/spend', search: { tab: 'budgets' } });
  assert.equal(plan('budget_blocked').primary.label, 'Edit caps');
  assert.deepEqual((plan('landing_lead').primary as any).link, { to: '/app/landing', search: { tab: 'leads' } });
  for (const kind of ['ad_orders_stuck', 'ad_order_unfulfilled', 'sponsor_cutover']) assert.deepEqual((plan(kind).primary as any).link, { to: '/app/ads' }, kind);
  assert.deepEqual((plan('low_runway').primary as any).link, { to: '/app/data/$key', params: { key: 'recipes_pool' } });
  assert.deepEqual((plan('audit_report').primary as any).link, { to: '/app/artifacts', search: { type: 'audit', open: 'audit:aud1' } });
  assert.equal(plan('audit_report', { severity: 'info' }).secondary?.type, 'read');
  assert.equal(plan('audit_report', { severity: 'action' }).secondary, null);
  for (const kind of ['legacy_bindings_enabled', 'strategy_cutover_ready']) assert.deepEqual((plan(kind).primary as any).link, { to: '/app/strategies' }, kind);
  assert.equal(plan('host_struck').primary.label, 'Open network health');
});

test('info kinds lead with Got it unless the handoff names a page', () => {
  for (const kind of ['resource_health_ok', 'setup_expired']) assert.deepEqual(plan(kind).primary, { type: 'read', label: 'Got it' }, kind);
  for (const kind of ['network_mode', 'strategy_cutover', 'playbook_updated', 'ad_order_placed', 'source_failing', 'resource_paused', 'resource_resumed']) {
    assert.equal(plan(kind).primary.type, 'read', kind);
  }
  // resource_resumed on a resource: the agent's active effects; resource_paused by a directive: the directive
  assert.equal(plan('resource_resumed').secondary?.label, 'Open active effects');
  assert.equal(plan('resource_paused').secondary?.label, 'Open directive');
});

test('handle: from agentId, else from the ref', () => {
  assert.equal(plan('series_paused').handle, 'space');
  assert.equal(plan('shadow_ended').handle, 'space');
  assert.equal(plan('resource_health_daily').handle, 'space');
  assert.equal(plan('landing_lead').handle, null);
});

test('inboxActionMessage: an English message for every code of the server, errors flagged', () => {
  const codes = ['resumed', 'already_resumed', 'not_found', 'kept', 'paused', 'already_paused', 'muted', 'not_broken', 'unavailable'];
  for (const c of codes) {
    const m = inboxActionMessage(c);
    assert.ok(m.text.length > 5, c);
    assert.doesNotMatch(m.text, CYRILLIC, c);
  }
  assert.equal(inboxActionMessage('resumed').tone, 'success');
  assert.equal(inboxActionMessage('already_resumed').tone, 'info');
  assert.equal(inboxActionMessage('not_found').tone, 'error');
  assert.equal(inboxActionMessage('unavailable').tone, 'error');
  assert.equal(isSettledCode('muted'), true);
  assert.equal(isSettledCode('already_paused'), true);
  assert.equal(isSettledCode('not_found'), false);
  assert.equal(isSettledCode('unavailable'), false);
  assert.equal(inboxActionMessage('something_new').tone, 'info');
});

test('isAlreadyDecided: the 409s that mean somebody decided already', () => {
  for (const e of ['not_awaiting_owner', 'not_contested', 'not_pending']) assert.equal(isAlreadyDecided(e), true, e);
  for (const e of ['not_executable', 'directive_not_found', null, undefined]) assert.equal(isAlreadyDecided(e), false, String(e));
});
