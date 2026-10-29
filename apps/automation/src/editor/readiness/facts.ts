import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { resourceRef, type Platform } from '../agents/agent.types';
import { AgentsRepository } from '../agents/agents.repository';
import { profileCaps, ResourceProfilesRepository, type ResourceProfile } from '../agents/resource-profile';
import { SkillStore, type AgentSkillEntry } from '../agents/skill-store';
import type { EditorCard } from '../card';
import { LoadoutRepository } from '../loadout/loadout.repository';
import { intersectAllow, LoadoutService } from '../loadout/loadout.service';
import type { LaunchBotState, LaunchGraduation } from '../launch/launch.types';
import { feedKey, hostOf } from '../net/host-failures';
import { egressProxyConfigured } from '../net/safe-http';
import { NetworkRepository } from '../network/network.repository';
import type { Playbook, Series } from '../network/playbook';
import { instancesPerDay, parseCadence, seriesSourceLabel, SeriesSourceSchema } from '../network/series';
import { normalizePlaybook } from '../network/series-edit';
import { slotSeriesOf } from '../post/polls/poll-cap-guard';
import type { EditorSlot } from '../repo/editor-plans.repository';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { localDate, zonedToUtc } from '../roles/time';
import type { ConflictInput, OwnerRule, ResourceConfig } from '../rules/config-conflicts';
import { ownerRulesOf } from '../rules/owner-rules-prompt';
import { SeriesPausesRepository } from '../series-pause/series-pauses.repository';
import { SteeringRepository } from '../steering/steering.repository';
import { PgSourceProbes } from '../sources/source-probes.repository';
import { ledgerUsage } from '../tools/catalog-context';
import { resourceKeys, usedRefsCte } from '../../data/data-refs';
import type { ChannelFacts, DatasetFact, PlannedSlotFact, SkillFact, SourceFact } from './facts.types';
import { skeletonResourcesOf } from './plan-skeleton';
import type { SlotConfigCtx } from './slot-config';

/**
 * Spec 072 FR-002: the one module that reads for the channel doctor. `loadChannelFacts` loads one channel in a fixed number of
 * queries and writes nothing; the checks only look at what it returns. The rest of the file is pure: `deriveFacts` (what follows
 * from the loaded parts), `configHash` (which parts are configuration) and `applyOverlay` (the facts of a state that does not
 * exist yet, for 077).
 */

// ── pure: derived fields ──────────────────────────────────────────────────────────────────────────────────────────

/** What the loader reads; `deriveFacts` adds the rest. `series` given = used as it is (an overlay); absent = from the playbook. */
export type RawFacts = Omit<ChannelFacts, 'series' | 'effectiveTools' | 'conflictInput' | 'datasets' | 'sources'> & {
  series?: Series[];
  datasets: Array<Omit<DatasetFact, 'boundBy' | 'seriesPerDay'>>;
  sources: Array<Omit<SourceFact, 'required'>>;
};

/** The series of a playbook on one resource (inactive ones included). */
export const seriesOn = (pb: Playbook | null | undefined, ref: string): Series[] => (pb?.series ?? []).filter((s) => s.resource_ref === ref);

const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** How the card and the active series bind a dataset: who reads it and how many instances a day. */
function bindingOf(key: string, card: Pick<EditorCard, 'sources'>, series: readonly Series[]): Pick<DatasetFact, 'boundBy' | 'seriesPerDay'> {
  const boundBy: DatasetFact['boundBy'] = [];
  if (card.sources.some((s) => s.kind === 'library' && sameKey(s.ref, key))) boundBy.push('card');
  let seriesPerDay = 0;
  for (const s of series) {
    if (s.active === false || s.source?.kind !== 'library' || !sameKey(s.source.table, key)) continue;
    boundBy.push(`series:${s.name}`);
    const c = parseCadence(s.cadence);
    if (c) seriesPerDay += instancesPerDay(c);
  }
  return { boundBy, seriesPerDay };
}

