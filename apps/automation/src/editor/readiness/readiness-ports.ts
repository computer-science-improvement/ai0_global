import { resourceRef, type Agent } from '../agents/agent.types';
import type { HostProxyAddDeps, SourceDropDeps } from '../sources/source-fixes';
import { mergeToolsAllow, refusal, type FixPorts } from '../sysadmin/fix-runner';
import type { ReadinessService } from './readiness.service';
import type { ClosedSlotRow } from './view';

/**
 * Spec 072 FR-004, A30: the ports behind the readiness fixes, built from narrow views of the services that own each change (kept
 * out of editor.module.ts so the module only wires them, as `sysadmin/audit-ports.ts` does). Every port is one call to the
 * service that already does the change for the owner; a refusal is thrown with the reason (`{ response: { error, details } }`) and
 * `tryFix` turns it into the fix's error text.
 */

type Fail = { error: string; details?: unknown };
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && typeof (x as Fail).error === 'string';

/** `details` of a refusal as text (the schedule service answers `series_invalid` with a list). */
const detailsText = (d: unknown): string => (Array.isArray(d) ? d.map(String).join('; ') : d == null ? '' : String(d));

export interface ReadinessPortDeps {
  agents:   { getByHandle(handle: string): Promise<Agent | null> };
  /** AgentsService.patchSkill. */
  patchSkill(handle: string, name: string, patch: { enabled?: boolean; inline?: boolean }): Promise<unknown>;
  retireMemory(channel: string, id: number): Promise<boolean>;
  applyConflicts: FixPorts['applyConflicts'];
  channels: { get(channelKey: string): Promise<{ toolsAllow: string[] | null } | null>; setHashtagMin(channelKey: string, min: number): Promise<boolean> };
  /** EditorOpsService.upsertChannel: validates the card (an unknown tool is refused) before it is written. */
  upsertChannel(channelKey: string, patch: { toolsAllow: string[] }): Promise<unknown>;
  pauses:   { get(id: string): Promise<{ cause: string; resumedAt: Date | null } | null>; resume(id: string, via: 'dashboard'): Promise<unknown> };
  schedule: {
    scopeByChannel(channelKey: string): Promise<unknown>;
    commitSeriesChange(scope: any, op: 'update', fields: unknown): Promise<unknown>;
  };
  /** Spec 076 `source_drop`: the card as saved and the validating save (the Sources panel's "Remove" uses the same two). */
  sourceDrop?: SourceDropDeps;
  /** Spec 076 `host_proxy_add`: the live settings and the save of `EGRESS_PROXY_HOSTS`. */
  hostProxy?: HostProxyAddDeps;
}

export function readinessFixPorts(d: ReadinessPortDeps): FixPorts {
  return {
    agentByHandle: (h) => d.agents.getByHandle(h),
    patchSkill: (handle, name, patch) => d.patchSkill(handle, name, patch),
    retireMemory: (channel, id) => d.retireMemory(channel, id),
    applyConflicts: (orch, o) => d.applyConflicts(orch, o),
    ...(d.sourceDrop ? { sourceDrop: d.sourceDrop } : {}),
    ...(d.hostProxy ? { hostProxy: d.hostProxy } : {}),

    // A card with no list means "no limit": adding a tool would turn "everything" into "only these", so nothing is written.
    async addCardTools(channelKey, tools) {
      const card = await d.channels.get(channelKey);
      if (!card) throw refusal('channel_not_found', channelKey);
      const merged = mergeToolsAllow(card.toolsAllow, tools);
      if (merged === null) throw refusal('nothing_to_apply', 'the card has no tool list, so it already allows every tool');
      return d.upsertChannel(channelKey, { toolsAllow: merged });
    },
    setHashtagMin: (channelKey, min) => d.channels.setHashtagMin(channelKey, min),

    async seriesPause(id) {
      const p = await d.pauses.get(id);
      return p ? { cause: p.cause, resumed: !!p.resumedAt } : null;
    },
    resumeSeriesPause: (id) => d.pauses.resume(id, 'dashboard'),

    // Updates the series in place (it keeps its origin and becomes the owner's locked one, A32). A playbook that does not
    // pass (`series_invalid`) refuses with its reasons.
    async requireSeriesSource(channelKey, series) {
      const sc = await d.schedule.scopeByChannel(channelKey);
      if (isFail(sc)) throw refusal(sc.error, detailsText(sc.details));
      const r = await d.schedule.commitSeriesChange(sc, 'update', { name: series, source_mode: 'required' });
      if (isFail(r)) throw refusal(r.error, detailsText(r.details));
      return r;
    },
  };
}

/**
 * The closed slots of the last 24 hours of one channel (the same rows as `ChannelFacts.slots24h`), for a view built from the
 * stored row. One query.
 */
export function closedSlotsPort(pool: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }) {
  return async (channelKey: string, now: Date): Promise<ClosedSlotRow[]> => {
    const { rows } = await pool.query(
      `SELECT status, error, critic->>'verdict' AS verdict FROM editor_slots
        WHERE lower(COALESCE(resource_ref, 'telegram:' || channel_key)) = lower($1) AND kind = 'content'
          AND status IN ('published','shadowed','awaiting_approval','approved','skipped','failed','expired')
          AND scheduled_at > $2::timestamptz - interval '24 hours' AND scheduled_at <= $2`,
      [resourceRef('telegram', channelKey), now]);
    return rows.map((r: any) => ({ status: r.status, error: r.error ?? null, verdict: r.verdict ?? null }));
  };
}

/**
 * Lead L1 (073 × 072 merge): the runner's `onConfigSkip(channelKey, code)` becomes one `config_skip` recheck of the channel, so
 * a slot that stopped on its setup shows in the Readiness panel at once and the owner hears of it through the doctor's blocker
 * note (the runner's own once-a-day note is gone). Cheap and safe: no readiness service (a test module, a boot without it) is a
 * no-op; while a recheck of the channel is under way the next config skips of it are dropped (that recheck reads the state they
 * left); a failing recheck is logged and never reaches the slot.
 */
export function configSkipRecheck(
  svc: () => Pick<ReadinessService, 'recheck'> | undefined, log: (msg: string) => void = () => {},
): (channelKey: string, code: string) => void {
  const pending = new Set<string>();
  return (channelKey, code) => {
    const s = svc();
    const key = channelKey.toLowerCase();
    if (!s || pending.has(key)) return;
    pending.add(key);
    void s.recheck(channelKey, 'config_skip')
      .catch((err: any) => log(`readiness: config_skip recheck of ${channelKey} (${code}) failed: ${err?.message ?? err}`))
      .finally(() => pending.delete(key));
  };
}
