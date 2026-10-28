// Spec 026 T3/T4: pure view helpers for the public landing (and the admin preview,
// which renders the same components). No React here, so node:test covers the
// rules: which proof tiles show, how platforms are counted, which agent nodes the
// hero orbit draws, and the badge copy for each aiRun state.
// Spec 078 B5 adds what the redesigned landing needs: public channel titles, the orbit's
// agents, the channel marquee, the hero pill and agent.log lines, and the role explorer copy.
import type { IconName } from '../components/ui/Icon';
import type {
  AiRun, LandingNetwork, LandingNetworkAgent, LandingPlatform, LandingPulse,
} from '../api/landing';

export const PLATFORM_ORDER: readonly LandingPlatform[] = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok', 'youtube'];

/** Icon, label and a brand-ish tint used only as a faint glow. */
export const PLATFORM_META: Record<LandingPlatform, { icon: IconName; label: string; tint: string }> = {
  telegram:  { icon: 'telegram',  label: 'Telegram',  tint: '#2aabee' },
  instagram: { icon: 'instagram', label: 'Instagram', tint: '#e1306c' },
  facebook:  { icon: 'facebook',  label: 'Facebook',  tint: '#1877f2' },
  threads:   { icon: 'threads',   label: 'Threads',   tint: '#ededed' },
  tiktok:    { icon: 'tiktok',    label: 'TikTok',    tint: '#25f4ee' },
  youtube:   { icon: 'youtube',   label: 'YouTube',   tint: '#ff3d3d' },
};

/** 12_345 → "12.3K", 1_200_000 → "1.2M". Trims a trailing ".0". */
export function compact(n: number): string {
  if (n < 1_000) return String(n);
  const fmt = (v: number, s: string) => `${v.toFixed(1).replace(/\.0$/, '')}${s}`;
  if (n < 1_000_000) return fmt(n / 1_000, 'K');
  if (n < 1_000_000_000) return fmt(n / 1_000_000, 'M');
  return fmt(n / 1_000_000_000, 'B');
}

/** The platforms the showcase actually has, in display order. YouTube counts only when a
 *  featured YouTube resource exists (FR-010): the server only returns active, featured rows. */
export function networkPlatforms(networks: LandingNetwork[] | undefined): LandingPlatform[] {
  const present = new Set((networks ?? []).flatMap((n) => n.resources.map((r) => r.platform)));
  return PLATFORM_ORDER.filter((p) => present.has(p));
}

/** Platforms for the hero: the showcase when it loaded, else the platforms with posts this week. */
export function heroPlatforms(networks: LandingNetwork[] | undefined, pulse: LandingPulse | undefined): LandingPlatform[] {
  const fromNetworks = networkPlatforms(networks);
  if (fromNetworks.length) return fromNetworks;
  const fromPulse = new Set((pulse?.last7d.platforms ?? []).filter((p) => p.posts > 0).map((p) => p.platform));
  return PLATFORM_ORDER.filter((p) => fromPulse.has(p));
}

/** The hero pill: "A network run by AI agents · 5 platforms" (no count when unknown). */
export function heroPill(platformCount: number): string {
  const base = 'A network run by AI agents';
  if (platformCount <= 0) return base;
  return `${base} · ${platformCount} ${platformCount === 1 ? 'platform' : 'platforms'}`;
}

export function audienceStats(networks: LandingNetwork[] | undefined): { followers: number; resources: number; platforms: number } {
  const resources = (networks ?? []).flatMap((n) => n.resources);
  return {
    followers: resources.reduce((a, r) => a + (r.followerCount ?? 0), 0),
    resources: resources.length,
    platforms: networkPlatforms(networks).length,
  };
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'} ago`;
}

export interface ProofTile {
  key: 'agentPosts' | 'orchestratorsLive' | 'autonomyShare' | 'lastAgentPost';
  value: string;
  label: string;
  /** The FR-004 definition behind the "?". */
  definition: string;
}

/**
 * The proof strip (FR-005). Every number comes from /api/landing/pulse; a tile whose
 * value is zero is hidden (so the page never shows a number that contradicts the
 * headline), and the last-post tile is hidden when there is no agent post yet.
 * An empty list means the strip is hidden.
 */