/** A source before its host block is looked up. */
export interface SourceRef {
  url: string; kind: SourceFact['kind']; origin: SourceFact['origin']; host: string | null;
  /** The card source's id (card sources only). */
  id?: string;
  /** The key a feed failure is stored under (rss only). */
  feedKey: string | null;
}

/** The sources of the card and of the active series, as the doctor sees them (A16, A29). `free`, `network_highlights` and no source add none. */
export function sourceRefsOf(card: Pick<EditorCard, 'sources'>, series: readonly Series[]): SourceRef[] {
  const out: SourceRef[] = [];
  for (const s of card.sources) {
    if (s.kind === 'rss' || s.kind === 'url') out.push({ url: s.ref, kind: s.kind, origin: 'card', host: hostOf(s.ref), feedKey: s.kind === 'rss' ? feedKey(s.ref) : null, id: s.id });
    else out.push({ url: s.kind === 'library' ? `library:${s.ref}` : `api:${s.ref}`, kind: s.kind, origin: 'card', host: null, feedKey: null, id: s.id });
  }
  for (const se of series) {
    if (se.active === false || !se.source) continue;
    const origin = `series:${se.name}` as const;
    const src = se.source;
    if (src.kind === 'library') out.push({ url: `library:${src.table}`, kind: 'library', origin, host: null, feedKey: null });
    else if (src.kind === 'api') out.push({ url: `api:${src.source}`, kind: 'api', origin, host: null, feedKey: null });
    else if (src.kind === 'feed') {
      // `ref` is the id (or address) of a card source, or a URL of its own.
      const own = card.sources.find((c) => (c.kind === 'rss' || c.kind === 'url') && (c.id === src.ref || c.ref === src.ref));
      const url = own?.ref ?? src.ref;
      out.push({ url, kind: 'rss', origin, host: hostOf(url), feedKey: feedKey(url) });
    }
  }
  return out;
}

export type HostBlock = NonNullable<SourceFact['hostBlock']>;
export interface BlockRow { host: string; reason: string; until: Date | string; strikes: number }

/** The block that stops this source now, from the `source_host_failures` rows (a feed answers to its own key, then to the host's). */
export function blockOf(ref: SourceRef, rows: ReadonlyMap<string, BlockRow>): HostBlock | null {
  const keys = ref.kind === 'rss' ? [ref.feedKey, ref.host] : [ref.host];
  for (const k of keys) {
    const r = k ? rows.get(k) : undefined;
    if (!r) continue;
    // fetch_feed ignores a host's page refusal; a page fetch ignores a feed's own failure (host-failures.ts `blocked`).
    if (ref.kind === 'rss' ? r.reason === 'refused' : r.reason.startsWith('feed_')) continue;
    return { reason: r.reason, until: new Date(r.until).toISOString(), strikes: r.strikes };
  }
  return null;
}

/** A series' source is required when the series says so; a card source when it is the only one the card has. */
const requiredOf = (s: Omit<SourceFact, 'required'>, cardSources: number, series: readonly Series[]): boolean => {
  if (s.origin === 'card') return cardSources === 1;
  const name = s.origin.slice('series:'.length);
  const se = series.find((x) => x.name === name);
  return !!se && se.active !== false && se.source_mode === 'required';
};

/** This channel's own entry of the conflict input, built from the card and the profile as `ConfigConflictsService.forAgent` does. */
function anchorConfig(card: EditorCard, profile: ResourceProfile | null, ref: string): ResourceConfig {
  return {
    ref, style: card.style ?? null, slang: card.slang === true, pollsPerWeek: card.pollsPerWeek ?? null, profile,
    vocabulary: card.hashtags, hashtagMin: card.hashtagMin, language: card.language,
  };
}

/** The config of a resource that is not this channel: from its profile only. */
export function siblingConfig(ref: string, profile: ResourceProfile | null): ResourceConfig {
  const prefs = (profile?.format_prefs ?? {}) as Record<string, any>;
  return { ref, style: prefs.style ?? null, slang: prefs.slang === true, pollsPerWeek: profileCaps(profile).pollsPerWeek, profile };
}

