// Spec 027 FR-001: the single source of truth for every navigable page. The
// sidebar, the ⌘K palette, the breadcrumbs and the menu constructor all read it.
//
// Rules:
// - Ids are stable slugs and are NEVER reused: a saved menu (`app_settings`
//   row `ui.nav`) stores them. Removing an entry is safe (the saved id is then
//   skipped and listed as *Unavailable*); renaming an id is not.
// - Order inside a group is the default order in the menu.
// - `hiddenByDefault` pages are reachable from ⌘K and breadcrumbs, and the owner
//   can add them to the menu; `menu: false` entries are route templates with
//   params (detail pages): they exist only for breadcrumbs and never go in a menu.
// - Hiding an item only changes the menu. Every route keeps working, so deep
//   links and bookmarks never break.
//
// Pure data (type-only imports), so node tests can import it.
import type { IconName } from '../components/ui/Icon';

export type NavGroupId =
  | 'g_home' | 'g_agents' | 'g_publishing' | 'g_content' | 'g_analytics'
  | 'g_intelligence' | 'g_connections' | 'g_marketing' | 'g_system' | 'g_legacy';

/** Which live counter an item shows (see nav/badges.ts). */
export type BadgeKey = 'approvals' | 'agents' | 'agentsInbox' | 'directives' | 'chat' | 'dm' | 'editor' | 'scheduled';

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
  /** Registered but not in the default menu. */
  hiddenByDefault?: boolean;
  /** A route template with params: breadcrumbs only, never a menu item or a palette entry. */
  menu?:         false;
}

export const NAV_GROUPS: ReadonlyArray<{ id: NavGroupId; title: string }> = [
  { id: 'g_home',         title: 'Home' },
  { id: 'g_agents',       title: 'Agents' },
  { id: 'g_publishing',   title: 'Publishing' },
  { id: 'g_content',      title: 'Content' },
  { id: 'g_analytics',    title: 'Analytics' },
  { id: 'g_intelligence', title: 'Intelligence' },
  { id: 'g_connections',  title: 'Connections' },
  { id: 'g_marketing',    title: 'Marketing' },
  { id: 'g_system',       title: 'System' },
  // Spec 023 FR-013: strategies are read-only legacy (content is run by agents).
  { id: 'g_legacy',       title: 'Legacy' },
];

/** Always visible, whatever the saved menu says: the safety net (FR-006, open question 7). */
export const FORCED_IDS: ReadonlyArray<string> = ['overview', 'settings'];

