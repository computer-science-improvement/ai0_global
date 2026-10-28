// Spec 078 A3 (handoff 5.2 + research/inbox.md): what an Inbox note means and what the owner can do about it, per `kind`.
// Pure (no React, no api imports): `planNote` turns a note into a short "why it matters" and a list of steps (a link or an
// operation), and `components/inbox/NoteActions.tsx` runs them. Keyed by `kind`, never by `refType` (`channel`, `agent` and
// `slot` are shared by several kinds).
//
// Rules the table follows:
//   - A kind with a decision (directive, playbook, series pause, health) leads with it; an info kind leads with "Got it"
//     unless the handoff names a page to open.
//   - A step that cannot run (no handle, no stored action, an old server without `actions`) drops out, and the next one
//     takes its place; with nothing left the primary is "Got it" (mark read). An unknown kind is "Got it".
//   - Tokens are refreshed only for a Threads `token_expiring`; any other broken connection is "Reconnect" (a link); an
//     MTProto session is never verified from a button (a second connection with its auth key can kill the session).
//   - Skill kinds link to the Skills tab: a rollback or an "adopt anyway" needs a version the note does not carry.

import {
  connectionLink, firstTelegramRef, nodeByScope, parseHostRef, parseRefId, parseResourceRef, parseSeriesRef, parseEscalationRef,
  replanChannel, resolveHandle, telegramChannelOf, type NoteLink, type ParsedRefId, type TreeNode,
} from './inbox-ref';

export type NoteActionType = 'resume' | 'keep' | 'pause' | 'mute';

/** The note as these functions read it (`InboxItem` from `api/agents.ts` fits; the last three fields need the A3 server). */
export interface NoteItem {
  id:        number;
  agentId:   string | null;
  kind:      string;
  title:     string;
  body:      string | null;
  refType:   string | null;
  refId:     string | null;
  severity:  'info' | 'action' | 'critical';
  readAt:    string | null;
  subject?:  string | null;
  parts?:    string[] | null;
  actions?:  ReadonlyArray<{ key: string; type: NoteActionType; label: string }>;
}

export type NoteStep =
  /** Opens a page. */
  | { type: 'link'; label: string; link: NoteLink }
  /** Marks the note read ("Got it"). */
  | { type: 'read'; label: string }
  /** A button stored on the note (`POST /api/agents/inbox/:id/actions {key}`): resume, keep, pause, mute. */
  | { type: 'action'; label: string; key: string; actionType: NoteActionType }
  /** Resume a series by its pause id (`POST /api/agents/:handle/series-pauses {action:'resume'}`): notes without stored actions. */
  | { type: 'resume-series'; label: string; handle: string; pauseId: string }
  /** Pause a series (`POST /api/agents/:handle/series-pauses {action:'pause'}`). */
  | { type: 'pause-series'; label: string; handle: string; key: string; seriesLabel: string }
  | { type: 'replan'; label: string; channel: string; date: 'today' | 'tomorrow' }
  | { type: 'threads-refresh'; label: string; accountId: string }
  | { type: 'directive'; label: string; id: string; decision: 'approve' | 'decline' }
  | { type: 'contest'; label: string; id: string; decision: 'uphold' | 'accept-refusal' }
  | { type: 'playbook'; label: string; id: string; decision: 'approve' | 'reject' }
  /** The "approve to live" dialog of a channel; `handle` is the agent whose mode it changes. */
  | { type: 'autonomy'; label: string; channel: string; handle: string | null }
  /** The agent's mode switch (off / shadow / approve / live). */
  | { type: 'mode'; label: string; handle: string }
  /** The independent-network offer's own buttons. */
  | { type: 'network-offer'; label: string; groupId: string; handle: string };

export interface NotePlan {
  kind:      string;
  /** False for a kind this table does not know (it falls back to "Got it"). */
  known:     boolean;
  /** One English sentence: why the owner should care. */
  why:       string;
  /** The agent the note belongs to (from `agentId` or the ref), or null. */
  handle:    string | null;
  primary:   NoteStep;
  secondary: NoteStep | null;
  /** Further steps (a second pause, "Open channel"), shown as quiet links. */
  extra:     NoteStep[];
}

export interface PlanContext {
  /** The agent tree (`useAgentTree().data?.agents`); missing = not loaded. */
  tree?: readonly TreeNode[] | null;
}

// ── step builders ──────────────────────────────────────────────────────────