export function deriveFacts(raw: RawFacts): ChannelFacts {
  const { series: given, datasets, sources, ...rest } = raw;
  const series = given ?? seriesOn(raw.playbook?.body, raw.resourceRef);
  const byRef = new Map(raw.conflictBase.others.map((c) => [c.ref, c]));
  const resources: ResourceConfig[] = raw.conflictBase.refs.map((ref) => (ref === raw.resourceRef ? anchorConfig(raw.card, raw.profile?.full ?? null, ref) : byRef.get(ref) ?? siblingConfig(ref, null)));
  const conflictInput: ConflictInput = { rules: raw.conflictBase.rules, playbook: raw.playbook?.body ?? null, resources };
  return {
    ...rest,
    series,
    datasets: datasets.map((d) => ({ ...d, ...bindingOf(d.key, raw.card, series) })),
    sources: sources.map((s) => ({ ...s, required: requiredOf(s, sources.filter((x) => x.origin === 'card').length, series) })),
    effectiveTools: intersectAllow(raw.card.toolsAllow, raw.loadoutTools),
    conflictInput,
  };
}

// ── pure: the config hash ─────────────────────────────────────────────────────────────────────────────────────────

function sortKeys(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)]));
  }
  return v;
}

/** JSON with sorted keys: the same value is the same text. */
export const canonical = (v: unknown): string => JSON.stringify(sortKeys(v));

const byId = <T extends { id: string | number }>(a: readonly T[]): T[] => [...a].sort((x, y) => String(x.id).localeCompare(String(y.id)));

/**
 * sha256 of the configuration of the channel: what a change of would make a plan stale. Never counts, pauses, host blocks, slots,
 * the launch state, `updated_at`, the mode, the models and the budgets (they change without anything being reconfigured).
 */
export function configHash(f: ChannelFacts): string {
  const { mode: _mode, models: _models, dailyBudgetUsd: _budget, createdAt: _created, richUnsupported: _rich, ...card } = f.card;
  const body = {
    card,
    profile: f.profile ? { topic: f.profile.topic, language: f.profile.language, formatPrefs: f.profile.formatPrefs } : null,
    playbook: f.playbook ? { version: f.playbook.version, body: f.playbook.body } : null,
    pendingPlaybook: f.pendingPlaybook?.id ?? null,
    pins: byId(f.pins),
    skills: byId(f.skills).map((s) => ({ id: s.id, version: s.version, enabled: true, inline: s.inline })),
    rules: byId(f.rules).map((r) => [r.id, r.text]),
    steering: byId(f.steering).map((r) => [r.id, r.text]),
    datasets: [...f.datasets].sort((a, b) => a.key.localeCompare(b.key)).map((d) => ({ key: d.key, version: d.version, reusePolicy: d.reusePolicy, postRequires: d.postRequires })),
    loadout: f.loadoutTools ? [...f.loadoutTools].sort() : null,
    groupMode: f.group?.mode ?? null,
  };
  return createHash('sha256').update(canonical(body)).digest('hex');
}

// ── pure: the overlay ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 077's "what would the doctor say if". `card` is merged over the card; `profile`, `playbook` and `series` replace theirs;
 * `datasets` replace a dataset of the same key or are added; `sources` are added. The derived fields are computed again.
 */
export interface FactsOverlay {
  card?:     Partial<EditorCard>;
  profile?:  ChannelFacts['profile'];
  playbook?: ChannelFacts['playbook'];
  series?:   Series[];
  datasets?: DatasetFact[];
  sources?:  SourceFact[];
}

const isDerivedSource = (s: SourceFact) => s.origin === 'card' || s.origin.startsWith('series:');

