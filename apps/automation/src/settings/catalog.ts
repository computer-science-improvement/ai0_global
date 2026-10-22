/**
 * Spec 039 FR-001: the settings the dashboard edits instead of `.env`. The key is the env name (= the `app_settings` key);
 * the start-up overlay (env-overlay.ts) puts the DB value into `process.env`, so the code keeps reading `ConfigService.get` /
 * `process.env`. `default` is what the code uses when the variable is absent ('' = unset). `apply`:
 *   live    — the code reads the value on every use (tick, request, run): a change applies at once;
 *   restart — read once at boot (clients, factories, constructors, `@Cron`): applies after a restart.
 * Infrastructure stays in env (DB, Redis, encryption key, JWT, sign-in, ports, VITE_*): see INFRA_KEYS.
 */
import { RETENTION_POLICIES, SCRUB_POLICIES } from '../common/retention/retention.service';
import { EDITOR_ROLES } from '../editor/llm/model-registry';
import { DIRECTIVE_KINDS } from '../editor/manager/directives.repository';

export type SettingType = 'bool' | 'int' | 'number' | 'string' | 'enum' | 'list' | 'url' | 'cron' | 'secret';
export type SettingApply = 'live' | 'restart';

export const SETTING_GROUPS = [
  { id: 'ai',           label: 'AI providers' },
  { id: 'editor',       label: 'Editor' },
  { id: 'models',       label: 'Models (advanced)' },
  { id: 'agent',        label: 'Inbox agent' },
  { id: 'publishing',   label: 'Publishing' },
  { id: 'telegram',     label: 'Telegram' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'payments',     label: 'Payments' },
  { id: 'general',      label: 'Links' },
  { id: 'retention',    label: 'Retention' },
  { id: 'sessions',     label: 'Sessions' },
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number]['id'];

export interface SettingDef {
  key:      string;
  group:    SettingGroup;
  label:    string;
  help:     string;
  type:     SettingType;
  /** The value the code uses when the variable is absent ('' = unset). For a bool, `bool.on` or `bool.off`. */
  default:  string;
  apply:    SettingApply;
  min?:     number;
  max?:     number;
  /** enum: the allowed values; list: the allowed items (absent = free items matching `pattern`). */
  options?: readonly string[];
  /** string / list items: the shape the value must have. */
  pattern?: RegExp;
  /** bool: the strings the code understands as on / off (e.g. 'true'/'false', 'on'/'off'). */
  bool?:    { on: string; off: string };
  /** Shown with a warning on the page (payments sandbox). */
  danger?:  boolean;
}

const TF  = { on: 'true', off: 'false' } as const;
const OFF = { on: 'on', off: 'off' } as const;
const MODEL_ID = /^[A-Za-z0-9._:\/-]{2,120}$/;

const roleLabel = (r: string) => r.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Retention windows, from the retention policy tables (one source for the days and their defaults). */
const RETENTION_HELP: Record<string, string> = {
  AI_LOGS_RETENTION_DAYS:                'Legacy AI call logs are deleted after this many days.',
  POST_SNAPSHOTS_RETENTION_DAYS:         'Post statistics snapshots are deleted after this many days.',
  CHANNEL_SNAPSHOTS_RETENTION_DAYS:      'Channel statistics snapshots are deleted after this many days.',
  META_HISTORY_RETENTION_DAYS:           'Meta follower history is deleted after this many days.',
  TRACKED_POST_HISTORY_RETENTION_DAYS:   'Metrics history of tracked posts is deleted after this many days.',
  TRACKED_SUBS_HISTORY_RETENTION_DAYS:   'Subscriber history of tracked channels is deleted after this many days.',
  STRATEGY_RUNS_RETENTION_DAYS:          'Legacy strategy run traces are deleted after this many days.',
  EDITOR_RUN_STEPS_RETENTION_DAYS:       'Step-by-step traces of editor runs are deleted after this many days.',
  EDITOR_RUNS_RETENTION_DAYS:            'Editor run summaries (cost, tokens, status) are deleted after this many days.',
  TRACKED_POST_TEXT_RETENTION_DAYS:      'Texts of tracked posts are cleared after this many days; the metrics stay.',
  AGENT_DM_TEXT_RETENTION_DAYS:          'Private message texts and replies of the inbox agent are cleared after this many days.',
  AGENT_OPPORTUNITY_TEXT_RETENTION_DAYS: 'Message texts of agent opportunities are cleared after this many days.',
  CANDIDATE_RAW_PAYLOAD_RETENTION_DAYS:  'Raw marketplace payloads of candidate channels are cleared after this many days.',
  LANDING_LEAD_PURGE_DAYS:               'Lost or spam landing leads lose their message and links after this many days.',
};

