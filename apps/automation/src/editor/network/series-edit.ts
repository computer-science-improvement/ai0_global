import { effectiveMode, type ChannelMode, type EditorCard } from '../card';
import type { ToolContext } from '../harness/tool';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { NetworkCtx } from './network-context';
import type { NetworkRepository, PlaybookRow } from './network.repository';
import { classifyPlaybookChange, Playbook, PlaybookSchema, Series, validatePlaybook } from './playbook';
import { seriesContent, SeriesSourceCatalog } from './series';

/**
 * Who may change a series (spec 023 FR-002/FR-003) and the one submit path every playbook change of an
 * orchestrator goes through (`submit_playbook` and the five series tools):
 *   validate (incl. series v2 checks) → ownership guard → classify (with the resource's mode, spec 031)
 *   → insert (structural: pending_owner, else active) → Inbox item (a card when the owner decides).
 */

/** Stored bodies are raw JSON (older versions lack the v2 defaults); parse them, fall back to the raw body. */
export function normalizePlaybook(raw: unknown): Playbook {
  const p = PlaybookSchema.safeParse(raw);
  return p.success ? p.data : (raw as Playbook);
}

export type SeriesGuard = { ok: true; body: Playbook } | { error: 'series_locked'; details: string };

/**
 * An agent's body: ownership fields come from the active version (an agent can neither claim a series as the
 * owner's nor unlock one), new series are the agent's, and an owner-locked series must stay exactly as it is.
 */
export function guardAgentSeries(active: Playbook | null, next: Playbook): SeriesGuard {
  const prev = new Map((active?.series ?? []).map((s) => [s.name, s]));
  for (const [name, o] of prev) {
    if (!o.locked) continue;
    const n = next.series.find((s) => s.name === name);
    if (!n) return { error: 'series_locked', details: `серію «${name}» заблокував власник — її не можна прибрати; згадай це в підсумку прогону` };
    if (seriesContent(n) !== seriesContent(o)) {
      return { error: 'series_locked', details: `серію «${name}» заблокував власник — її не можна змінювати; згадай це в підсумку прогону` };
    }
  }
  const series = next.series.map((s): Series => {
    const o = prev.get(s.name);
    return o
      ? { ...s, origin: o.origin ?? 'agent', locked: !!o.locked, ...(o.migrated_from ? { migrated_from: o.migrated_from } : { migrated_from: undefined }) }
      : { ...s, origin: 'agent', locked: false, migrated_from: undefined };
  });
  return { ok: true, body: { ...next, series } };
}

/**
 * An owner edit (dashboard PUT, chat card): a new series becomes the owner's and locked; an edited one is
 * locked; an unchanged one keeps its owner and lock (only "Unlock" hands it back to the agent).
 */
export function lockOwnerSeries(active: Playbook | null, next: Playbook): Playbook {
  const prev = new Map((active?.series ?? []).map((s) => [s.name, s]));
  return {
    ...next,
    series: next.series.map((s): Series => {
      const o = prev.get(s.name);
      if (!o) return { ...s, origin: 'owner', locked: true };
      if (seriesContent(s) !== seriesContent(o)) return { ...s, origin: o.origin ?? 'agent', locked: true, migrated_from: o.migrated_from };
      return { ...s, origin: o.origin ?? 'agent', locked: !!o.locked, migrated_from: o.migrated_from };
    }),
  };
}

/** Active library datasets and the card's feeds (rss / url sources, by id and by ref). */
export async function seriesSourceCatalog(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, card: EditorCard | null): Promise<SeriesSourceCatalog> {
  const { rows } = await pool.query(`SELECT key FROM data_schemas WHERE status = 'active' ORDER BY key`);
  const feeds = (card?.sources ?? []).filter((s) => s.kind === 'rss' || s.kind === 'url').flatMap((s) => [s.id, s.ref]).filter(Boolean);
  return { tables: rows.map((r) => String(r.key)), feeds };
}

/** Is this series owner-locked in the active playbook? (manager `pause_series` directives, spec 021). */
export function isSeriesLocked(active: unknown, name: string): boolean {
  const series = (active as { series?: Array<{ name?: string; locked?: boolean }> } | null)?.series;
  return Array.isArray(series) && !!series.find((s) => s?.name === name)?.locked;
}