type MaybeStep = NoteStep | null | undefined | false;
type Search = NonNullable<NoteLink['search']>;

const link = (label: string, to: string, o: { params?: Record<string, string>; search?: Search } = {}): NoteStep =>
  ({ type: 'link', label, link: { to, ...(o.params ? { params: o.params } : {}), ...(o.search ? { search: o.search } : {}) } });

const read = (label = 'Got it'): NoteStep => ({ type: 'read', label });

interface Ctx {
  it:      NoteItem;
  tree:    readonly TreeNode[] | null;
  handle:  string | null;
  ref:     ParsedRefId | null;
  actions: NonNullable<NoteItem['actions']>;
}

const agentLink = (c: Ctx, label: string, tab?: string): NoteStep | null =>
  c.handle ? link(label, '/app/agents/$handle', { params: { handle: c.handle }, ...(tab ? { search: { tab } } : {}) }) : null;

const channelLink = (label: string, channel: string | null): NoteStep | null =>
  channel ? link(label, '/app/editor/$channel', { params: { channel } }) : null;

const slotLink = (c: Ctx): NoteStep | null => c.ref ? link('Open slot', '/app/editor/slot/$id', { params: { id: c.ref.base } }) : null;

const storedAll = (c: Ctx, type: NoteActionType): NoteStep[] =>
  c.actions.filter((a) => a.type === type).map((a) => ({ type: 'action', label: a.label, key: a.key, actionType: type }));

const stored = (c: Ctx, type: NoteActionType): NoteStep | null => storedAll(c, type)[0] ?? null;

const directiveLink = (c: Ctx): NoteStep =>
  c.ref
    ? link('Open directive', '/app/agents/$handle', { params: { handle: 'manager' }, search: { tab: 'directives', directive: c.ref.base } })
    : link('Open directives', '/app/agents/$handle', { params: { handle: 'manager' }, search: { tab: 'directives' } });

/** A stable identity of a step (React keys, de-duplication). */
export function stepKey(s: NoteStep): string {
  switch (s.type) {
    case 'link':   return `link:${s.link.to}:${JSON.stringify(s.link.params ?? {})}:${JSON.stringify(s.link.search ?? {})}`;
    case 'action': return `action:${s.key}`;
    case 'read':   return 'read';
    default:       return `${s.type}:${s.label}`;
  }
}

/** The ordered steps with the unavailable ones dropped: the first is primary, the second secondary, the rest extra. */
function lay(steps: readonly MaybeStep[]): Pick<NotePlan, 'primary' | 'secondary' | 'extra'> {
  const seen = new Set<string>();
  const list: NoteStep[] = [];
  for (const s of steps) {
    if (!s) continue;
    const k = stepKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(s);
  }
  return { primary: list[0] ?? read(), secondary: list[1] ?? null, extra: list.slice(2) };
}

// ── health ─────────────────────────────────────────────────────────────────

/** The access state a health note is about (`token_invalid`, `no_access`, `token_expiring`, `rate_limited`…), from its gate parts or its title. */
export function healthState(it: Pick<NoteItem, 'parts' | 'title'>): string | null {
  const p = it.parts?.find((x) => x.startsWith('state:'));
  if (p) return p.slice('state:'.length) || null;
  const m = /:\s(token_invalid|no_access|token_expiring|rate_limited|unknown|ok)\b/.exec(it.title);
  return m ? m[1] : null;
}

const INFRA = new Set(['bot', 'mtproto', 'telegraph']);

function healthSteps(c: Ctx): MaybeStep[] {
  const r = parseResourceRef(c.ref?.base);
  const openConnections = link('Open connections', '/app/connections', { search: { section: 'telegram' } });
  if (!r) return [read(), openConnections];
  const state = healthState(c.it);
  const to = connectionLink(r.platform);
  const connect: NoteStep = { type: 'link', label: INFRA.has(r.platform) ? 'Open connections' : 'Reconnect', link: to };
  const mute = stored(c, 'mute');
  if (state === 'rate_limited') return [read(), connect];
  if (r.platform === 'threads' && state === 'token_expiring') return [{ type: 'threads-refresh', label: 'Refresh token', accountId: r.id }, mute, connect];
  return [connect, mute];
}

// ── the table ──────────────────────────────────────────────────────────────