const retention: SettingDef[] = [...RETENTION_POLICIES, ...SCRUB_POLICIES].map((p) => ({
  key: p.envDays, group: 'retention' as const,
  label: roleLabel(p.envDays.replace(/_RETENTION_DAYS$|_PURGE_DAYS$/, '').toLowerCase()) + ' (days)',
  help: `${RETENTION_HELP[p.envDays] ?? `Rows of ${p.table} older than this many days are removed.`} 0 = keep forever.`,
  type: 'int' as const, default: String(p.defaultDays), apply: 'live' as const, min: 0, max: 3650,
}));

const roleModels: SettingDef[] = EDITOR_ROLES.flatMap((role) => {
  const R = role.toUpperCase();
  return [
    { key: `EDITOR_MODEL_${R}`, group: 'models' as const, label: `${roleLabel(role)} model (OpenRouter)`,
      help: `Forces the ${role.replace(/_/g, ' ')} role onto this OpenRouter model, above the default on the Models page (an agent's own model still wins).`,
      type: 'string' as const, default: '', apply: 'live' as const, pattern: MODEL_ID },
    { key: `EDITOR_ANTHROPIC_MODEL_${R}`, group: 'models' as const, label: `${roleLabel(role)} model (Anthropic)`,
      help: `The same for the Anthropic workspace.`,
      type: 'string' as const, default: '', apply: 'live' as const, pattern: MODEL_ID },
    { key: `EDITOR_REASONING_${R}`, group: 'models' as const, label: `${roleLabel(role)} reasoning effort`,
      help: `Reasoning effort of the ${role.replace(/_/g, ' ')} role (an agent's own effort wins). Empty = the general effort, then the role default.`,
      type: 'enum' as const, default: '', apply: 'live' as const, options: ['low', 'medium', 'high'] },
  ];
});

