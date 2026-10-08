import { z } from 'zod';
import { defineTool, type EditorTool } from '../harness/tool';
import { proposeCard } from '../agents/builder-tools';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { PendingActionsService } from '../agents/pending-actions';
import { proposalKey, type MigrationProposal } from './proposal';
import { isFail, type Fail, type StrategyMigrationService } from './strategy-migration.service';

/**
 * The migration cards (spec 023 FR-011/FR-012): `migrate_strategies` (writes the migration draft),
 * `strategy_cutover` (retires the taken-over bindings, the resource goes to approval mode) and
 * `strategy_rollback`. Proposed from `/app/strategies` (chatless cards) or by @ai0 in the chat; each is
 * re-validated at Apply and fails with the reason. Summaries are English (the dashboard shows them).
 */

export const MIGRATION_ACTIONS = ['migrate_strategies', 'strategy_cutover', 'strategy_rollback'] as const;
export type MigrationOp = 'migrate' | 'cutover' | 'rollback';

const failText = (f: Fail) => `${f.error}${f.details !== undefined ? `: ${Array.isArray(f.details) ? f.details.join('; ') : String(f.details)}` : ''}`;

export function registerMigrationActions(actions: Pick<PendingActionsService, 'register'>, svc: StrategyMigrationService): void {
  actions.register('migrate_strategies', async (p) => {
    const r = await svc.writeDraft(String(p.channel_key), (p.key as string | undefined) ?? null);
    if (isFail(r)) throw new Error(failText(r));
    return { playbook: r.id, version: r.version, mapped: r.proposal.mapped, total: r.proposal.total };
  });
  actions.register('strategy_cutover', async (p) => {
    const r = await svc.cutover(String(p.channel_key), { expectExtIds: Array.isArray(p.ext_ids) ? (p.ext_ids as unknown[]).map(String) : undefined });
    if (isFail(r)) throw new Error(failText(r));
    return r;
  });
  actions.register('strategy_rollback', async (p) => {
    const r = await svc.rollback(String(p.channel_key));
    if (isFail(r)) throw new Error(failText(r));
    return r;
  });
}

/** What a card would carry: the kind, payload and English summary — or why it cannot be offered. */
export async function migrationCard(svc: StrategyMigrationService, op: MigrationOp, channelKey: string): Promise<{
  kind: typeof MIGRATION_ACTIONS[number]; payload: Record<string, unknown>; summary: string; agentId: string | null; proposal?: MigrationProposal;
} | Fail> {
  const sc = await svc.scope(channelKey);
  if (isFail(sc)) return sc;
  if (op === 'migrate') {
    const p = await svc.propose(channelKey);
    if (isFail(p)) return p;
    if (!p.mapped || !p.body) return { error: 'nothing_to_migrate', details: 'no enabled binding maps to a series or a frequency hint', status: 409 };
    if (p.errors.length) return { error: 'migration_invalid', details: p.errors, status: 409 };
    return {
      kind: 'migrate_strategies', agentId: sc.agent.id, proposal: p,
      payload: { channel_key: sc.card.channelKey, key: proposalKey(p) },
      summary: `Migrate ${p.mapped} of ${p.total} strategy binding(s) on ${sc.card.channelKey} to @${sc.agent.handle} (a playbook draft for your approval; the strategies keep publishing in shadow)`,
    };
  }
  if (op === 'cutover') {
    const o = await svc.cutoverOffer(channelKey);
    if (isFail(o)) return o;
    return {
      kind: 'strategy_cutover', agentId: sc.agent.id,
      payload: { channel_key: sc.card.channelKey, ext_ids: o.extIds },
      summary: `Cutover on ${sc.card.channelKey}: retire ${o.extIds.join(', ')} and switch @${sc.agent.handle} to approval mode (${o.stats.days} days in shadow, ${Math.round(o.stats.ratio * 100)}% of the series instances done)`,
    };
  }
  return {
    kind: 'strategy_rollback', agentId: sc.agent.id,
    payload: { channel_key: sc.card.channelKey },
    summary: `Rollback on ${sc.card.channelKey}: re-enable the migrated strategies and put @${sc.agent.handle} back to shadow`,
  };
}

