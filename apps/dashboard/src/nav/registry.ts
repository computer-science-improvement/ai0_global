// Spec 027 FR-001: the single source of truth for every navigable page. The
// sidebar, the ⌘K palette, the breadcrumbs and the menu constructor all read it.
//
// Rules:
// - Ids are stable slugs and are NEVER reused: a saved menu (`app_settings`
//   row `ui.nav`) stores them. Removing an entry is safe (the saved id is then
//   skipped and listed as *Unavailable*); renaming an id is not.
// - Group order is the order of NAV_GROUPS; the order inside a group is the
//   order of NAV_REGISTRY.
// - `hiddenByDefault` pages are reachable from "More tools", ⌘K and breadcrumbs,
//   and the owner can add them to the menu; `menu: false` entries are route
//   templates with params (detail pages): they exist only for breadcrumbs and
//   never go in a menu.
// - Hiding an item only changes the menu. Every route keeps working, so deep
//   links and bookmarks never break.
// - Spec 078: the default menu has 11 items in four groups (Home, Network,
//   Insights, System). Every other page is hidden by default, and its
//   `defaultGroup` is a group of that menu so "Restore" lands it somewhere sensible.
//
// Pure data (type-only imports), so node tests can import it.
import type { IconName } from '../components/ui/Icon';

export type NavGroupId =
  | 'g_home' | 'g_agents' | 'g_publishing' | 'g_content' | 'g_analytics'
  | 'g_intelligence' | 'g_connections' | 'g_marketing' | 'g_system';

/** Which live counter an item shows (see nav/badges.ts). */
export type BadgeKey = 'approvals' | 'agentsInbox' | 'directives' | 'chat' | 'dm' | 'editor' | 'scheduled';

export interface NavEntry {
  id:            string;
  /** Path. Concrete for menu pages; a route template (`$param`) for `menu: false` entries. */
  to:            string;
  search?:       Record<string, string>;
  label:         string;
  icon:          IconName;
  defaultGroup:  NavGroupId;
  /** Active only on an exact path match (Overview, Connections). */
  exact?:        boolean;
  /** Extra words the ⌘K palette matches on. */
  keywords:      string[];
  badge?:        BadgeKey;
  /** Breadcrumb parent (a registry id). */
  parent?:       string;
  /** Registered but not in the default menu (spec 078: they live under "More tools"). */
  hiddenByDefault?: boolean;
  /** A tab or section of a bigger page (approvals, directives, bots…): reachable from ⌘K, never listed under "More tools". */
  subview?:      boolean;
  /** A route template with params: breadcrumbs only, never a menu item or a palette entry. */
  menu?:         false;
}

/**
 * Group order = array order. `legacy` groups (spec 078) are not in the default
 * menu: a saved menu that still names one keeps its title, and nothing else.
 */
export const NAV_GROUPS: ReadonlyArray<{ id: NavGroupId; title: string; legacy?: true }> = [
  { id: 'g_home',         title: 'Home' },
  { id: 'g_agents',       title: 'Network' },
  { id: 'g_publishing',   title: 'Publishing', legacy: true },
  { id: 'g_content',      title: 'Content', legacy: true },
  { id: 'g_analytics',    title: 'Insights' },
  { id: 'g_intelligence', title: 'Intelligence', legacy: true },
  { id: 'g_connections',  title: 'Connections', legacy: true },
  { id: 'g_marketing',    title: 'Marketing', legacy: true },
  { id: 'g_system',       title: 'System' },
];

/** The groups of the default menu, in order. */
export const DEFAULT_GROUPS = NAV_GROUPS.filter((g) => !g.legacy);

/** Always visible, whatever the saved menu says: the safety net (FR-006, open question 7). */
export const FORCED_IDS: ReadonlyArray<string> = ['overview', 'settings'];