export function applyOverlay(facts: ChannelFacts, o: FactsOverlay): ChannelFacts {
  const card = o.card ? { ...facts.card, ...o.card } as ChannelFacts['card'] : facts.card;
  const playbook = o.playbook !== undefined ? o.playbook : facts.playbook;
  const profile = o.profile !== undefined ? o.profile : facts.profile;
  // Series: the overlay's, else those of the overlay playbook, else the loaded ones.
  const series = o.series ?? (o.playbook !== undefined ? seriesOn(playbook?.body, facts.resourceRef) : facts.series);

  // The card's and the series' sources follow them; sources the overlay added before stay.
  let sources: Array<Omit<SourceFact, 'required'>> = facts.sources;
  if (o.card || o.series || o.playbook !== undefined) {
    const known = new Map(facts.sources.map((s) => [s.url, s]));
    const hosts = new Map(facts.sources.filter((s) => s.host && s.hostBlock).map((s) => [s.host!, s.hostBlock!]));
    const rebuilt = sourceRefsOf(card, series).map((r): SourceFact => {
      const old = known.get(r.url);
      return {
        url: r.url, kind: r.kind, origin: r.origin, host: r.host, hostBlock: old?.hostBlock ?? (r.host ? hosts.get(r.host) ?? null : null),
        ...(r.id ? { id: r.id } : {}),
        ...(old?.lastSuccessAt !== undefined ? { lastSuccessAt: old.lastSuccessAt } : {}), ...(old?.probe !== undefined ? { probe: old.probe } : {}),
      };
    });
    sources = [...rebuilt, ...facts.sources.filter((s) => !isDerivedSource(s))];
  }
  if (o.sources?.length) sources = [...sources, ...o.sources];

  const added = new Set((o.datasets ?? []).map((d) => d.key));
  const datasets = [...facts.datasets.filter((d) => !added.has(d.key)), ...(o.datasets ?? [])];

  const { effectiveTools: _e, conflictInput: _c, series: _s, datasets: _d, sources: _src, ...rest } = facts;
  return deriveFacts({ ...rest, card, playbook, profile, series, datasets, sources });
}

// ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Counts = { rows: number; notPostable: number; unusedPostable: number };

/**
 * Per dataset: active rows, rows that cannot be posted and postable rows not used on this resource. The SQL of `buildCatalog`'s
 * `countRows`, but never `buildCatalog` itself: that starts the next round of a cycle dataset, which is a write. 075 replaces this
 * with `postableCount`.
 */
export async function countPostable(pool: Pick<Pool, 'query'>, schemaIds: string[], resource: string): Promise<Map<string, Counts>> {
  if (!schemaIds.length) return new Map();
  const { resourceRef: rr } = resourceKeys(resource);
  const { rows } = await pool.query(
    `WITH ${usedRefsCte('$2')}
     SELECT d.schema_id, count(*)::int AS rows,
            count(*) FILTER (WHERE NOT data_postable(s.post_requires, d.data))::int AS not_postable,
            count(*) FILTER (WHERE data_postable(s.post_requires, d.data)
              AND NOT EXISTS (SELECT 1 FROM used u WHERE u.ref = 'data://' || s.key || '/' || d.id::text)
              AND (d.legacy_ref IS NULL OR NOT EXISTS (SELECT 1 FROM used u WHERE u.ref = d.legacy_ref)))::int AS unposted_here
       FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
      WHERE d.schema_id = ANY($1::uuid[]) AND d.status = 'active'
      GROUP BY d.schema_id`, [schemaIds, rr]);
  return new Map(rows.map((r: any) => [r.schema_id, { rows: Number(r.rows), notPostable: Number(r.not_postable), unusedPostable: Number(r.unposted_here) }]));
}

/** The card's own spelling of a channel key (`@X` and `@x` are one channel); null = no card. */
export async function resolveChannelKey(pool: Pick<Pool, 'query'>, key: string): Promise<string | null> {
  const { rows } = await pool.query(`SELECT channel_key FROM editor_channels WHERE lower(channel_key) = lower($1) ORDER BY (channel_key = $1) DESC LIMIT 1`, [key]);
  return rows[0]?.channel_key ?? null;
}

