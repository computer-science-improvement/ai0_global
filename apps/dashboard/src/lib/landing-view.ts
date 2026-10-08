// Spec 026 T3/T4: pure view helpers for the public landing (and the admin preview,
// which renders the same components). No React here, so node:test covers the
// rules: which proof tiles show, how platforms are counted, which agent nodes the
// hierarchy diagram draws, and the badge copy for each aiRun state.
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

/** Up to 4 real network nodes for the hierarchy diagram: networks with an agent first. */
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