export interface SubmitDeps {
  repo:  Pick<NetworkRepository, 'insertPlaybook' | 'pendingPlaybook'>;
  inbox: Pick<OwnerInbox, 'post'>;
  /** Library datasets and card feeds a series source may name; without it only API names are checked. */
  sourceCatalog?: (card: EditorCard | null) => Promise<SeriesSourceCatalog>;
}

export type SubmitResult =
  | { ok: true; id: string; version: number; status: 'active' | 'pending_owner'; changes: string[] }
  | { error: string; details?: unknown };

/** The mode a schedule change is judged in: the lower of the orchestrator's and its card's (spec 031). */
export function networkMode(net: NetworkCtx, card: EditorCard | null): ChannelMode {
  return effectiveMode(net.orchestrator.mode ?? null, card?.mode ?? net.orchestrator.mode ?? 'shadow');
}

/** The agent's own pending draft, or an error when a migration draft waits for the owner (T6 corner case). */
export async function agentDraft(d: Pick<SubmitDeps, 'repo'>, net: NetworkCtx): Promise<{ draft: PlaybookRow | null } | { error: 'migration_pending'; details: string }> {
  const pending = await d.repo.pendingPlaybook(net.orchestrator.id);
  if (pending && (pending.createdBy as string) === 'migration') {
    return { error: 'migration_pending', details: 'на власника чекає чернетка міграції стратегій — дочекайся його рішення' };
  }
  return { draft: pending && pending.createdBy === 'orchestrator' ? pending : null };
}

/** Validate, guard, classify, store and tell the owner. The single submit path of an orchestrator. */
export async function submitPlaybookVersion(d: SubmitDeps, net: NetworkCtx, ctx: ToolContext, bodyIn: Playbook, rationale: string): Promise<SubmitResult> {
  const card = (ctx.extras?.card as EditorCard | undefined) ?? null;
  const draft = await agentDraft(d, net);
  if ('error' in draft) return draft;
  const active = net.playbook ? normalizePlaybook(net.playbook) : null;
  const guard = guardAgentSeries(active, normalizePlaybook(bodyIn));
  if ('error' in guard) return guard;
  const body = guard.body;
  const errors = validatePlaybook(body, net.resources, net.telegramFormats, {
    quiet: card ? { startHour: card.quietStartHour, endHour: card.quietEndHour } : undefined,
    sources: d.sourceCatalog ? await d.sourceCatalog(card) : null,
  });
  if (errors.length) return { error: 'playbook_invalid', details: errors };
  const change = classifyPlaybookChange(active, body, { mode: networkMode(net, card) });
  const status = change.structural ? 'pending_owner' : 'active';
  const pb = await d.repo.insertPlaybook({
    agentId: net.orchestrator.id, status, brief: (ctx.extras?.brief as string | undefined) ?? null, body, rationale, createdBy: 'orchestrator', runId: ctx.runId,
  });
  if (status === 'active') { net.playbook = body; net.playbookVersion = pb.version; }
  await d.inbox.post({
    agentId: net.orchestrator.id, kind: change.structural ? 'playbook_pending' : 'playbook_updated', severity: change.structural ? 'action' : 'info',
    title: change.structural
      ? `📘 @${net.orchestrator.handle}: playbook v${pb.version} awaits your approval`
      : `📘 @${net.orchestrator.handle}: playbook updated to v${pb.version}`,
    body: `${rationale}\n\nChanges: ${change.reasons.join('; ') || 'minor (weights, hours, briefs, sources)'}`,
    alert: {
      title: change.structural
        ? `📘 @${net.orchestrator.handle}: плейбук v${pb.version} чекає затвердження`
        : `📘 @${net.orchestrator.handle}: плейбук оновлено до v${pb.version}`,
      body: `${rationale}\n\nЗміни: ${change.reasons.join('; ') || 'дрібні'}`,
    },
    refType: 'playbook', refId: pb.id,
  });
  return { ok: true, id: pb.id, version: pb.version, status, changes: change.reasons };
}