export class ChannelNotFound extends Error {
  readonly code = 'channel_not_found';
  constructor(key: string) { super(`channel_not_found: ${key}`); }
}

const skillFactOf = (e: AgentSkillEntry): SkillFact => ({
  id: e.skill.id, name: e.skill.name, description: e.skill.description, body: e.skill.body, version: e.skill.currentVersion,
  inline: e.inline, origin: e.origin, scope: e.skill.scope, safety: e.skill.safety, agentId: e.skill.agentId,
});

/** The enabled skills of the executor's chain, then the orchestrator's: one entry per skill, the executor's view first. */
async function enabledSkills(skills: SkillStore, orchId: string, executorId: string | null): Promise<SkillFact[]> {
  const lists = [...(executorId ? [await skills.listForAgent([executorId, orchId])] : []), await skills.listForAgent([orchId])];
  const out = new Map<string, SkillFact>();
  for (const list of lists) for (const e of list) if (e.enabled && !out.has(e.skill.id)) out.set(e.skill.id, skillFactOf(e));
  return [...out.values()];
}

const pinSource = (v: unknown): string | null => {
  if (v == null) return null;
  const p = SeriesSourceSchema.safeParse(v);
  return p.success ? seriesSourceLabel(p.data) : JSON.stringify(v);
};

const addDays = (date: string, n: number): string => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

function zoneOk(tz: string): string {
  try { localDate(new Date(), tz); return tz; } catch { return 'Europe/Kyiv'; }
}