/** @ai0's tool: dry-run a migration, or propose one of the three cards. */
export function buildMigrationTools(d: { svc: StrategyMigrationService; actions: Pick<PendingActionsService, 'propose'> }): EditorTool[] {
  const tool = defineTool({
    name: 'propose_strategy_migration',
    description: 'Перенесення старих стратегій (cron-публікацій) каналу в серії агента. op=preview — лише показати, що й як переноситься (нічого не пише); migrate — картка «перенести» (чернетка плейбука на затвердження власника, стратегії публікують далі, агент у shadow); cutover — картка «вимкнути стратегії й перевести ресурс у режим апруву» (лише після 7 днів у shadow і ≥80% виконаних серій); rollback — картка «повернути стратегії, агент знову в shadow». Картки — лише на пряме прохання власника. Якщо агента в каналу немає (no_agent) — спершу запропонуй create_agent.',
    kind: 'act', roles: ['builder'],
    input: z.object({
      channel: z.string().min(2).max(200).describe('ключ Telegram-каналу, напр. @my_channel'),
      op:      z.enum(['preview', 'migrate', 'cutover', 'rollback']).default('preview'),
    }),
    execute: async ({ channel, op }, ctx) => {
      if (op === 'preview') {
        const p = await d.svc.propose(channel);
        if (isFail(p)) return { error: p.error, details: p.details };
        return { mapped: p.mapped, total: p.total, bindings: p.bindings, errors: p.errors, rationale: p.rationale };
      }
      const card = await migrationCard(d.svc, op, channel);
      if (isFail(card)) return { error: card.error, details: card.details };
      return proposeCard(d, ctx, card.kind, card.payload, card.summary, card.agentId);
    },
  });
  return [tool];
}

/**
 * The cutover offer (FR-012): once a migrated channel has run ≥ 7 days in shadow with ≥ 80 % of its series
 * instances realised, a chatless `strategy_cutover` card waits on /app/strategies and the owner gets one Inbox
 * item per channel per 7 days. Never a mode change by itself.
 */
export async function offerCutovers(d: {
  svc: StrategyMigrationService;
  actions: Pick<PendingActionsService, 'propose'>;
  inbox: Pick<OwnerInbox, 'post'>;
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
}): Promise<number> {
  let n = 0;
  for (const row of await d.svc.status()) {
    if (row.state !== 'cutover_ready' || !row.agent) continue;
    const { rows: pending } = await d.pool.query(
      `SELECT 1 FROM pending_actions WHERE kind = 'strategy_cutover' AND status = 'pending' AND payload->>'channel_key' = $1 LIMIT 1`, [row.channel_key]);
    if (pending.length) continue;
    const card = await migrationCard(d.svc, 'cutover', row.channel_key);
    if (isFail(card)) continue;
    await d.actions.propose({ chatId: null, agentId: card.agentId, kind: card.kind, payload: card.payload, summary: card.summary });
    n++;
    const { rows: told } = await d.pool.query(
      `SELECT 1 FROM agent_inbox WHERE kind = 'strategy_cutover_ready' AND ref_id = $1 AND created_at > now() - interval '7 days' LIMIT 1`, [row.channel_key]);
    if (told.length) continue;
    await d.inbox.post({
      agentId: card.agentId, kind: 'strategy_cutover_ready', severity: 'action',
      title: `🔁 ${row.channel_key}: the migrated series ran ${row.shadow?.days ?? 7} days in shadow — ready to retire the strategies`,
      body: `${card.summary}. Apply it on the Strategies page (Legacy).`,
      alert: {
        title: `🔁 ${row.channel_key}: серії агента відпрацювали в shadow — можна вимикати стратегії`,
        body: 'Картка «Cutover» чекає на сторінці Strategies (Legacy).',
      },
      refType: 'channel', refId: row.channel_key,
    }).catch(() => {});
  }
  return n;
}
