import type { Pool } from 'pg';
import type { OwnerInbox } from '../agents/owner-inbox';

/**
 * Offers to convert a legacy auto-duplicate network into independent resources
 * (spec 024 FR-010, owner-approved, structural: Constitution IX). A
 * once-per-group housekeeping step writes one Inbox item per `legacy_duplicate`
 * group whose anchor has an orchestrator, idempotent by (kind, group_id)
 * through `network_offers` (064). It is offered once more when a first
 * playbook becomes active for a group that was offered without one. Groups
 * run only by strategies (no orchestrator) get no offer. "Keep auto-duplicate"
 * closes the offer for good.
 */
export const OFFER_KIND = 'network_independent_offer';

/** What the confirmation says about shadow (FR-010). */
export const SWITCH_NOTE = 'In shadow the agent records decisions as previews and auto-duplication continues; it stops when the agent goes live.';

export type OfferStatus = 'open' | 'switched' | 'kept';

export interface OfferCandidate {
  groupId:         string;
  groupName:       string;
  mode:            string;
  sourcePlatform:  string;
  anchor:          string;
  agentId:         string;
  handle:          string;
  agentMode:       string;
  agentStatus:     string;
  cardMode:        string | null;
  hasPlaybook:     boolean;
  pendingPlaybook: boolean;
  offerStatus:     OfferStatus | null;
  hadPlaybook:     boolean | null;
  reofferedAt:     Date | null;
}

export interface OfferChecklist {
  playbook:         'active' | 'pending' | 'none';
  orchestratorMode: string;
  paused:           boolean;
  strategies:       Array<{ type: string; extId: string; platform: string }>;
  autoDuplicateSource: string;
}

export type OfferStep = 'offer' | 'reoffer' | 'close_switched' | 'none';

/** What housekeeping does for one candidate (pure). */
export function offerStep(c: Pick<OfferCandidate, 'mode' | 'hasPlaybook' | 'offerStatus' | 'hadPlaybook' | 'reofferedAt'>): OfferStep {
  if (c.mode !== 'legacy_duplicate') return c.offerStatus === 'open' ? 'close_switched' : 'none';
  if (c.offerStatus == null) return 'offer';
  if (c.offerStatus === 'open' && c.hadPlaybook === false && c.hasPlaybook && !c.reofferedAt) return 'reoffer';
  return 'none';
}

