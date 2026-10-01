import type { Pool } from 'pg';

export type ActionStatus = 'pending' | 'applied' | 'discarded' | 'expired' | 'failed';

export interface PendingAction {
  id:        string;
  chatId:    string | null;
  agentId:   string | null;
  kind:      string;
  payload:   Record<string, unknown>;
  summary:   string;
  status:    ActionStatus;
  result:    unknown;
  error:     string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export const ACTION_TTL_MS = 24 * 3600_000;

const toAction = (r: any): PendingAction => ({
  id: r.id, chatId: r.chat_id ?? null, agentId: r.agent_id ?? null, kind: r.kind, payload: r.payload ?? {}, summary: r.summary,
  status: r.status, result: r.result ?? null, error: r.error ?? null, createdAt: r.created_at, decidedAt: r.decided_at ?? null,
});

export class PendingActionsRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async create(a: { chatId: string | null; agentId?: string | null; kind: string; payload: Record<string, unknown>; summary: string }): Promise<PendingAction> {
    const { rows } = await this.pool.query(
      `INSERT INTO pending_actions (chat_id, agent_id, kind, payload, summary) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [a.chatId, a.agentId ?? null, a.kind, JSON.stringify(a.payload), a.summary.slice(0, 2000)]);
    return toAction(rows[0]);
  }

  async get(id: string): Promise<PendingAction | null> {
    const { rows } = await this.pool.query(`SELECT * FROM pending_actions WHERE id = $1`, [id]);
    return rows[0] ? toAction(rows[0]) : null;
  }

  /** Atomically moves a pending action to a final status; null when it was not pending any more. */
  async decide(id: string, status: Exclude<ActionStatus, 'pending'>, result?: unknown, error?: string | null): Promise<PendingAction | null> {
    const { rows } = await this.pool.query(
      `UPDATE pending_actions SET status = $2, result = $3, error = $4, decided_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, status, result === undefined ? null : JSON.stringify(result), error ?? null]);
    return rows[0] ? toAction(rows[0]) : null;
  }

  async listForChat(chatId: string): Promise<PendingAction[]> {
    const { rows } = await this.pool.query(`SELECT * FROM pending_actions WHERE chat_id = $1 ORDER BY created_at`, [chatId]);
    return rows.map(toAction);
  }

  async expireOld(now: Date): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE pending_actions SET status = 'expired', decided_at = now() WHERE status = 'pending' AND created_at < $1`,
      [new Date(now.getTime() - ACTION_TTL_MS)]);
    return rowCount ?? 0;
  }
}

/** A mutation the owner confirms with a card click. Throwing marks the action failed with the message. */
export type ActionHandler = (payload: Record<string, unknown>, action: PendingAction) => Promise<unknown>;

/**
 * Confirmation cards (spec 018 FR-005): tools only propose; the owner's
 * [Apply] runs the registered handler once. Later specs register more kinds
 * (playbooks, network mode, directives).
 */
export class PendingActionsService {
  private readonly handlers = new Map<string, ActionHandler>();

  constructor(private readonly repo: PendingActionsRepository, private readonly now: () => Date = () => new Date()) {}

  register(kind: string, handler: ActionHandler): void {
    if (this.handlers.has(kind)) throw new Error(`duplicate action handler ${kind}`);
    this.handlers.set(kind, handler);
  }

  has(kind: string): boolean {
    return this.handlers.has(kind);
  }

  propose(a: { chatId: string | null; agentId?: string | null; kind: string; payload: Record<string, unknown>; summary: string }): Promise<PendingAction> {
    if (!this.handlers.has(a.kind)) throw new Error(`unknown action kind ${a.kind}`);
    return this.repo.create(a);
  }

  async apply(id: string): Promise<PendingAction> {
    const a = await this.repo.get(id);
    if (!a) throw Object.assign(new Error('action_not_found'), { status: 404 });
    if (a.status === 'applied') return a; // idempotent
    if (a.status !== 'pending') throw Object.assign(new Error(`action_${a.status}`), { status: 409 });
    if (this.now().getTime() - a.createdAt.getTime() > ACTION_TTL_MS) {
      return (await this.repo.decide(id, 'expired')) ?? a;
    }
    const h = this.handlers.get(a.kind);
    if (!h) throw Object.assign(new Error(`no handler for ${a.kind}`), { status: 500 });
    try {
      const result = await h(a.payload, a);
      return (await this.repo.decide(id, 'applied', result ?? { ok: true })) ?? a;
    } catch (err: any) {
      const msg = typeof err?.response === 'object' && err.response
        ? JSON.stringify(err.response)
        : String(err?.message ?? err);
      // Validation failures (stale rename, taken handle…) leave the card failed with the reason.
      return (await this.repo.decide(id, 'failed', null, msg.slice(0, 1000))) ?? a;
    }
  }

  async discard(id: string): Promise<PendingAction> {
    const a = await this.repo.get(id);
    if (!a) throw Object.assign(new Error('action_not_found'), { status: 404 });
    if (a.status !== 'pending') return a;
    return (await this.repo.decide(id, 'discarded')) ?? a;
  }
}
