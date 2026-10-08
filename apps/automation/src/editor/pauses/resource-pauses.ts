import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import type { OwnerInbox } from '../agents/owner-inbox';
import type { NetworkRepository } from '../network/network.repository';
import { localDate, localTimeLabel } from '../roles/time';

/**
 * Resource pauses (spec 025 FR-013): a `pause_resource` directive stops content and promo publishing on one
 * resource until `until` (or until the owner lifts it). Paid ad slots are contractual and never paused.
 *
 * A pause is active while `lifted_at IS NULL AND starts_at <= now < until`: it ends at `until` even before the
 * tick stamps `lifted_at` (liftDue), so no guard depends on a housekeeping run.
 */

export interface ResourcePause {
  id:          number;
  resourceRef: string;
  agentId:     string | null;
  /** The top-level agent's @handle (listing only). */
  agentHandle?: string | null;
  directiveId: string | null;
  reason:      string;
  startsAt:    Date;
  until:       Date;
  liftedAt:    Date | null;
  liftedBy:    'schedule' | 'owner' | null;
  createdAt:   Date;
}

export const PAUSED_ERROR = 'resource_paused';
const KYIV = 'Europe/Kyiv';

/** The resource a slot publishes on: its resource_ref, else the anchor Telegram channel. */
export const slotRef = (s: { resourceRef?: string | null; channelKey: string }): string => s.resourceRef ?? `telegram:${s.channelKey}`;

export const isActivePause = (p: Pick<ResourcePause, 'liftedAt' | 'startsAt' | 'until'>, now: Date): boolean =>
  !p.liftedAt && p.startsAt.getTime() <= now.getTime() && p.until.getTime() > now.getTime();

const toPause = (r: any): ResourcePause => ({
  id: Number(r.id), resourceRef: r.resource_ref, agentId: r.agent_id ?? null, directiveId: r.directive_id ?? null, reason: r.reason,
  startsAt: new Date(r.starts_at), until: new Date(r.until), liftedAt: r.lifted_at ? new Date(r.lifted_at) : null,
  liftedBy: r.lifted_by ?? null, createdAt: new Date(r.created_at),
  ...(r.agent_handle !== undefined ? { agentHandle: r.agent_handle ?? null } : {}),
});

const kyiv = (d: Date) => `${localDate(d, KYIV)} ${localTimeLabel(d, KYIV)}`;

export interface ResourcePauseDeps {
  pool:   Pick<Pool, 'query'>;
  /** Inbox entries `resource_paused` / `resource_resumed`; without it pauses are silent (read-only users). */
  inbox?: Pick<OwnerInbox, 'post'>;
  now?:   () => Date;
}

export type PauseInput = {
  resourceRef: string;
  agentId:     string | null;
  directiveId: string | null;
  reason:      string;
  until:       Date;
  startsAt?:   Date;
};

