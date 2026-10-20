import type { IconName } from '../components/ui/Icon';
import type {
  InfraKind, LevelStats, MapAgentKind, MapInfra, MapAlert, MapEventKind, MapHealth, MapMode, MapPlatform, MapRoad, MapUnit, RoadKind, UnitState,
} from '../api/map';

// Spec 056: the words, colours and glyphs of the network map — one place, so the legend, the drawers and the map agree.
// Pure data and functions (type-only imports), so node tests can import it.

export interface StateMeta {
  label: string;
  /** CSS colour of the unit's ring. */
  color: string;
  /** The tiny glyph on the unit (pen = writing, magnifier = reviewing, map = planning, clock = waiting, send = publishing…). */
  icon: IconName;
  working: boolean;
  /** What the state means, for the legend and the drawer. */
  help: string;
}

export const STATE_META: Record<UnitState, StateMeta> = {
  idle:       { label: 'Idle',       color: 'var(--color-ink-dim)',   icon: 'check',   working: false, help: 'Nothing to do right now' },
  planning:   { label: 'Planning',   color: 'var(--color-tg-link)',   icon: 'map',     working: true,  help: 'Planning the day or running an orchestration' },
  writing:    { label: 'Writing',    color: 'var(--color-accent)',    icon: 'pen',     working: true,  help: 'Writing a post' },
  reviewing:  { label: 'Reviewing',  color: 'var(--color-chart-5)',   icon: 'search',  working: true,  help: 'Reviewing a post or an idea' },
  waiting:    { label: 'Waiting',    color: 'var(--color-warning)',   icon: 'clock',   working: false, help: 'Posts wait for your approval' },
  publishing: { label: 'Publishing', color: 'var(--color-chart-6)',   icon: 'send',    working: true,  help: 'A post is going out' },
  error:      { label: 'Error',      color: 'var(--color-danger)',    icon: 'warning', working: false, help: 'The last run or a post failed' },
  paused:     { label: 'Paused',     color: 'var(--color-ink-muted)', icon: 'pause',   working: false, help: 'Paused by you or by a pause on the resource' },
  off:        { label: 'Off',        color: 'var(--color-hairline-strong)', icon: 'ban', working: false, help: 'The channel is switched off' },
};

export const isWorking = (s: UnitState): boolean => STATE_META[s].working;

/** Greyed on the map: switched off or paused. */
export const isDormant = (s: UnitState): boolean => s === 'off' || s === 'paused';

export interface PlatformMeta { label: string; icon: IconName; tint: string }
export const PLATFORM_META: Record<MapPlatform, PlatformMeta> = {
  telegram:  { label: 'Telegram',  icon: 'telegram',  tint: 'var(--color-tg-link)' },
  instagram: { label: 'Instagram', icon: 'instagram', tint: 'var(--color-chart-6)' },
  facebook:  { label: 'Facebook',  icon: 'facebook',  tint: 'var(--color-chart-5)' },
  threads:   { label: 'Threads',   icon: 'threads',   tint: 'var(--color-ink)' },
  tiktok:    { label: 'TikTok',    icon: 'tiktok',    tint: 'var(--color-chart-8)' },
  youtube:   { label: 'YouTube',   icon: 'youtube',   tint: 'var(--color-danger)' },
};

