import type { Pool, PoolClient } from 'pg';
import type { Agent } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { ChannelMode, EditorCard } from '../card';
import { CUTOVER_TARGET_MODE } from '../approval/approval-policy';
import { networkContext, type NetworkContextDeps, type NetworkCtx } from '../network/network-context';
import type { NetworkRepository } from '../network/network.repository';
import type { Playbook } from '../network/playbook';
import { instancesOn, parseCadence, type SeriesSourceCatalog } from '../network/series';
import { normalizePlaybook } from '../network/series-edit';
import { dropWaitingPosts } from '../repo/editor-channels.repository';
import { localDate, zonedToUtc } from '../roles/time';
import { shiftDate, weekdayOf } from '../schedule/schedule-rules';
import { DEFAULT_QUIET, DEFAULT_TZ } from '../time/resource-time';
import { allBindings, bindingsFor, type BindingRow } from './binding-guard';
import { buildProposal, migratedSeries, proposalKey, type MigrationProposal, type ProposalResource } from './proposal';
import { toneSkillsFor } from './type-mapping';

/**
 * Strategy bindings → agent series (spec 023 FR-011/FR-012): the proposal (deterministic, no LLM), the
 * migration draft (`created_by='migration'`, pending the owner), the cutover (one transaction: card and agent
 * to approval mode, the migrated bindings retired) and the rollback. Owner-facing text is English.
 */

type Q = Pick<Pool, 'query'>;
export type Fail = { error: string; details?: unknown; status?: number };
export const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && typeof (x as Fail).error === 'string' && !('bindings' in (x as object));

