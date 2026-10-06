import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { parseResourceRef } from '../agents/agent.types';
import type { ChannelMode, EditorCard } from '../card';
import type { ApprovalStats, ApprovalStatsReport, ApprovalStatsRepository } from './approval-stats';

/**
 * Switching a resource between approval and autonomous work (spec 031 FR-010).
 *
 * Only the owner switches, through the dashboard: the confirm dialog reads
 * `preview` (the last 14 days and the posts that still wait) and calls
 * `switchMode`. No agent tool, MCP tool or pending-action card reaches this
 * class (approval-mode.test.ts sweeps the tool sets).
 *
 * A Telegram channel is the unit that has a mode: its card and its resource
 * orchestrator. Platform resources of a network follow the network's channel
 * (the T1–T4 behaviour), so "per network" and "per resource" both resolve to a
 * channel and a platform ref is refused with a clear reason.
 */

/** The window the switch dialog and the autonomy signal look at. */
export const AUTONOMY_WINDOW_DAYS = 14;

export interface AutonomyDeps {
  stats:   Pick<ApprovalStatsRepository, 'report'>;
  card:    (channelKey: string) => Promise<EditorCard | null>;
  /** The channel's effective mode now (orchestrator ∧ card). */
  mode:    (card: EditorCard) => Promise<ChannelMode>;
  /** The owner's switch: the channel card (audited in its memory) and its resource orchestrator. */
  setMode: (channelKey: string, mode: 'live' | 'approve') => Promise<void>;
  /** Posts of the channel (all its resources) that wait for approval. */
  waiting: (channelKey: string) => Promise<Array<{ id: string; lintWarnings?: string[] | null }>>;
  /** ApprovalsService.approve: single-flight; a lost race throws ConflictException. */
  approve: (slotId: string) => Promise<unknown>;
  now?:    () => Date;
}

export interface AutonomyPreview {
  channel:   string;
  title:     string | null;
  /** Effective mode now, and the card's own mode. */
  mode:      ChannelMode;
  cardMode:  ChannelMode;
  days:      number;
  stats:     ApprovalStatsReport['totals'];
  byResource: ApprovalStatsReport['byResource'];
  waiting:   number;
  /** Waiting posts with lint warnings stay for a manual look even when "approve them too" is chosen. */
  waitingWithWarnings: number;
}

export interface AutonomySwitchResult {
  channel:  string;
  from:     ChannelMode;
  to:       'live' | 'approve';
  changed:  boolean;
  approved: number;
  skippedWithWarnings: number;
  conflicts: number;
  leftWaiting: number;
}

const TargetSchema = z.object({
  channel:  z.string().trim().min(2).max(200).optional(),
  resource: z.string().trim().min(2).max(200).optional(),
});

const SwitchSchema = TargetSchema.extend({
  mode:            z.enum(['live', 'approve']),
  approve_waiting: z.boolean().default(true),
}).strict();

const StatsQuery = z.object({
  resource: z.string().trim().min(2).max(200).optional(),
  channel:  z.string().trim().min(2).max(200).optional(),
  days:     z.coerce.number().int().min(1).max(90).default(AUTONOMY_WINDOW_DAYS),
});

const badRequest = (r: z.ZodError) => new BadRequestException({ error: 'invalid_body', issues: r.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });

export class AutonomyService {
  constructor(private readonly d: AutonomyDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /** `channel` (@chan, the network) or `resource` (telegram:@chan) → the channel whose mode is switched. */
  private channelOf(t: { channel?: string; resource?: string }): string {
    if (t.channel) return t.channel;
    if (!t.resource) throw new BadRequestException({ error: 'invalid_body', details: 'channel or resource is required' });
    if (!t.resource.includes(':')) return t.resource;
    const r = parseResourceRef(t.resource);
    if (!r) throw new BadRequestException({ error: 'invalid_resource', details: t.resource });
    if (r.platform !== 'telegram') {
      throw new BadRequestException({
        error: 'resource_follows_network',
        details: 'A platform resource works in the mode of its network: switch the network’s Telegram channel.',
      });
    }
    return r.id;
  }

  private async require(channelKey: string): Promise<EditorCard> {
    const card = await this.d.card(channelKey);
    if (!card) throw new NotFoundException({ error: 'channel_not_found', channel: channelKey });
    return card;
  }

  /**
   * FR-011 stats: approval rate, edit rate, top reject reasons, median time to
   * approve, expired — in total and per resource. Without a filter: every
   * resource (the 029 Agents card reads it this way).
   */
  async stats(raw: unknown): Promise<ApprovalStatsReport> {
    const p = StatsQuery.safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    return this.d.stats.report({ resource: p.data.resource ?? null, channel: p.data.channel ?? null, days: p.data.days, now: this.now() });
  }

  /** What the confirm dialog shows: the effective mode, 14 days of decisions and the posts that wait. */
  async preview(raw: unknown): Promise<AutonomyPreview> {
    const p = TargetSchema.safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    const channel = this.channelOf(p.data);
    const card = await this.require(channel);
    const [mode, report, waiting] = await Promise.all([
      this.d.mode(card),
      this.d.stats.report({ channel, days: AUTONOMY_WINDOW_DAYS, now: this.now() }),
      this.d.waiting(channel),
    ]);
    return {
      channel, title: card.title, mode, cardMode: card.mode, days: AUTONOMY_WINDOW_DAYS,
      stats: report.totals, byResource: report.byResource,
      waiting: waiting.length, waitingWithWarnings: waiting.filter((w) => (w.lintWarnings ?? []).length > 0).length,
    };
  }

  /**
   * approve → live: the card and the orchestrator go live; with
   * `approve_waiting` (the dialog's default) every waiting post without lint
   * warnings is approved too, each through the single-flight approve (late
   * ones are moved as usual). Without it they keep waiting and expire.
   * live → approve: one call, always allowed; the next written slot waits.
   */
  async switchMode(raw: unknown): Promise<AutonomySwitchResult> {
    const p = SwitchSchema.safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    const channel = this.channelOf(p.data);
    const card = await this.require(channel);
    const from = await this.d.mode(card);
    const to = p.data.mode;
    const out: AutonomySwitchResult = { channel, from, to, changed: false, approved: 0, skippedWithWarnings: 0, conflicts: 0, leftWaiting: 0 };
    if (from !== to || card.mode !== to) {
      await this.d.setMode(channel, to);
      out.changed = true;
    }
    if (to === 'live' && from === 'approve' && p.data.approve_waiting) {
      for (const w of await this.d.waiting(channel)) {
        if ((w.lintWarnings ?? []).length) { out.skippedWithWarnings++; continue; }
        try {
          await this.d.approve(w.id);
          out.approved++;
        } catch (err) {
          if (err instanceof ConflictException) out.conflicts++;
          else throw err;
        }
      }
    }
    out.leftWaiting = (await this.d.waiting(channel)).length;
    return out;
  }
}

// ── MANAGER: "ready for autonomy" ────────────────────────────────────────────

/** FR-010: ≥ 20 approved posts in 14 days… */
export const READY_MIN_APPROVED = 20;
/** …and ≥ 90 % of them approved without edits. */
export const READY_MIN_CLEAN_PCT = 90;
/** One signal per resource per week. */
export const READY_DEDUP_DAYS = 7;

/** The threshold, in integers (no rounding at the edge: 18 of 20 is exactly 90 %). */
export function isReadyForAutonomy(s: Pick<ApprovalStats, 'approved' | 'approvedClean'>): boolean {
  return s.approved >= READY_MIN_APPROVED && s.approvedClean * 100 >= s.approved * READY_MIN_CLEAN_PCT;
}

export interface ReadyForAutonomyDeps {
  cards:   () => Promise<EditorCard[]>;
  mode:    (card: EditorCard) => Promise<ChannelMode>;
  stats:   Pick<ApprovalStatsRepository, 'report'>;
  /** A `ready_for_autonomy` item for this channel filed since `since`. */
  filedSince: (channelKey: string, since: Date) => Promise<boolean>;
  /** Files the info item (Inbox). It never changes a mode. */
  file:    (card: EditorCard, stats: ApprovalStats) => Promise<void>;
  now?:    () => Date;
  log?:    (msg: string) => void;
}

/**
 * The MANAGER's "ready for autonomy" signal (FR-010). Spec 025 (advice cards)
 * is not built yet, so the signal is an info item in the owner's Inbox, deduped
 * per resource per week. It only informs: switching stays the owner's click.
 */
export class ReadyForAutonomy {
  constructor(private readonly d: ReadyForAutonomyDeps) {}

  async run(): Promise<string[]> {
    const now = (this.d.now ?? (() => new Date()))();
    const filed: string[] = [];
    for (const card of await this.d.cards()) {
      try {
        if ((await this.d.mode(card)) !== 'approve') continue;
        const report = await this.d.stats.report({ channel: card.channelKey, days: AUTONOMY_WINDOW_DAYS, now });
        if (!isReadyForAutonomy(report.totals)) continue;
        if (await this.d.filedSince(card.channelKey, new Date(now.getTime() - READY_DEDUP_DAYS * 86_400_000))) continue;
        await this.d.file(card, report.totals);
        filed.push(card.channelKey);
      } catch (err: any) {
        this.d.log?.(`ready-for-autonomy check of ${card.channelKey} failed: ${err?.message ?? err}`);
      }
    }
    return filed;
  }
}

/** The Inbox text of the signal (dashboard UI copy: English). */
export function readyForAutonomyText(card: Pick<EditorCard, 'channelKey' | 'title'>, s: ApprovalStats): { title: string; body: string } {
  const pct = s.approved ? Math.round((s.approvedClean / s.approved) * 100) : 0;
  return {
    title: `@manager: ${card.title ?? card.channelKey} looks ready to work autonomously`,
    body: [
      `Last ${AUTONOMY_WINDOW_DAYS} days in approval mode: ${s.approved} posts approved, ${s.approvedClean} of them without edits (${pct}%); `
        + `${s.edited} edited, ${s.rejected} rejected, ${s.expired} expired.`,
      'If you agree, switch it to Live on the agent page — the dialog shows these numbers and the posts still waiting. Agents never switch modes themselves.',
    ].join('\n'),
  };
}