export function proofTiles(pulse: LandingPulse | undefined, now: number = Date.now()): ProofTile[] {
  if (!pulse) return [];
  const tiles: ProofTile[] = [];
  const { agentPosts, autonomyShare } = pulse.last7d;
  if (agentPosts > 0) {
    tiles.push({
      key: 'agentPosts', value: compact(agentPosts), label: agentPosts === 1 ? 'post by agents in 7 days' : 'posts by agents in 7 days',
      definition: 'Posts published in the last 7 days that an AI agent planned and wrote, on every platform. Posts the owner approved before they went out count; ads, the classic pipeline and shadow drafts do not.',
    });
  }
  if (pulse.agents.orchestratorsLive > 0) {
    tiles.push({
      key: 'orchestratorsLive', value: String(pulse.agents.orchestratorsLive),
      label: pulse.agents.orchestratorsLive === 1 ? 'agent live' : 'agents live',
      definition: 'Top-level agents that publish, directly or after the owner approves. Agents in training (shadow), switched off or paused are not counted.',
    });
  }
  if (autonomyShare > 0) {
    tiles.push({
      key: 'autonomyShare', value: `${autonomyShare}%`, label: 'of content created by agents',
      definition: 'Agent posts as a share of everything the network published in the last 7 days, ads and the classic pipeline included.',
    });
  }
  if (pulse.lastAgentPostAt) {
    tiles.push({
      key: 'lastAgentPost', value: relativeTime(pulse.lastAgentPostAt, now), label: 'last agent post',
      definition: 'When the most recent agent post went out, on any platform.',
    });
  }
  return tiles;
}

export interface DiagramNode { key: string; label: string; emoji: string | null; mode: 'live' | 'shadow' | null }

/** Up to 4 real network nodes: networks with an agent first, then networks without one. */
export function diagramNodes(networks: LandingNetwork[] | undefined, max = 4): DiagramNode[] {
  const named = (networks ?? []).filter((n) => n.name !== null);
  const ranked = [...named.filter((n) => n.agent?.mode === 'live'), ...named.filter((n) => n.agent?.mode === 'shadow'), ...named.filter((n) => !n.agent)];
  return ranked.slice(0, max).map((n) => ({
    key: n.name as string,
    label: n.name as string,
    emoji: n.agent?.emoji ?? null,
    mode: n.agent?.mode ?? null,
  }));
}

export const ROLES: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: 'planner', label: 'Planner' },
  { kind: 'ideator', label: 'Ideator' },
  { kind: 'idea_reviewer', label: 'Idea reviewer' },
  { kind: 'executor', label: 'Executor' },
  { kind: 'reviewer', label: 'Reviewer' },
];

/** Role chips: every role of an orchestrator, lit when it had a successful run this week. */
export function roleChips(pulse: LandingPulse | undefined): Array<{ kind: string; label: string; active: boolean }> {
  const active = new Set(pulse?.agents.rolesActive ?? []);
  return ROLES.map((r) => ({ ...r, active: active.has(r.kind) }));
}

export function aiRunBadge(aiRun: AiRun): { label: string; tone: 'success' | 'warning' | 'neutral'; title: string } {
  switch (aiRun) {
    case 'live':
      return { label: 'Run by an AI agent', tone: 'success', title: 'An AI agent plans and writes the posts here.' };
    case 'shadow':
      return { label: 'Agent in shadow · classic pipeline publishes', tone: 'warning', title: 'An AI agent is in training here: it drafts in shadow while the classic pipeline still publishes.' };
    default:
      return { label: 'Automated pipeline', tone: 'neutral', title: 'Published by the automated pipeline, without an AI agent.' };
  }
}

export function agentChip(agent: LandingNetworkAgent | null): string | null {
  if (!agent) return null;
  return agent.mode === 'live'
    ? `Run by AI agent ${agent.name} · live`
    : `AI agent ${agent.name} in training (shadow)`;
}

