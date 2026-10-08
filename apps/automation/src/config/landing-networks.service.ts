// apps/automation/src/config/landing-networks.service.ts
// Spec 026 FR-006/FR-007: the public showcase grouped by network, with the AI agent
// that runs each network and resource.
//
//   GET /api/landing/networks → LandingNetwork[]   (public, cached 300 s)
//
// Sources: the featured resources (LandingResourcesService, same rows as
// /api/landing/resources), the network and agent of each resource
// (ResourceCatalog, spec 018/020), the top-level orchestrators (`agents`), the
// owner's network blurb and order (meta_account_groups, migration 066) and the
// active ad prices (ad_prices, spec 008).
//
// Public payload rules: no ids, no agent @handles, no costs, no personal data. The
// agent's display name and emoji are shown (spec 026 open question 4). Resource
// handles are the public profile handles the existing /resources endpoint shows.
//
// aiRun of a resource is its agent's public mode: live (mode live, or approve —
// approval mode publishes after the owner's OK and counts as agent work, spec 031),
// shadow (the agent writes in shadow; the classic pipeline publishes), none (no agent,
// the agent is off, or it is paused).
import type { Pool } from 'pg';
import type { ResourceListItem } from '../editor/agents/resource-catalog';
import type { AdDmContext } from './landing-config.service';
import { buildAdDmUrl } from './landing-dm';
import { publicMode } from './landing-pulse.service';
import {
  LANDING_PLATFORMS, type LandingFeaturedEntry, type LandingPlatform, type LandingResource,
} from './landing-resources.service';

export type AiRun = 'live' | 'shadow' | 'none';

export interface LandingNetworkAgent {
  name:  string;
  emoji: string | null;
  mode:  'live' | 'shadow';
}

export interface LandingNetworkResource extends LandingResource {
  aiRun:   AiRun;
  /** "Ads here" deep link; set only when the channel has an active ad price. */
  adDmUrl: string | null;
}

export interface LandingNetwork {
  /** The network's name; null for the final group of standalone resources. */
  name:      string | null;
  /** The owner's one-line description (English; the page ships English only). */
  blurb:     string | null;
  order:     number;
  agent:     LandingNetworkAgent | null;
  /** Sum of the known follower counts of the featured resources; null when none is known. */
  followers: number | null;
  /** Platforms of the featured resources, in display order. */
  platforms: LandingPlatform[];
  /** "Order an ad in this network": set when at least one of its channels has an active ad price. */
  adDmUrl:   string | null;
  resources: LandingNetworkResource[];
}

export interface AgentRow {
  handle:   string;
  name:     string;
  emoji:    string | null;
  mode:     string;
  status:   string | null;
  scope:    string;
  scope_id: string | null;
}

export interface GroupRow {
  id:               string;
  name:             string;
  landing_blurb_en: string | null;
  landing_order:    number | null;
}

/** The owner's view of a network on /app/landing (FR-015). */
export interface LandingAdminNetwork {
  id:        string;
  name:      string;
  blurb:     string | null;
  order:     number;
  /** Active resources the catalog puts in this network, and how many of them are featured. */
  resources: number;
  featured:  number;
  agent:     LandingNetworkAgent | null;
}

export interface NetworksInput {
  entries:   LandingFeaturedEntry[];
  catalog:   ResourceListItem[];
  agents:    AgentRow[];
  groups:    GroupRow[];
  /** Telegram channel keys with an active ad price (any spelling: `@x` or `x`). */
  pricedKeys: string[];
  adDm:      AdDmContext | null;
}

const normKey = (k: string | null | undefined) => (k ?? '').trim().replace(/^@/, '').toLowerCase();

function aiRunOf(agent: AgentRow | undefined): AiRun {
  if (!agent) return 'none';
  const mode = publicMode(agent.mode, agent.status);
  return mode === 'off' ? 'none' : mode;
}

function publicAgent(agent: AgentRow | undefined): LandingNetworkAgent | null {
  if (!agent) return null;
  const mode = publicMode(agent.mode, agent.status);
  if (mode === 'off') return null;
  return { name: agent.name, emoji: agent.emoji ?? null, mode };
}

/** The agent that runs a network: its own network orchestrator, else the agent of its
 *  Telegram anchor channel, else the one agent all its resources share. */
function networkAgentHandle(groupId: string, catalog: ResourceListItem[], agents: AgentRow[]): string | null {
  const own = agents.find((a) => a.scope === 'network' && a.scope_id === groupId);
  if (own) return own.handle;
  const members = catalog.filter((r) => r.groupId === groupId && r.agent);
  const anchor = members.find((r) => r.platform === 'telegram');
  if (anchor?.agent) return anchor.agent;
  const handles = new Set(members.map((r) => r.agent as string));
  return handles.size === 1 ? [...handles][0] : null;
}