export const NAV_REGISTRY: ReadonlyArray<NavEntry> = [
  // ── Home ──
  { id: 'overview', to: '/app', label: 'Today', icon: 'overview', defaultGroup: 'g_home', exact: true, keywords: ['home', 'dashboard', 'start', 'overview'] },
  // Spec 078: the Inbox absorbed "Posts to approve"; its counter is the unread notes plus the posts waiting.
  { id: 'agents-inbox', to: '/app/agents/inbox', label: 'Inbox', icon: 'inbox', defaultGroup: 'g_home', badge: 'agentsInbox', parent: 'agents', keywords: ['notifications', 'alerts', 'unread', 'approve', 'approvals', 'posts to approve'] },
  { id: 'chat', to: '/app/chat', label: 'Chat', icon: 'chat', defaultGroup: 'g_home', badge: 'chat', keywords: ['ai0', 'talk', 'ask', 'conversation'] },
  { id: 'approvals', to: '/app/agents/inbox', search: { tab: 'approvals' }, label: 'Posts to approve', icon: 'check', defaultGroup: 'g_home', badge: 'approvals', parent: 'agents', hiddenByDefault: true, subview: true, keywords: ['approve', 'approval', 'review', 'waiting', 'queue'] },

  // ── Network ──
  { id: 'agents', to: '/app/agents', label: 'Agents', icon: 'agents', defaultGroup: 'g_agents', badge: 'directives', keywords: ['bots', 'network', 'orchestrator', 'team'] },
  // Spec 078 wave B turns /app/calendar into the week grid; until then it redirects to Scheduled.
  { id: 'calendar', to: '/app/calendar', label: 'Calendar', icon: 'calendar', defaultGroup: 'g_agents', keywords: ['schedule', 'plan', 'slots', 'upcoming', 'week'] },
  { id: 'channels', to: '/app/channels', search: { filter: 'mine' }, label: 'Channels', icon: 'channels', defaultGroup: 'g_agents', keywords: ['telegram', 'own'] },
  // Spec 056: the whole network as a game map — who works now, what waits for you, how the channels feed each other.
  { id: 'network-map', to: '/app/map', label: 'Map', icon: 'map', defaultGroup: 'g_agents', parent: 'agents', keywords: ['map', 'game', 'network', 'live', 'avatars', 'territory'] },
  { id: 'directives', to: '/app/agents/manager', search: { tab: 'directives' }, label: 'Directives', icon: 'agents', defaultGroup: 'g_agents', badge: 'directives', parent: 'agents', hiddenByDefault: true, subview: true, keywords: ['manager', 'decisions', 'awaiting'] },
  { id: 'dm-inbox', to: '/app/dm', label: 'DM inbox', icon: 'inbox', defaultGroup: 'g_agents', badge: 'dm', hiddenByDefault: true, keywords: ['messages', 'direct', 'triage', 'ad requests', 'cross-promo'] },
  // Spec 035: which LLM each agent runs on (global default, per agent, bulk).
  { id: 'models', to: '/app/models', label: 'Models', icon: 'cpu', defaultGroup: 'g_agents', hiddenByDefault: true, keywords: ['llm', 'model', 'openrouter', 'glm', 'ai model', 'reasoning', 'default model'] },
  // Spec 048: what shapes an agent (setup, steering, rules, memory, skills, playbooks…) in one place; it replaced
  // the Setup from history (042) and Steering (045) pages.
  { id: 'artifacts', to: '/app/artifacts', label: 'Artifacts', icon: 'layers', defaultGroup: 'g_agents', parent: 'agents', hiddenByDefault: true, keywords: ['rules', 'memory', 'skills', 'playbook', 'profile', 'formatting', 'versions', 'setup from history', 'onboard', 'analyze channel', 'steering', 'reference', 'inspiration', 'like this channel', 'learn from', 'style of'] },
  { id: 'scheduled', to: '/app/scheduled', label: 'Scheduled', icon: 'calendar', defaultGroup: 'g_agents', badge: 'scheduled', hiddenByDefault: true, keywords: ['calendar', 'queue', 'planned'] },
  { id: 'compose', to: '/app/compose', label: 'Compose', icon: 'pencil', defaultGroup: 'g_agents', parent: 'scheduled', hiddenByDefault: true, keywords: ['new post', 'write', 'create'] },
  { id: 'editor', to: '/app/editor', label: 'Editor', icon: 'sparkles', defaultGroup: 'g_agents', badge: 'editor', hiddenByDefault: true, keywords: ['slots', 'plan', 'runs'] },
  { id: 'logs', to: '/app/logs', label: 'Logs', icon: 'logs', defaultGroup: 'g_agents', hiddenByDefault: true, keywords: ['history', 'published', 'runs'] },
  { id: 'data', to: '/app/data', label: 'Data', icon: 'database', defaultGroup: 'g_agents', hiddenByDefault: true, keywords: ['datasets', 'library', 'import', 'schema'] },

  // ── Insights ──
  { id: 'analytics', to: '/app/analytics', label: 'Analytics', icon: 'analytics', defaultGroup: 'g_analytics', keywords: ['stats', 'views', 'growth'] },
  { id: 'spend', to: '/app/spend', label: 'Spend', icon: 'spend', defaultGroup: 'g_analytics', keywords: ['cost', 'budget', 'tokens', 'usd', 'ai spend'] },
  // Spec 049 FR-005: connections, sources, budget headroom and stuck work in one place.
  { id: 'health', to: '/app/health', label: 'Health', icon: 'health', defaultGroup: 'g_analytics', keywords: ['network health', 'status', 'problems', 'stuck', 'failing', 'sources', 'tokens', 'budget', 'headroom', 'ops'] },
  { id: 'tracked', to: '/app/tracked', label: 'Tracked', icon: 'radar', defaultGroup: 'g_analytics', hiddenByDefault: true, keywords: ['competitors', 'watch'] },
  { id: 'discovery', to: '/app/discovery', label: 'Discovery', icon: 'discovery', defaultGroup: 'g_analytics', hiddenByDefault: true, keywords: ['find', 'search channels'] },
  { id: 'graph', to: '/app/graph', label: 'Graph', icon: 'graph', defaultGroup: 'g_analytics', hiddenByDefault: true, keywords: ['network', 'links', 'map'] },
  { id: 'recommendations', to: '/app/recommendations', label: 'Recommendations', icon: 'recommendations', defaultGroup: 'g_analytics', hiddenByDefault: true, keywords: ['suggestions', 'ideas'] },

  // ── System ──
  { id: 'settings', to: '/app/settings', label: 'Settings', icon: 'settings', defaultGroup: 'g_system', keywords: ['config', 'preferences', 'env'] },
  { id: 'settings-navigation', to: '/app/settings', search: { tab: 'navigation' }, label: 'Navigation', icon: 'menu', defaultGroup: 'g_system', parent: 'settings', hiddenByDefault: true, subview: true, keywords: ['menu', 'sidebar', 'edit menu', 'constructor'] },
  { id: 'settings-security', to: '/app/settings', search: { tab: 'security' }, label: 'Security', icon: 'lock', defaultGroup: 'g_system', parent: 'settings', hiddenByDefault: true, subview: true, keywords: ['sessions', 'sign-in', 'login', 'audit'] },
  { id: 'settings-ai', to: '/app/settings', search: { tab: 'ai' }, label: 'AI keys', icon: 'sparkles', defaultGroup: 'g_system', parent: 'settings', hiddenByDefault: true, subview: true, keywords: ['anthropic', 'openai', 'providers'] },
  { id: 'connections', to: '/app/connections', label: 'Connections', icon: 'connections', defaultGroup: 'g_system', exact: true, hiddenByDefault: true, keywords: ['sessions', 'accounts', 'integrations', 'mtproto'] },
  { id: 'groups', to: '/app/connections/groups', label: 'Groups', icon: 'users', defaultGroup: 'g_system', parent: 'connections', hiddenByDefault: true, keywords: ['meta groups', 'facebook groups'] },
  { id: 'bots', to: '/app/connections', search: { section: 'telegram', tab: 'bots' }, label: 'Bots', icon: 'bots', defaultGroup: 'g_system', parent: 'connections', hiddenByDefault: true, subview: true, keywords: ['telegram bots'] },
  { id: 'telegraph', to: '/app/connections', search: { section: 'telegram', tab: 'telegraph' }, label: 'Telegraph', icon: 'telegraph', defaultGroup: 'g_system', parent: 'connections', hiddenByDefault: true, subview: true, keywords: ['telegra.ph', 'long-form'] },
  { id: 'connections-meta', to: '/app/connections', search: { section: 'meta' }, label: 'Meta accounts', icon: 'facebook', defaultGroup: 'g_system', parent: 'connections', hiddenByDefault: true, subview: true, keywords: ['facebook', 'instagram', 'threads'] },
  { id: 'connections-tiktok', to: '/app/connections', search: { section: 'tiktok' }, label: 'TikTok accounts', icon: 'tiktok', defaultGroup: 'g_system', parent: 'connections', hiddenByDefault: true, subview: true, keywords: ['tiktok'] },
  { id: 'landing', to: '/app/landing', label: 'Landing', icon: 'globe', defaultGroup: 'g_system', hiddenByDefault: true, keywords: ['site', 'page', 'public'] },
  { id: 'ads', to: '/app/ads', label: 'Ads', icon: 'megaphone', defaultGroup: 'g_system', hiddenByDefault: true, keywords: ['orders', 'advertising', 'sales', 'revenue'] },

  // Spec 023 phase B: the legacy Strategies pages (ids `strategies`, `strategies-new`, `strategy-detail`) are
  // gone; /app/strategies* redirects to /app/agents. A saved menu that still names them lists them as unavailable.

  // ── Detail templates (breadcrumbs only) ──
  { id: 'agent-detail', to: '/app/agents/$handle', label: 'Agent', icon: 'agents', defaultGroup: 'g_agents', parent: 'agents', menu: false, keywords: [] },
  { id: 'channel-detail', to: '/app/channels/$id', label: 'Channel', icon: 'channels', defaultGroup: 'g_agents', parent: 'channels', menu: false, keywords: [] },
  { id: 'editor-channel', to: '/app/editor/$channel', label: 'Editor channel', icon: 'sparkles', defaultGroup: 'g_agents', parent: 'editor', menu: false, keywords: [] },
  { id: 'editor-run', to: '/app/editor/run/$id', label: 'Run', icon: 'sparkles', defaultGroup: 'g_agents', parent: 'editor', menu: false, keywords: [] },
  { id: 'editor-slot', to: '/app/editor/slot/$id', label: 'Slot', icon: 'calendar', defaultGroup: 'g_agents', parent: 'editor', menu: false, keywords: [] },
  { id: 'meta-account', to: '/app/connections/meta/$accountId', label: 'Meta account', icon: 'facebook', defaultGroup: 'g_system', parent: 'connections-meta', menu: false, keywords: [] },
  { id: 'dataset', to: '/app/data/$key', label: 'Dataset', icon: 'database', defaultGroup: 'g_agents', parent: 'data', menu: false, keywords: [] },
];

const BY_ID = new Map(NAV_REGISTRY.map((e) => [e.id, e]));

export function navEntry(id: string): NavEntry | undefined {
  return BY_ID.get(id);
}

/** Menu candidates: every entry that may appear in a menu (not a route template). */
export function menuEntries(registry: ReadonlyArray<NavEntry> = NAV_REGISTRY): NavEntry[] {
  return registry.filter((e) => e.menu !== false);
}

/** Ancestors of an entry, root first (the entry itself excluded). Cycles are cut. */
export function parentChain(id: string, registry: ReadonlyArray<NavEntry> = NAV_REGISTRY): NavEntry[] {
  const byId = registry === NAV_REGISTRY ? BY_ID : new Map(registry.map((e) => [e.id, e]));
  const out: NavEntry[] = [];
  const seen = new Set<string>([id]);
  let cur = byId.get(id)?.parent;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const e = byId.get(cur);
    if (!e) break;
    out.unshift(e);
    cur = e.parent;
  }
  return out;
}
