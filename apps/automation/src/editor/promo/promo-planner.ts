import type { Pool } from 'pg';
import { parseResourceRef } from '../agents/agent.types';
import type { Agent } from '../agents/agent.types';
import type { ResourceCatalog } from '../agents/resource-catalog';
import type { ResourceProfile, ResourceProfilesRepository } from '../agents/resource-profile';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import { localDate, zonedToUtc, isQuietHour } from '../roles/time';
import { minMode, type EditorCard } from '../card';
import type { Directive, DirectivesRepository } from '../manager/directives.repository';
import { publicUrlOf, TrackedLinks } from './tracked-links';

export const PAIR_COOLDOWN_DAYS = 14;
export const MAX_PROMO_PER_RESOURCE_DAY = 1;
export const MAX_PROMO_PER_NETWORK_DAY = 3;
export const AD_PROXIMITY_MS = 2 * 3600_000;
export const MIN_RELEVANCE = 3;
export const RELEVANCE_TTL_DAYS = 30;

const WORD_RE = /[\p{L}\p{N}]{4,}/gu;
const STOP = new Set(['канал', 'каналу', 'новини', 'людей', 'людям', 'тих', 'хто', 'про', 'для', 'який', 'яка', 'щоб']);

function words(p: ResourceProfile | null): Set<string> {
  if (!p) return new Set();
  const text = [p.topic, p.audience.who, p.tone ?? '', ...p.examples].join(' ').toLowerCase();
  return new Set((text.match(WORD_RE) ?? []).map((w) => w.slice(0, 6)).filter((w) => !STOP.has(w)));
}

/**
 * Deterministic topic overlap of two resource profiles, 1–5 (spec 022 FR-004).
 * Unknown profiles score 3 (allowed, flagged); a taboo of one that is the
 * topic of the other forces 1.
 */
export function relevance(a: ResourceProfile | null, b: ResourceProfile | null): { score: number; note: string } {
  if (!a || !b) return { score: MIN_RELEVANCE, note: 'профіль одного з ресурсів не описаний — релевантність невідома' };
  const taboo = (x: ResourceProfile, y: ResourceProfile) => x.taboo.some((t) => y.topic.toLowerCase().includes(t.toLowerCase()));
  if (taboo(a, b) || taboo(b, a)) return { score: 1, note: 'тема одного ресурсу — табу для іншого' };
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return { score: MIN_RELEVANCE, note: 'замало опису для оцінки' };
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  const r = common / Math.min(A.size, B.size);
  const score = r >= 0.5 ? 5 : r >= 0.35 ? 4 : r >= 0.2 ? 3 : r >= 0.1 ? 2 : 1;
  return { score, note: `спільних слів ${common} (${Math.round(r * 100)}%)` };
}

export interface PromoPlannerDeps {
  pool:     Pick<Pool, 'query'>;
  plans:    Pick<EditorPlansRepository, 'reserveSlot'>;
  catalog:  Pick<ResourceCatalog, 'list'>;
  profiles: Pick<ResourceProfilesRepository, 'get'>;
  links:    Pick<TrackedLinks, 'forPromo'>;
  directives: Pick<DirectivesRepository, 'update'>;
  card:     (channelKey: string) => Promise<EditorCard | null>;
  usable:   (ref: string) => Promise<boolean>;
  /** Best hours of the source resource from the playbook (020), when known. */
  bestHours?: (orch: Agent, ref: string) => Promise<number[]>;
  now?:     () => Date;
}

export type PromoResult = { ok: true; slotId: string; at: Date; tracked: boolean; note?: string } | { error: string; details: string };

/**
 * Turns an accepted cross_promo / repost directive into a reserved promo slot
 * on the source resource's plan (spec 022 FR-003/FR-004). Every limit is code;
 * a refusal rejects the directive with the reason, which the manager sees.
 */