export const SETTINGS: readonly SettingDef[] = [
  // ── AI providers ───────────────────────────────────────────────────────────
  { key: 'OPENROUTER_API_KEY', group: 'ai', label: 'OpenRouter API key', help: 'The editor agents run on OpenRouter with this key (OpenRouter workspace).', type: 'secret', default: '', apply: 'restart' },
  { key: 'OPENROUTER_BASE_URL', group: 'ai', label: 'OpenRouter base URL', help: 'Empty = https://openrouter.ai/api/v1.', type: 'url', default: '', apply: 'restart' },
  { key: 'EDITOR_ANTHROPIC_API_KEY', group: 'ai', label: 'Anthropic API key (agents)', help: 'Key of the Anthropic workspace (the Console organization linked to your Claude plan). Empty = the general Anthropic key below.', type: 'secret', default: '', apply: 'restart' },
  { key: 'ANTHROPIC_API_KEY', group: 'ai', label: 'Anthropic API key (general)', help: 'Used by the legacy AI features, and by the agents when the key above is empty.', type: 'secret', default: '', apply: 'restart' },
  { key: 'ANTHROPIC_BASE_URL', group: 'ai', label: 'Anthropic base URL', help: 'Empty = https://api.anthropic.com.', type: 'url', default: '', apply: 'restart' },
  { key: 'OPENAI_API_KEY', group: 'ai', label: 'OpenAI API key', help: 'Legacy AI features.', type: 'secret', default: '', apply: 'restart' },
  { key: 'PERPLEXITY_API_KEY', group: 'ai', label: 'Perplexity API key', help: 'Legacy AI features (web research).', type: 'secret', default: '', apply: 'restart' },
  { key: 'GROK_API_KEY', group: 'ai', label: 'Grok API key', help: 'Legacy AI features.', type: 'secret', default: '', apply: 'restart' },

  // ── Editor ─────────────────────────────────────────────────────────────────
  { key: 'EDITOR_ENABLED', group: 'editor', label: 'Editor agents', help: 'Master switch of the autonomous editor: off = no editor runs on any channel.', type: 'bool', bool: TF, default: 'false', apply: 'live' },
  { key: 'EDITOR_CRITIC', group: 'editor', label: 'Pre-publish critic', help: 'Every post is scored by the critic before it is published or sent for approval.', type: 'bool', bool: OFF, default: 'on', apply: 'restart' },
  { key: 'EDITOR_ORCHESTRATION', group: 'editor', label: 'Network orchestrator', help: 'The orchestrator agent plans the network and hands work to channel agents.', type: 'bool', bool: OFF, default: 'on', apply: 'restart' },
  { key: 'EDITOR_FALLBACK_LADDER', group: 'editor', label: 'Fallback ladder', help: 'When a slot finds no fresh story the editor steps down to reposts, evergreen and other fallbacks instead of skipping.', type: 'bool', bool: OFF, default: 'on', apply: 'restart' },
  { key: 'EDITOR_SHADOW_PREVIEW', group: 'editor', label: 'Shadow previews to the owner', help: 'In shadow mode, send the post the editor would have published to the owner in Telegram.', type: 'bool', bool: TF, default: 'true', apply: 'restart' },
  { key: 'EDITOR_STORY_BACKFILL', group: 'editor', label: 'Story registry backfill', help: 'At start, fill the story registry from already published posts.', type: 'bool', bool: OFF, default: 'on', apply: 'restart' },
  { key: 'EDITOR_EVERGREEN_PER_DAY', group: 'editor', label: 'Evergreen posts per day', help: 'Evergreen posts per channel per day on the fallback ladder (0 = off).', type: 'int', default: '1', apply: 'restart', min: 0, max: 10 },
  { key: 'EDITOR_STORY_REPOSTS_PER_STORY', group: 'editor', label: 'Reposts per story', help: 'How many times one story may be reposted into a channel.', type: 'int', default: '1', apply: 'restart', min: 0, max: 10 },
  { key: 'EDITOR_STORY_REPOSTS_PER_DAY', group: 'editor', label: 'Reposts per day', help: 'Story reposts per channel per day.', type: 'int', default: '2', apply: 'restart', min: 0, max: 20 },
  { key: 'EDITOR_CHAT_TURN_MAX_USD', group: 'editor', label: 'Chat turn cap (USD)', help: 'One chat answer stops once it has cost this much; the reply says what was done. 0 = off. The daily chat cap is on Spend → Budgets (editor.chat).', type: 'number', default: '0.3', apply: 'live', min: 0, max: 10 },
  { key: 'AUDITOR_ENABLED', group: 'editor', label: 'Weekly audit by @sysadmin', help: 'Once a week @sysadmin checks skills, memory, rules and tools and posts a report (Artifacts → Audits). It changes nothing by itself. Off = no weekly run; /audit still works.', type: 'bool', bool: TF, default: 'true', apply: 'live' },
  { key: 'AUDITOR_LLM', group: 'editor', label: 'Audit: model comments', help: 'on = after the checks of the code, one bounded model pass writes the summary, comments and a few findings of its own; off = the report has the code checks only.', type: 'bool', bool: OFF, default: 'on', apply: 'live' },
  { key: 'AUDITOR_WEEKDAY', group: 'editor', label: 'Audit weekday', help: 'The day of the weekly audit: 1 = Monday … 7 = Sunday (Kyiv time).', type: 'int', default: '1', apply: 'live', min: 1, max: 7 },
  { key: 'AUDITOR_AT', group: 'editor', label: 'Audit time (Kyiv)', help: 'When the weekly audit runs on its day (HH:MM, Kyiv time).', type: 'string', default: '06:30', apply: 'live', pattern: /^([01]\d|2[0-3]):[0-5]\d$/ },
  { key: 'AUDITOR_BUDGET_USD', group: 'editor', label: 'Audit model cap (USD)', help: 'One audit pass stops once it has cost this much; the report then has the code checks only.', type: 'number', default: '0.15', apply: 'live', min: 0.01, max: 5 },
  { key: 'SKILL_PROBE_PER_DAY', group: 'editor', label: 'Skill probes per day', help: 'An agent\'s edit of a skill is tried on recent posts (old text against new, dry runs, no publishing) before it goes live. This is how many edits are probed per day; the rest wait for the next day. 0 = off: edits go live at once, as before.', type: 'int', default: '3', apply: 'live', min: 0, max: 20 },
  { key: 'SKILL_PROBE_SAMPLES', group: 'editor', label: 'Skill probe: posts per edit', help: 'How many of the latest published or approved posts of the agent\'s scope a skill probe re-writes with the old and the new text.', type: 'int', default: '3', apply: 'live', min: 1, max: 5 },
  { key: 'SKILL_PROBE_BUDGET_USD', group: 'editor', label: 'Skill probe cap (USD)', help: 'One probe stops once its dry runs and the judge have cost this much; it then ends as inconclusive with what it gathered and the edit goes live as before.', type: 'number', default: '0.3', apply: 'live', min: 0, max: 2 },
  { key: 'EDITOR_CRITIC_REJECT_STREAK', group: 'editor', label: 'Critic reject streak', help: 'After this many critic rejections in a row the owner is alerted.', type: 'int', default: '3', apply: 'restart', min: 1, max: 20 },
  { key: 'LAUNCH_GRADUATION', group: 'editor', label: 'Launch graduation', help: 'When a launched channel meets the criteria in approval mode: propose = a "Ready to go live" card, auto = it goes live by itself, off = nothing.', type: 'enum', default: 'propose', apply: 'live', options: ['propose', 'auto', 'off'] },
  { key: 'LAUNCH_GRADUATE_MIN_DAYS', group: 'editor', label: 'Launch: days in approval', help: 'Days in approval mode since Start before a launched channel can go live.', type: 'int', default: '7', apply: 'live', min: 1, max: 60 },
  { key: 'LAUNCH_GRADUATE_MIN_APPROVED', group: 'editor', label: 'Launch: approved posts', help: 'Approved posts since Start before a launched channel can go live.', type: 'int', default: '10', apply: 'live', min: 1, max: 200 },
  { key: 'LAUNCH_GRADUATE_MIN_CLEAN_PCT', group: 'editor', label: 'Launch: approved without edits (%)', help: 'Share of the approved posts approved without edits.', type: 'int', default: '80', apply: 'live', min: 0, max: 100 },
  { key: 'LAUNCH_GRADUATE_MIN_CRITIC_PCT', group: 'editor', label: 'Launch: critic pass rate (%)', help: 'Critic pass rate since Start, over at least 5 verdicts.', type: 'int', default: '80', apply: 'live', min: 0, max: 100 },
  { key: 'SETUP_PROPOSAL_TTL_DAYS', group: 'editor', label: 'Setup proposals expire after (days)', help: 'A setup-from-history proposal nobody applied for this many days closes by itself (expired). Sections already applied stay. 0 = never expire.', type: 'int', default: '14', apply: 'live', min: 0, max: 365 },
  { key: 'DIRECTIVE_TIMEOUT_HOURS', group: 'editor', label: 'Directive timeout (hours)', help: 'A MANAGER directive with no owner answer expires after this many hours.', type: 'number', default: '12', apply: 'restart', min: 1, max: 720 },
  { key: 'DIRECTIVE_TIMEOUT_APPLY_KINDS', group: 'editor', label: 'Directives applied on timeout', help: 'Directive kinds that are applied (not dropped) when the owner does not answer in time.', type: 'list', default: '', apply: 'restart', options: DIRECTIVE_KINDS },
  { key: 'DIRECTIVE_CONTEST_TIMEOUT_HOURS', group: 'editor', label: 'Contest timeout (hours)', help: 'How long a channel agent may contest a directive before it applies.', type: 'number', default: '24', apply: 'restart', min: 1, max: 720 },
  { key: 'LEDGER_REUSABLE_HOSTS', group: 'editor', label: 'Reference-document hosts', help: 'Hosts of reference documents (laws, standards) that posts may cite many times. A post on such a host is stopped only when it cites the same clause (source.anchor or the #fragment of the link) a second time; different clauses are allowed.', type: 'list', default: 'zakon.rada.gov.ua', apply: 'live', pattern: /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i },

  // ── Models (advanced) ──────────────────────────────────────────────────────
  { key: 'EDITOR_REASONING', group: 'models', label: 'Reasoning effort (all roles)', help: 'Reasoning effort of every role without its own setting (an agent\'s own effort wins). Empty = the role defaults.', type: 'enum', default: '', apply: 'live', options: ['low', 'medium', 'high'] },
  ...roleModels,
  { key: 'POST_GEN_MODEL', group: 'models', label: 'Legacy post generation model', help: 'Model of the legacy post generator (Anthropic SDK).', type: 'string', default: 'claude-sonnet-4-6', apply: 'live', pattern: MODEL_ID },

  // ── Inbox agent ────────────────────────────────────────────────────────────
  { key: 'AGENT_ENABLED', group: 'agent', label: 'Inbox agent', help: 'Reads the Telegram inbox, sorts messages and drafts replies.', type: 'bool', bool: TF, default: 'false', apply: 'live' },
  { key: 'AGENT_CHAT_ENABLED', group: 'agent', label: 'Chat classifier', help: 'Classifies messages in the channels\' chats.', type: 'bool', bool: TF, default: 'false', apply: 'live' },
  { key: 'AGENT_POLL_CRON', group: 'agent', label: 'Inbox poll schedule', help: 'Cron schedule of the inbox poll.', type: 'cron', default: '*/5 * * * *', apply: 'restart' },
  { key: 'AGENT_CHAT_POLL_CRON', group: 'agent', label: 'Chat poll schedule', help: 'Cron schedule of the chat classifier.', type: 'cron', default: '*/15 * * * *', apply: 'restart' },
  { key: 'AGENT_CHAT_MAX', group: 'agent', label: 'Chat messages per poll', help: 'At most this many chat messages are classified per poll.', type: 'int', default: '20', apply: 'live', min: 1, max: 200 },
  { key: 'AGENT_REPLY_DAILY_CAP', group: 'agent', label: 'Replies per day', help: 'At most this many approved replies are sent per day.', type: 'int', default: '20', apply: 'live', min: 1, max: 500 },
  { key: 'AGENT_TRIAGE_MODEL', group: 'agent', label: 'Triage model', help: 'Model that sorts inbox and chat messages. Empty = the service default.', type: 'string', default: '', apply: 'live', pattern: MODEL_ID },
  { key: 'AGENT_TRIAGE_MAX_TOKENS', group: 'agent', label: 'Triage max tokens', help: 'Output limit of one triage call.', type: 'int', default: '800', apply: 'live', min: 100, max: 8000 },

  // ── Publishing ─────────────────────────────────────────────────────────────
  { key: 'POSTING_COOLDOWN_MIN', group: 'publishing', label: 'Telegram cooldown (min)', help: 'Minimum gap between two posts in one Telegram channel.', type: 'int', default: '20', apply: 'live', min: 1, max: 1440 },
  { key: 'INSTAGRAM_COOLDOWN_MIN', group: 'publishing', label: 'Instagram cooldown (min)', help: 'Minimum gap between two Instagram posts of one account.', type: 'int', default: '30', apply: 'live', min: 1, max: 1440 },
  { key: 'FACEBOOK_COOLDOWN_MIN', group: 'publishing', label: 'Facebook cooldown (min)', help: 'Minimum gap between two Facebook posts of one page.', type: 'int', default: '15', apply: 'live', min: 1, max: 1440 },
  { key: 'THREADS_COOLDOWN_MIN', group: 'publishing', label: 'Threads cooldown (min)', help: 'Minimum gap between two Threads posts of one account.', type: 'int', default: '10', apply: 'live', min: 1, max: 1440 },
  { key: 'SEMANTIC_DEDUP_HOURS', group: 'publishing', label: 'Duplicate window (hours)', help: 'A post too similar to one published in this window is held back.', type: 'int', default: '8', apply: 'live', min: 1, max: 720 },
  { key: 'FETCH_TIMEOUT', group: 'publishing', label: 'Meta API timeout (ms)', help: 'Timeout of one Meta Graph API request.', type: 'int', default: '15000', apply: 'live', min: 1000, max: 120000 },
  { key: 'META_GRAPH_VERSION', group: 'publishing', label: 'Facebook Graph API version', help: 'Graph API version for Facebook and Instagram.', type: 'string', default: 'v21.0', apply: 'live', pattern: /^v\d{1,2}\.\d{1,2}$/ },
  { key: 'THREADS_GRAPH_VERSION', group: 'publishing', label: 'Threads API version', help: 'Threads has its own API version line.', type: 'string', default: 'v1.0', apply: 'live', pattern: /^v\d{1,2}\.\d{1,2}$/ },
  { key: 'TIKTOK_PRIVACY_LEVEL', group: 'publishing', label: 'TikTok privacy', help: 'Who sees TikTok posts. SELF_ONLY until the app passes TikTok\'s audit.', type: 'enum', default: 'SELF_ONLY', apply: 'live', options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR'] },
  { key: 'SUPABASE_URL', group: 'publishing', label: 'Supabase URL', help: 'Image hosting for carousels (Instagram / Threads / TikTok need public image URLs).', type: 'url', default: '', apply: 'live' },
  { key: 'SUPABASE_SERVICE_KEY', group: 'publishing', label: 'Supabase service key', help: 'Key that uploads carousel images.', type: 'secret', default: '', apply: 'live' },
  { key: 'SUPABASE_CAROUSEL_BUCKET', group: 'publishing', label: 'Supabase bucket', help: 'Public bucket for carousel images.', type: 'string', default: '', apply: 'live', pattern: /^[a-z0-9][a-z0-9._-]{1,62}$/ },

  // ── Telegram ───────────────────────────────────────────────────────────────
  { key: 'TELEGRAM_OWNER_ID', group: 'telegram', label: 'Owner chat id', help: 'Your Telegram user id: alerts, approvals and the admin bot go there.', type: 'string', default: '', apply: 'restart', pattern: /^-?\d{3,20}$/ },
  { key: 'TRACKING_ENABLED', group: 'telegram', label: 'Tracking', help: 'Collect statistics of tracked channels and posts.', type: 'bool', bool: TF, default: 'false', apply: 'live' },
  { key: 'TELEGRAM_TRACKING_SHARE_SESSION', group: 'telegram', label: 'Share the stats session with tracking', help: 'Tracking uses the statistics MTProto session instead of its own.', type: 'bool', bool: TF, default: 'false', apply: 'restart' },
  { key: 'STATS_POST_AGE_DAYS', group: 'telegram', label: 'Stats post age (days)', help: 'Statistics are collected for posts younger than this.', type: 'int', default: '30', apply: 'live', min: 1, max: 365 },
  { key: 'TRACKING_BATCH_SIZE', group: 'telegram', label: 'Tracking batch size', help: 'Channels checked per tracking tick.', type: 'int', default: '50', apply: 'restart', min: 1, max: 500 },
  { key: 'TRACKING_VIEW_TO_SUB_RATE', group: 'telegram', label: 'View-to-subscriber rate', help: 'Share of views assumed to turn into subscribers in the ROI estimate.', type: 'number', default: '0.02', apply: 'live', min: 0, max: 1 },
  { key: 'TELEGRAM_API_ID', group: 'telegram', label: 'MTProto API id (fallback)', help: 'Used only when the MTProto session on the Connections page has no API id.', type: 'string', default: '', apply: 'restart', pattern: /^\d{3,12}$/ },
  { key: 'TELEGRAM_API_HASH', group: 'telegram', label: 'MTProto API hash (fallback)', help: 'Used only when the MTProto session on the Connections page has no API hash.', type: 'secret', default: '', apply: 'restart' },
  { key: 'TELEGRAM_SESSION_STRING', group: 'telegram', label: 'Stats session (fallback)', help: 'MTProto session string used when no statistics session is set on the Connections page.', type: 'secret', default: '', apply: 'restart' },
  { key: 'TELEGRAM_TRACKING_SESSION_STRING', group: 'telegram', label: 'Tracking session (fallback)', help: 'MTProto session string used when no tracking session is set on the Connections page.', type: 'secret', default: '', apply: 'restart' },
  // Spec 012: the owner bot (cards with buttons in the owner chat, the daily and weekly reports). Read on every sweep.
  { key: 'OWNER_BOT_CARDS', group: 'telegram', label: 'Owner bot cards', help: 'Things that wait for you come to Telegram as cards with buttons. Off brings back the plain inbox alerts.', type: 'bool', bool: OFF, default: 'on', apply: 'live' },
  { key: 'OWNER_QUIET_HOURS', group: 'telegram', label: 'Quiet hours (Kyiv)', help: 'Hours when only critical cards are sent, as start-end (23-8). "off" turns quiet hours off.', type: 'string', default: '23-8', apply: 'live', pattern: /^(off|([01]?\d|2[0-3])-([01]?\d|2[0-3]))$/ },
  { key: 'OWNER_BOT_MAX_PER_HOUR', group: 'telegram', label: 'Cards per hour', help: 'At most this many cards are sent per hour; critical cards first, the rest wait.', type: 'int', default: '30', apply: 'live', min: 1, max: 200 },
  { key: 'OWNER_DAILY_REPORT_AT', group: 'telegram', label: 'Daily summary at (Kyiv)', help: 'When the daily summary is sent (HH:MM). "off" turns it off.', type: 'string', default: '21:00', apply: 'live', pattern: /^(off|([01]\d|2[0-3]):[0-5]\d)$/ },
  { key: 'OWNER_WEEKLY_REPORT_AT', group: 'telegram', label: 'Weekly report at (Kyiv)', help: 'When the weekly report is sent, as "Mon 09:00". "off" turns it off.', type: 'string', default: 'Mon 09:00', apply: 'live', pattern: /^(off|(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([01]\d|2[0-3]):[0-5]\d)$/ },

  // ── Integrations ───────────────────────────────────────────────────────────
  { key: 'STATS_API_KEY', group: 'integrations', label: 'Stats API key', help: 'Key external clients send in X-API-Key to read the stats API.', type: 'secret', default: '', apply: 'live' },
  { key: 'NASA_API_KEY', group: 'integrations', label: 'NASA API key', help: 'Astronomy picture of the day source. Empty = NASA\'s DEMO_KEY (low rate limit).', type: 'secret', default: '', apply: 'live' },
  { key: 'TMDB_API_KEY', group: 'integrations', label: 'TMDB API key', help: 'Trending movies and series source.', type: 'secret', default: '', apply: 'live' },
  { key: 'TIKTOK_CLIENT_KEY', group: 'integrations', label: 'TikTok client key', help: 'TikTok app for connecting accounts.', type: 'secret', default: '', apply: 'live' },
  { key: 'TIKTOK_CLIENT_SECRET', group: 'integrations', label: 'TikTok client secret', help: 'TikTok app secret.', type: 'secret', default: '', apply: 'live' },
  { key: 'TIKTOK_REDIRECT_URI', group: 'integrations', label: 'TikTok redirect URI', help: 'Must match the redirect URI registered in the TikTok app.', type: 'url', default: '', apply: 'live' },
  { key: 'TIKTOK_SCOPES', group: 'integrations', label: 'TikTok scopes', help: 'Permissions asked when an account is connected.', type: 'list', default: 'user.info.basic,video.publish', apply: 'live', pattern: /^[a-z][a-z0-9._]{2,60}$/ },

  // ── Payments ───────────────────────────────────────────────────────────────
  { key: 'LIQPAY_PUBLIC_KEY', group: 'payments', label: 'LiqPay public key', help: 'Ad orders are paid through LiqPay.', type: 'string', default: '', apply: 'live', pattern: /^[A-Za-z0-9_-]{4,120}$/ },
  { key: 'LIQPAY_PRIVATE_KEY', group: 'payments', label: 'LiqPay private key', help: 'Signs payment requests and checks LiqPay callbacks.', type: 'secret', default: '', apply: 'live' },
  { key: 'LIQPAY_SANDBOX', group: 'payments', label: 'LiqPay sandbox', help: 'Accept sandbox (test) payments as paid. Keep off in production.', type: 'bool', bool: TF, default: 'false', apply: 'live', danger: true },
  { key: 'AD_STUCK_CHECK', group: 'payments', label: 'Stuck order check', help: 'Alert the owner about paid ad orders that are stuck.', type: 'bool', bool: OFF, default: 'on', apply: 'live' },

  // ── Links ──────────────────────────────────────────────────────────────────
  { key: 'DASHBOARD_URL', group: 'general', label: 'Dashboard URL', help: 'Links in alerts, payment pages and ad reports point here.', type: 'url', default: '', apply: 'restart' },
  { key: 'PUBLIC_BASE_URL', group: 'general', label: 'Public base URL', help: 'Base of the promo redirect links. Empty = the dashboard URL.', type: 'url', default: '', apply: 'restart' },

  // ── Retention ──────────────────────────────────────────────────────────────
  { key: 'RETENTION_ENABLED', group: 'retention', label: 'Nightly cleanup', help: 'At 03:00 delete or clear the rows older than the windows below.', type: 'bool', bool: TF, default: 'false', apply: 'live' },
  ...retention,
  { key: 'LLM_USAGE_RETENTION_DAYS', group: 'retention', label: 'LLM usage (days)', help: 'Per-call LLM usage rows are rolled up into daily totals after this many days.', type: 'int', default: '90', apply: 'restart', min: 1, max: 3650 },

  // ── Sessions ───────────────────────────────────────────────────────────────
  { key: 'AUTH_ACCESS_TTL_MIN', group: 'sessions', label: 'Access token lifetime (min)', help: 'The dashboard renews it silently while the session lives.', type: 'int', default: '60', apply: 'restart', min: 5, max: 1440 },
  { key: 'AUTH_IDLE_TTL_DAYS', group: 'sessions', label: 'Idle timeout (days)', help: 'A session unused this long signs out.', type: 'int', default: '7', apply: 'restart', min: 1, max: 90 },
  { key: 'AUTH_ABSOLUTE_TTL_DAYS', group: 'sessions', label: 'Session lifetime (days)', help: 'A session signs out after this long, used or not.', type: 'int', default: '30', apply: 'restart', min: 1, max: 365 },
  { key: 'AUTH_EVENTS_RETENTION_DAYS', group: 'sessions', label: 'Sign-in log (days)', help: 'Sign-in audit events are kept this long.', type: 'int', default: '180', apply: 'restart', min: 1, max: 3650 },
];

/** Never in the catalog: needed before the DB connects, decrypts the DB, guards sign-in, or read outside this process. */
export const INFRA_KEYS: readonly string[] = [
  'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'DATABASE_URL', 'REDIS_URL', 'REDIS_PASSWORD',
  'TOKEN_ENCRYPTION_KEY', 'NODE_ENV', 'PORT', 'SWAGGER_ENABLED', 'DATA_IMPORT_DIR', 'JWT_SECRET', 'TRACKING_TOKEN', 'ALLOW_NO_AUTH',
  'PROMO_HASH_SALT', 'TELEGRAM_BOT_TOKEN', 'TRACKING_ALLOWED_TG_USER_IDS', 'SCHEDULER_TZ', 'EDITOR_API_URL', 'EDITOR_MCP_ALLOW_LIVE_RUN',
];

const BY_KEY = new Map(SETTINGS.map((d) => [d.key, d]));

export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

export const isSecret = (d: SettingDef): boolean => d.type === 'secret';

/**
 * Validates and normalizes a value for a setting (trimmed; lists joined with ','). Returns the stored string, or
 * `{ error }` with a reason the page can show. An empty value is not a value: reset the setting instead.
 */
export function normalizeSetting(d: SettingDef, raw: unknown): { value: string } | { error: string } {
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return { error: 'expected a string' };
  const v = String(raw).trim();
  if (!v) return { error: 'empty: use reset to clear the setting' };
  if (/[\r\n\0]/.test(v)) return { error: 'must be one line' };
  const bounds = (n: number): string | null =>
    d.min !== undefined && n < d.min ? `must be ≥ ${d.min}` : d.max !== undefined && n > d.max ? `must be ≤ ${d.max}` : null;
  switch (d.type) {
    case 'bool': {
      const b = d.bool ?? TF;
      if (v === b.on || v === b.off) return { value: v };
      if (v === 'true' || v === 'false') return { value: v === 'true' ? b.on : b.off };
      return { error: `must be ${b.on} or ${b.off}` };
    }
    case 'int': {
      if (!/^-?\d+$/.test(v)) return { error: 'must be a whole number' };
      const e = bounds(Number(v));
      return e ? { error: e } : { value: String(Number(v)) };
    }
    case 'number': {
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: 'must be a number' };
      const e = bounds(n);
      return e ? { error: e } : { value: String(n) };
    }
    case 'enum':
      return d.options?.includes(v) ? { value: v } : { error: `must be one of ${(d.options ?? []).join(', ')}` };
    case 'list': {
      const items = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
      if (!items.length) return { error: 'empty: use reset to clear the setting' };
      for (const it of items) {
        if (d.options && !d.options.includes(it)) return { error: `unknown item ${it}: allowed ${d.options.join(', ')}` };
        if (d.pattern && !d.pattern.test(it)) return { error: `bad item ${it}` };
      }
      return { value: items.join(',') };
    }
    case 'url': {
      let u: URL;
      try { u = new URL(v); } catch { return { error: 'must be a URL' }; }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'must be an http(s) URL' };
      return v.length > 500 ? { error: 'too long' } : { value: v };
    }
    case 'cron': {
      const f = v.split(/\s+/);
      if ((f.length !== 5 && f.length !== 6) || !f.every((x) => /^[\d*/,\-?LW#A-Za-z]+$/.test(x))) {
        return { error: 'must be a cron expression of 5 or 6 fields, e.g. */5 * * * *' };
      }
      return { value: f.join(' ') };
    }
    case 'secret':
      if (/\s/.test(v)) return { error: 'must not contain spaces' };
      return v.length > 4096 ? { error: 'too long' } : { value: v };
    case 'string':
    default:
      if (v.length > 500) return { error: 'too long' };
      if (d.pattern && !d.pattern.test(v)) return { error: 'has the wrong format' };
      return { value: v };
  }
}