interface Rule { why: string; steps: (c: Ctx) => MaybeStep[] }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const SLOT_STEPS = (c: Ctx): MaybeStep[] => [slotLink(c), agentLink(c, 'Open agent')];
const INFO_SLOT_STEPS = (c: Ctx): MaybeStep[] => [slotLink(c), read()];
const ADS_STEPS = (): MaybeStep[] => [link('Open ads', '/app/ads')];
const STRATEGIES_STEPS = (): MaybeStep[] => [link('Open strategies', '/app/strategies')];

const RULES: Record<string, Rule> = {
  // critical
  connection_broken: {
    why: 'A bot, Telegram session or Telegraph account stopped working, so what depends on it cannot publish or be read until it is fixed.',
    steps: healthSteps,
  },
  resource_health: {
    why: 'The planner stops scheduling posts on a resource whose access is broken and skips the slots already planned there, so it goes quiet until you fix it.',
    steps: healthSteps,
  },
  resource_health_daily: {
    why: 'This resource is still broken: nothing is scheduled or published there until it is reconnected.',
    steps: healthSteps,
  },
  budget_blocked: {
    why: 'Calls covered by this cap are blocked until midnight Kyiv time or until you raise the cap, so the agents it serves cannot work.',
    steps: () => [link('Edit caps', '/app/spend', { search: { tab: 'budgets' } })],
  },

  // action
  series_paused: {
    why: 'A paused series is no longer planned, so readers stop getting it. Resume it once its source has material again.',
    steps: (c) => {
      const id = c.ref?.base ?? null;
      const resume = stored(c, 'resume') ?? (c.handle && id ? { type: 'resume-series', label: 'Resume', handle: c.handle, pauseId: id } as NoteStep : null);
      return [resume, stored(c, 'keep'), agentLink(c, 'Open active effects')];
    },
  },
  dark_day: {
    why: 'A resource is going a whole day without a post, which breaks the habit of its audience.',
    steps: (c) => missedSteps(c),
  },
  series_missed: {
    why: 'A series that should have posted did not, and readers expect it at its usual time.',
    steps: (c) => missedSteps(c),
  },
  critic_reject_streak: {
    why: 'The critic keeps rejecting this resource\'s drafts, so posts are not going out; its brief or sources probably need a change.',
    steps: (c) => {
      const ch = replanChannel(c.it, c.tree);
      return [channelLink('Open channel', ch), ...storedAll(c, 'pause'), agentLink(c, 'Open agent')];
    },
  },
  manager_escalation: {
    why: 'An agent could not solve this on its own and handed it up; the manager and you are the next stop.',
    steps: (c) => {
      const e = parseEscalationRef(c.it.refId);
      const q = `@manager ${e ? `about the escalation from @${e.handle}` : 'about this escalation'}: ${clip(c.it.title, 160)}`;
      return [link('Ask @manager', '/app/chat', { search: { q } }), agentLink(c, c.handle ? `Open @${c.handle}` : 'Open agent')];
    },
  },
  directive_structural: {
    why: 'This directive changes the structure of the network (channels, bindings, series), so it waits for your yes.',
    steps: (c) => c.ref
      ? [{ type: 'directive', label: 'Approve', id: c.ref.base, decision: 'approve' }, { type: 'directive', label: 'Decline', id: c.ref.base, decision: 'decline' }, directiveLink(c)]
      : [directiveLink(c)],
  },
  directive_contested: {
    why: 'The agent refused a directive. Accept the refusal, or uphold the directive and it runs anyway.',
    steps: (c) => c.ref
      ? [{ type: 'contest', label: 'Accept refusal', id: c.ref.base, decision: 'accept-refusal' }, { type: 'contest', label: 'Uphold directive', id: c.ref.base, decision: 'uphold' }, directiveLink(c)]
      : [directiveLink(c)],
  },
  directive_ignored: {
    why: 'An agent did not act on a directive in time, so the change you asked for has not happened.',
    steps: (c) => [directiveLink(c)],
  },
  directive_failed: {
    why: 'A directive could not be applied; the directive shows the reason.',
    steps: (c) => [directiveLink(c), read()],
  },
  playbook_pending: {
    why: 'An agent proposed new working rules (a playbook); they only take effect once you approve them.',
    steps: (c) => c.ref
      ? [{ type: 'playbook', label: 'Approve', id: c.ref.base, decision: 'approve' }, { type: 'playbook', label: 'Reject', id: c.ref.base, decision: 'reject' }, agentLink(c, 'Review playbook', 'playbook')]
      : [agentLink(c, 'Review playbook', 'playbook')],
  },
  network_independent_offer: {
    why: 'This network can run as independent resources, each with its own decisions, instead of copying one channel\'s posts everywhere.',
    steps: (c) => [c.ref && c.handle ? { type: 'network-offer', label: 'Choose', groupId: c.ref.base, handle: c.handle } : null, agentLink(c, 'Open playbook', 'playbook')],
  },
  shadow_ended: {
    why: 'The shadow period is over. Choose whether the agent goes live, works in approval mode or stays off.',
    steps: (c) => [c.handle ? { type: 'mode', label: 'Choose mode', handle: c.handle } : null, agentLink(c, 'Open agent')],
  },
  landing_lead: {
    why: 'Someone left their details on your landing page and is waiting for an answer.',
    steps: () => [link('Open lead', '/app/landing', { search: { tab: 'leads' } })],
  },
  ad_orders_stuck: {
    why: 'Paid ad orders were not published. Nothing is refunded or published automatically, so the advertiser is waiting on you.',
    steps: ADS_STEPS,
  },
  ad_order_unfulfilled: {
    why: 'A paid ad order was not delivered, and the advertiser is waiting on you.',
    steps: ADS_STEPS,
  },
  sponsor_cutover: {
    why: 'Digest strategies were retired, so their sponsors need a new place in the agent\'s plan.',
    steps: (c) => [...ADS_STEPS(), agentLink(c, 'Open agent')],
  },
  low_runway: {
    why: 'A dataset is almost used up; series that depend on it will start skipping posts.',
    steps: (c) => [c.ref ? link('Open data', '/app/data/$key', { params: { key: c.ref.base } }) : link('Open data', '/app/data')],
  },
  series_source_empty: {
    why: 'A series whose source is required has no unused material left, so its slot was skipped.',
    steps: (c) => {
      const s = parseSeriesRef(c.it.refId);
      const open = agentLink(c, 'Open schedule', 'schedule') ?? (s ? channelLink('Open channel', s.owner) : null);
      const pause: NoteStep | null = s && c.handle
        ? { type: 'pause-series', label: 'Pause series', handle: c.handle, key: `series:${s.series}`, seriesLabel: s.series }
        : null;
      return [open, pause];
    },
  },
  derived_post_failed: {
    why: 'A post derived from another one (a carousel, a cross-post) could not be made, so that slot has nothing to publish.',
    steps: SLOT_STEPS,
  },
  critic_failed: {
    why: 'The critic did not answer, so the post was held back and did not go out.',
    steps: SLOT_STEPS,
  },
  audit_report: {
    why: 'The system audit finished; errors in it are things the network needs fixed.',
    steps: (c) => [
      c.ref ? link('Open report', '/app/artifacts', { search: { type: 'audit', open: `audit:${c.ref.base}` } }) : link('Open reports', '/app/artifacts', { search: { type: 'audit' } }),
      c.it.severity === 'info' ? read() : null,
    ],
  },
  host_struck: {
    why: 'A website keeps refusing our requests, so it is blocked for a while and sources that depend on it stay empty.',
    steps: (c) => {
      const h = parseHostRef(c.it.refId);
      return [link('Open network health', '/app/health'), agentLink(c, 'Open agent') ?? channelLink('Open channel', h?.channelKey ?? null)];
    },
  },
  event_not_covered: {
    why: 'An event was announced but no post followed it, so a recap is missing. Planning one now still catches readers.',
    steps: (c) => {
      const ch = telegramChannelOf(firstTelegramRef(c.it.body));
      return [ch ? { type: 'replan', label: 'Plan a recap today', channel: ch, date: 'today' } as NoteStep : null, read(ch ? 'Skip recap' : 'Got it')];
    },
  },
  legacy_bindings_enabled: {
    why: 'Old strategy bindings are still switched on, so they can post next to the agent that replaced them.',
    steps: STRATEGIES_STEPS,
  },
  strategy_cutover_ready: {
    why: 'The migrated series ran long enough in shadow; the old strategies can be retired and the agent takes over.',
    steps: STRATEGIES_STEPS,
  },
  launch_graduated: {
    why: 'The launch criteria were met, so this channel now publishes without your approval.',
    steps: (c) => [agentLink(c, 'Open agent'), read()],
  },

  // info
  skill_self_edit: {
    why: 'An agent changed one of its own skills; its behaviour changes from the next run.',
    steps: (c) => [agentLink(c, 'Open skills', 'skills'), read()],
  },
  skill_rolled_back: {
    why: 'A skill change made things worse, so the previous version was restored.',
    steps: (c) => [agentLink(c, 'Open skills', 'skills'), read()],
  },
  skill_probe: {
    why: 'A new skill version was tried on past posts to see whether it helps before it goes live.',
    steps: (c) => [agentLink(c, 'Open skills', 'skills'), read()],
  },
  ready_for_autonomy: {
    why: 'This channel\'s posts have been approved without edits long enough that the agent can publish on its own.',
    steps: (c) => {
      const channel = c.ref?.base ?? null;
      const node = channel ? nodeByScope(c.tree, `telegram:${channel}`) : null;
      return [channel ? { type: 'autonomy', label: 'Go live', channel, handle: node?.handle ?? c.handle } as NoteStep : null, agentLink(c, 'Open agent')];
    },
  },
  approval_dedup: {
    why: 'A post was left out of approval because it duplicates one that is already waiting.',
    steps: INFO_SLOT_STEPS,
  },
  evergreen_fallback: {
    why: 'A slot had nothing fresh, so an evergreen post was used instead.',
    steps: INFO_SLOT_STEPS,
  },
  loadout_suggestions: {
    why: 'Agents have ideas for a better set of tools; applying them can cut cost or improve posts.',
    steps: (c) => [agentLink(c, 'Open loadout', 'loadout'), read()],
  },
  resource_paused: {
    why: 'A resource was paused, so nothing is planned or published on it until it is resumed.',
    steps: (c) => [read(), c.it.refType === 'directive' && c.ref ? directiveLink(c) : agentLink(c, 'Open active effects', 'effects')],
  },
  resource_resumed: {
    why: 'A paused resource is back: planning and publishing there start again.',
    steps: (c) => [read(), c.it.refType === 'directive' && c.ref ? directiveLink(c) : agentLink(c, 'Open active effects', 'effects')],
  },
  resource_health_ok: {
    why: 'The connection works again; planning and publishing there resume on their own.',
    steps: () => [read()],
  },
  directive_expired: {
    why: 'A directive expired before it was applied, so nothing changed.',
    steps: (c) => [read(), directiveLink(c)],
  },
  directive_auto_applied: {
    why: 'A directive was applied automatically because it is within the limits you set.',
    steps: (c) => [read(), directiveLink(c)],
  },
  playbook_updated: {
    why: 'An agent\'s playbook changed; it follows the new version from the next plan.',
    steps: (c) => [read(), agentLink(c, 'Open playbook', 'playbook')],
  },
  network_mode: {
    why: 'The posting mode of a network changed; the new mode applies from the next plan day.',
    steps: (c) => [read(), agentLink(c, 'Open playbook', 'playbook')],
  },
  strategy_cutover: {
    why: 'The old strategies were retired and the agent now runs the channel in approval mode.',
    steps: (c) => [read(), agentLink(c, 'Open agent')],
  },
  ad_order_placed: {
    why: 'A new ad order came in and was scheduled.',
    steps: () => [read(), link('Open ads', '/app/ads')],
  },
  setup_expired: {
    why: 'A setup proposal waited too long and expired; ask the agent to set the channel up again if you still want it.',
    steps: () => [read()],
  },
  source_failing: {
    why: 'A source of a channel is failing or has nothing new; the agent looks for a replacement and will propose it.',
    steps: () => [read(), link('Open network health', '/app/health')],
  },
};

