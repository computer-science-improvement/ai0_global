import type { Pool } from 'pg';
import { errText } from '../../common/err-text';

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

/**
 * A mutation the owner confirms with a card click. Throwing marks the action failed with the message — except a
 * `KeepPendingError`, which leaves the card pending (the owner fixes his choices and applies again). `input` is what
 * the owner chose on the card (spec 034: verdicts and edits of example posts); null for a plain Apply.
 */
export type ActionHandler = (payload: Record<string, unknown>, action: PendingAction, input: unknown) => Promise<unknown>;

/** The owner's choices on the card are not acceptable yet (HTTP 400); the card stays pending. */
export class KeepPendingError extends Error {
  readonly status = 400;
  readonly keepPending = true;
  constructor(readonly code: string, message: string) { super(message); }
}

/**
 * Spec 069 FR-001: a card may carry follow-ups in `payload.then`. They run after the main handler succeeded, through the
 * same registered handlers, each in its own try: one failing does not change the card's status (only the main handler
 * does) and does not stop the next. `ticked: false` starts unticked (a soft suggestion); `requires: 'main_rows'` waits
 * for an import that actually found rows. An item's own `then` is never run.
 */
export interface FollowUp {
  key:       string;
  kind:      string;
  payload:   Record<string, unknown>;
  summary:   string;
  ticked?:   boolean;
  requires?: 'main_rows';
}

/** How one follow-up went; the card's `result.then` lists them in order. */
export interface FollowUpResult { key: string; ok: boolean; error?: string; result?: unknown }

export const MAX_FOLLOW_UPS = 8;

/** The follow-ups of a payload (malformed items are left out). */
export function followUpsOf(payload: Record<string, unknown> | null | undefined): FollowUp[] {
  const raw = payload?.then;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): FollowUp[] => {
    if (!x || typeof x !== 'object') return [];
    const o = x as Record<string, unknown>;
    if (typeof o.key !== 'string' || !o.key || typeof o.kind !== 'string' || !o.kind) return [];
    const body = o.payload && typeof o.payload === 'object' && !Array.isArray(o.payload) ? o.payload as Record<string, unknown> : {};
    return [{
      key: o.key, kind: o.kind, payload: body, summary: typeof o.summary === 'string' ? o.summary : '',
      ...(o.ticked === false ? { ticked: false } : {}), ...(o.requires === 'main_rows' ? { requires: 'main_rows' as const } : {}),
    }];
  });
}

/** The keys the owner unticked on the card, or null when the caller sent no choice (API, owner bot). */
const skipThenOf = (input: unknown): Set<string> | null => {
  const v = (input as { skip_then?: unknown } | null)?.skip_then;
  return Array.isArray(v) ? new Set(v.map(String)) : null;
};

/** `inserted + updated + skipped` of an import result: 0 = the import found nothing (a re-import of an unchanged list is not empty). */
const mainRows = (main: unknown): number => {
  const r = (main && typeof main === 'object' ? main : {}) as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === 'number' ? r[k] as number : 0);
  return n('inserted') + n('updated') + n('skipped');
};

const withThen = (main: unknown, then: FollowUpResult[]): Record<string, unknown> =>
  main && typeof main === 'object' && !Array.isArray(main)
    ? { ...(main as Record<string, unknown>), then }
    : { ok: true, ...(main !== undefined && main !== null ? { value: main } : {}), then };

const errorText = (err: any): string => (typeof err?.response === 'object' && err.response ? JSON.stringify(err.response) : errText(err));

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

  /** One card by id (a card made outside a chat opens from "Waiting for you"). */
  get(id: string): Promise<PendingAction | null> {
    return this.repo.get(id);
  }

  propose(a: { chatId: string | null; agentId?: string | null; kind: string; payload: Record<string, unknown>; summary: string }): Promise<PendingAction> {
    if (!this.handlers.has(a.kind)) throw new Error(`unknown action kind ${a.kind}`);
    this.checkFollowUps(a.payload);
    return this.repo.create(a);
  }

  /** Spec 069 A2: every follow-up names a registered kind and a key of its own; a card carries a handful at most. */
  private checkFollowUps(payload: Record<string, unknown>): void {
    if (payload.then === undefined) return;
    const items = followUpsOf(payload);
    if (!Array.isArray(payload.then) || items.length !== payload.then.length) throw new Error('invalid follow-ups: every item needs a key and a kind');
    if (items.length > MAX_FOLLOW_UPS) throw new Error(`invalid follow-ups: at most ${MAX_FOLLOW_UPS} per card`);
    const seen = new Set<string>();
    for (const it of items) {
      if (!this.handlers.has(it.kind)) throw new Error(`unknown action kind ${it.kind} in a follow-up`);
      if (seen.has(it.key)) throw new Error(`duplicate follow-up key ${it.key}`);
      seen.add(it.key);
    }
  }

  private readonly applying = new Set<string>();

  async apply(id: string, input: unknown = null): Promise<PendingAction> {
    // Single instance (constitution): an in-process claim makes a double click or a retried POST run the handler once.
    if (this.applying.has(id)) throw Object.assign(new Error('action_in_progress'), { status: 409 });
    this.applying.add(id);
    try {
      return await this.applyOnce(id, input);
    } finally {
      this.applying.delete(id);
    }
  }

  private async applyOnce(id: string, input: unknown): Promise<PendingAction> {
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
      const result = await h(a.payload, a, input);
      // Spec 069: the follow-ups run after the main handler; their outcomes join the result, the status is the main one's.
      const then = await this.runFollowUps(a, result, input);
      return (await this.repo.decide(id, 'applied', then.length ? withThen(result, then) : result ?? { ok: true })) ?? a;
    } catch (err: any) {
      if (err instanceof KeepPendingError) throw err;
      const msg = errorText(err);
      // Validation failures (stale rename, taken handle…) leave the card failed with the reason.
      return (await this.repo.decide(id, 'failed', null, msg.slice(0, 1000))) ?? a;
    }
  }

  /** Spec 069 FR-001 / A2 / A3: the card's follow-ups, in order, after the main handler succeeded. */
  private async runFollowUps(a: PendingAction, main: unknown, input: unknown): Promise<FollowUpResult[]> {
    const items = followUpsOf(a.payload);
    if (!items.length) return [];
    const skip = skipThenOf(input);
    const rows = mainRows(main);
    const out: FollowUpResult[] = [];
    for (const it of items) {
      // The dashboard sends the owner's choice (the unticked keys); without one (API, owner bot) the soft items stay off.
      if (skip ? skip.has(it.key) : it.ticked === false) { out.push({ key: it.key, ok: false, error: skip ? 'skipped' : 'not_ticked' }); continue; }
      if (it.requires === 'main_rows' && rows === 0) { out.push({ key: it.key, ok: false, error: 'import_empty' }); continue; }
      const h = this.handlers.get(it.kind);
      if (!h) { out.push({ key: it.key, ok: false, error: `no handler for ${it.kind}` }); continue; }
      try {
        const result = await h(it.payload, a, null);
        out.push({ key: it.key, ok: true, ...(result !== undefined && result !== null ? { result } : {}) });
      } catch (err: any) {
        out.push({ key: it.key, ok: false, error: errorText(err).slice(0, 500) });
      }
    }
    return out;
  }

  async discard(id: string): Promise<PendingAction> {
    const a = await this.repo.get(id);
    if (!a) throw Object.assign(new Error('action_not_found'), { status: 404 });
    if (a.status !== 'pending') return a;
    return (await this.repo.decide(id, 'discarded')) ?? a;
  }
}
