import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Agent } from '../agents/agent.types';
import { telegramKeyOf } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import type { OwnerInbox } from '../agents/owner-inbox';
import { effectiveMode, type ChannelMode, type EditorCard } from '../card';
import { localDate } from '../roles/time';
import { rowToSlot } from '../repo/editor-plans.repository';
import { APPROVAL_BATCH_HOUR } from '../approval/approval-timing';
import { networkContext, NetworkContextDeps } from './network-context';
import { IDEA_STATUSES, IdeaStatus, NETWORK_MODE_ALIASES, NETWORK_MODES, NetworkMode, NetworkRepository, type PlaybookRow } from './network.repository';
import { PlaybookSchema, validatePlaybook } from './playbook';
import { lockOwnerSeries, normalizePlaybook, seriesSourceCatalog } from './series-edit';
import type { NetworkOffers } from './network-offers';
import { errText } from '../../common/err-text';

/** A content_decisions row as the dashboard reads it (spec 024 FR-006/FR-011). */
function toDecisionView(d: any) {
  return {
    ideaId: d.idea_id, resourceRef: d.resource_ref, decision: d.decision, reason: d.reason, reasonCode: d.reason_code ?? null,
    slotId: d.slot_id ?? null, decidedBy: d.decided_by, at: d.created_at,
  };
}

export interface NetworkServiceDeps {
  pool:     Pick<Pool, 'query'>;
  agents:   Pick<AgentsRepository, 'getByHandle' | 'get'>;
  repo:     NetworkRepository;
  inbox:    Pick<OwnerInbox, 'post'>;
  card:     (channelKey: string) => Promise<EditorCard | null>;
  usable?:  NetworkContextDeps['usable'];
  time?:    NetworkContextDeps['time'];
  /** Background playbook rebuild (NetworkRunner.runPlaybookBuild). */
  rebuild:  (card: EditorCard, brief: string | null) => Promise<unknown>;
  log?:     (msg: string) => void;
  now?:     () => Date;
  /** Spec 024 FR-010: offers to convert legacy auto-duplicate networks. */
  offers?:  Pick<NetworkOffers, 'onPlaybookActive' | 'decide' | 'list' | 'run'>;
  /** Spec 025 FR-015: a decided version that a strategy directive asked for (DirectiveExecution.onPlaybookDecided). */
  onPlaybookDecided?: (pb: PlaybookRow, approve: boolean) => Promise<unknown>;
}

/** Owner surface of playbooks, the idea pool, network plans and network mode (spec 020 FR-010/FR-011). */
export class NetworkService {
  constructor(private readonly d: NetworkServiceDeps) {}

  private async orch(handle: string): Promise<{ agent: Agent; card: EditorCard }> {
    const a = await this.d.agents.getByHandle(handle);
    if (!a) throw new NotFoundException({ error: 'agent_not_found', handle });
    const orch = a.parentId ? (await this.d.agents.get(a.parentId)) ?? a : a;
    const key = telegramKeyOf(orch);
    const card = key ? await this.d.card(key) : null;
    if (!card) throw new BadRequestException({ error: 'no_channel_card', details: 'an orchestrator without a Telegram channel has no playbook' });
    return { agent: orch, card };
  }

  async network(handle: string) {
    const { agent, card } = await this.orch(handle);
    const net = await networkContext({ repo: this.d.repo, usable: this.d.usable, time: this.d.time }, agent, card);
    // Spec 024 FR-003/FR-012: whether the anchor's posts are still auto-duplicated today.
    const autoDuplicateActive = net?.groupId && this.d.repo.autoDuplicateActive
      ? await this.d.repo.autoDuplicateActive(net.groupId, (this.d.now ?? (() => new Date()))()).catch(() => true)
      : true;
    return { anchor: card.channelKey, mode: net?.mode ?? 'single', groupId: net?.groupId ?? null, groupName: net?.groupName ?? null, autoDuplicateActive,
      // Spec 024 FR-012: each resource's own zone and quiet hours.
      resources: (net?.resources ?? []).map(({ tz, quiet, ...r }) => ({ ...r, timezone: tz ?? null, quietHours: quiet ?? null })) };
  }

  async playbook(handle: string) {
    const { agent } = await this.orch(handle);
    const [active, pending, history] = await Promise.all([
      this.d.repo.activePlaybook(agent.id), this.d.repo.pendingPlaybook(agent.id), this.d.repo.playbookHistory(agent.id),
    ]);
    return { active, pending, history };
  }

