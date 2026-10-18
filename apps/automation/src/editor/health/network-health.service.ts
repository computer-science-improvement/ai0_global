import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import { KYIV_DAY_START_SQL } from '../../common/ai/usage/llm-budget.service';
import type { AgentCapStatus, BlockingCap, BudgetStatus } from '../../spend/spend.service';
import { isTroubled, type SourceHealthReport } from '../sources/source-health';
import {
  BAD_CONNECTION_STATES, networkHealth, type BadConnectionState, type ConnectionIssue, type NetworkHealth, type SourceIssue,
  type StuckGroup, type StuckItem, type StuckKind,
} from './network-health';

export interface NetworkHealthDeps {
  pool:     Pick<Pool, 'query'>;
  channels: { listActive(): Promise<EditorCard[]> };
  sources:  (card: EditorCard) => Promise<SourceHealthReport>;
  budgets:  () => Promise<{ rows: BudgetStatus[]; agentCaps: AgentCapStatus[]; blocking: BlockingCap[] }>;
  /** Resource titles for the connections (the resource catalog); optional. */
  catalog?: { list(): Promise<Array<{ ref: string; title: string | null; agent: string | null }>> };
  now?:     () => Date;
}

/** Items shown per stuck group (the count covers all). */
const STUCK_ITEMS = 5;

/** Each stuck kind: rows ordered oldest first, `total` = count(*) OVER (). */
const STUCK_SQL: Record<StuckKind, string> = {
  slot_running: `
    SELECT s.id::text, s.topic AS title, s.updated_at AS at, s.channel_key, s.error AS detail, NULL::text AS agent, count(*) OVER () AS total
      FROM editor_slots s WHERE s.status = 'running' AND s.updated_at < now() - interval '30 minutes'`,
  slot_overdue: `
    SELECT s.id::text, s.topic AS title, s.scheduled_at AS at, s.channel_key, s.error AS detail, NULL::text AS agent, count(*) OVER () AS total
      FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id AND p.status = 'active'
     WHERE s.status = 'planned' AND s.scheduled_at < now() - interval '30 minutes' AND (s.retry_at IS NULL OR s.retry_at < now())`,
  slot_failed: `
    SELECT s.id::text, s.topic AS title, s.updated_at AS at, s.channel_key, s.error AS detail, NULL::text AS agent, count(*) OVER () AS total
      FROM editor_slots s WHERE s.status = 'failed' AND s.updated_at > now() - interval '24 hours'`,
  approval_waiting: `
    SELECT s.id::text, s.topic AS title, s.updated_at AS at, s.channel_key, NULL::text AS detail, NULL::text AS agent, count(*) OVER () AS total
      FROM editor_slots s WHERE s.status = 'awaiting_approval' AND s.updated_at < now() - interval '24 hours'`,
  action_waiting: `
    SELECT a.id::text, a.summary AS title, a.created_at AS at, a.payload->>'channelKey' AS channel_key, a.kind AS detail, g.handle AS agent, count(*) OVER () AS total
      FROM pending_actions a LEFT JOIN agents g ON g.id = a.agent_id
     WHERE a.status = 'pending' AND a.created_at < now() - interval '12 hours'`,
  playbook_waiting: `
    SELECT p.id::text, 'Playbook v' || p.version AS title, p.created_at AS at, NULL::text AS channel_key, p.rationale AS detail, g.handle AS agent, count(*) OVER () AS total
      FROM playbooks p JOIN agents g ON g.id = p.agent_id
     WHERE p.status = 'pending_owner' AND p.created_at < now() - interval '2 days'`,
  ideas_waiting: `
    SELECT i.id::text, i.title, i.created_at AS at, NULL::text AS channel_key, i.angle AS detail, g.handle AS agent, count(*) OVER () AS total
      FROM content_ideas i JOIN agents g ON g.id = i.agent_id
     WHERE i.status = 'new' AND i.created_at < now() - interval '48 hours' AND i.expires_at > now()`,
};

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Spec 049 FR-005: reads connections, sources, budget headroom and stuck work for the network health view. */
export class NetworkHealthService {
  constructor(private readonly d: NetworkHealthDeps) {}

