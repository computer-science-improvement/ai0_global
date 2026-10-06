import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Agent } from '../agents/agent.types';
import { telegramKeyOf } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { EditorCard } from '../card';
import { localDate } from '../roles/time';
import { networkContext, NetworkContextDeps } from './network-context';
import { IDEA_STATUSES, IdeaStatus, NETWORK_MODE_ALIASES, NETWORK_MODES, NetworkMode, NetworkRepository } from './network.repository';
import { PlaybookSchema, validatePlaybook } from './playbook';

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
    return { playbook: pb };
  }

  /** Owner edit: validated and active at once (owner precedence); a pending agent draft is superseded. */
  async putPlaybook(handle: string, body: unknown) {
    const { agent, card } = await this.orch(handle);
    const p = z.object({ body: PlaybookSchema, rationale: z.string().max(2000).optional() }).safeParse(body ?? {});
    if (!p.success) throw new BadRequestException({ error: 'invalid_body', issues: p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const net = await networkContext({ repo: this.d.repo, usable: this.d.usable, time: this.d.time }, agent, card);
    const errors = validatePlaybook(p.data.body, net?.resources ?? [], net?.telegramFormats ?? []);
    if (errors.length) throw new BadRequestException({ error: 'playbook_invalid', details: errors });
    const pb = await this.d.repo.insertPlaybook({ agentId: agent.id, status: 'active', brief: null, body: p.data.body, rationale: p.data.rationale ?? 'owner edit', createdBy: 'owner' });
    return { playbook: pb };
  }

  async rebuild(handle: string, body: unknown) {
    const { card } = await this.orch(handle);
    const p = z.object({ brief: z.string().max(4000).optional() }).safeParse(body ?? {});
    if (!p.success) throw new BadRequestException({ error: 'invalid_body' });
    void this.d.rebuild(card, p.data.brief ?? (card.brief || null)).catch((err) => this.d.log?.(`playbook rebuild failed: ${err?.message ?? err}`));
    return { started: true };
  }

  async ideas(handle: string, status?: string) {
    const { agent } = await this.orch(handle);
    const statuses = status ? status.split(',').filter((s) => (IDEA_STATUSES as readonly string[]).includes(s)) as IdeaStatus[] : null;
    return { ideas: await this.d.repo.listIdeas(agent.id, statuses?.length ? statuses : null, 200) };
  }

  /** Owner override of the reviewer: accept or reject an idea. */
  async decideIdea(id: string, accept: boolean) {
    const idea = await this.d.repo.idea(id);
    if (!idea) throw new NotFoundException({ error: 'idea_not_found' });
    if (!['new', 'needs_revision', 'accepted', 'rejected'].includes(idea.status)) throw new ConflictException({ error: 'idea_final', details: idea.status });
    return { idea: await this.d.repo.updateIdea(id, { status: accept ? 'accepted' : 'rejected', review: { ...(idea.review ?? {}), owner: accept ? 'accepted' : 'rejected' } }) };
  }

  /** The day's plan of the anchor channel with every resource's slots. */
  async plan(handle: string, date?: string) {
    const { card } = await this.orch(handle);
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate((this.d.now ?? (() => new Date()))(), card.timezone);
    const { rows: plans } = await this.d.pool.query(
      `SELECT id, rationale, created_at FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active'`, [card.channelKey, day]);
    const plan = plans[0] ?? null;
    const { rows: slots } = plan ? await this.d.pool.query(
      `SELECT s.id, s.scheduled_at, s.kind, s.format, s.topic, s.angle, s.status, s.error, s.rendered_preview, s.resource_ref, s.idea_id, s.run_id
         FROM editor_slots s WHERE s.plan_id = $1 ORDER BY s.scheduled_at`, [plan.id]) : { rows: [] as any[] };
    return {
      date: day, anchor: card.channelKey, rationale: plan?.rationale ?? null,
      slots: slots.map((s) => ({
        id: s.id, at: s.scheduled_at, kind: s.kind, format: s.format, topic: s.topic, angle: s.angle, status: s.status, error: s.error,
        preview: s.rendered_preview, resourceRef: s.resource_ref ?? `telegram:${card.channelKey}`, ideaId: s.idea_id, runId: s.run_id,
      })),
    };
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