  async decide(id: string, approve: boolean) {
    const pb = await this.d.repo.decidePlaybook(id, approve);
    if (!pb) throw new ConflictException({ error: 'not_pending', details: 'this version no longer awaits a decision' });
    if (approve) await this.playbookActive(pb.agentId);
    if (pb.directiveId && this.d.onPlaybookDecided) {
      await this.d.onPlaybookDecided(pb, approve).catch((err) => this.d.log?.(`strategy directive after the playbook decision failed: ${errText(err)}`));
    }
    return { playbook: pb };
  }

  /** Owner edit: validated and active at once (owner precedence); a pending agent draft is superseded. */
  async putPlaybook(handle: string, body: unknown) {
    const { agent, card } = await this.orch(handle);
    const p = z.object({ body: PlaybookSchema, rationale: z.string().max(2000).optional() }).safeParse(body ?? {});
    if (!p.success) throw new BadRequestException({ error: 'invalid_body', issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const net = await networkContext({ repo: this.d.repo, usable: this.d.usable, time: this.d.time }, agent, card);
    // Spec 023 FR-002: an owner's new or edited series is locked (the agent gets series_locked); quiet hours
    // are not enforced for the owner's own series (owner precedence, like the owner's pins).
    const lockedIn = lockOwnerSeries(net?.playbook ? normalizePlaybook(net.playbook) : null, p.data.body);
    // Spec 034 FR-008: an edit that does not send `examples` (an older editor) keeps the current ones.
    const sentExamples = Array.isArray((body as { body?: { examples?: unknown } } | null)?.body?.examples);
    const locked = sentExamples ? lockedIn : { ...lockedIn, examples: net?.playbook ? normalizePlaybook(net.playbook).examples ?? [] : [] };
    const errors = validatePlaybook(locked, net?.resources ?? [], net?.telegramFormats ?? [], { sources: await seriesSourceCatalog(this.d.pool, card) });
    if (errors.length) throw new BadRequestException({ error: 'playbook_invalid', details: errors });
    const pb = await this.d.repo.insertPlaybook({ agentId: agent.id, status: 'active', brief: null, body: locked, rationale: p.data.rationale ?? 'owner edit', createdBy: 'owner' });
    await this.playbookActive(agent.id);
    return { playbook: pb };
  }

  /** Spec 024 FR-010: a legacy group offered without a playbook is offered again once its first playbook is active. */
  private async playbookActive(agentId: string): Promise<void> {
    await this.d.offers?.onPlaybookActive(agentId).catch((err) => this.d.log?.(`network offer after playbook failed: ${errText(err)}`));
  }

  /** Spec 024 FR-010: every offer to convert a legacy network, with the owner's answer. */
  async offers() {
    return { offers: this.d.offers ? await this.d.offers.list() : [] };
  }

  /** The once-per-group housekeeping step (hourly cron). */
  async runOffers() {
    return this.d.offers ? this.d.offers.run() : [];
  }

  /** "Keep auto-duplicate": the group stays legacy_duplicate and is never offered again. */
  async keepOffer(groupId: string) {
    if (!this.d.offers) throw new NotFoundException({ error: 'offer_not_found' });
    const ok = await this.d.offers.decide(groupId, 'kept', 'owner');
    if (!ok) {
      const cur = (await this.d.offers.list()).find((o) => o.groupId === groupId);
      if (!cur) throw new NotFoundException({ error: 'offer_not_found' });
      return { status: cur.status };
    }
    return { status: 'kept' as const };
  }

  async rebuild(handle: string, body: unknown) {
    const { card } = await this.orch(handle);
    const p = z.object({ brief: z.string().max(4000).optional() }).safeParse(body ?? {});
    if (!p.success) throw new BadRequestException({ error: 'invalid_body' });
    void this.d.rebuild(card, p.data.brief ?? (card.brief || null)).catch((err) => this.d.log?.(`playbook rebuild failed: ${errText(err)}`));
    return { started: true };
  }

  async ideas(handle: string, status?: string) {
    const { agent } = await this.orch(handle);
    const statuses = status ? status.split(',').filter((s) => (IDEA_STATUSES as readonly string[]).includes(s)) as IdeaStatus[] : null;
    const ideas = await this.d.repo.listIdeas(agent.id, statuses?.length ? statuses : null, 200);
    // Spec 024 FR-011: the Ideas card shows the decision matrix once an idea is planned.
    const ids = ideas.map((i) => i.id);
    const { rows } = ids.length ? await this.d.pool.query(
      `SELECT idea_id, resource_ref, decision, reason, reason_code, slot_id, decided_by, created_at FROM content_decisions
        WHERE idea_id = ANY($1::uuid[]) ORDER BY created_at`, [ids]).catch(() => ({ rows: [] as any[] })) : { rows: [] as any[] };
    const byIdea = new Map<string, unknown[]>();
    for (const d of rows) {
      const list = byIdea.get(d.idea_id) ?? [];
      list.push(toDecisionView(d));
      byIdea.set(d.idea_id, list);
    }
    return { ideas: ideas.map((i) => ({ ...i, decisions: byIdea.get(i.id) ?? [] })) };
  }

  /** Owner override of the reviewer: accept or reject an idea. */
  async decideIdea(id: string, accept: boolean) {
    const idea = await this.d.repo.idea(id);
    if (!idea) throw new NotFoundException({ error: 'idea_not_found' });
    if (!['new', 'needs_revision', 'accepted', 'rejected'].includes(idea.status)) throw new ConflictException({ error: 'idea_final', details: idea.status });
    return { idea: await this.d.repo.updateIdea(id, { status: accept ? 'accepted' : 'rejected', review: { ...(idea.review ?? {}), owner: accept ? 'accepted' : 'rejected' } }) };
  }

  /**
   * The day's plan of the anchor channel with every resource's slots (spec 020), and (spec 034 FR-012/FR-013) when
   * and by which run it was made, the superseded plans of the day (history), how the agent plans (card plan hour;
   * approval mode plans the next day at 20:00 the evening before), each slot's planning details (series, source
   * hints, live spec, critic verdict, the owner's dry-run preview) and the typical cost of one Preview.
   */
  async plan(handle: string, date?: string) {
    const { agent, card } = await this.orch(handle);
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate((this.d.now ?? (() => new Date()))(), card.timezone);
    const { rows: plans } = await this.d.pool.query(
      `SELECT p.id, p.rationale, p.created_at, p.run_id, p.status, r.role AS run_role,
              (SELECT COUNT(*)::int FROM editor_slots s WHERE s.plan_id = p.id) AS slots
         FROM editor_plans p LEFT JOIN editor_runs r ON r.id = p.run_id
        WHERE p.channel_key = $1 AND p.plan_date = $2
        ORDER BY (p.status = 'active') DESC, p.created_at DESC`, [card.channelKey, day]);
    const plan = plans.find((p) => p.status === 'active') ?? null;
    const { rows: slots } = plan ? await this.d.pool.query(`SELECT s.* FROM editor_slots s WHERE s.plan_id = $1 ORDER BY s.scheduled_at`, [plan.id]) : { rows: [] as any[] };
    // Spec 024 FR-006: the per-(idea, resource) decisions of the ideas in this plan, skips included.
    const ideaIds = [...new Set(slots.map((s) => s.idea_id).filter(Boolean))] as string[];
    const { rows: decisions } = ideaIds.length ? await this.d.pool.query(
      `SELECT idea_id, resource_ref, decision, reason, reason_code, slot_id, decided_by, created_at FROM content_decisions
        WHERE idea_id = ANY($1::uuid[]) ORDER BY created_at`, [ideaIds]) : { rows: [] as any[] };
    const est = await this.previewEstimate(card.channelKey);
    const mode = effectiveMode(agent.mode as ChannelMode, card.mode);
    return {
      date: day, anchor: card.channelKey, rationale: plan?.rationale ?? null,
      // Spec 034 FR-012: "Planned at {time} by {run}".
      planId: plan?.id ?? null, plannedAt: plan?.created_at ?? null, runId: plan?.run_id ?? null, runRole: plan?.run_role ?? null,
      // Spec 034 FR-013: when this agent plans (the card's plan hour; approval mode: the evening before).
      schedule: { timezone: card.timezone, planHour: card.planHour, mode, approval: mode === 'approve', batchHour: APPROVAL_BATCH_HOUR },
      history: plans.filter((p) => p.status !== 'active').map((p) => ({
        id: p.id, plannedAt: p.created_at, runId: p.run_id ?? null, runRole: p.run_role ?? null, rationale: p.rationale ?? null, slots: Number(p.slots),
      })),
      previewEstimateUsd: est,
      // The card's feeds (id → URL), so a live slot's sources read as site names.
      feeds: Object.fromEntries((card.sources ?? []).filter((x) => x.kind === 'rss' || x.kind === 'url').map((x) => [x.id, x.ref])),
      slots: slots.map(rowToSlot).map((s) => ({
        id: s.id, at: s.scheduledAt, kind: s.kind, format: s.format, topic: s.topic, angle: s.angle, status: s.status, error: s.error,
        preview: s.renderedPreview, resourceRef: s.resourceRef ?? `telegram:${card.channelKey}`, ideaId: s.ideaId ?? null, runId: s.runId,
        treatment: s.treatment ?? null, treatmentReason: s.treatmentReason ?? null, derivedFrom: s.derivedFromSlotId ?? null,
        sourceHints: s.sourceHints, seriesName: s.seriesName ?? null, isExperiment: s.isExperiment, createdAt: s.createdAt ?? null,
        pinned: !!s.scheduleRuleId, topicMode: s.topicMode ?? 'fixed', ...(s.liveSpec ? { liveSpec: s.liveSpec } : {}),
        critic: s.critic ?? null, previewDraft: s.previewDraft ?? null,
      })),
      decisions: decisions.map(toDecisionView),
    };
  }

  /** The typical USD of one slot Preview on the channel (spec 034 FR-012), null without executor history. */
  private async previewEstimate(channelKey: string): Promise<number | null> {
    try {
      const { rows } = await this.d.pool.query(
        `SELECT role, AVG(cost_usd)::float8 AS usd FROM (
           SELECT role, cost_usd, ROW_NUMBER() OVER (PARTITION BY role ORDER BY started_at DESC) AS rn
             FROM editor_runs WHERE channel_key = $1 AND role IN ('executor', 'checker') AND status = 'ok' AND finished_at IS NOT NULL
         ) x WHERE rn <= 20 GROUP BY role`, [channelKey]);
      const exec = rows.find((r) => r.role === 'executor');
      if (!exec) return null;
      return Number((Number(exec.usd) + Number(rows.find((r) => r.role === 'checker')?.usd ?? 0)).toFixed(6));
    } catch {
      return null;
    }
  }

  /**
   * independent ↔ legacy_duplicate (spec 024 FR-002). `orchestrated` / `mirror` are
   * accepted as aliases for one release. No playbook is required: an independent
   * network without one plans Telegram only and keeps auto-duplicating (FR-003).
   */
  async setMode(handle: string, body: unknown) {
    const { agent, card } = await this.orch(handle);
    const p = z.object({ mode: z.enum(['independent', 'legacy_duplicate', 'orchestrated', 'mirror']) }).safeParse(body ?? {});
    if (!p.success) throw new BadRequestException({ error: 'invalid_body', details: `mode is one of ${NETWORK_MODES.join(', ')}` });
    const alias = NETWORK_MODE_ALIASES[p.data.mode];
    const mode: NetworkMode = alias ?? (p.data.mode as NetworkMode);
    if (alias) this.d.log?.(`network-mode: "${p.data.mode}" is deprecated, use "${alias}" (@${agent.handle})`);
    const group = await this.d.repo.groupOfChannel(card.channelKey);
    if (!group) throw new BadRequestException({ error: 'no_network', details: 'the channel is not in an account group (/app/connections/groups)' });
    const now = (this.d.now ?? (() => new Date()))();
    await this.d.repo.setGroupMode(group.id, mode, now);
    // Spec 024 FR-010: switching answers an open offer; explicitly choosing legacy keeps it.
    await this.d.offers?.decide(group.id, mode === 'independent' ? 'switched' : 'kept', 'owner')
      .catch((err) => this.d.log?.(`network offer update failed: ${errText(err)}`));
    const hasPlaybook = !!(await this.d.repo.activePlaybook(agent.id));
    const independent = mode === 'independent';
    await this.d.inbox.post({
      agentId: agent.id, kind: 'network_mode', severity: 'info',
      title: `🕸 Network "${group.name}" → ${independent ? 'independent' : 'auto-duplicate (legacy)'}`,
      body: independent
        ? `Each resource is its own unit: @${agent.handle} decides per post whether to duplicate, adapt, write a unique post or skip (agent mode: ${agent.mode}).`
          + (hasPlaybook ? '' : ' Until a playbook is approved only Telegram is planned and its posts keep being auto-duplicated.')
          + ' Auto-duplication stops from the next plan day once the agent is live with an active playbook.'
        : 'Telegram posts are auto-duplicated to the other resources again from the next plan day.',
      alert: {
        title: `🕸 Мережа «${group.name}» → ${independent ? 'незалежні ресурси' : 'автодублювання (legacy)'}`,
        body: independent
          ? `Кожен ресурс — окрема одиниця: @${agent.handle} вирішує для кожного поста — дублювати, адаптувати, унікальний пост чи пропустити (режим агента: ${agent.mode}).`
            + (hasPlaybook ? '' : ' Поки плейбук не затверджено, планується лише Telegram і його пости далі автоматично дублюються.')
            + ' Автодублювання припиняється з наступного дня плану, коли агент у live з активним плейбуком.'
          : 'Пости Telegram знову автоматично дублюються в інші ресурси з наступного дня плану.',
      },
      refType: 'agent', refId: agent.handle,
    });
    return { mode, group: group.name, ...(alias ? { deprecated_alias: p.data.mode } : {}) };
  }
}