export interface InfraMeta { label: string; icon: IconName; tint: string; short: string; help: string }
export const INFRA_META: Record<InfraKind, InfraMeta> = {
  bot:       { label: 'Telegram bot',      icon: 'bots',      tint: 'var(--color-tg-link)', short: 'bot', help: 'Publishes posts to the channels it is bound to; the default bot also to channels without a bot of their own.' },
  mtproto:   { label: 'MTProto session',   icon: 'radar',     tint: 'var(--color-chart-5)', short: 'session', help: 'A Telegram user account the system logs in as.' },
  telegraph: { label: 'Telegraph account', icon: 'telegraph', tint: 'var(--color-ink)',     short: 'account', help: 'Creates the long Telegraph pages that posts link to.' },
};
const SESSION_ROLE: Record<string, { short: string; help: string }> = {
  tracker: { short: 'tracker · reads stats', help: 'Reads views, reactions and subscriber counts of the channels (the Bot API cannot).' },
  agent:   { short: 'agent · writes DMs',    help: 'The account the agents write direct messages from.' },
};
/** The words of a connection: a session's role decides its line. */
export function infraMeta(i: Pick<MapInfra, 'kind' | 'role'>): InfraMeta {
  const base = INFRA_META[i.kind];
  const role = i.kind === 'mtproto' ? SESSION_ROLE[i.role ?? 'tracker'] : null;
  return role ? { ...base, short: role.short, help: role.help } : base;
}

/** "3 channels", "2 bots": the count in a section's corner. */
export function sectionCount(t: { kind: 'network' | 'platform' | 'infra'; infra?: InfraKind; platform?: string; refs: unknown[] }): string {
  const n = t.refs.length;
  const [one, many] = t.kind === 'infra'
    ? ({ bot: ['bot', 'bots'], mtproto: ['session', 'sessions'], telegraph: ['account', 'accounts'] } as const)[t.infra ?? 'bot']
    : t.kind === 'platform' ? (t.platform === 'telegram' ? ['channel', 'channels'] : t.platform === 'facebook' ? ['page', 'pages'] : ['account', 'accounts'])
    : ['resource', 'resources'];
  return `${n} ${n === 1 ? one : many}`;
}

export const HEALTH_META: Record<MapHealth, { label: string; color: string }> = {
  ok:      { label: 'Connected',        color: 'var(--color-accent)' },
  warning: { label: 'Needs attention',  color: 'var(--color-warning)' },
  broken:  { label: 'Broken',           color: 'var(--color-danger)' },
  unknown: { label: 'Not checked yet',  color: 'var(--color-ink-dim)' },
};

export const ROAD_META: Record<RoadKind, { label: string; color: string; dash: string }> = {
  promo:     { label: 'Cross-promo', color: 'var(--color-tg-link)', dash: '6 5' },
  repost:    { label: 'Repost',      color: 'var(--color-chart-5)', dash: '2 4' },
  duplicate: { label: 'Duplicate',   color: 'var(--color-chart-7)', dash: '' },
};

const KIND_LABEL: Record<MapAgentKind, string> = {
  manager: 'Manager', builder: 'Builder', orchestrator: 'Orchestrator', planner: 'Planner', ideator: 'Ideator',
  idea_reviewer: 'Idea reviewer', executor: 'Writer', reviewer: 'Reviewer',
};
export const kindLabel = (k: MapAgentKind): string => KIND_LABEL[k] ?? k;

const MODE_LABEL: Record<MapMode, string> = { off: 'Off', shadow: 'Shadow', approve: 'Approval', live: 'Live' };
export const modeLabel = (m: MapMode): string => MODE_LABEL[m] ?? m;

/** A resource's mode on the map: the pill over a building, the badge in its drawer, the legend. */
export const MODE_META: Record<MapMode, { label: string; short: string; color: string; tone: 'success' | 'accent' | 'neutral' | 'warning'; help: string }> = {
  live:    { label: 'Live',     short: 'LIVE',   color: 'var(--color-accent)',   tone: 'success', help: 'Publishes on its own' },
  approve: { label: 'Approval', short: 'APPROVE', color: 'var(--color-tg-link)', tone: 'accent',  help: 'Writes posts; each waits for your approval' },
  shadow:  { label: 'Shadow',   short: 'SHADOW', color: 'var(--color-chart-5)',  tone: 'neutral', help: 'Writes previews only; publishes nothing' },
  off:     { label: 'Off',      short: 'OFF',    color: 'var(--color-ink-dim)',  tone: 'neutral', help: 'Switched off: nothing is planned' },
};