/** 023 FR-012 / open question 5: shadow days and the share of series instances shadowed before the cutover offer. */
export const CUTOVER_MIN_DAYS = 7;
export const CUTOVER_MIN_RATIO = 0.8;
const REALISED = ['shadowed', 'published', 'awaiting_approval', 'approved'];
/** A frequency hint's playbook rule names its binding: «Замість стратегії <ext_id> (<type>): …». */
const HINT_RE = /^Замість стратегії (\S+) \(/;

export interface StrategyMigrationDeps {
  pool:      Pool;
  agents:    Pick<AgentsRepository, 'findTop' | 'get'>;
  network:   Pick<NetworkRepository, 'activePlaybook' | 'pendingPlaybook' | 'insertPlaybook' | 'groupOfChannel' | 'groupResources'>;
  card:      (channelKey: string) => Promise<EditorCard | null>;
  inbox:     Pick<OwnerInbox, 'post'>;
  time?:     NetworkContextDeps['time'];
  usable?:   NetworkContextDeps['usable'];
  sourceCatalog?: (card: EditorCard | null) => Promise<SeriesSourceCatalog>;
  /** `config:changed` (kind strategy): the strategy scheduler reloads its bindings. */
  publishConfig?: () => Promise<void>;
  /** Spec 034 FR-014: attach a resource tone skill to the agent (enabled, always in context). */
  attachSkill?: (agentId: string, name: string) => Promise<'attached' | 'kept_off' | 'missing'>;
  /** EDITOR_ENABLED=true — the cutover is refused otherwise (the kill switch). */
  editorEnabled: () => boolean;
  /** The zone strategy crons run in (SCHEDULER_TZ, else the process zone). */
  cronTz?:   string;
  now?:      () => Date;
  log?:      (m: string) => void;
}

interface Scope { agent: Agent; card: EditorCard; net: NetworkCtx; allRefs: string[] }

export interface ShadowStats { since: string | null; days: number; expected: number; realised: number; ratio: number; ready: boolean }

export type MigrationState = 'no_agent' | 'not_migrated' | 'draft_pending' | 'shadow' | 'cutover_ready' | 'retired' | 'legacy';

export interface MigrationStatusRow {
  channel_key: string;
  agent:       { handle: string; mode: ChannelMode } | null;
  state:       MigrationState;
  enabled:     string[];
  retired:     string[];
  draft:       { id: string; version: number } | null;
  shadow:      ShadowStats | null;
}

export class StrategyMigrationService {
  constructor(private readonly d: StrategyMigrationDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }
  private cronTz(): string { return this.d.cronTz ?? (process.env.SCHEDULER_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); }

  /** The channel's orchestrator, card and network (every group resource, usable or not). */
  async scope(channelKey: string): Promise<Scope | Fail> {
    const key = channelKey.trim();
    const agent = await this.d.agents.findTop('orchestrator', 'resource', `telegram:${key}`);
    const card = agent ? await this.d.card(key) : null;
    if (!agent || !card) {
      return { error: 'no_agent', details: `no agent runs ${key}; create one first (Agents → New agent or ask @ai0)`, status: 409 };
    }
    const net = await networkContext({ repo: this.d.network, usable: this.d.usable, time: this.d.time }, agent, card);
    if (!net) return { error: 'no_agent', details: `${key} has no Telegram anchor`, status: 409 };
    const group = await this.d.network.groupOfChannel(key);
    const allRefs = group ? (await this.d.network.groupResources(group.id)).map((r) => r.ref) : [];
    if (!allRefs.includes(`telegram:${key}`)) allRefs.unshift(`telegram:${key}`);
    return { agent, card, net, allRefs };
  }

  /** Published posts of each binding in the last 14 days (Telegram: published_posts; other platforms: successful runs). */
  private async history(bindings: BindingRow[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    for (const b of bindings) {
      try {
        if (b.platform === 'telegram' && b.resourceRef) {
          const key = b.resourceRef.slice('telegram:'.length);
          const { rows } = await this.d.pool.query(
            `SELECT count(*)::int AS n FROM published_posts
              WHERE strategy_type = $1 AND posted_at > now() - interval '14 days'
                AND channel_id IN (SELECT $2::text UNION SELECT tg_chat_id::text FROM tracked_channels WHERE channel_key = $2 AND tg_chat_id IS NOT NULL)`,
            [b.type, key]);
          out.set(b.ext_id, Number(rows[0]?.n ?? 0));
        } else {
          const { rows } = await this.d.pool.query(
            `SELECT count(*)::int AS n FROM strategy_runs WHERE strategy_id = $1 AND status = 'ok' AND started_at > now() - interval '14 days'`, [b.id]);
          out.set(b.ext_id, Number(rows[0]?.n ?? 0));
        }
      } catch {
        out.set(b.ext_id, null);
      }
    }
    return out;
  }

  /** FR-011: map every enabled binding of the channel's network. Writes nothing (the dry run). */
  async propose(channelKey: string): Promise<MigrationProposal | Fail> {
    const sc = await this.scope(channelKey);
    if (isFail(sc)) return sc;
    return this.proposeIn(sc);
  }

  private async proposeIn(sc: Scope): Promise<MigrationProposal> {
    const bindings = await bindingsFor(this.d.pool, sc.allRefs, { enabledOnly: true });
    const active = await this.d.network.activePlaybook(sc.agent.id);
    const resources: ProposalResource[] = sc.net.resources.map((r) => ({
      ref: r.ref, platform: r.platform,
      tz: r.tz ?? (r.platform === 'telegram' ? sc.card.timezone : DEFAULT_TZ),
      quiet: r.quiet ?? (r.platform === 'telegram' ? { start: sc.card.quietStartHour, end: sc.card.quietEndHour } : { ...DEFAULT_QUIET }),
    }));
    const catalog = this.d.sourceCatalog ? await this.d.sourceCatalog(sc.card).catch(() => null) : null;
    return buildProposal(bindings.map((b) => ({ id: b.id, ext_id: b.ext_id, type: b.type, schedule: b.schedule, params: b.params, platform: b.platform, resourceRef: b.resourceRef })), {
      channelKey: sc.card.channelKey, agent: { id: sc.agent.id, handle: sc.agent.handle },
      networkMode: sc.net.mode, resources, allRefs: sc.allRefs, telegramFormats: sc.net.telegramFormats,
      card: { postsPerDayMin: sc.card.postsPerDayMin, postsPerDayMax: sc.card.postsPerDayMax, formats: sc.card.formats },
      active: active ? normalizePlaybook(active.body) : null, activeVersion: active?.version ?? null,
      catalog, history: await this.history(bindings), cronTz: this.cronTz(), now: this.now(),
    });
  }

  /** The `migrate_strategies` card's Apply: a pending migration draft (re-proposed; a changed proposal is stale). */
  async writeDraft(channelKey: string, expectKey?: string | null): Promise<{ id: string; version: number; proposal: MigrationProposal; toneSkills: string[] } | Fail> {
    const sc = await this.scope(channelKey);
    if (isFail(sc)) return sc;
    const p = await this.proposeIn(sc);
    if (expectKey && proposalKey(p) !== expectKey) return { error: 'stale', details: 'the bindings or the playbook changed since the card was made; migrate again', status: 409 };
    if (!p.mapped || !p.body) return { error: 'nothing_to_migrate', details: 'no enabled binding maps to a series or a frequency hint', status: 409 };
    if (p.errors.length) return { error: 'migration_invalid', details: p.errors, status: 409 };
    const pb = await this.d.network.insertPlaybook({
      agentId: sc.agent.id, status: 'pending_owner', brief: null, body: p.body, rationale: p.rationale, createdBy: 'migration',
      review: { strategy_migration: { channel_key: p.channel_key, bindings: p.bindings.map((o) => ({ ext_id: o.ext_id, outcome: o.outcome })) } },
    });
    const toneSkills = await this.attachToneSkills(sc.agent, p);
    const toneNote = toneSkills.length ? `\n\nVoice skills attached to @${sc.agent.handle}: ${toneSkills.join(', ')} (from the strategies' channel tone).` : '';
    await this.d.inbox.post({
      agentId: sc.agent.id, kind: 'playbook_pending', severity: 'action',
      title: `📘 @${sc.agent.handle}: strategy migration draft v${pb.version} awaits your approval`,
      body: `${p.rationale}\n\nApprove the playbook on the agent page. The strategies keep publishing while the agent works in shadow; the cutover is offered after ${CUTOVER_MIN_DAYS} days.${toneNote}`,
      alert: {
        title: `📘 @${sc.agent.handle}: чернетка міграції стратегій v${pb.version} чекає затвердження`,
        body: `Перенесено ${p.mapped} з ${p.total} стратегій. Стратегії публікують далі, поки агент працює в shadow.`,
      },
      refType: 'playbook', refId: pb.id,
    });
    return { id: pb.id, version: pb.version, proposal: p, toneSkills };
  }

  /**
   * Spec 034 FR-014: the legacy strategies wrote with a channel tone skill; the agent that takes them over gets
   * the matching `tone-*` skill (enabled, inline). Best-effort: a failure never blocks the draft.
   */
  private async attachToneSkills(agent: Agent, p: MigrationProposal): Promise<string[]> {
    if (!this.d.attachSkill) return [];
    const names = toneSkillsFor(p.bindings.filter((o) => o.outcome !== 'unmappable').map((o) => o.type));
    const attached: string[] = [];
    for (const name of names) {
      try {
        if ((await this.d.attachSkill(agent.id, name)) === 'attached') attached.push(name);
      } catch (err: any) {
        this.d.log?.(`tone skill ${name} for @${agent.handle}: ${err?.message ?? err}`);
      }
    }
    return attached;
  }

  /** The bindings the active playbook took over: migrated series (`migrated_from`) and frequency-hint rules. */
  private takenOver(active: Playbook | null): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const s of migratedSeries(active)) out.set(s.migrated_from!, [...(out.get(s.migrated_from!) ?? []), s.name]);
    for (const r of active?.rules ?? []) {
      const m = r.match(HINT_RE);
      if (m && !out.has(m[1])) out.set(m[1], []);
    }
    return out;
  }

  /** FR-012: how long the migrated series ran in shadow and how many of their instances were realised (last 7 days). */
  async shadowStats(sc: Scope, active: Playbook | null): Promise<ShadowStats | null> {
    const series = migratedSeries(active).filter((s) => s.active !== false);
    if (!series.length) return null;
    const now = this.now();
    const names = series.map((s) => s.name);
    const { rows: first } = await this.d.pool.query(
      `SELECT min(scheduled_at) AS since FROM editor_slots WHERE channel_key = $1 AND series_name = ANY($2::text[])`, [sc.card.channelKey, names]);
    const since: Date | null = first[0]?.since ?? null;
    if (!since) return { since: null, days: 0, expected: 0, realised: 0, ratio: 0, ready: false };
    const from = new Date(Math.max(since.getTime(), now.getTime() - CUTOVER_MIN_DAYS * 86_400_000));
    const tzOf = (ref: string) => sc.net.resources.find((r) => r.ref === ref)?.tz ?? sc.card.timezone;
    let expected = 0;
    for (const s of series) {
      const c = parseCadence(s.cadence);
      if (!c) continue;
      const tz = tzOf(s.resource_ref);
      for (let d = localDate(from, tz); d <= localDate(now, tz); d = shiftDate(d, 1)) {
        for (const t of instancesOn(c, weekdayOf(d))) {
          const at = zonedToUtc(d, t, tz).getTime();
          if (at >= from.getTime() && at < now.getTime()) expected++;
        }
      }
    }
    const { rows } = await this.d.pool.query(
      `SELECT count(*)::int AS n FROM editor_slots
        WHERE channel_key = $1 AND series_name = ANY($2::text[]) AND status = ANY($3::text[]) AND scheduled_at >= $4 AND scheduled_at < $5`,
      [sc.card.channelKey, names, REALISED, from, now]);
    const realised = Math.min(expected || Infinity, Number(rows[0]?.n ?? 0));
    const days = Math.floor((now.getTime() - since.getTime()) / 86_400_000 * 10) / 10;
    const ratio = expected ? Math.round(realised / expected * 100) / 100 : 0;
    return { since: since.toISOString(), days, expected, realised: expected ? realised : 0, ratio, ready: days >= CUTOVER_MIN_DAYS && ratio >= CUTOVER_MIN_RATIO };
  }

  /** What a cutover would retire: enabled bindings of the network that the active playbook took over. */
  private async retireSet(sc: Scope): Promise<{ active: { id: string; body: Playbook } | null; bindings: Array<BindingRow & { series: string[] }> }> {
    const row = await this.d.network.activePlaybook(sc.agent.id);
    const active = row ? normalizePlaybook(row.body) : null;
    const taken = this.takenOver(active);
    const enabled = await bindingsFor(this.d.pool, sc.allRefs, { enabledOnly: true });
    return {
      active: row && active ? { id: row.id, body: active } : null,
      bindings: enabled.filter((b) => taken.has(b.ext_id)).map((b) => ({ ...b, series: taken.get(b.ext_id) ?? [] })),
    };
  }

  /** Is the cutover card due? (≥ 7 days in shadow, ≥ 80 % of the migrated series' instances realised.) */
  async cutoverOffer(channelKey: string): Promise<{ stats: ShadowStats; extIds: string[] } | Fail> {
    const sc = await this.scope(channelKey);
    if (isFail(sc)) return sc;
    const set = await this.retireSet(sc);
    if (!set.bindings.length) return { error: 'nothing_to_retire', details: 'no enabled binding was taken over by an approved migration', status: 409 };
    const stats = await this.shadowStats(sc, set.active?.body ?? null);
    if (!stats || !stats.ready) {
      return {
        error: 'cutover_not_ready',
        details: stats
          ? `${stats.days} day(s) in shadow, ${Math.round(stats.ratio * 100)}% of ${stats.expected} series instance(s) realised in the last ${CUTOVER_MIN_DAYS} days; the cutover needs ${CUTOVER_MIN_DAYS} days and ${CUTOVER_MIN_RATIO * 100}%`
          : 'the active playbook has no migrated series yet (approve the migration draft first)',
        status: 409,
      };
    }
    return { stats, extIds: set.bindings.map((b) => b.ext_id) };
  }

  /**
   * FR-012 cutover, one transaction: the card and its orchestrator move to approval mode (spec 031; the owner
   * switches to live later), the taken-over bindings are retired (`enabled=false`, `retired_reason='migrated'`,
   * `migrated_to`); then `config:changed`. Refused while EDITOR_ENABLED≠true so a channel never goes silent.
   */
  async cutover(channelKey: string, o: { expectExtIds?: string[] } = {}): Promise<{ mode: ChannelMode; retired: string[] } | Fail> {
    if (!this.d.editorEnabled()) {
      return { error: 'editor_disabled', details: 'EDITOR_ENABLED is not true: retiring the strategies would leave the channel silent', status: 409 };
    }
    const sc = await this.scope(channelKey);
    if (isFail(sc)) return sc;
    const set = await this.retireSet(sc);
    if (!set.bindings.length || !set.active) return { error: 'nothing_to_retire', details: 'no enabled binding was taken over by the active playbook', status: 409 };
    if (o.expectExtIds && [...o.expectExtIds].sort().join(',') !== set.bindings.map((b) => b.ext_id).sort().join(',')) {
      return { error: 'stale', details: 'the bindings changed since the card was made', status: 409 };
    }
    const mode = CUTOVER_TARGET_MODE;
    await this.tx(async (c) => {
      await setCardMode(c, sc.card.channelKey, mode, 'strategy cutover');
      await c.query(`UPDATE agents SET mode = $2, shadow_until = NULL, updated_at = now() WHERE id = $1`, [sc.agent.id, mode]);
      for (const b of set.bindings) {
        await c.query(
          `UPDATE strategy_bindings SET enabled = false, retired_at = now(), retired_reason = 'migrated', migrated_to = $2
            WHERE id = $1 AND retired_at IS NULL`,
          [b.id, JSON.stringify({ agent_id: sc.agent.id, handle: sc.agent.handle, playbook_id: set.active!.id, series: b.series })]);
      }
    });
    await this.config();
    const retired = set.bindings.map((b) => b.ext_id);
    await this.d.inbox.post({
      agentId: sc.agent.id, kind: 'strategy_cutover', severity: 'info',
      title: `🔁 @${sc.agent.handle}: strategies retired, the agent now runs ${sc.card.channelKey} in approval mode`,
      body: `Retired: ${retired.join(', ')}. Every post waits for your approval; switch to live on the agent page when you trust it. A rollback re-enables the strategies.`,
      alert: { title: `🔁 @${sc.agent.handle}: стратегії вимкнено, агент веде ${sc.card.channelKey} у режимі апруву`, body: `Вимкнено: ${retired.join(', ')}.` },
      refType: 'agent', refId: sc.agent.handle,
    }).catch(() => {});
    return { mode, retired };
  }

  /** The rollback card: the agent and its card back to shadow, the migrated bindings re-enabled (one transaction). */
  async rollback(channelKey: string): Promise<{ mode: ChannelMode; restored: string[] } | Fail> {
    const sc = await this.scope(channelKey);
    if (isFail(sc)) return sc;
    const retired = (await bindingsFor(this.d.pool, sc.allRefs)).filter((b) => b.retiredReason === 'migrated' && b.migratedTo?.agent_id === sc.agent.id);
    if (!retired.length) return { error: 'nothing_to_restore', details: 'no binding was retired by a cutover of this agent', status: 409 };
    await this.tx(async (c) => {
      await setCardMode(c, sc.card.channelKey, 'shadow', 'strategy rollback');
      await c.query(`UPDATE agents SET mode = 'shadow', updated_at = now() WHERE id = $1`, [sc.agent.id]);
      await c.query(
        `UPDATE strategy_bindings SET enabled = true, retired_at = NULL, retired_reason = NULL, migrated_to = NULL WHERE id = ANY($1::uuid[])`,
        [retired.map((b) => b.id)]);
    });
    await this.config();
    const restored = retired.map((b) => b.ext_id);
    await this.d.inbox.post({
      agentId: sc.agent.id, kind: 'strategy_rollback', severity: 'info',
      title: `↩️ @${sc.agent.handle}: strategies restored on ${sc.card.channelKey}, the agent is back in shadow`,
      body: `Re-enabled: ${restored.join(', ')}.`,
      alert: { title: `↩️ @${sc.agent.handle}: стратегії повернуто, агент знову в shadow`, body: `Увімкнено: ${restored.join(', ')}.` },
      refType: 'agent', refId: sc.agent.handle,
    }).catch(() => {});
    return { mode: 'shadow', restored };
  }

  /** `/app/strategies` banner: one row per channel that has (or had) bindings. */
  async status(): Promise<MigrationStatusRow[]> {
    const all = await allBindings(this.d.pool);
    const keys = [...new Set(all.map((b) => (b.resourceRef?.startsWith('telegram:') ? b.resourceRef.slice('telegram:'.length) : null)).filter(Boolean) as string[])].sort();
    const out: MigrationStatusRow[] = [];
    for (const key of keys) {
      const sc = await this.scope(key);
      if (isFail(sc)) {
        const mine = all.filter((b) => b.resourceRef === `telegram:${key}`);
        out.push({ channel_key: key, agent: null, state: 'no_agent' as MigrationState, enabled: mine.filter((b) => b.enabled).map((b) => b.ext_id), retired: mine.filter((b) => b.retiredAt).map((b) => b.ext_id), draft: null, shadow: null });
        continue;
      }
      const mine = all.filter((b) => b.resourceRef && sc.allRefs.includes(b.resourceRef));
      const pending = await this.d.network.pendingPlaybook(sc.agent.id);
      const draft = pending?.createdBy === 'migration' ? { id: pending.id, version: pending.version } : null;
      const set = await this.retireSet(sc);
      const shadow = set.active ? await this.shadowStats(sc, set.active.body) : null;
      const enabled = mine.filter((b) => b.enabled).map((b) => b.ext_id);
      const retired = mine.filter((b) => b.retiredAt).map((b) => b.ext_id);
      const state: MigrationState = draft ? 'draft_pending'
        : set.bindings.length ? (shadow?.ready ? 'cutover_ready' : 'shadow')
        : retired.length && !enabled.length ? 'retired'
        : enabled.length ? 'not_migrated' : 'legacy';
      out.push({ channel_key: key, agent: { handle: sc.agent.handle, mode: sc.agent.mode }, state, enabled, retired, draft, shadow });
    }
    return out;
  }

  private async config(): Promise<void> {
    try { await this.d.publishConfig?.(); } catch (err: any) { this.d.log?.(`config:changed publish failed: ${err?.message ?? err}`); }
  }

  private async tx(fn: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await this.d.pool.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
}

/** A card mode change inside a transaction, audited like an owner upsert (editor_channel_memory, inactive rule). */
async function setCardMode(c: Q, channelKey: string, mode: ChannelMode, why: string): Promise<void> {
  const prev = await c.query(`SELECT mode FROM editor_channels WHERE channel_key = $1 FOR UPDATE`, [channelKey]);
  const from: ChannelMode | null = prev.rows[0]?.mode ?? null;
  if (from === mode) return;
  await c.query(`UPDATE editor_channels SET mode = $2, updated_at = now() WHERE channel_key = $1`, [channelKey, mode]);
  await c.query(
    `INSERT INTO editor_channel_memory (channel_key, kind, text, evidence, created_by, active) VALUES ($1, 'rule', $2, $3, 'owner', false)`,
    [channelKey, `mode changed ${from ?? 'off'}→${mode} by ${why}`, JSON.stringify({ audit: 'mode_change', from, to: mode, via: why })]);
  // Spec 031: leaving approval for shadow drops the posts that still wait.
  if (from === 'approve' && (mode === 'shadow' || mode === 'off')) await dropWaitingPosts(c, channelKey);
}
