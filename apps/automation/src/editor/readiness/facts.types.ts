import type { EditorCard } from '../card';
import type { ResourceProfile } from '../agents/resource-profile';
import type { AgentSkillEntry, SkillScope } from '../agents/skill-store';
import type { Playbook, Series } from '../network/playbook';
import type { LaunchBotState, LaunchGraduation } from '../launch/launch.types';
import type { ConflictInput, OwnerRule, ResourceConfig } from '../rules/config-conflicts';
import type { SeriesPause } from '../series-pause/series-pauses.repository';
import type { ReusePolicy } from '../../data/data.types';
import type { PostRequires } from '../../data/post-requires';
import type { Quiet } from '../time/resource-time';
import type { SlotConfigCtx } from './slot-config';

/**
 * Spec 072 FR-002, A16: everything the doctor's checks read about one channel, loaded once by `loadChannelFacts` (the only
 * module that reads) and never changed by a check. Plain data, so a check is a pure function of it, and 077 can ask "what would
 * the doctor say" for a state that does not exist yet (`applyOverlay`).
 */
export interface ChannelFacts {
  now:             Date;
  /** The card's stored spelling (A27). */
  channelKey:      string;
  /** `telegram:<channelKey>`. */
  resourceRef:     string;
  card:            EditorCard & { createdAt: Date };
  /** The resource orchestrator. */
  agent:           { id: string; handle: string; mode: string } | null;
  chain:           { orchestratorId: string; executorId: string | null } | null;
  /** `full` is the whole stored profile, which the conflict input needs (A16 lists the other three). */
  profile:         { topic: string | null; language: string | null; formatPrefs: Record<string, unknown>; full: ResourceProfile | null } | null;
  group:           { id: string; name: string; mode: string } | null;
  /**
   * The group's resources, or this channel alone. `formats` (what can be produced there now), `tz` and `quiet` are for 073's
   * skeleton check: the loader fills them through `skeletonResourcesOf` (I6). A resource without `formats` is left out of it.
   */
  resources:       Array<{ ref: string; platform: string; formats?: string[]; tz?: string; quiet?: Quiet }>;
  /** Active. */
  playbook:        { id: string; version: number; body: Playbook } | null;
  pendingPlaybook: { id: string; createdAt: string } | null;
  /** Series of the active playbook on `resourceRef`, inactive ones included. */
  series:          Series[];
  pins:            Array<{ id: string; format: string | null; source: string | null; active: boolean }>;
  /** Enabled entries of the executor chain and the orchestrator chain. */
  skills:          SkillFact[];
  /** `ownerRulesOf(listActive(key, 60))`: the rules the owner wrote, without approval preferences (A19). */
  rules:           Array<{ id: number; text: string }>;
  /** `<setId>/<n>`; enabled rules without a conflict of the active sets. */
  steering:        Array<{ id: string; text: string }>;
  datasets:        DatasetFact[];
  /** Open. */
  pauses:          SeriesPause[];
  sources:         SourceFact[];
  /** 076: an egress proxy is configured (`EGRESS_PROXY_URL`), so a refused or timing-out host can be routed through it. Absent = no. */
  proxyConfigured?: boolean;
  /** 076: `EGRESS_PROXY_HOSTS` as listed now (a host on it is not offered the proxy again). Absent = none. */
  proxyHosts?:     string[];
  /** The executor's loadout allowlist; null = the role default. */
  loadoutTools:    string[] | null;
  /** `intersectAllow(card.toolsAllow, loadoutTools)`; null = no limit. */
  effectiveTools:  string[] | null;
  /** As `ConfigConflictsService.forAgent` builds it. */
  conflictInput:   ConflictInput;
  /**
   * What `deriveFacts` needs to rebuild `conflictInput` after an overlay: the rules the owner created (approval preferences
   * included, as `forAgent` selects them), the group's resource refs in `forAgent`'s order, and the configs of the refs other
   * than this channel (this channel's own is built from the card and the profile).
   */
  conflictBase:    { rules: OwnerRule[]; refs: string[]; others: ResourceConfig[] };
  launch:          { id: string; status: 'ready' | 'running'; botState: LaunchBotState | null; graduation: LaunchGraduation | null } | null;
  /** Status planned, today and tomorrow in the channel's zone. */
  planned:         PlannedSlotFact[];
  /** Closed slots of the last 24 h (by `scheduled_at`). */
  slots24h:        Array<{ status: string; error: string | null; verdict: string | null; scheduledAt: string }>;
}

export interface SkillFact {
  id: string; name: string; description: string; body: string; version: number; inline: boolean;
  origin: AgentSkillEntry['origin']; scope: SkillScope; safety: boolean; agentId: string | null;
}

export interface DatasetFact {
  id: string; key: string; entity: string; version: number;
  /** 076: the dataset's latest committed list import was made from a page the owner uploaded (re-synced only by uploading again). */
  uploaded?: boolean;
  roles: Record<string, string | string[]>; reusePolicy: ReusePolicy; postRequires: PostRequires | null;
  /** data_schema_stats; null = no stats. */
  fillRate: Record<string, number> | null;
  /** countPostable; 075 swaps in postableCount. */
  rows: number; notPostable: number; unusedPostable: number;
  /** The card and the active series of this resource that read it. */
  boundBy: Array<'card' | `series:${string}`>;
  /** instancesPerDay over the active series that read it. */
  seriesPerDay: number;
  /** Ledger use in the last 28 days. */
  used28: number;
}

export interface SourceFact {
  url: string; kind: 'rss' | 'url' | 'library' | 'api'; origin: 'card' | `series:${string}`; host: string | null;
  hostBlock: { reason: string; until: string; strikes: number } | null;
  /** The card source's id, for `origin: 'card'` (076's `source_drop` names the source by it). */
  id?: string;
  /** A12: `source_host_failures.last_success_at` of the host (migration 100); null when it never answered or before 100. */
  lastSuccessAt?: string | null;
  /** A required series' source, or the card's only source. */
  required?: boolean;
  /**
   * 076's latest stored probe of the address (`source_probes`, read from the cache only, never a live fetch); null = never probed,
   * absent for a library or api source. `detail` is the display line of the probe.
   */
  probe?: { ok: boolean; failure_class: string | null; items: number | null; newest_at: string | null; checked_at: string; detail?: string; via_proxy?: boolean } | null;
}

export interface PlannedSlotFact {
  id: string; scheduledAt: string; resourceRef: string | null; format: string;
  seriesName: string | null; sourceHints: string[]; scheduleRuleId: string | null;
  /**
   * 073's `SlotConfigCtx` of this slot, from `ScheduleService.slotConfigContext` (read only; no tools, so the tools check stays the
   * doctor's own). Absent or null = the slot names no series, or nothing is known: the config seam skips it.
   */
  configCtx?: SlotConfigCtx | null;
}