/** Every kind the table knows (the backend writes these; `critic_failed` is one, see research/inbox.md). */
export const INBOX_KINDS: readonly string[] = Object.keys(RULES);

const UNKNOWN_WHY = 'Nothing to do here; mark it as done once you have read it.';

/** An unknown kind still gets a page to open when its `refType` names one. */
function unknownSteps(c: Ctx): MaybeStep[] {
  switch (c.it.refType) {
    case 'directive':             return [read(), c.ref ? directiveLink(c) : null];
    case 'slot': case 'editor_slot': return [read(), slotLink(c)];
    case 'run':                   return [read(), c.ref ? link('Open run', '/app/editor/run/$id', { params: { id: c.ref.base } }) : null];
    case 'skill':                 return [read(), agentLink(c, 'Open skills', 'skills')];
    default:                      return [read(), agentLink(c, 'Open agent')];
  }
}

function missedSteps(c: Ctx): MaybeStep[] {
  const ch = replanChannel(c.it, c.tree);
  const replan: NoteStep | null = ch ? { type: 'replan', label: 'Replan tomorrow', channel: ch, date: 'tomorrow' } : null;
  return [replan, ...storedAll(c, 'pause'), channelLink('Open channel', ch) ?? agentLink(c, 'Open agent')];
}

/** What a note means and what can be done about it. Never throws; a note it does not know ends in "Got it". */
export function planNote(it: NoteItem, ctx: PlanContext = {}): NotePlan {
  const tree = ctx.tree && ctx.tree.length ? ctx.tree : null;
  const c: Ctx = {
    it, tree, handle: resolveHandle(it, tree), ref: parseRefId(it.refId), actions: it.actions ?? [],
  };
  const rule = RULES[it.kind];
  const steps = rule ? rule.steps(c) : unknownSteps(c);
  return { kind: it.kind, known: !!rule, why: rule?.why ?? UNKNOWN_WHY, handle: c.handle, ...lay(steps) };
}