export class PromoPlanner {
  constructor(private readonly d: PromoPlannerDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async schedule(dir: Directive, orch: Agent, anchorKey: string): Promise<PromoResult> {
    if (dir.shadow) return { error: 'shadow_directive', details: 'директиви shadow-менеджера не виконуються' };
    const r = await this.plan(dir, orch, anchorKey);
    if ('error' in r) {
      await this.d.directives.update(dir.id, { status: 'rejected', resolution: `${r.error}: ${r.details}`, reasonKind: 'data' }, ['accepted']);
    } else {
      await this.d.directives.update(dir.id, { status: 'applied', appliedAt: this.now() }, ['accepted']);
    }
    return r;
  }

  private async plan(dir: Directive, orch: Agent, anchorKey: string): Promise<PromoResult> {
    const p = dir.params as Record<string, any>;
    const kind = dir.kind;
    const sourceRef: string = kind === 'repost' ? String(p.to_ref ?? '') : String(p.source_ref ?? '');
    const targetRef: string = kind === 'repost' ? String(p.post_ref ?? '').replace(/\/\d+$/, '') : String(p.target_ref ?? '');
    if (!parseResourceRef(sourceRef) || !parseResourceRef(targetRef)) return { error: 'invalid_params', details: 'потрібні source_ref і target_ref (або to_ref і post_ref для repost)' };
    if (sourceRef === targetRef) return { error: 'same_resource', details: 'джерело і ціль — один ресурс' };
    const resources = await this.d.catalog.list();
    const src = resources.find((x) => x.ref === sourceRef);
    const tgt = resources.find((x) => x.ref === targetRef);
    if (!src || !tgt) return { error: 'not_own_resource', details: 'обидва ресурси мають бути нашими (зовнішній взаємопіар — спека 014)' };
    // The promo is posted by THIS orchestrator: its source must be its anchor channel or a resource of its network.
    const anchorRef = `telegram:${anchorKey}`;
    const anchor = resources.find((x) => x.ref === anchorRef);
    const inNetwork = sourceRef === anchorRef || (!!anchor?.groupId && src.groupId === anchor.groupId);
    if (!inNetwork) return { error: 'source_not_in_network', details: `${sourceRef} не належить мережі ${anchorKey} — директиву має отримати оркестратор джерела` };
    if (kind === 'repost' && sourceRef !== anchorRef) return { error: 'repost_into_anchor_only', details: `репост можна лише в ${anchorRef}` };
    if (!(await this.d.usable(sourceRef)) || !(await this.d.usable(targetRef))) return { error: 'resource_unhealthy', details: 'один із ресурсів недоступний (токен/права)' };
    if (kind === 'repost' && (parseResourceRef(sourceRef)!.platform !== 'telegram' || parseResourceRef(targetRef)!.platform !== 'telegram')) {
      return { error: 'repost_telegram_only', details: 'нативне пересилання — лише Telegram → Telegram; для інших платформ — cross_promo' };
    }

    const now = this.now();
    const { rows: pair } = await this.d.pool.query(
      `SELECT * FROM promo_pairs WHERE (source_ref = $1 AND target_ref = $2) OR (source_ref = $2 AND target_ref = $1)`, [sourceRef, targetRef]);
    const last = pair.map((x) => x.last_promo_at).filter(Boolean).map((x) => new Date(x).getTime()).sort().pop();
    if (last && now.getTime() - last < PAIR_COOLDOWN_DAYS * 86_400_000) return { error: 'pair_cooldown', details: `ця пара вже мала промо за останні ${PAIR_COOLDOWN_DAYS} днів` };

    const cached = pair.find((x) => x.source_ref === sourceRef && x.relevance != null && x.relevance_at && now.getTime() - new Date(x.relevance_at).getTime() < RELEVANCE_TTL_DAYS * 86_400_000);
    let score = cached ? Number(cached.relevance) : null;
    let note = cached ? 'кеш' : '';
    if (score == null) {
      const rel = relevance((await this.d.profiles.get(sourceRef))?.profile ?? null, (await this.d.profiles.get(targetRef))?.profile ?? null);
      score = rel.score;
      note = rel.note;
      await this.d.pool.query(
        `INSERT INTO promo_pairs (source_ref, target_ref, relevance, relevance_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (source_ref, target_ref) DO UPDATE SET relevance = EXCLUDED.relevance, relevance_at = now()`, [sourceRef, targetRef, score]);
    }
    if (score < MIN_RELEVANCE) return { error: 'low_relevance', details: `релевантність ${score}/5 (${note})` };

    const card = await this.d.card(anchorKey);
    if (!card) return { error: 'no_card', details: anchorKey };
    const hours = (this.d.bestHours ? await this.d.bestHours(orch, sourceRef).catch(() => []) : []).filter((h) => !isQuietHour(h, card.quietStartHour, card.quietEndHour));
    const windowDays = Math.min(Math.max(Number(p.window_days ?? 3), 1), 7);
    const candidates = hours.length ? hours : [12, 15, 18];
    let at: Date | null = null;
    for (let day = 1; day <= windowDays && !at; day++) {
      const date = localDate(new Date(now.getTime() + day * 86_400_000), card.timezone);
      if (!(await this.capacity(anchorKey, sourceRef, date))) continue;
      for (const h of candidates) {
        const t = zonedToUtc(date, `${String(h).padStart(2, '0')}:00`, card.timezone);
        if (await this.nearAd(anchorKey, t)) continue;
        at = t;
        break;
      }
    }
    if (!at) return { error: 'no_window', details: `немає вільного часу у вікні ${windowDays} дн. (ліміти промо або реклама)` };

    // Spec 031 FR-009: a promo written in approval mode carries a working tracked link too (it waits, then goes out as is).
    const live = ['approve', 'live'].includes(minMode(orch.mode, card.mode));
    const planDate = localDate(at, card.timezone);
    const promo: Record<string, unknown> = {
      kind, source_ref: sourceRef, target_ref: targetRef, directive_id: dir.id, relevance: score,
      ...(kind === 'repost' ? { post_ref: p.post_ref } : {}),
    };
    const slotId = await this.d.plans.reserveSlot({
      channelKey: anchorKey, planDate, scheduledAt: at, format: kind === 'repost' ? 'repost' : 'text',
      topic: kind === 'repost' ? `Repost ${p.post_ref}` : `Promo ${tgt.title ?? targetRef}`, sourceHints: [`directive:${dir.id}`],
      postSpec: null, promo, resourceRef: parseResourceRef(sourceRef)!.platform === 'telegram' ? null : sourceRef,
    });
    let tracked = false;
    let linkNote: string | undefined;
    if (kind === 'cross_promo') {
      // Shadow never touches Telegram: no invite link is created, the public link stands in.
      const l = live
        ? await this.d.links.forPromo({ targetRef, sourceRef, slotId, directiveId: dir.id, username: tgt.username, targetUrl: publicUrlOf(tgt) })
        : { link: null, url: tgt.username ? `https://t.me/${tgt.username}` : null, tracked: false, note: 'shadow — трекінгове посилання не створюється' };
      tracked = l.tracked;
      linkNote = l.note;
      await this.d.pool.query(`UPDATE editor_slots SET promo = promo || $2::jsonb WHERE id = $1`,
        [slotId, JSON.stringify({ link_url: l.url, tracked_link_id: l.link?.id ?? null, tracked })]);
    }
    await this.d.pool.query(
      `INSERT INTO promo_pairs (source_ref, target_ref, last_promo_at, count_30d) VALUES ($1, $2, $3, 1)
       ON CONFLICT (source_ref, target_ref) DO UPDATE SET last_promo_at = $3, count_30d = promo_pairs.count_30d + 1`, [sourceRef, targetRef, at]);
    return { ok: true, slotId, at, tracked, ...(linkNote ? { note: linkNote } : {}) };
  }

  /** ≤ 1 promo per source resource and ≤ 3 per network (anchor plan) on a day. */
  private async capacity(anchorKey: string, sourceRef: string, date: string): Promise<boolean> {
    const { rows } = await this.d.pool.query(
      `SELECT s.promo->>'source_ref' AS src FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id
        WHERE p.channel_key = $1 AND p.plan_date = $2::date AND s.promo IS NOT NULL AND s.status <> 'skipped'`, [anchorKey, date]);
    return rows.length < MAX_PROMO_PER_NETWORK_DAY && rows.filter((r) => r.src === sourceRef).length < MAX_PROMO_PER_RESOURCE_DAY;
  }

  /** Paid ads keep 2 h of air around them. */
  private async nearAd(anchorKey: string, at: Date): Promise<boolean> {
    const { rows } = await this.d.pool.query(
      `SELECT 1 FROM editor_slots WHERE channel_key = $1 AND kind = 'reserved' AND promo IS NULL AND status <> 'skipped'
          AND abs(extract(epoch FROM scheduled_at - $2::timestamptz)) < $3 LIMIT 1`, [anchorKey, at, AD_PROXIMITY_MS / 1000]);
    return rows.length > 0;
  }
}