const SOURCE_LABEL: Record<string, string> = { telegram: 'Telegram', facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads' };

/** The Inbox text (English: shown in the dashboard) and the owner's Telegram alert (Ukrainian), from the checklist. */
export function offerText(c: Pick<OfferCandidate, 'groupName' | 'handle'>, k: OfferChecklist, reoffer: boolean): {
  title: string; body: string; alert: { title: string; body: string };
} {
  const playbook = k.playbook === 'active' ? 'active'
    : k.playbook === 'pending' ? 'a draft waits for your approval — until one is approved only Telegram is planned'
    : 'none yet — until one is approved only Telegram is planned';
  const strategies = k.strategies.length
    ? `${k.strategies.map((s) => `${s.type} (${s.extId}, ${s.platform})`).join(', ')} — they publish on their own into an independent network; retire them or keep auto-duplicate`
    : 'none';
  const source = SOURCE_LABEL[k.autoDuplicateSource] ?? k.autoDuplicateSource;
  const body = [
    `Each member becomes its own resource: @${c.handle} decides per post whether to duplicate, adapt, write a unique post or skip, and formats every post for its resource.`,
    '',
    'Checklist:',
    `• Playbook: ${playbook}`,
    `• Orchestrator mode: ${k.orchestratorMode}${k.paused ? ' (paused)' : ''}`,
    `• Strategies on members: ${strategies}`,
    `• Auto-duplicate source: ${source} — used only while auto-duplication is on`,
    '',
    SWITCH_NOTE,
  ].join('\n');
  const tbPlaybook = k.playbook === 'active' ? 'активний' : k.playbook === 'pending' ? 'чернетка чекає вашого схвалення' : 'ще немає';
  return {
    title: reoffer
      ? `🕸 Network "${c.groupName}" has its first playbook — switch to independent resources?`
      : `🕸 Network "${c.groupName}": switch to independent resources?`,
    body,
    alert: {
      title: reoffer
        ? `🕸 Мережа «${c.groupName}» має перший плейбук — перейти на незалежні ресурси?`
        : `🕸 Мережа «${c.groupName}»: перейти на незалежні ресурси?`,
      body: [
        `Кожен ресурс стане окремою одиницею: @${c.handle} вирішує для кожного поста — дублювати, адаптувати, унікальний пост чи пропустити.`,
        `Плейбук: ${tbPlaybook}. Режим оркестратора: ${k.orchestratorMode}. Стратегії на учасниках: ${k.strategies.length ? k.strategies.map((s) => s.type).join(', ') : 'немає'}. Джерело автодублювання: ${source}.`,
        'У shadow агент записує рішення як прев\'ю, а автодублювання триває; воно припиняється, коли агент переходить у live.',
        'Відповісти: Inbox у дашборді — «Switch to independent» / «Keep auto-duplicate».',
      ].join('\n'),
    },
  };
}

export interface NetworkOfferRow {
  groupId:     string;
  groupName:   string | null;
  agentId:     string | null;
  status:      OfferStatus;
  hadPlaybook: boolean;
  inboxId:     number | null;
  createdAt:   Date;
  reofferedAt: Date | null;
  decidedAt:   Date | null;
  decidedBy:   string | null;
}

type Q = Pick<Pool, 'query'>;

export class NetworkOffers {
  constructor(private readonly d: { pool: Q; inbox: Pick<OwnerInbox, 'post'>; log?: (m: string) => void }) {}

  /** Groups with an orchestrator on their anchor channel (strategy-only groups have none), filtered by group or agent. */
  async candidates(o: { groupId?: string; agentId?: string } = {}): Promise<OfferCandidate[]> {
    const { rows } = await this.d.pool.query(
      `SELECT g.id AS group_id, g.name, g.mode, g.source_platform, anchor.channel_key,
              a.id AS agent_id, a.handle, a.mode AS agent_mode, a.status AS agent_status, ec.mode AS card_mode,
              EXISTS (SELECT 1 FROM playbooks p WHERE p.agent_id = a.id AND p.status = 'active') AS has_playbook,
              EXISTS (SELECT 1 FROM playbooks p WHERE p.agent_id = a.id AND p.status = 'pending_owner') AS pending_playbook,
              o.status AS offer_status, o.had_playbook, o.reoffered_at
         FROM meta_account_groups g
         JOIN LATERAL (SELECT channel_key FROM tracked_channels t WHERE t.group_id = g.id AND t.channel_key IS NOT NULL
                        ORDER BY t.channel_key LIMIT 1) anchor ON true
         JOIN agents a ON a.parent_id IS NULL AND a.kind = 'orchestrator' AND a.scope = 'resource'
                      AND a.scope_id = 'telegram:' || anchor.channel_key
         LEFT JOIN editor_channels ec ON ec.channel_key = anchor.channel_key
         LEFT JOIN network_offers o ON o.group_id = g.id AND o.kind = $3
        WHERE ($1::uuid IS NULL OR g.id = $1) AND ($2::uuid IS NULL OR a.id = $2)
        ORDER BY g.name`, [o.groupId ?? null, o.agentId ?? null, OFFER_KIND]);
    return rows.map((r) => ({
      groupId: r.group_id, groupName: r.name, mode: r.mode === 'mirror' ? 'legacy_duplicate' : r.mode, sourcePlatform: r.source_platform,
      anchor: r.channel_key, agentId: r.agent_id, handle: r.handle, agentMode: r.agent_mode, agentStatus: r.agent_status,
      cardMode: r.card_mode ?? null, hasPlaybook: !!r.has_playbook, pendingPlaybook: !!r.pending_playbook,
      offerStatus: r.offer_status ?? null, hadPlaybook: r.had_playbook ?? null, reofferedAt: r.reoffered_at ?? null,
    }));
  }

  /** Enabled strategies that publish to a member of the group (they ignore the network mode). */
  async strategies(groupId: string): Promise<OfferChecklist['strategies']> {
    const { rows } = await this.d.pool.query(
      `SELECT sb.type, sb.ext_id, sb.platform FROM strategy_bindings sb
         LEFT JOIN tracked_channels t ON t.id = sb.channel_id
         LEFT JOIN meta_accounts m ON m.id = sb.meta_account_id
         LEFT JOIN tiktok_accounts k ON k.id = sb.tiktok_account_id
        WHERE sb.enabled AND (t.group_id = $1 OR m.group_id = $1 OR k.group_id = $1)
        ORDER BY sb.type, sb.ext_id`, [groupId]);
    return rows.map((r) => ({ type: r.type, extId: r.ext_id, platform: r.platform }));
  }

  async checklist(c: OfferCandidate): Promise<OfferChecklist> {
    return {
      playbook: c.hasPlaybook ? 'active' : c.pendingPlaybook ? 'pending' : 'none',
      orchestratorMode: c.agentMode, paused: c.agentStatus === 'paused',
      strategies: await this.strategies(c.groupId).catch(() => []),
      autoDuplicateSource: c.sourcePlatform,
    };
  }

  /** The housekeeping step: offer, re-offer or close what is due. Returns what it did per group. */
  async run(o: { groupId?: string; agentId?: string } = {}): Promise<Array<{ groupId: string; step: OfferStep }>> {
    const done: Array<{ groupId: string; step: OfferStep }> = [];
    for (const c of await this.candidates(o)) {
      const step = offerStep(c);
      try {
        if (step === 'offer' && await this.offer(c)) done.push({ groupId: c.groupId, step });
        else if (step === 'reoffer' && await this.reoffer(c)) done.push({ groupId: c.groupId, step });
        else if (step === 'close_switched' && await this.decide(c.groupId, 'switched', 'mode_change')) done.push({ groupId: c.groupId, step });
      } catch (err: any) {
        this.d.log?.(`network offer for "${c.groupName}" failed: ${err?.message ?? err}`);
      }
    }
    return done;
  }

  /** A playbook became active for this orchestrator (owner approval or edit): offer or re-offer now. */
  async onPlaybookActive(agentId: string): Promise<void> {
    await this.run({ agentId });
  }

  private async offer(c: OfferCandidate): Promise<boolean> {
    const k = await this.checklist(c);
    const { rows } = await this.d.pool.query(
      `INSERT INTO network_offers (group_id, kind, agent_id, had_playbook, checklist) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_id, kind) DO NOTHING RETURNING group_id`,
      [c.groupId, OFFER_KIND, c.agentId, c.hasPlaybook, JSON.stringify(k)]);
    if (!rows[0]) return false;
    await this.post(c, k, false);
    return true;
  }

  private async reoffer(c: OfferCandidate): Promise<boolean> {
    const k = await this.checklist(c);
    const { rows } = await this.d.pool.query(
      `UPDATE network_offers SET reoffered_at = now(), had_playbook = true, checklist = $3
        WHERE group_id = $1 AND kind = $2 AND status = 'open' AND reoffered_at IS NULL RETURNING group_id`,
      [c.groupId, OFFER_KIND, JSON.stringify(k)]);
    if (!rows[0]) return false;
    await this.post(c, k, true);
    return true;
  }

  private async post(c: OfferCandidate, k: OfferChecklist, reoffer: boolean): Promise<void> {
    const t = offerText(c, k, reoffer);
    const id = await this.d.inbox.post({
      agentId: c.agentId, kind: OFFER_KIND, severity: 'action', title: t.title, body: t.body, alert: t.alert,
      refType: 'network_group', refId: c.groupId,
    });
    await this.d.pool.query(`UPDATE network_offers SET inbox_id = $3 WHERE group_id = $1 AND kind = $2`, [c.groupId, OFFER_KIND, id]);
  }

  /** The owner's answer (or a mode change made elsewhere); only an open offer is decided. */
  async decide(groupId: string, status: Exclude<OfferStatus, 'open'>, by: string): Promise<boolean> {
    const { rowCount } = await this.d.pool.query(
      `UPDATE network_offers SET status = $3, decided_at = now(), decided_by = $4
        WHERE group_id = $1 AND kind = $2 AND status = 'open'`, [groupId, OFFER_KIND, status, by]);
    return (rowCount ?? 0) > 0;
  }

  async list(): Promise<NetworkOfferRow[]> {
    const { rows } = await this.d.pool.query(
      `SELECT o.*, g.name FROM network_offers o LEFT JOIN meta_account_groups g ON g.id = o.group_id
        WHERE o.kind = $1 ORDER BY o.created_at DESC`, [OFFER_KIND]);
    return rows.map((r) => ({
      groupId: r.group_id, groupName: r.name ?? null, agentId: r.agent_id ?? null, status: r.status, hadPlaybook: !!r.had_playbook,
      inboxId: r.inbox_id == null ? null : Number(r.inbox_id), createdAt: r.created_at, reofferedAt: r.reoffered_at ?? null,
      decidedAt: r.decided_at ?? null, decidedBy: r.decided_by ?? null,
    }));
  }
}