/** All steps of a plan in display order. */
export function planSteps(p: Pick<NotePlan, 'primary' | 'secondary' | 'extra'>): NoteStep[] {
  return [p.primary, ...(p.secondary ? [p.secondary] : []), ...p.extra];
}

// ── what the server says back ──────────────────────────────────────────────

/** The outcome codes of `POST /api/agents/inbox/:id/actions`. */
export type InboxActionCode =
  | 'resumed' | 'already_resumed' | 'not_found' | 'kept' | 'paused' | 'already_paused' | 'muted' | 'not_broken' | 'unavailable';

/** The toast for an action's outcome code (English; the server's own `outcome` text is Ukrainian, for Telegram). */
export function inboxActionMessage(code: string): { tone: 'success' | 'info' | 'error'; text: string } {
  switch (code) {
    case 'resumed':         return { tone: 'success', text: 'Series resumed. The planner plans it again from the next plan.' };
    case 'already_resumed': return { tone: 'info',    text: 'That series was already resumed.' };
    case 'not_found':       return { tone: 'error',   text: 'That pause no longer exists.' };
    case 'kept':            return { tone: 'success', text: 'Kept paused.' };
    case 'paused':          return { tone: 'success', text: 'Series paused. The planner skips it until you resume it.' };
    case 'already_paused':  return { tone: 'info',    text: 'That series is already paused.' };
    case 'muted':           return { tone: 'success', text: 'Muted for 7 days. You will hear about it again if it changes.' };
    case 'not_broken':      return { tone: 'info',    text: 'The connection is fine now, so there is nothing to mute.' };
    case 'unavailable':     return { tone: 'error',   text: 'The server cannot do that right now.' };
    default:                return { tone: 'info',    text: 'Done.' };
  }
}

