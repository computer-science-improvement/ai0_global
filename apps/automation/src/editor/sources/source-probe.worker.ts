import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import type { EditorCard } from '../card';
import { canonicalUrl } from '../docs/doc-store';
import { feedKey, hostOf } from '../net/host-failures';
import type { OwnerInbox } from '../agents/owner-inbox';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { playbookSources } from './playbook-feeds';
import { sourceProberOf, type SourceProber } from './probe';
import { PgSourceProbes } from './source-probes.repository';
import { SourceHealthRepository } from './source-health.repository';
import { sourceHealthOf } from './source-wiring';

/**
 * Spec 076 FR-004: the server reads the sources of its channels on a schedule, so a dead feed is found before a slot needs it.
 *
 * - Daily at 05:35 Kyiv: the `rss` / `url` sources of every young channel (created in the last 14 days, mode not `off`) and of
 *   its playbook, cache first, one at a time and 2 s apart; then the host notes of every active card (`noteStruckHosts`), whether
 *   or not the agent is asked to propose source changes (SOURCE_PROPOSALS only gates that proposal).
 * - Every 6 hours: the sources of a channel with an open `source_unreachable` pause whose host has a block, a strike or a
 *   timeout, forced, one per host. A success ends the block (FR-002), which is what 072's `pause_cause_gone` and 074's lift read.
 *
 * Both jobs are exported functions over a port bundle, so tests drive them with fakes.
 */
export const YOUNG_CHANNEL_DAYS = 14;
/** Pause between two live probes (a source site is not asked in a burst). */
export const PROBE_GAP_MS = 2_000;
/** The 6-hourly job skips an address probed this recently: a button or a save has just done it (A18). */
export const REPROBE_SKIP_MS = 30 * 60_000;

type CardWithAge = EditorCard & { createdAt: Date };

export interface SourceProbeDeps {
  channels:       { listActive(): Promise<CardWithAge[]>; get(channelKey: string): Promise<CardWithAge | null> };
  /** The active playbook body of the channel's orchestrator (`telegram:<channel>`), or null. */
  playbookOf:     (resourceRef: string) => Promise<unknown | null>;
  probe:          SourceProber;
  /** `checked_at` of the stored probe of each address that has one. */
  probedAt:       (urls: string[]) => Promise<Map<string, Date>>;
  /** Which of these host / feed keys have an active block, a strike or a counted timeout in `source_host_failures`. */
  troubledKeys:   (keys: string[], now: Date) => Promise<Set<string>>;
  /** Channels with an open `source_unreachable` pause. */
  pausedChannels: () => Promise<string[]>;
  /** The owner notes of struck hosts (`SourceHealthService.noteStruckHosts`); absent = none are written. */
  noteStruck?:    (card: EditorCard, agentId: string | null) => Promise<unknown>;
  agentIdOf?:     (channelKey: string) => Promise<string | null>;
  now?:           () => Date;
  sleep?:         (ms: number) => Promise<void>;
  gapMs?:         number;
  log?:           (m: string) => void;
}

/** The feed and page sources of a card and of its playbook that the server can read (an http address). */
export function sourcesToProbe(card: EditorCard, playbookBody: unknown): Array<{ url: string; kind: 'rss' | 'url' }> {
  const all = [...card.sources, ...playbookSources(playbookBody, card.sources)];
  const seen = new Set<string>();
  const out: Array<{ url: string; kind: 'rss' | 'url' }> = [];
  for (const s of all) {
    if ((s.kind !== 'rss' && s.kind !== 'url') || !hostOf(s.ref)) continue;
    const url = s.ref.trim();
    if (seen.has(canonicalUrl(url))) continue;
    seen.add(canonicalUrl(url));
    out.push({ url, kind: s.kind });
  }
  return out;
}

const realSleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
const message = (err: unknown): string => String((err as Error)?.message ?? err);

export interface DailyProbeResult { channels: string[]; probed: string[]; noted: string[] }

export async function dailyProbe(d: SourceProbeDeps): Promise<DailyProbeResult> {
  const now = (d.now ?? (() => new Date()))();
  const sleep = d.sleep ?? realSleep;
  const gap = d.gapMs ?? PROBE_GAP_MS;
  const out: DailyProbeResult = { channels: [], probed: [], noted: [] };
  const cards = await d.channels.listActive();
  const youngSince = now.getTime() - YOUNG_CHANNEL_DAYS * 86_400_000;

  for (const card of cards) {
    if (card.createdAt.getTime() < youngSince) continue;
    out.channels.push(card.channelKey);
    const body = await d.playbookOf(`telegram:${card.channelKey}`).catch(() => null);
    for (const s of sourcesToProbe(card, body)) {
      try {
        const r = await d.probe(s.url, { kind: s.kind });
        out.probed.push(s.url);
        if (!r.cached) await sleep(gap);
      } catch (err) {
        d.log?.(`source probe of ${s.url} (${card.channelKey}) failed: ${message(err)}`);
      }
    }
  }

  // The host notes cover every active card, young or not: a feed that dies in month three is as much news as one in week one.
  if (d.noteStruck) {
    for (const card of cards) {
      try {
        const agentId = d.agentIdOf ? await d.agentIdOf(card.channelKey) : null;
        const hosts = await d.noteStruck(card, agentId);
        if (Array.isArray(hosts)) out.noted.push(...hosts.map((h) => `${card.channelKey}/${String(h)}`));
      } catch (err) {
        d.log?.(`host notes of ${card.channelKey} failed: ${message(err)}`);
      }
    }
  }
  return out;
}