/** FR-007: the React key of a resource card (fixes the platform:handle collision of BRD 08 §3.1). */
export function resourceKey(r: { platform: LandingPlatform; handle: string | null; order: number }): string {
  return `${r.platform}:${r.handle ?? ''}:${r.order}`;
}

// ── Spec 078 B5: the redesigned landing ──────────────────────────────────────────────────────────

/**
 * A channel title as the public page shows it. The tracker syncs the Telegram title, and the channels
 * of a dev instance end in "| DEV" (or "(dev)"): that suffix never reaches a visitor. Null when
 * nothing is left, so the caller falls back to the @handle.
 */
export function publicTitle(title: string | null | undefined): string | null {
  if (title == null) return null;
  const t = title.replace(/\s*(?:\|\s*DEV|[([]\s*DEV\s*[)\]])\s*$/i, '').trim();
  return t.length > 0 ? t : null;
}

/** First two characters of a name, for an avatar tile without an emoji ("Nova" becomes "No"). */
export function initials(name: string): string {
  const chars = Array.from(name.trim());
  if (chars.length === 0) return '';
  return chars[0].toUpperCase() + (chars[1] ?? '');
}

export interface AgentNode { key: string; name: string; emoji: string | null; mode: 'live' | 'shadow'; initials: string }

/**
 * The agents the hero orbit draws: the agent of each network (live first, then in training), one tile per
 * agent name. A network without an agent is a pipeline, not an agent, so it never gets a tile.
 */
export function agentNodes(networks: LandingNetwork[] | undefined, max = 5): AgentNode[] {
  const seen = new Set<string>();
  const agents = (networks ?? []).flatMap((n) => (n.agent ? [n.agent] : [])).filter((a) => {
    const k = a.name.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const ranked = [...agents.filter((a) => a.mode === 'live'), ...agents.filter((a) => a.mode === 'shadow')];
  return ranked.slice(0, max).map((a, i) => ({
    key: `${a.name}#${i}`, name: a.name, emoji: a.emoji, mode: a.mode, initials: initials(a.name),
  }));
}

/** Angles (degrees, 0 = right, clockwise) of `count` tiles spread evenly on a ring, starting at `start`. */
export function ringAngles(count: number, start: number): number[] {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) => Math.round((start + (360 / count) * i) * 100) / 100);
}

/** Platforms with at least one agent post this week: the hero orbit lights these. */
export function livePlatforms(pulse: LandingPulse | undefined): LandingPlatform[] {
  const live = new Set((pulse?.last7d.platforms ?? []).filter((p) => p.agentPosts > 0).map((p) => p.platform));
  return PLATFORM_ORDER.filter((p) => live.has(p));
}

/**
 * The hero pill. With agents live it says so ("Live · 2 agents publishing to Telegram and Instagram", from
 * the same pulse as the proof strip); with none, or without a pulse, it is the plain pill of FR-005.
 */
export function heroLivePill(pulse: LandingPulse | undefined, platformCount: number): { text: string; live: boolean } {
  const agents = pulse?.agents.orchestratorsLive ?? 0;
  if (agents <= 0) return { text: heroPill(platformCount), live: false };
  const where = livePlatforms(pulse).map((p) => PLATFORM_META[p].label);
  const to = where.length === 0 ? ''
    : where.length === 1 ? ` to ${where[0]}`
    : where.length === 2 ? ` to ${where[0]} and ${where[1]}`
    : ` to ${where.length} platforms`;
  return { text: `Live · ${agents} ${agents === 1 ? 'agent' : 'agents'} publishing${to}`, live: true };
}

export interface MarqueeChannel {
  key: string;
  name: string;
  handle: string | null;
  platform: LandingPlatform;
  aiRun: AiRun;
}

/**
 * The channel marquee: every resource of every network in the payload's order, named like the cards are
 * (public title, else @handle, else the platform). At most `max`, so the strip stays light.
 */