/** The schema ids whose latest committed list import was an upload (076 A15). Empty before 076's marks exist or on any error. */
async function uploadedImportsOf(pool: Pick<Pool, 'query'>, schemaIds: string[]): Promise<Set<string>> {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (i.schema_id) i.schema_id, coalesce((i.options -> 'list_import' ->> 'uploaded')::boolean, false) AS uploaded
         FROM data_imports i WHERE i.schema_id = ANY($1::uuid[]) AND i.status = 'committed' AND i.options ? 'list_import'
        ORDER BY i.schema_id, i.created_at DESC`, [schemaIds]);
    return new Set(rows.filter((r: any) => r.uploaded).map((r: any) => String(r.schema_id)));
  } catch {
    return new Set();
  }
}

/** `source_host_failures.last_success_at` per host (migration 100); empty before 100 (the column is missing) or on any error. */
async function lastSuccessOf(pool: Pick<Pool, 'query'>, hosts: string[]): Promise<Map<string, string>> {
  if (!hosts.length) return new Map();
  try {
    const { rows } = await pool.query(`SELECT host, last_success_at FROM source_host_failures WHERE host = ANY($1::text[]) AND last_success_at IS NOT NULL`, [hosts]);
    return new Map(rows.map((r: any) => [r.host as string, new Date(r.last_success_at).toISOString()]));
  } catch {
    return new Map();
  }
}

/** What the loader may be given besides the pool (wired in `editor.module.ts`; a test passes what it needs). */
export interface LoadFactsOptions {
  now?: Date;
  /** The settings behind `formatAvailable` (a carousel needs slide hosting); absent = every format a platform implements is producible. */
  env?: (key: string) => string | undefined;
  /**
   * `ScheduleService.slotConfigContext`, read only (no inbox post, no round started: 073 I1). Called once per series that has a
   * planned slot today or tomorrow, without tools. Absent = no `configCtx`, and the config seam skips the planned slots.
   */
  slotConfigContext?: (card: EditorCard, slot: Pick<EditorSlot, 'channelKey' | 'resourceRef' | 'seriesName' | 'sourceHints'>) => Promise<SlotConfigCtx | null>;
}

/** The resources with what 073's skeleton check needs (I6): producible formats, zone, quiet hours. A platform it cannot read keeps none. */
function withSkeleton(card: EditorCard, resources: Array<{ ref: string; platform: string }>, env?: LoadFactsOptions['env']): ChannelFacts['resources'] {
  return resources.map((r) => {
    try {
      const [s] = skeletonResourcesOf(card, [{ ref: r.ref, platform: r.platform as Platform }], env);
      return { ref: r.ref, platform: r.platform, formats: [...s.formats], ...(s.tz ? { tz: s.tz } : {}), ...(s.quiet ? { quiet: s.quiet } : {}) };
    } catch {
      return r;
    }
  });
}

/**
 * Everything the doctor reads about one channel (the card's spelling of the key is resolved first, A27). A fixed number of
 * queries whatever the channel holds, plus one read-only slot config context per series planned today or tomorrow; writes nothing.
 */
export async function loadChannelFacts(pool: Pool, channelKeyIn: string, o: LoadFactsOptions = {}): Promise<ChannelFacts> {
  const now = o.now ?? new Date();
  const channelKey = await resolveChannelKey(pool, channelKeyIn);
  if (!channelKey) throw new ChannelNotFound(channelKeyIn);
  const ref = resourceRef('telegram', channelKey);

  const agents = new AgentsRepository(pool);
  const network = new NetworkRepository(pool);
  const [card, orch, profiles, group, memory] = await Promise.all([
    new EditorChannelsRepository(pool).get(channelKey),
    agents.findTop('orchestrator', 'resource', ref),
    new ResourceProfilesRepository(pool).list(),
    network.groupOfChannel(channelKey),
    new EditorMemoryRepository(pool).listActive(channelKey, 60),
  ]);
  if (!card) throw new ChannelNotFound(channelKeyIn);
  const executor = orch ? (await agents.children(orch.id)).find((a) => a.kind === 'executor') ?? null : null;
  const groupRefs = group ? await network.groupResources(group.id) : [];
  const resources = withSkeleton(card, groupRefs.length ? groupRefs.map((r) => ({ ref: r.ref, platform: r.platform })) : [{ ref, platform: 'telegram' }], o.env);
  const refs = resources.map((r) => r.ref);
  if (!refs.includes(ref)) refs.unshift(ref);

  const profileOf = (r: string) => profiles.find((p) => p.resourceRef === r)?.profile ?? null;
  const stored = profileOf(ref);
  const prefs = (stored?.format_prefs ?? {}) as Record<string, unknown>;

  const [activePb, pendingPb, pinRows, skills, steeringSets, pauses, loadoutTools] = await Promise.all([
    orch ? network.activePlaybook(orch.id) : null,
    orch ? network.pendingPlaybook(orch.id) : null,
    pool.query(`SELECT id, format, source, active FROM schedule_rules WHERE kind = 'pin' AND lower(resource_ref) = lower($1) ORDER BY created_at`, [ref]),
    orch ? enabledSkills(new SkillStore(pool), orch.id, executor?.id ?? null) : [],
    new SteeringRepository(pool).activeFor(ref),
    new SeriesPausesRepository(pool).open(channelKey),
    executor ? new LoadoutService({ repo: new LoadoutRepository(pool) }).toolsAllow(executor.id) : null,
  ]);

  const body = activePb ? normalizePlaybook(activePb.body) : null;
  const playbook = activePb && body ? { id: activePb.id, version: activePb.version, body } : null;
  const series = seriesOn(body, ref);

  // Datasets: the card's library sources and the library sources of the active series.
  const keys = [...new Set([
    ...card.sources.filter((s) => s.kind === 'library').map((s) => s.ref.toLowerCase()),
    ...series.filter((s) => s.active !== false && s.source?.kind === 'library').map((s) => (s.source as { table: string }).table.toLowerCase()),
  ])];
  const { rows: schemas } = keys.length ? await pool.query(
    `SELECT s.id, s.key, s.entity, s.version, s.roles, s.reuse_policy, s.post_requires, st.fill_rate
       FROM data_schemas s LEFT JOIN data_schema_stats st ON st.schema_id = s.id
      WHERE s.status = 'active' AND lower(s.key) = ANY($1::text[]) ORDER BY s.key`, [keys]) : { rows: [] as any[] };
  const [counts, ledger, uploadedKeys] = schemas.length
    ? await Promise.all([countPostable(pool, schemas.map((s: any) => s.id), ref), ledgerUsage(pool, ref), uploadedImportsOf(pool, schemas.map((s: any) => s.id))])
    : [new Map<string, Counts>(), {}, new Set<string>()];
  const datasets: RawFacts['datasets'] = schemas.map((s: any) => {
    const c = counts.get(s.id) ?? { rows: 0, notPostable: 0, unusedPostable: 0 };
    return {
      id: s.id, key: s.key, entity: s.entity, version: Number(s.version), roles: s.roles ?? {}, reusePolicy: s.reuse_policy ?? { kind: 'never' },
      ...(uploadedKeys.has(s.id) ? { uploaded: true } : {}),
      postRequires: Array.isArray(s.post_requires) && s.post_requires.length ? s.post_requires : null, fillRate: s.fill_rate && Object.keys(s.fill_rate).length ? s.fill_rate : null,
      ...c, used28: (ledger as Record<string, { used28: number }>)[s.key]?.used28 ?? 0,
    };
  });

  // Hosts of the feeds and pages the card and the series name, and the blocks that stop them now.
  const refsOfSources = sourceRefsOf(card, series);
  const hostKeys = [...new Set(refsOfSources.flatMap((r) => [r.host, r.feedKey]).filter((x): x is string => !!x))];
  const { rows: blockRows } = hostKeys.length ? await pool.query(
    `SELECT host, reason, blocked_until AS until, strikes FROM source_host_failures WHERE host = ANY($1::text[]) AND blocked_until > $2`, [hostKeys, now]) : { rows: [] as any[] };
  const blocks = new Map<string, BlockRow>(blockRows.map((r: any) => [r.host, { host: r.host, reason: r.reason, until: r.until, strikes: Number(r.strikes ?? 0) }]));
  // 076 (S10): the latest stored probe of each feed and page (the cache, never a live read) and when its host last answered.
  const readFromServer = refsOfSources.filter((r) => r.kind === 'rss' || r.kind === 'url');
  const [probes, answered] = await Promise.all([
    new PgSourceProbes(pool).latest(readFromServer.map((r) => r.url)),
    lastSuccessOf(pool, [...new Set(readFromServer.map((r) => r.host).filter((h): h is string => !!h))]),
  ]);
  const sources: RawFacts['sources'] = refsOfSources.map((r) => {
    const p = r.kind === 'rss' || r.kind === 'url' ? probes.get(r.url) ?? null : undefined;
    return {
      url: r.url, kind: r.kind, origin: r.origin, host: r.host, hostBlock: blockOf(r, blocks), ...(r.id ? { id: r.id } : {}),
      lastSuccessAt: r.host ? answered.get(r.host) ?? null : null,
      ...(p === undefined ? {} : {
        probe: p && { ok: p.ok, failure_class: p.failure_class, items: p.items, newest_at: p.newest_at, checked_at: p.checked_at, ...(p.detail ? { detail: p.detail } : {}) },
      }),
    };
  });

  // The open launch, the slots planned for today and tomorrow, and the closed slots of the last 24 hours.
  const tz = zoneOk(card.timezone || 'Europe/Kyiv');
  const today = localDate(now, tz);
  const [launchRows, plannedRows, closedRows] = await Promise.all([
    pool.query(`SELECT id, status, bot_state, graduation FROM channel_launches WHERE lower(channel_key) = lower($1) AND status IN ('ready','running') ORDER BY created_at DESC LIMIT 1`, [channelKey]),
    pool.query(
      `SELECT id, scheduled_at, resource_ref, format, series_name, source_hints, schedule_rule_id FROM editor_slots
        WHERE lower(COALESCE(resource_ref, 'telegram:' || channel_key)) = lower($1) AND kind = 'content' AND status = 'planned'
          AND scheduled_at >= $2 AND scheduled_at < $3
        ORDER BY scheduled_at`, [ref, zonedToUtc(today, '00:00', tz), zonedToUtc(addDays(today, 2), '00:00', tz)]),
    pool.query(
      `SELECT status, error, critic->>'verdict' AS verdict, scheduled_at FROM editor_slots
        WHERE lower(COALESCE(resource_ref, 'telegram:' || channel_key)) = lower($1) AND kind = 'content'
          AND status IN ('published','shadowed','awaiting_approval','approved','skipped','failed','expired')
          AND scheduled_at > $2::timestamptz - interval '24 hours' AND scheduled_at <= $2
        ORDER BY scheduled_at`, [ref, now]),
  ]);
  const l = launchRows.rows[0];
  const planned: PlannedSlotFact[] = plannedRows.rows.map((r: any) => ({
    id: r.id, scheduledAt: new Date(r.scheduled_at).toISOString(), resourceRef: r.resource_ref ?? null, format: r.format,
    seriesName: r.series_name ?? null, sourceHints: Array.isArray(r.source_hints) ? r.source_hints.map(String) : [], scheduleRuleId: r.schedule_rule_id ?? null,
  }));
  // 073's slot config context (L8): one read per series, shared by its slots (the context depends on the series, not the slot).
  if (o.slotConfigContext) {
    const ctxOf = new Map<string, Promise<SlotConfigCtx | null>>();
    for (const p of planned) {
      const name = slotSeriesOf(p);
      if (!name) continue;
      const k = `${(p.resourceRef ?? ref).toLowerCase()}|${name}`;
      if (!ctxOf.has(k)) {
        ctxOf.set(k, o.slotConfigContext(card, { channelKey, resourceRef: p.resourceRef, seriesName: p.seriesName, sourceHints: p.sourceHints }).catch(() => null));
      }
      p.configCtx = await ctxOf.get(k)!;
    }
  }

  const steering = steeringSets.flatMap((set) => set.rules.map((r, i) => ({ r, i })).filter(({ r }) => r.enabled && !r.conflict).map(({ r, i }) => ({ id: `${set.id}/${i}`, text: r.text })));
  const others = refs.filter((r) => r !== ref).map((r) => siblingConfig(r, profileOf(r)));

  return deriveFacts({
    now, channelKey, resourceRef: ref, card,
    agent: orch ? { id: orch.id, handle: orch.handle, mode: orch.mode } : null,
    chain: orch ? { orchestratorId: orch.id, executorId: executor?.id ?? null } : null,
    profile: stored ? { topic: stored.topic ?? null, language: stored.language ?? null, formatPrefs: prefs, full: stored } : null,
    group: group ? { id: group.id, name: group.name, mode: group.mode } : null,
    resources,
    playbook,
    pendingPlaybook: pendingPb ? { id: pendingPb.id, createdAt: new Date(pendingPb.createdAt).toISOString() } : null,
    series,
    pins: pinRows.rows.map((r: any) => ({ id: r.id, format: r.format ?? null, source: pinSource(r.source), active: !!r.active })),
    skills,
    rules: ownerRulesOf(memory),
    steering,
    datasets,
    pauses,
    sources,
    proxyConfigured: o.env ? egressProxyConfigured(o.env) : false,
    loadoutTools,
    conflictBase: { rules: memory.filter((m) => m.createdBy === 'owner').map((m): OwnerRule => ({ id: m.id, text: m.text })), refs, others },
    launch: l ? { id: l.id, status: l.status, botState: (l.bot_state ?? null) as LaunchBotState | null, graduation: (l.graduation ?? null) as LaunchGraduation | null } : null,
    planned,
    slots24h: closedRows.rows.map((r: any) => ({ status: r.status, error: r.error ?? null, verdict: r.verdict ?? null, scheduledAt: new Date(r.scheduled_at).toISOString() })),
  });
}