export const EVENT_ICON: Record<MapEventKind, IconName> = {
  run_started: 'play', run_finished: 'check', run_failed: 'warning', post_published: 'send', post_failed: 'warning',
  post_approved: 'check', post_rejected: 'x', promo: 'megaphone', directive: 'agents', launch_started: 'rocket', launch_graduated: 'rocket',
};

/** The feed line is red for failures. */
export const isBadEvent = (k: MapEventKind): boolean => k === 'run_failed' || k === 'post_failed' || k === 'post_rejected';

/** A title for a resource: its title, else @username, else the ref. */
export function resourceTitle(r: { title: string | null; username: string | null; ref: string }): string {
  return r.title?.trim() || (r.username ? `@${r.username.replace(/^@/, '')}` : r.ref.replace(/^[a-z]+:/, ''));
}

export const unitInitial = (u: Pick<MapUnit, 'name' | 'handle'>): string => (u.name.trim()[0] ?? u.handle[0] ?? '?').toUpperCase();

/** "12 s ago", "5 min ago", "3 h ago", "2 d ago". */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** en-GB clock time of a timestamp ("14:05"). */
export function clock(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function usd(x: number | null | undefined): string {
  if (x == null) return '—';
  return `$${x >= 100 ? x.toFixed(0) : x >= 1 ? x.toFixed(2) : x.toFixed(x === 0 ? 0 : 3)}`;
}

export function compactNumber(n: number | null | undefined): string {
  if (n == null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

const plural = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;

/** "12 clean approvals, 18 critic passes, 1 rejection in 30 days" — the same line the drawer explains the level with. */
export function levelLine(s: Pick<LevelStats, 'clean' | 'pass' | 'rejected' | 'failedRuns'>): string {
  const parts = [plural(s.clean, 'clean approval', 'clean approvals'), plural(s.pass, 'critic pass', 'critic passes'), plural(s.rejected, 'rejection', 'rejections')];
  if (s.failedRuns > 0) parts.push(plural(s.failedRuns, 'failed run', 'failed runs'));
  return `${parts.join(', ')} in 30 days`;
}

/** The unit's state in a sentence, with its detail: "Writing — Bridge opens". */
export function stateLine(u: Pick<MapUnit, 'state' | 'detail'>): string {
  const label = STATE_META[u.state].label;
  return u.detail ? `${label} — ${u.detail}` : label;
}

/** Order of the agent kinds around a building: orchestrator in front, role children behind in this order. */
export const KIND_ORDER: MapAgentKind[] = ['manager', 'builder', 'orchestrator', 'ideator', 'planner', 'executor', 'reviewer', 'idea_reviewer'];

export type AlertTone = 'warning' | 'danger';
const DANGER_ALERTS = new Set(['stuck', 'budget']);
export const alertTone = (kind: string): AlertTone => (DANGER_ALERTS.has(kind) ? 'danger' : 'warning');

/** What waits for the owner at each building: the sum of the alerts that name it, and how loud the beacon is. */
export function alertsByRef(alerts: MapAlert[]): Map<string, { count: number; tone: AlertTone }> {
  const out = new Map<string, { count: number; tone: AlertTone }>();
  for (const a of alerts) {
    if (!a.ref) continue;
    const cur = out.get(a.ref) ?? { count: 0, tone: 'warning' as AlertTone };
    out.set(a.ref, { count: cur.count + a.count, tone: cur.tone === 'danger' || alertTone(a.kind) === 'danger' ? 'danger' : 'warning' });
  }
  return out;
}

/** The number on the top bar's alerts button: everything that waits for the owner. */
export const alertTotal = (alerts: MapAlert[]): number => alerts.reduce((s, a) => s + a.count, 0);

/** A road's stable id (two roads between the same pair of buildings differ by direction and kind). */
export const roadKey = (r: Pick<MapRoad, 'from' | 'to' | 'kind'>): string => `${r.from}>${r.to}>${r.kind}`;