export function marqueeChannels(networks: LandingNetwork[] | undefined, max = 24): MarqueeChannel[] {
  const out: MarqueeChannel[] = [];
  for (const n of networks ?? []) {
    for (const r of n.resources) {
      const title = publicTitle(r.displayName);
      const at = r.handle ? `@${r.handle}` : null;
      out.push({
        key: `${resourceKey(r)}#${out.length}`,
        name: title ?? at ?? PLATFORM_META[r.platform].label,
        handle: title && at ? at : null,
        platform: r.platform,
        aiRun: r.aiRun,
      });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Repeat `items` until there are at least `min` of them (a short list would leave a gap in a looping strip). */
export function fillTo<T>(items: readonly T[], min: number): Array<{ item: T; copy: number }> {
  if (items.length === 0) return [];
  const out: Array<{ item: T; copy: number }> = [];
  const total = Math.max(min, items.length);
  for (let i = 0; i < total; i++) out.push({ item: items[i % items.length], copy: Math.floor(i / items.length) });
  return out;
}

export interface LogLine { key: string; role: string; text: string; owner?: boolean }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The hero's agent.log, phase 1: lines made of the real numbers of the last 7 days (no invented events, no
 * times, no handles). A line whose count is zero is left out; no pulse means no lines.
 */
export function agentLogLines(pulse: LandingPulse | undefined, now: number = Date.now()): LogLine[] {
  if (!pulse) return [];
  const w = pulse.last7d;
  const lines: LogLine[] = [];
  if (w.agentPosts > 0) {
    lines.push({ key: 'posts', role: 'executor', text: `${plural(w.agentPosts, 'post', 'posts')} published${w.autonomyShare > 0 ? ` (${w.autonomyShare}% of all)` : ''}` });
  }
  if (w.skippedByAgents > 0) {
    lines.push({ key: 'skipped', role: 'executor', text: `${plural(w.skippedByAgents, 'slot', 'slots')} skipped by the agent’s own call` });
  }
  if (w.ideasReviewed > 0) {
    lines.push({ key: 'ideas', role: 'idea reviewer', text: `${plural(w.ideasReviewed, 'idea', 'ideas')} reviewed` });
  }
  if (w.agentRuns > 0) {
    lines.push({ key: 'runs', role: 'agents', text: plural(w.agentRuns, 'successful run', 'successful runs') });
  }
  if (pulse.claims.managerLive && (w.managerReviews > 0 || w.directivesFiled > 0)) {
    const parts = [
      w.managerReviews > 0 ? plural(w.managerReviews, 'review', 'reviews') : null,
      w.directivesFiled > 0 ? plural(w.directivesFiled, 'directive', 'directives') : null,
    ].filter((p): p is string => p !== null);
    lines.push({ key: 'manager', role: 'manager', text: parts.join(', ') });
  }
  if (w.ownerDecisions > 0) {
    lines.push({ key: 'owner', role: 'owner', text: plural(w.ownerDecisions, 'decision', 'decisions'), owner: true });
  }
  if (pulse.lastAgentPostAt) {
    lines.push({ key: 'last', role: 'last post', text: relativeTime(pulse.lastAgentPostAt, now) });
  }
  return lines;
}

/** The orchestrators the explorer counts: live ones and the ones still in training (the hero pill says "live" only). */
export function orchestratorCount(pulse: LandingPulse | undefined): number {
  return (pulse?.agents.orchestratorsLive ?? 0) + (pulse?.agents.orchestratorsShadow ?? 0);
}

export type ExplorerId = 'manager' | 'orchestrator' | 'planner' | 'ideator' | 'idea_reviewer' | 'executor' | 'reviewer';

export interface ExplorerRole {
  id: ExplorerId;
  /** "01" to "07". */
  num: string;
  title: string;
  desc: string;
  /** Who the role reports to. */
  up: string;
  tags: string[];
  /** The MANAGER before it goes live: dimmed and marked "soon". */
  soon?: boolean;
}

/**
 * The seven roles of the role explorer. The five workers are keyed like the pulse's `rolesActive` (ROLES kinds), so
 * the buttons can light up from it. The MANAGER copy is gated by `claims.managerLive`: until then it "will" read the
 * digest and the orchestrators report to the owner.
 */
export function explorerRoles(managerLive: boolean): ExplorerRole[] {
  return [
    {
      id: 'manager', num: '01', title: 'MANAGER', up: 'the owner', soon: !managerLive,
      desc: managerLive
        ? 'Reads the network’s KPI digest and turns it into directives or advice for the agents below.'
        : 'Will read the network’s KPI digest and turn it into directives or advice for the agents below.',
      tags: ['KPI digest', 'directives', 'advice'],
    },
    {
      id: 'orchestrator', num: '02', title: 'Orchestrator', up: managerLive ? 'MANAGER' : 'the owner',
      desc: 'Owns one network or channel: keeps its playbook and a pool of ideas worth writing.',
      tags: ['playbook', 'idea pool', 'one per network or channel'],
    },
    {
      id: 'planner', num: '03', title: 'Planner', up: 'Orchestrator',
      desc: 'Plans the day for each resource and platform: what goes out, and when.',
      tags: ['daily plan', 'time slots'],
    },
    {
      id: 'ideator', num: '04', title: 'Ideator', up: 'Orchestrator',
      desc: 'Pitches new ideas into the orchestrator’s pool, from the channel’s sources.',
      tags: ['sources', 'idea pool'],
    },
    {
      id: 'idea_reviewer', num: '05', title: 'Idea reviewer', up: 'Orchestrator',
      desc: 'Checks each idea against the playbook before it can reach the plan.',
      tags: ['playbook check', 'filter'],
    },
    {
      id: 'executor', num: '06', title: 'Executor', up: 'Orchestrator',
      desc: 'Writes and publishes through code guards: dedup, rate limits, quiet hours, budget and a kill switch.',
      tags: ['dedup', 'rate limits', 'quiet hours', 'budget', 'kill switch'],
    },
    {
      id: 'reviewer', num: '07', title: 'Reviewer', up: 'Orchestrator',
      desc: 'Measures how every post performed and feeds the lessons back into planning.',
      tags: ['post metrics', 'lessons → plan'],
    },
  ];
}

/** The code guards every post passes before the Executor publishes (the Executor copy above names the same five). */
export const GUARDS: ReadonlyArray<{ id: string; label: string; icon: IconName; at: number }> = [
  { id: 'dedup', label: 'Dedup', icon: 'copy', at: 18 },
  { id: 'rate', label: 'Rate limits', icon: 'gauge', at: 34 },
  { id: 'quiet', label: 'Quiet hours', icon: 'moon', at: 50 },
  { id: 'budget', label: 'Budget', icon: 'spend', at: 66 },
  { id: 'kill', label: 'Kill switch', icon: 'power', at: 82 },
];

/** The six steps of the loop, placed on a circle (percent of the ring box), clockwise from the top. */
export const LOOP_STEPS: ReadonlyArray<{ label: string; x: number; y: number }> = [
  { label: 'Plan', x: 50, y: 10.5 },
  { label: 'Write', x: 84.2, y: 30.25 },
  { label: 'Guard', x: 84.2, y: 69.75 },
  { label: 'Publish', x: 50, y: 89.5 },
  { label: 'Measure', x: 15.8, y: 69.75 },
  { label: 'Learn', x: 15.8, y: 30.25 },
];

/**
 * The #networks heading, made of the payload: "7 channels and profiles" / "4 run by AI agents today". Nothing is
 * claimed that the cards below do not show; with no resources (loading, error, empty) it is the neutral title.
 */
export function networkHeadline(networks: LandingNetwork[] | undefined): { lead: string; rest: string | null } {
  const resources = (networks ?? []).flatMap((n) => n.resources);
  if (resources.length === 0) return { lead: 'The network', rest: null };
  const live = resources.filter((r) => r.aiRun === 'live').length;
  const shadow = resources.filter((r) => r.aiRun === 'shadow').length;
  const lead = `${resources.length} ${resources.length === 1 ? 'channel or profile' : 'channels and profiles'}`;
  if (live > 0) return { lead, rest: `${live} run by AI agents today` };
  if (shadow > 0) return { lead, rest: 'AI agents are training in shadow' };
  return { lead, rest: null };
}