function platformsOf(resources: LandingResource[]): LandingPlatform[] {
  const present = new Set(resources.map((r) => r.platform));
  return LANDING_PLATFORMS.filter((p) => present.has(p));
}

function sumFollowers(resources: LandingResource[]): number | null {
  const known = resources.map((r) => r.followerCount).filter((n): n is number => n !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** Pure: the public networks payload from already-loaded rows. */
export function buildNetworks(input: NetworksInput): LandingNetwork[] {
  const byRef = new Map(input.catalog.map((c) => [c.ref, c]));
  const agentsByHandle = new Map(input.agents.map((a) => [a.handle, a]));
  const priced = new Set(input.pricedKeys.map(normKey));
  const groupsById = new Map(input.groups.map((g) => [g.id, g]));

  const buckets = new Map<string | null, Array<{ entry: LandingFeaturedEntry; resource: LandingNetworkResource; priced: string | null }>>();
  for (const entry of input.entries) {
    const item = entry.ref ? byRef.get(entry.ref) : undefined;
    const groupId = item?.groupId && groupsById.has(item.groupId) ? item.groupId : null;
    const agent = item?.agent ? agentsByHandle.get(item.agent) : undefined;
    const r = entry.resource;
    const pricedKey = r.platform === 'telegram' && entry.channelKey && priced.has(normKey(entry.channelKey))
      ? normKey(entry.channelKey) : null;
    const adDmUrl = pricedKey && input.adDm
      ? buildAdDmUrl({
        username: input.adDm.username, template: input.adDm.template, placement: 'resource',
        target: r.displayName ?? (r.handle ? `@${r.handle}` : null), channelKey: entry.channelKey,
      })
      : null;
    const list = buckets.get(groupId) ?? [];
    list.push({ entry, priced: pricedKey ? entry.channelKey : null, resource: { ...r, aiRun: aiRunOf(agent), adDmUrl } });
    buckets.set(groupId, list);
  }

  const networks: LandingNetwork[] = [];
  for (const [groupId, list] of buckets) {
    if (groupId === null) continue;
    const g = groupsById.get(groupId)!;
    const resources = list.map((x) => x.resource);
    const handle = networkAgentHandle(groupId, input.catalog, input.agents);
    const firstPriced = list.find((x) => x.priced)?.priced ?? null;
    networks.push({
      name: g.name,
      blurb: g.landing_blurb_en?.trim() ? g.landing_blurb_en.trim() : null,
      order: g.landing_order ?? 0,
      agent: publicAgent(handle ? agentsByHandle.get(handle) : undefined),
      followers: sumFollowers(resources),
      platforms: platformsOf(resources),
      adDmUrl: firstPriced && input.adDm
        ? buildAdDmUrl({ username: input.adDm.username, template: input.adDm.template, placement: 'network', target: g.name, channelKey: firstPriced })
        : null,
      resources,
    });
  }
  networks.sort((a, b) => a.order - b.order || (a.name ?? '').localeCompare(b.name ?? ''));

  const standalone = buckets.get(null);
  if (standalone?.length) {
    const resources = standalone.map((x) => x.resource);
    networks.push({
      name: null, blurb: null,
      order: networks.length ? Math.max(...networks.map((n) => n.order)) + 1 : 0,
      agent: null, followers: sumFollowers(resources), platforms: platformsOf(resources), adDmUrl: null, resources,
    });
  }
  return networks;
}

/** Pure: the owner's network list (every network, featured resources or not). */
export function buildAdminNetworks(input: Pick<NetworksInput, 'entries' | 'catalog' | 'agents' | 'groups'>): LandingAdminNetwork[] {
  const featuredRefs = new Set(input.entries.map((e) => e.ref).filter(Boolean));
  const agentsByHandle = new Map(input.agents.map((a) => [a.handle, a]));
  return input.groups
    .map((g) => {
      const members = input.catalog.filter((c) => c.groupId === g.id);
      const handle = networkAgentHandle(g.id, input.catalog, input.agents);
      return {
        id: g.id,
        name: g.name,
        blurb: g.landing_blurb_en ?? null,
        order: g.landing_order ?? 0,
        resources: members.length,
        featured: members.filter((m) => featuredRefs.has(m.ref)).length,
        agent: publicAgent(handle ? agentsByHandle.get(handle) : undefined),
      };
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export const NETWORK_BLURB_MAX = 280;
export const NETWORK_ORDER_MAX = 9999;

export interface NetworkPatch { blurb?: string | null; order?: number }

/** Validation problems of an admin network patch ([] when fine). */
export function networkPatchIssues(p: { blurb?: unknown; order?: unknown }): Array<{ path: 'blurb' | 'order'; message: string }> {
  const issues: Array<{ path: 'blurb' | 'order'; message: string }> = [];
  if (p.blurb !== undefined && p.blurb !== null) {
    if (typeof p.blurb !== 'string') issues.push({ path: 'blurb', message: 'must be text or null' });
    else if (Array.from(p.blurb.trim()).length > NETWORK_BLURB_MAX) issues.push({ path: 'blurb', message: `at most ${NETWORK_BLURB_MAX} characters` });
  }
  if (p.order !== undefined) {
    if (typeof p.order !== 'number' || !Number.isInteger(p.order) || p.order < 0 || p.order > NETWORK_ORDER_MAX) {
      issues.push({ path: 'order', message: `a whole number from 0 to ${NETWORK_ORDER_MAX}` });
    }
  }
  return issues;
}

export interface LandingNetworksDeps {
  pool:      Pick<Pool, 'query'>;
  resources: { listFeaturedEntries(): Promise<LandingFeaturedEntry[]> };
  catalog:   { list(): Promise<ResourceListItem[]> };
  adDm:      () => Promise<AdDmContext | null>;
  now?:      () => number;
}

const TTL_MS = 300_000;

export class LandingNetworksService {
  readonly maxAgeSeconds = TTL_MS / 1000;
  private cache: { at: number; value: LandingNetwork[] } | null = null;

  constructor(private readonly d: LandingNetworksDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  private async load(): Promise<NetworksInput> {
    const [entries, catalog, agents, groups, priced, adDm] = await Promise.all([
      this.d.resources.listFeaturedEntries(),
      this.d.catalog.list(),
      this.d.pool.query<AgentRow>(
        `SELECT handle, name, emoji, mode, status, scope, scope_id FROM agents
          WHERE parent_id IS NULL AND kind = 'orchestrator'`).then((r) => r.rows),
      this.d.pool.query<GroupRow>(
        `SELECT id, name, landing_blurb_en, landing_order FROM meta_account_groups`).then((r) => r.rows),
      this.d.pool.query<{ channel_key: string }>(
        `SELECT DISTINCT channel_key FROM ad_prices WHERE active`).then((r) => r.rows.map((x) => x.channel_key)),
      this.d.adDm(),
    ]);
    return { entries, catalog, agents, groups, pricedKeys: priced, adDm };
  }

  /** GET /api/landing/networks — cached 300 s; a failed refresh serves the last good value. */
  async list(): Promise<LandingNetwork[]> {
    const t = this.now();
    if (this.cache && t - this.cache.at < TTL_MS) return this.cache.value;
    try {
      const value = buildNetworks(await this.load());
      this.cache = { at: t, value };
      return value;
    } catch (err) {
      if (this.cache) return this.cache.value;
      throw err;
    }
  }

  /** The owner's view: every network plus an uncached preview of the public payload. */
  async admin(): Promise<{ networks: LandingAdminNetwork[]; preview: LandingNetwork[] }> {
    const input = await this.load();
    return { networks: buildAdminNetworks(input), preview: buildNetworks(input) };
  }

  /** PATCH /api/landing/admin/network/:groupId. Returns false when the network does not exist. */
  async patchNetwork(groupId: string, patch: NetworkPatch): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [groupId];
    if (patch.blurb !== undefined) {
      const blurb = patch.blurb === null ? '' : patch.blurb.trim();
      params.push(blurb === '' ? null : blurb);
      sets.push(`landing_blurb_en = $${params.length}`);
    }
    if (patch.order !== undefined) {
      params.push(patch.order);
      sets.push(`landing_order = $${params.length}`);
    }
    if (!sets.length) {
      const { rowCount } = await this.d.pool.query(`SELECT 1 FROM meta_account_groups WHERE id::text = $1`, [groupId]);
      return (rowCount ?? 0) > 0;
    }
    const { rowCount } = await this.d.pool.query(
      `UPDATE meta_account_groups SET ${sets.join(', ')} WHERE id::text = $1`, params);
    this.invalidate();
    return (rowCount ?? 0) > 0;
  }

  /** Expire the public cache (after any admin edit that changes the page); the old value
   *  stays as the fallback for a failed refresh. */
  invalidate(): void {
    if (this.cache) this.cache = { at: Number.NEGATIVE_INFINITY, value: this.cache.value };
  }
}