export class ResourcePauseService {
  constructor(private readonly d: ResourcePauseDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /** Active pauses now. */
  async active(now: Date = this.now()): Promise<ResourcePause[]> {
    const { rows } = await this.d.pool.query(
      `SELECT * FROM resource_pauses WHERE lifted_at IS NULL AND starts_at <= $1 AND until > $1 ORDER BY until`, [now]);
    return rows.map(toPause);
  }

  async pausedRefs(now: Date = this.now()): Promise<Set<string>> {
    return new Set((await this.active(now)).map((p) => p.resourceRef));
  }

  async isPaused(ref: string, now: Date = this.now()): Promise<boolean> {
    const { rows } = await this.d.pool.query(
      `SELECT 1 FROM resource_pauses WHERE resource_ref = $1 AND lifted_at IS NULL AND starts_at <= $2 AND until > $2 LIMIT 1`, [ref, now]);
    return rows.length > 0;
  }

  /** The (latest) pause a directive created, active or not. */
  async byDirective(directiveId: string): Promise<ResourcePause | null> {
    const { rows } = await this.d.pool.query(
      `SELECT * FROM resource_pauses WHERE directive_id = $1 ORDER BY created_at DESC LIMIT 1`, [directiveId]);
    return rows[0] ? toPause(rows[0]) : null;
  }

  /** Listing for REST: active ones first, then the most recent. */
  async list(o: { active?: boolean; limit?: number } = {}): Promise<ResourcePause[]> {
    const now = this.now();
    const { rows } = await this.d.pool.query(
      `SELECT p.*, a.handle AS agent_handle FROM resource_pauses p LEFT JOIN agents a ON a.id = p.agent_id
        WHERE $1::bool IS NULL
           OR ($1 AND p.lifted_at IS NULL AND p.starts_at <= $2 AND p.until > $2)
           OR (NOT $1 AND NOT (p.lifted_at IS NULL AND p.starts_at <= $2 AND p.until > $2))
        ORDER BY (p.lifted_at IS NULL AND p.until > $2) DESC, p.created_at DESC LIMIT $3`,
      [o.active ?? null, now, Math.min(Math.max(o.limit ?? 50, 1), 500)]);
    return rows.map(toPause);
  }

  /**
   * Pause a resource. Idempotent per directive: a pause the directive already created (active or lifted) is
   * returned with `created: false`. Another active pause on the resource → `already_paused`.
   */
  async pause(i: PauseInput): Promise<{ pause: ResourcePause; created: boolean } | { error: 'already_paused'; pause: ResourcePause }> {
    if (i.directiveId) {
      const mine = await this.byDirective(i.directiveId);
      if (mine) return { pause: mine, created: false };
    }
    const now = this.now();
    // A pause that ran out but was not stamped yet still holds the unique index: close it first.
    await this.closeExpired(now, i.resourceRef);
    const { rows } = await this.d.pool.query(
      `INSERT INTO resource_pauses (resource_ref, agent_id, directive_id, reason, starts_at, until)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (resource_ref) WHERE lifted_at IS NULL DO NOTHING RETURNING *`,
      [i.resourceRef, i.agentId, i.directiveId, i.reason.slice(0, 2000), i.startsAt ?? now, i.until]);
    if (!rows[0]) {
      const { rows: cur } = await this.d.pool.query(`SELECT * FROM resource_pauses WHERE resource_ref = $1 AND lifted_at IS NULL LIMIT 1`, [i.resourceRef]);
      const existing = toPause(cur[0]);
      if (i.directiveId && existing.directiveId === i.directiveId) return { pause: existing, created: false };
      return { error: 'already_paused', pause: existing };
    }
    const p = toPause(rows[0]);
    await this.notifyPaused(p);
    return { pause: p, created: true };
  }

  /**
   * The owner lifts a pause early (`POST /api/resources/:ref/pause/lift`). A pause that already ran out is
   * closed as `schedule` and reported as not lifted (null), like a resource that is not paused.
   */
  async lift(ref: string, by: 'owner' | 'schedule' = 'owner'): Promise<ResourcePause | null> {
    const now = this.now();
    await this.closeExpired(now, ref);
    const { rows } = await this.d.pool.query(
      `UPDATE resource_pauses SET lifted_at = $2, lifted_by = $3
        WHERE resource_ref = $1 AND lifted_at IS NULL AND starts_at <= $2 AND until > $2 RETURNING *`, [ref, now, by]);
    if (!rows[0]) return null;
    const p = toPause(rows[0]);
    await this.notifyResumed(p);
    return p;
  }

  /** Auto-lift (every scheduler tick): pauses whose `until` has come are stamped `schedule`. */
  async liftDue(now: Date = this.now()): Promise<ResourcePause[]> {
    return this.closeExpired(now, null);
  }

  private async closeExpired(now: Date, ref: string | null): Promise<ResourcePause[]> {
    const { rows } = await this.d.pool.query(
      `UPDATE resource_pauses SET lifted_at = until, lifted_by = 'schedule'
        WHERE lifted_at IS NULL AND until <= $1 AND ($2::text IS NULL OR resource_ref = $2) RETURNING *`, [now, ref]);
    const out = rows.map(toPause);
    for (const p of out) await this.notifyResumed(p);
    return out;
  }

  /** Reserved slots that are not promos (paid ads, the owner's scheduled posts) on the resource in a window: they still publish. */
  async reservedIn(ref: string, from: Date, to: Date): Promise<number> {
    const { rows } = await this.d.pool.query(
      `SELECT count(*)::int AS n FROM editor_slots
        WHERE kind = 'reserved' AND promo IS NULL AND status IN ('planned','running')
          AND COALESCE(resource_ref, 'telegram:' || channel_key) = $1 AND scheduled_at >= $2 AND scheduled_at < $3`, [ref, from, to]);
    return Number(rows[0]?.n ?? 0);
  }

  /** Content and promo slots on the resource published or shadowed in a window (the verification of FR-013). */
  async publishedIn(ref: string, from: Date, to: Date): Promise<number> {
    const { rows } = await this.d.pool.query(
      `SELECT count(*)::int AS n FROM editor_slots
        WHERE (kind = 'content' OR promo IS NOT NULL) AND status IN ('published','shadowed')
          AND COALESCE(resource_ref, 'telegram:' || channel_key) = $1 AND scheduled_at >= $2 AND scheduled_at < $3`, [ref, from, to]);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Platforms whose paused resource mirrors this Telegram channel (its group's members or its crosspost
   * targets): the legacy auto-duplication skips them while the pause is active.
   */
  async pausedMirrorPlatforms(channelKey: string, now: Date = this.now()): Promise<Set<string>> {
    const { rows } = await this.d.pool.query(
      `SELECT DISTINCT split_part(p.resource_ref, ':', 1) AS platform FROM resource_pauses p
        WHERE p.lifted_at IS NULL AND p.starts_at <= $2 AND p.until > $2 AND p.resource_ref NOT LIKE 'telegram:%'
          AND p.resource_ref IN (
            SELECT m.platform || ':' || m.id FROM meta_accounts m JOIN tracked_channels t ON t.group_id = m.group_id WHERE t.channel_key = $1
            UNION SELECT 'tiktok:' || a.id FROM tiktok_accounts a JOIN tracked_channels t ON t.group_id = a.group_id WHERE t.channel_key = $1
            UNION SELECT m.platform || ':' || m.id FROM meta_crosspost_targets x JOIN tracked_channels t ON t.id = x.channel_id
                    JOIN meta_accounts m ON m.id = x.meta_account_id WHERE t.channel_key = $1)`, [channelKey, now]);
    return new Set(rows.map((r) => r.platform));
  }

  private async notifyPaused(p: ResourcePause): Promise<void> {
    if (!this.d.inbox) return;
    let reserved = 0;
    try { reserved = await this.reservedIn(p.resourceRef, p.startsAt, p.until); } catch { /* the note is best-effort */ }
    const ads = reserved
      ? `${reserved} reserved slot(s) in this window (paid ads, your scheduled posts) still publish — ads are contractual.`
      : 'Paid ad slots on it would still publish (contractual).';
    const adsUk = reserved
      ? `${reserved} резервних слотів у цьому вікні (реклама, твої заплановані пости) вийдуть — реклама за договором.`
      : 'Рекламні слоти на ньому все одно вийдуть (договір).';
    await this.d.inbox.post({
      agentId: p.agentId, kind: 'resource_paused', severity: 'info',
      title: `⏸ ${p.resourceRef} paused until ${kyiv(p.until)} (Kyiv)`,
      body: `Reason: ${p.reason}\n\nContent and promo slots on this resource are skipped and it is left out of planning until the pause ends. ${ads} Lift it early from the dashboard (POST /api/resources/${encodeURIComponent(p.resourceRef)}/pause/lift).`,
      alert: {
        title: `⏸ ${p.resourceRef} на паузі до ${kyiv(p.until)} (Київ)`,
        body: `Причина: ${p.reason}\n\nКонтент і промо на цьому ресурсі не виходять, у планування він не потрапляє до кінця паузи. ${adsUk}`,
      },
      ...(p.directiveId ? { refType: 'directive', refId: p.directiveId } : { refType: 'resource', refId: p.resourceRef }),
    });
  }

  private async notifyResumed(p: ResourcePause): Promise<void> {
    if (!this.d.inbox) return;
    const early = p.liftedBy === 'owner';
    await this.d.inbox.post({
      agentId: p.agentId, kind: 'resource_resumed', severity: 'info',
      title: `▶️ ${p.resourceRef} resumed${early ? ' (lifted by you)' : ''}`,
      body: `${early ? `The pause was lifted early (planned until ${kyiv(p.until)} Kyiv).` : 'The pause ended on schedule.'} The resource is back in planning from the next plan run.`,
      alert: {
        title: `▶️ ${p.resourceRef} знову працює${early ? ' (паузу знято тобою)' : ''}`,
        body: early ? `Паузу знято раніше (планувалась до ${kyiv(p.until)}).` : 'Пауза закінчилась за розкладом.',
      },
      ...(p.directiveId ? { refType: 'directive', refId: p.directiveId } : { refType: 'resource', refId: p.resourceRef }),
    });
  }
}

/**
 * Is a channel's own orchestration and planning held by pauses? A single channel (or a legacy auto-duplicate
 * group, where only Telegram is planned) whose Telegram anchor is paused: yes. An independent network keeps
 * running for its other resources unless every one of them is paused too.
 */
export function channelHeldBy(net: Pick<NetworkRepository, 'groupOfChannel' | 'groupResources'>) {
  return async (card: Pick<EditorCard, 'channelKey'>, paused: Set<string>): Promise<boolean> => {
    if (!paused.has(`telegram:${card.channelKey}`)) return false;
    const g = await net.groupOfChannel(card.channelKey);
    if (!g || g.mode !== 'independent') return true;
    return (await net.groupResources(g.id)).every((r) => paused.has(r.ref));
  };
}