  async health(): Promise<NetworkHealth> {
    const now = (this.d.now ?? (() => new Date()))();
    const agents = await this.orchestrators();
    const [connections, sources, budget, slotsHit, stuck] = await Promise.all([
      this.connections(agents), this.sources(agents), this.d.budgets().catch(() => ({ rows: [], agentCaps: [], blocking: [] })),
      this.slotsHitByBudget(), Promise.all((Object.keys(STUCK_SQL) as StuckKind[]).map((k) => this.stuck(k))),
    ]);
    return networkHealth({ now, connections, sources, budget: { ...budget, slotsHit }, stuck });
  }

  /** scope:scope_id → handle of the top-level orchestrators (a Telegram channel is resource:telegram:@x). */
  private async orchestrators(): Promise<Map<string, string>> {
    const { rows } = await this.d.pool.query(
      `SELECT scope, scope_id, handle FROM agents WHERE parent_id IS NULL AND kind = 'orchestrator'`).catch(() => ({ rows: [] as any[] }));
    return new Map(rows.map((a: any) => [`${a.scope}:${a.scope_id}`, a.handle as string]));
  }

  private async connections(agents: Map<string, string>): Promise<ConnectionIssue[]> {
    const { rows } = await this.d.pool.query(
      `SELECT resource_ref, resource_health FROM resource_profiles WHERE resource_health->>'state' = ANY($1::text[])`,
      [[...BAD_CONNECTION_STATES]]).catch(() => ({ rows: [] as any[] }));
    if (!rows.length) return [];
    const catalog = this.d.catalog ? await this.d.catalog.list().catch(() => []) : [];
    const byRef = new Map(catalog.map((c) => [c.ref, c]));
    return rows.map((r: any) => {
      const h = r.resource_health ?? {};
      const c = byRef.get(r.resource_ref);
      return {
        ref: r.resource_ref, title: c?.title ?? null, state: h.state as BadConnectionState, detail: h.detail ?? null,
        since: h.since ?? null, checkedAt: h.checkedAt ?? null, expiresAt: h.expiresAt ?? null, muted: !!h.dismissedAt,
        agent: c?.agent ?? agents.get(`resource:${r.resource_ref}`) ?? null,
      };
    });
  }

  private async sources(agents: Map<string, string>): Promise<SourceIssue[]> {
    const cards = (await this.d.channels.listActive().catch(() => [] as EditorCard[])).filter((c) => c.sources.length);
    const out: SourceIssue[] = [];
    for (const card of cards) {
      const report = await this.d.sources(card).catch(() => null);
      if (!report) continue;
      const agent = agents.get(`resource:telegram:${card.channelKey}`) ?? null;
      for (const s of report.sources.filter(isTroubled)) out.push({ ...s, channelKey: card.channelKey, agent });
    }
    return out;
  }

  private async slotsHitByBudget(): Promise<number> {
    const { rows } = await this.d.pool.query(
      `SELECT count(*)::int AS n FROM editor_slots
        WHERE (error LIKE 'budget:%' OR error LIKE 'waiting for budget:%') AND updated_at >= ${KYIV_DAY_START_SQL}`)
      .catch(() => ({ rows: [{ n: 0 }] }));
    return Number(rows[0]?.n ?? 0);
  }

  private async stuck(kind: StuckKind): Promise<Omit<StuckGroup, 'label' | 'rule'>> {
    const { rows } = await this.d.pool.query(`${STUCK_SQL[kind]} ORDER BY at ASC LIMIT ${STUCK_ITEMS}`)
      .catch(() => ({ rows: [] as any[] }));
    const items: StuckItem[] = rows.map((r: any) => ({
      id: r.id, title: String(r.title ?? '').slice(0, 200), at: iso(r.at)!,
      channelKey: r.channel_key ?? null, agent: r.agent ?? null, detail: r.detail ? String(r.detail).slice(0, 300) : null,
    }));
    return { kind, count: Number(rows[0]?.total ?? 0), oldestAt: items[0]?.at ?? null, items };
  }
}