export const NAV_REGISTRY: ReadonlyArray<NavEntry> = [
  // ── Home ──
  { id: 'overview', to: '/app', label: 'Overview', icon: 'overview', defaultGroup: 'g_home', exact: true, keywords: ['home', 'dashboard', 'start'] },
  { id: 'approvals', to: '/app/agents/inbox', search: { tab: 'approvals' }, label: 'Posts to approve', icon: 'check', defaultGroup: 'g_home', badge: 'approvals', parent: 'agents', keywords: ['approve', 'approval', 'review', 'waiting', 'queue'] },

  // ── Agents ──
  { id: 'agents', to: '/app/agents', label: 'Agents', icon: 'agents', defaultGroup: 'g_agents', badge: 'agents', keywords: ['bots', 'network', 'orchestrator', 'team'] },
  { id: 'chat', to: '/app/chat', label: 'Chat', icon: 'chat', defaultGroup: 'g_agents', badge: 'chat', keywords: ['ai0', 'talk', 'ask', 'conversation'] },
  { id: 'dm-inbox', to: '/app/dm', label: 'DM inbox', icon: 'inbox', defaultGroup: 'g_agents', badge: 'dm', keywords: ['messages', 'direct', 'triage', 'ad requests', 'cross-promo'] },
  // Spec 035: which LLM each agent runs on (global default, per agent, bulk).
  { id: 'models', to: '/app/models', label: 'Models', icon: 'cpu', defaultGroup: 'g_agents', keywords: ['llm', 'model', 'openrouter', 'glm', 'ai model', 'reasoning', 'default model'] },
  { id: 'agents-inbox', to: '/app/agents/inbox', label: 'Agent inbox', icon: 'inbox', defaultGroup: 'g_agents', badge: 'agentsInbox', parent: 'agents', hiddenByDefault: true, keywords: ['notifications', 'alerts', 'unread'] },
  { id: 'directives', to: '/app/agents/manager', search: { tab: 'directives' }, label: 'Directives', icon: 'agents', defaultGroup: 'g_agents', badge: 'directives', parent: 'agents', hiddenByDefault: true, keywords: ['manager', 'decisions', 'awaiting'] },

  // ── Publishing ──
  { id: 'compose', to: '/app/compose', label: 'Compose', icon: 'pencil', defaultGroup: 'g_publishing', parent: 'scheduled', keywords: ['new post', 'write', 'create'] },
  { id: 'scheduled', to: '/app/scheduled', label: 'Scheduled', icon: 'calendar', defaultGroup: 'g_publishing', badge: 'scheduled', keywords: ['calendar', 'queue', 'planned'] },
  { id: 'editor', to: '/app/editor', label: 'Editor', icon: 'sparkles', defaultGroup: 'g_publishing', badge: 'editor', keywords: ['slots', 'plan', 'runs'] },
  { id: 'logs', to: '/app/logs', label: 'Logs', icon: 'logs', defaultGroup: 'g_publishing', keywords: ['history', 'published', 'runs'] },
  { id: 'channels', to: '/app/channels', search: { filter: 'mine' }, label: 'My channels', icon: 'channels', defaultGroup: 'g_publishing', keywords: ['telegram', 'own'] },

  // ── Content ──
  { id: 'data', to: '/app/data', label: 'Data', icon: 'database', defaultGroup: 'g_content', keywords: ['datasets', 'library', 'import', 'schema'] },

  // ── Analytics ──
  { id: 'analytics', to: '/app/analytics', label: 'Analytics', icon: 'analytics', defaultGroup: 'g_analytics', keywords: ['stats', 'views', 'growth'] },
  { id: 'spend', to: '/app/spend', label: 'Spend', icon: 'spend', defaultGroup: 'g_analytics', keywords: ['cost', 'budget', 'tokens', 'usd', 'ai spend'] },
  { id: 'tracked', to: '/app/tracked', label: 'Tracked', icon: 'radar', defaultGroup: 'g_analytics', keywords: ['competitors', 'watch'] },

  // ── Intelligence ──
  { id: 'discovery', to: '/app/discovery', label: 'Discovery', icon: 'discovery', defaultGroup: 'g_intelligence', keywords: ['find', 'search channels'] },
  { id: 'graph', to: '/app/graph', label: 'Graph', icon: 'graph', defaultGroup: 'g_intelligence', keywords: ['network', 'links', 'map'] },
  { id: 'recommendations', to: '/app/recommendations', label: 'Recommendations', icon: 'recommendations', defaultGroup: 'g_intelligence', keywords: ['suggestions', 'ideas'] },

  // ── Connections ──
  { id: 'connections', to: '/app/connections', label: 'Connections', icon: 'connections', defaultGroup: 'g_connections', exact: true, keywords: ['sessions', 'accounts', 'integrations', 'mtproto'] },
  { id: 'groups', to: '/app/connections/groups', label: 'Groups', icon: 'users', defaultGroup: 'g_connections', parent: 'connections', keywords: ['meta groups', 'facebook groups'] },
  { id: 'bots', to: '/app/connections', search: { section: 'telegram', tab: 'bots' }, label: 'Bots', icon: 'bots', defaultGroup: 'g_connections', parent: 'connections', hiddenByDefault: true, keywords: ['telegram bots'] },
  { id: 'telegraph', to: '/app/connections', search: { section: 'telegram', tab: 'telegraph' }, label: 'Telegraph', icon: 'telegraph', defaultGroup: 'g_connections', parent: 'connections', hiddenByDefault: true, keywords: ['telegra.ph', 'long-form'] },
  { id: 'connections-meta', to: '/app/connections', search: { section: 'meta' }, label: 'Meta accounts', icon: 'facebook', defaultGroup: 'g_connections', parent: 'connections', hiddenByDefault: true, keywords: ['facebook', 'instagram', 'threads'] },
  { id: 'connections-tiktok', to: '/app/connections', search: { section: 'tiktok' }, label: 'TikTok accounts', icon: 'tiktok', defaultGroup: 'g_connections', parent: 'connections', hiddenByDefault: true, keywords: ['tiktok'] },

  // ── Marketing ──
  { id: 'landing', to: '/app/landing', label: 'Landing', icon: 'globe', defaultGroup: 'g_marketing', keywords: ['site', 'page', 'public'] },
  { id: 'ads', to: '/app/ads', label: 'Ads', icon: 'megaphone', defaultGroup: 'g_marketing', keywords: ['orders', 'advertising', 'sales', 'revenue'] },

  // ── System ──
  { id: 'settings', to: '/app/settings', label: 'Settings', icon: 'settings', defaultGroup: 'g_system', keywords: ['config', 'preferences', 'env'] },
  { id: 'settings-navigation', to: '/app/settings', search: { tab: 'navigation' }, label: 'Navigation', icon: 'menu', defaultGroup: 'g_system', parent: 'settings', hiddenByDefault: true, keywords: ['menu', 'sidebar', 'edit menu', 'constructor'] },
  { id: 'settings-security', to: '/app/settings', search: { tab: 'security' }, label: 'Security', icon: 'lock', defaultGroup: 'g_system', parent: 'settings', hiddenByDefault: true, keywords: ['sessions', 'sign-in', 'login', 'audit'] },
  { id: 'settings-ai', to: '/app/settings', search: { tab: 'ai' }, label: 'AI keys', icon: 'sparkles', defaultGroup: 'g_system', parent: 'settings', hiddenByDefault: true, keywords: ['anthropic', 'openai', 'providers'] },

  // ── Legacy (spec 023 FR-013 phase A) ──
  { id: 'strategies', to: '/app/strategies', label: 'Strategies', icon: 'strategies', defaultGroup: 'g_legacy', keywords: ['bindings', 'cron', 'legacy', 'migrate'] },
  { id: 'strategies-new', to: '/app/strategies/new', label: 'New strategy', icon: 'plus', defaultGroup: 'g_legacy', parent: 'strategies', hiddenByDefault: true, keywords: ['add strategy'] },

  // ── Detail templates (breadcrumbs only) ──
  { id: 'agent-detail', to: '/app/agents/$handle', label: 'Agent', icon: 'agents', defaultGroup: 'g_agents', parent: 'agents', menu: false, keywords: [] },
  { id: 'channel-detail', to: '/app/channels/$id', label: 'Channel', icon: 'channels', defaultGroup: 'g_publishing', parent: 'channels', menu: false, keywords: [] },
  { id: 'editor-channel', to: '/app/editor/$channel', label: 'Editor channel', icon: 'sparkles', defaultGroup: 'g_publishing', parent: 'editor', menu: false, keywords: [] },
  { id: 'editor-run', to: '/app/editor/run/$id', label: 'Run', icon: 'sparkles', defaultGroup: 'g_publishing', parent: 'editor', menu: false, keywords: [] },
  { id: 'editor-slot', to: '/app/editor/slot/$id', label: 'Slot', icon: 'calendar', defaultGroup: 'g_publishing', parent: 'editor', menu: false, keywords: [] },
  { id: 'strategy-detail', to: '/app/strategies/$id', label: 'Strategy', icon: 'strategies', defaultGroup: 'g_legacy', parent: 'strategies', menu: false, keywords: [] },
  { id: 'meta-account', to: '/app/connections/meta/$accountId', label: 'Meta account', icon: 'facebook', defaultGroup: 'g_connections', parent: 'connections-meta', menu: false, keywords: [] },
  { id: 'dataset', to: '/app/data/$key', label: 'Dataset', icon: 'database', defaultGroup: 'g_content', parent: 'data', menu: false, keywords: [] },
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