export interface PausedReprobeResult { channels: string[]; probed: string[]; skipped: string[] }

export async function pausedReprobe(d: SourceProbeDeps): Promise<PausedReprobeResult> {
  const now = (d.now ?? (() => new Date()))();
  const sleep = d.sleep ?? realSleep;
  const gap = d.gapMs ?? PROBE_GAP_MS;
  const out: PausedReprobeResult = { channels: [], probed: [], skipped: [] };
  const hostsDone = new Set<string>();

  for (const channelKey of await d.pausedChannels()) {
    const card = await d.channels.get(channelKey);
    if (!card) continue;
    out.channels.push(channelKey);
    const body = await d.playbookOf(`telegram:${channelKey}`).catch(() => null);
    const sources = sourcesToProbe(card, body);
    const keys = [...new Set(sources.flatMap((s) => [hostOf(s.url), feedKey(s.url)]).filter((k): k is string => !!k))];
    const troubled = await d.troubledKeys(keys, now);
    if (!troubled.size) continue;

    for (const s of sources) {
      const host = hostOf(s.url);
      // One forced probe per host per run: the first source on that host that has a row, with that source's kind.
      if (!host || hostsDone.has(host)) continue;
      const fk = feedKey(s.url);
      if (!troubled.has(host) && !(fk && troubled.has(fk))) continue;
      hostsDone.add(host);
      const at = (await d.probedAt([s.url]).catch(() => new Map<string, Date>())).get(s.url);
      if (at && now.getTime() - at.getTime() < REPROBE_SKIP_MS) { out.skipped.push(s.url); continue; }
      try {
        await d.probe(s.url, { kind: s.kind, force: true });
        out.probed.push(s.url);
      } catch (err) {
        d.log?.(`forced probe of ${s.url} (${channelKey}) failed: ${message(err)}`);
      }
      await sleep(gap);
    }
  }
  return out;
}

/** The worker the module registers before `EditorCron`; the jobs return at once unless the editor is enabled. */
@Injectable()
export class SourceProbeWorker {
  private readonly logger = new Logger('SourceProbe');
  private readonly d: SourceProbeDeps;

  /** `AGENT_INFRA` by its string token (a type-only import of the module is a cycle); optional, so a test module without it still builds. */
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Optional() @Inject('AGENT_INFRA') infra?: { inbox?: Pick<OwnerInbox, 'post' | 'postOnce'> } | null,
  ) {
    const channels = new EditorChannelsRepository(pool);
    const health = infra?.inbox ? sourceHealthOf(pool, channels, infra.inbox) : null;
    const repo = new SourceHealthRepository(pool);
    const probes = new PgSourceProbes(pool);
    this.d = {
      channels, probe: sourceProberOf(pool, (k) => process.env[k] ?? this.config.get<string>(k) ?? undefined),
      playbookOf: (ref) => repo.playbookOf(ref),
      probedAt: (urls) => probes.checkedAt(urls),
      troubledKeys: async (keys, now) => {
        if (!keys.length) return new Set<string>();
        try {
          const { rows } = await pool.query(
            `SELECT host FROM source_host_failures WHERE host = ANY($1) AND (blocked_until > $2 OR strikes >= 1 OR consecutive_timeouts >= 1)`, [keys, now]);
          return new Set<string>(rows.map((r: { host: string }) => r.host));
        } catch {
          return new Set<string>();   // before migration 100
        }
      },
      pausedChannels: async () => {
        const { rows } = await pool.query(`SELECT DISTINCT channel_key FROM series_pauses WHERE cause = 'source_unreachable' AND resumed_at IS NULL ORDER BY 1`);
        return rows.map((r: { channel_key: string }) => r.channel_key);
      },
      ...(health ? { noteStruck: (card: EditorCard, agentId: string | null) => health.noteStruckHosts(card, agentId) } : {}),
      agentIdOf: async (channelKey) => {
        const { rows } = await pool.query(
          `SELECT id FROM agents WHERE parent_id IS NULL AND kind = 'orchestrator' AND scope = 'resource' AND scope_id = $1 LIMIT 1`, [`telegram:${channelKey}`]);
        return rows[0]?.id ?? null;
      },
      log: (m) => this.logger.warn(m),
    };
  }

  private enabled(): boolean {
    return this.config.get<string>('EDITOR_ENABLED') === 'true';
  }

  @Cron('35 5 * * *', { name: 'source-probe-daily', timeZone: 'Europe/Kyiv' })
  async daily(): Promise<void> {
    if (!this.enabled()) return;
    try {
      const r = await dailyProbe(this.d);
      if (r.probed.length || r.noted.length) this.logger.log(`daily source probe: ${r.probed.length} read, ${r.noted.length} host notes, ${r.channels.length} young channels`);
    } catch (err) {
      this.logger.warn(`daily source probe failed: ${message(err)}`);
    }
  }

  @Cron('35 */6 * * *', { name: 'source-probe-paused', timeZone: 'Europe/Kyiv' })
  async paused(): Promise<void> {
    if (!this.enabled()) return;
    try {
      const r = await pausedReprobe(this.d);
      if (r.probed.length) this.logger.log(`paused-channel source probe: ${r.probed.length} read of ${r.channels.length} channels`);
    } catch (err) {
      this.logger.warn(`paused-channel source probe failed: ${message(err)}`);
    }
  }
}