/** Whether the note is settled by an outcome code (the note is marked read) or the owner should look again (an error). */
export const isSettledCode = (code: string): boolean => inboxActionMessage(code).tone !== 'error';

/** A 409 on a directive or playbook decision that means "somebody already decided": the note is stale, not the click wrong. */
export function isAlreadyDecided(error: string | null | undefined): boolean {
  return error === 'not_awaiting_owner' || error === 'not_contested' || error === 'not_pending';
}

/**
 * English text for the failures of a note's action, or null when the caller should show the server's own message.
 * `status` is the HTTP status and `code` the `{error}` of the JSON body (see `errorBody` in `api/agents.ts`). A 404 that is
 * not one of ours is a server without the endpoint yet (the dashboard may be newer than the automation service).
 */
export function noteErrorMessage(status: number | null, code: string | null): string | null {
  switch (code) {
    case 'unknown_action':  return 'This note no longer offers that action. Refresh the list.';
    case 'note_not_found':  return 'That note no longer exists.';
    case 'not_available':   return 'The server cannot run note actions right now.';
    case 'no_channel':      return 'This agent has no Telegram channel, so there is no series to change.';
    case 'already_paused':  return 'That series is already paused.';
    case 'pause_not_found': return 'That pause no longer exists.';
    case 'not_paused':      return 'That series is not paused any more.';
    default: break;
  }
  if (status === 404) return 'This server does not support that action yet. Update the automation service, or open the page instead.';
  return null;
}
