import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { parseResourceRef, type Platform } from '../agents/agent.types';
import type { Agent } from '../agents/agent.types';
import type { PendingActionsService } from '../agents/pending-actions';
import { proposeCard } from '../agents/builder-tools';
import type { EditorCard } from '../card';
import { defineTool, EditorTool, ToolContext, ToolError } from '../harness/tool';
import { CAPABILITIES, implementedFormats } from '../platform/capabilities';
import { derivedFormatProblem, type DerivedTreatment } from '../post/duplicate';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import { isQuietHour, localDate, localHour } from '../roles/time';
import { zonedToUtcStrict } from '../time/resource-time';
import { DecisionReason } from './plan-decisions';
import { NetworkCtx, resourceClock } from './network-context';

/**
 * Spec 024 FR-008: `repurpose_post` — the agent duplicates or adapts a post
 * of its network onto other resources of the same network, at a time it
 * picks (0–1440 min after the source, or HH:MM in the target's zone). Code
 * checks only the network, the platform hard limits, quiet hours, daily caps
 * and API limits; the spacing is the agent's choice.
 */

export const REPURPOSE_CALLS_PER_DAY = 10;
export const REPURPOSE_SOURCE_MAX_AGE_H = 72;

const SourceInput = z.object({
  slot_id:           z.string().uuid().optional().describe('Слот мережі: опублікований/shadow за 72 год або запланований на сьогодні (виконавець — лише свій слот)'),
  platform_post_id:  z.number().int().positive().optional().describe('Пост Instagram / Facebook / Threads / TikTok (platform_posts.id)'),
  published_post_id: z.number().int().positive().optional().describe('Пост Telegram (published_posts.id), зокрема пост стратегії'),
}).refine((s) => [s.slot_id, s.platform_post_id, s.published_post_id].filter((x) => x != null).length === 1, { message: 'exactly one of slot_id, platform_post_id, published_post_id' });

export const RepurposeTargetInput = z.object({
  resource_ref: z.string().min(3).max(200),
  treatment:    z.enum(['duplicate', 'adapt']).describe('duplicate — той самий пост, оформлений під ресурс; adapt — та сама ідея, переписана нативно'),
  at:           z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('HH:MM сьогодні в часовому поясі цього ресурсу'),
  delay_min:    z.number().int().min(0).max(1440).optional().describe('Або: через скільки хвилин після джерела (0 — одночасно)'),
  format:       z.string().min(2).max(30).optional().describe('Формат на цьому ресурсі; без нього код бере перший можливий з плейбука'),
  format_notes: z.string().max(500).optional().describe('Твої інструкції оформлення для цього ресурсу'),
  reason:       DecisionReason.describe('Чому цей пост іде на цей ресурс: сигнал профілю, плейбука чи KPI'),
}).refine((t) => !(t.at && t.delay_min != null), { message: 'at or delay_min, not both' });

export const RepurposeInput = z.object({
  source:  SourceInput,
  targets: z.array(RepurposeTargetInput).min(1).max(5),
});
export type RepurposeRequest = z.infer<typeof RepurposeInput>;

export type RepurposeBy = 'orchestrator' | 'planner' | 'executor' | 'owner';

/** A resolved source post of the network. */
interface ResolvedSource {
  key:       string;
  ref:       string;
  platform:  Platform;
  format:    string;
  at:        Date;
  ideaId:    string | null;
  slotId:    string | null;
  topic:     string;
}

export interface RepurposeResult {
  ok: true;
  slots: Array<{ id: string; resource_ref: string; scheduled_at: string }>;
  decisions: Array<{ resource_ref: string; decision: DerivedTreatment; reason: string }>;
}

export interface RepurposeDeps {
  pool:  Pick<Pool, 'query'>;
  plans: Pick<EditorPlansRepository, 'createRepurpose'>;
  now?:  () => Date;
}

const PENDING = new Set(['planned', 'running', 'awaiting_approval', 'approved']);
const DONE = new Set(['published', 'shadowed']);

/** The validation and the write of one repurpose_post call (also the chat's Apply handler). */
export class RepurposeService {
  constructor(private readonly d: RepurposeDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async run(
    net: NetworkCtx, card: Pick<EditorCard, 'channelKey' | 'timezone' | 'quietStartHour' | 'quietEndHour'>, input: RepurposeRequest,
    by: { decidedBy: RepurposeBy; runId?: string | null; ownSlotId?: string | null; dryRun?: boolean },
  ): Promise<RepurposeResult | (ToolError & { dry_run?: boolean }) | { ok: true; dry_run: true; targets: unknown[] }> {
    if (net.mode === 'single' || !net.groupId) return { error: 'no_network', details: 'this channel is not part of a network' };
    const now = this.now();
    if (by.decidedBy !== 'owner') {
      const { rows } = await this.d.pool.query(
        `SELECT COUNT(DISTINCT call_id)::int AS n FROM content_decisions
          WHERE agent_id = $1 AND call_id IS NOT NULL AND (created_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date`,
        [net.orchestrator.id, card.timezone, now]);
      if (Number(rows[0]?.n ?? 0) >= REPURPOSE_CALLS_PER_DAY) {
        return { error: 'daily_limit', details: `${REPURPOSE_CALLS_PER_DAY} repurpose_post calls a day (${localDate(now, card.timezone)})` };
      }
    }
    const src = await this.source(net, input.source, by, now, card.timezone);
    if ('error' in src) return src;

    const resources = new Map(net.resources.map((r) => [r.ref, r]));
    const sections = new Map((net.playbook?.platforms ?? []).map((s) => [s.resource_ref, s]));
    const errors: Array<{ resource_ref: string; error: string; details?: string }> = [];
    const planned: Array<{ resourceRef: string; planDate: string; scheduledAt: Date; format: string; treatment: DerivedTreatment; reason: string; formatNotes: string | null }> = [];
    const seen = new Set<string>();
    for (const t of input.targets) {
      const fail = (error: string, details?: string) => { errors.push({ resource_ref: t.resource_ref, error, ...(details ? { details } : {}) }); };
      const r = resources.get(t.resource_ref);
      if (!r) { fail('not_in_network', `usable: ${[...resources.keys()].join(', ')}`); continue; }
      if (t.resource_ref === src.ref) { fail('same_resource'); continue; }
      if (seen.has(t.resource_ref)) { fail('duplicate_target'); continue; }
      seen.add(t.resource_ref);
      const sec = sections.get(t.resource_ref);
      if (!sec) { fail('no_playbook_section'); continue; }
      if (await this.decided(src, t.resource_ref)) { fail('already_decided'); continue; }

      const format = t.format ?? this.defaultFormat(src, r.platform, sec.formats, t.treatment);
      if (!format) { fail('unsupported_format', `nothing on ${r.platform} can carry ${src.format}`); continue; }
      const problem = derivedFormatProblem({ platform: src.platform, format: src.format }, { platform: r.platform, format }, t.treatment);
      if (problem) { fail('unsupported_format', problem); continue; }

      const { tz, quiet } = resourceClock(r, card);
      let at: Date;
      if (t.at) {
        const x = zonedToUtcStrict(localDate(now, tz), t.at, tz);
        if (!x) { fail('invalid_time', `${t.at} does not exist today in ${tz}`); continue; }
        if (x.getTime() < now.getTime()) { fail('time_passed', `${t.at} ${tz} has passed`); continue; }
        at = x;
      } else {
        at = new Date(src.at.getTime() + (t.delay_min ?? 0) * 60_000);
        // A published source repurposed "now": as soon as possible, never in the past.
        if (at.getTime() < now.getTime()) at = new Date(now.getTime() + 60_000);
      }
      if (at.getTime() < src.at.getTime()) { fail('before_source', 'a derived post goes out at the same time as its source or later'); continue; }
      const hour = localHour(at, tz);
      if (isQuietHour(hour, quiet.start, quiet.end)) { fail('quiet_hours', `${String(hour).padStart(2, '0')}:00 is quiet on ${t.resource_ref} (${quiet.start}:00–${quiet.end}:00 ${tz})`); continue; }
      const day = localDate(at, tz);
      const used = await this.dayCount(net, t.resource_ref, day, tz) + planned.filter((p) => p.resourceRef === t.resource_ref).length;
      if (used >= sec.per_day.max) { fail('daily_cap', `${used}/${sec.per_day.max} posts on ${day} (${tz})`); continue; }
      if (r.platform !== 'telegram' && used >= CAPABILITIES[r.platform].dailyApiCap) { fail('daily_cap', `API cap ${CAPABILITIES[r.platform].dailyApiCap}`); continue; }
      planned.push({
        resourceRef: t.resource_ref, planDate: localDate(at, card.timezone), scheduledAt: at, format, treatment: t.treatment,
        reason: t.reason, formatNotes: t.format_notes ?? null,
      });
    }
    if (errors.length) return { error: errors[0].error, details: errors };
    if (by.dryRun) {
      return { ok: true, dry_run: true, targets: planned.map((p) => ({ resource_ref: p.resourceRef, format: p.format, scheduled_at: p.scheduledAt.toISOString() })) };
    }
    const slots = await this.d.plans.createRepurpose({
      channelKey: net.anchorKey, agentId: net.orchestrator.id, callId: randomUUID(), decidedBy: by.decidedBy, runId: by.runId ?? null,
      sourceKey: src.key, ideaId: src.ideaId,
      targets: planned.map((p) => ({ ...p, topic: src.topic, derivedFromSlotId: src.slotId })),
    });
    if (!slots) return { error: 'already_decided', details: 'another decision for this source and resource was recorded meanwhile' };
    return {
      ok: true,
      slots: slots.map((s) => ({ id: s.id, resource_ref: s.resourceRef, scheduled_at: s.scheduledAt.toISOString() })),
      decisions: planned.map((p) => ({ resource_ref: p.resourceRef, decision: p.treatment, reason: p.reason })),
    };
  }

  /** The network's source post, in its window (published / shadowed within 72 h, or planned today). */
  private async source(net: NetworkCtx, s: RepurposeRequest['source'], by: { decidedBy: RepurposeBy; ownSlotId?: string | null }, now: Date, anchorTz: string): Promise<ResolvedSource | ToolError> {
    const refs = new Set(net.resources.map((r) => r.ref));
    const fresh = (d: Date) => now.getTime() - d.getTime() <= REPURPOSE_SOURCE_MAX_AGE_H * 3600_000;
    if (s.slot_id) {
      if (by.decidedBy === 'executor' && by.ownSlotId !== s.slot_id) return { error: 'not_own_slot', details: 'the executor repurposes only its own slot' };
      const { rows } = await this.d.pool.query(
        `SELECT s.*, p.plan_date::text AS plan_date, p.status AS plan_status FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id WHERE s.id = $1`, [s.slot_id]);
      const r = rows[0];
      if (!r) return { error: 'source_not_found' };
      const ref = r.resource_ref ?? `telegram:${r.channel_key}`;
      if (r.channel_key !== net.anchorKey || !refs.has(ref)) return { error: 'source_not_in_network' };
      if (r.treatment === 'duplicate' || r.treatment === 'adapt') return { error: 'source_not_eligible', details: 'a derived post cannot be a source (no chains)' };
      // A planned source of today's plan: its derived posts wait until it is out ("after this is published").
      const pending = PENDING.has(r.status) && r.plan_status === 'active' && r.plan_date === localDate(now, anchorTz);
      const done = DONE.has(r.status) && fresh(new Date(r.updated_at));
      if (!pending && !done && !(by.decidedBy === 'executor' && r.status === 'running')) {
        return { error: 'source_not_eligible', details: `slot is ${r.status}${DONE.has(r.status) ? ' (older than 72 h)' : ''}` };
      }
      return {
        key: `slot:${r.id}`, ref, platform: parseResourceRef(ref)!.platform, format: r.post_spec?.format ?? r.format,
        at: DONE.has(r.status) ? new Date(r.updated_at) : new Date(r.scheduled_at), ideaId: r.idea_id ?? null, slotId: r.id, topic: r.topic,
      };
    }
    if (s.platform_post_id) {
      const { rows } = await this.d.pool.query(`SELECT * FROM platform_posts WHERE id = $1`, [s.platform_post_id]);
      const r = rows[0];
      if (!r) return { error: 'source_not_found' };
      if (!refs.has(r.resource_ref)) return { error: 'source_not_in_network' };
      if (!DONE.has(r.status) || !fresh(new Date(r.posted_at))) return { error: 'source_not_eligible', details: `post is ${r.status}, posted ${new Date(r.posted_at).toISOString()}` };
      return {
        key: `pp:${r.id}`, ref: r.resource_ref, platform: r.platform, format: r.format, at: new Date(r.posted_at), ideaId: r.idea_id ?? null,
        slotId: r.slot_id ?? null, topic: r.spec?.title ?? (r.caption ?? '').slice(0, 120) ?? 'repurpose',
      };
    }
    const { rows } = await this.d.pool.query(`SELECT * FROM published_posts WHERE id = $1`, [s.published_post_id]);
    const r = rows[0];
    if (!r) return { error: 'source_not_found' };
    const ref = `telegram:${r.channel_id}`;
    if (!refs.has(ref)) return { error: 'source_not_in_network' };
    if (!fresh(new Date(r.posted_at))) return { error: 'source_not_eligible', details: 'posted more than 72 h ago' };
    let ideaId: string | null = null;
    if (r.editor_slot_id) ideaId = (await this.d.pool.query(`SELECT idea_id FROM editor_slots WHERE id = $1`, [r.editor_slot_id])).rows[0]?.idea_id ?? null;
    return {
      key: `tg:${r.id}`, ref, platform: 'telegram', format: r.format && r.format !== 'legacy' ? r.format : 'text', at: new Date(r.posted_at),
      ideaId, slotId: r.editor_slot_id ?? null, topic: r.title ?? 'repurpose',
    };
  }

  /** An existing decision for (idea or source, resource). */
  private async decided(src: ResolvedSource, ref: string): Promise<boolean> {
    const { rows } = await this.d.pool.query(
      src.ideaId
        ? `SELECT 1 FROM content_decisions WHERE idea_id = $1 AND resource_ref = $2 LIMIT 1`
        : `SELECT 1 FROM content_decisions WHERE idea_id IS NULL AND source_key = $1 AND resource_ref = $2 LIMIT 1`,
      [src.ideaId ?? src.key, ref]);
    return rows.length > 0;
  }

  /** Posts on a resource on its local day (anchor plan slots that are not dropped). */
  private async dayCount(net: NetworkCtx, ref: string, day: string, tz: string): Promise<number> {
    const anchor = `telegram:${net.anchorKey}`;
    const { rows } = await this.d.pool.query(
      `SELECT COUNT(*)::int AS n FROM editor_slots
        WHERE channel_key = $1 AND COALESCE(resource_ref, 'telegram:' || channel_key) = $2
          AND status NOT IN ('skipped','failed','expired') AND (scheduled_at AT TIME ZONE $3)::date = $4::date`,
      [net.anchorKey, ref === anchor ? anchor : ref, tz, day]);
    return Number(rows[0]?.n ?? 0);
  }

  /** The first playbook format (by weight) the target can technically carry from this source. */
  private defaultFormat(src: ResolvedSource, platform: Platform, weights: Record<string, number>, t: DerivedTreatment): string | null {
    const playbook = Object.entries(weights).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).map(([f]) => f);
    const all = [...playbook, ...implementedFormats(platform).filter((f) => !playbook.includes(f))];
    return all.find((f) => !derivedFormatProblem({ platform: src.platform, format: src.format }, { platform, format: f }, t)) ?? null;
  }
}

export interface RepurposeToolDeps {
  service: RepurposeService;
  /** The executor runs without ctx.extras.network: build it from the orchestrator and the card. */
  networkFor?: (orchestrator: Agent, card: EditorCard) => Promise<NetworkCtx | null>;
  /** Chat agents only propose (Apply card, FR-008): their network and anchor card. */
  chatNetwork?: (agent: Agent) => Promise<{ net: NetworkCtx; card: EditorCard } | null>;
  actions?: Pick<PendingActionsService, 'propose'>;
}

const ROLE_BY: Record<string, RepurposeBy> = { orchestrator: 'orchestrator', planner: 'planner', executor: 'executor' };

export function buildRepurposeTools(d: RepurposeToolDeps): EditorTool[] {
  const netOf = async (ctx: ToolContext): Promise<{ net: NetworkCtx; card: EditorCard } | ToolError> => {
    const card = ctx.extras?.card as EditorCard | undefined;
    if (!card) return { error: 'no_channel' };
    const net = (ctx.extras?.network as NetworkCtx | undefined)
      ?? (d.networkFor && ctx.extras?.orchestrator ? await d.networkFor(ctx.extras.orchestrator as Agent, card) : null);
    if (!net) return { error: 'no_network', details: 'this channel is not part of a network' };
    return { net, card };
  };

  const repurposePost = defineTool({
    name: 'repurpose_post',
    description: [
      'Дублювати (duplicate) або адаптувати (adapt) пост мережі на інші її ресурси (1–5): джерело — slot_id, platform_post_id або published_post_id (зокрема пост стратегії), опублікований за 72 год або запланований на сьогодні.',
      'Час — at (HH:MM у поясі ресурсу) або delay_min 0–1440 після джерела; інтервал обираєш ти. Кожен цільовий пост ти потім оформиш сам (format_prefs ресурсу + твої format_notes).',
      'Код перевіряє лише мережу, жорсткі ліміти платформи (unsupported_format), тихі години, денні ліміти й API; одне рішення на (ідею, ресурс) — already_decided. До 10 викликів на день.',
    ].join(' '),
    kind: 'act', roles: ['orchestrator', 'planner', 'executor'],
    input: RepurposeInput,
    execute: async (input, ctx) => {
      const c = await netOf(ctx);
      if ('error' in c) return c;
      return d.service.run(c.net, c.card, input, { decidedBy: ROLE_BY[ctx.role] ?? 'orchestrator', runId: ctx.runId, ownSlotId: ctx.slotId ?? null });
    },
  });

  const proposeRepurpose = defineTool({
    name: 'propose_repurpose',
    description: 'Запропонувати власнику дублювання / адаптацію поста мережі на інші ресурси (як repurpose_post). Код одразу перевіряє; слоти зʼявляться лише після кліку Apply.',
    kind: 'act', roles: ['composer'],
    input: RepurposeInput,
    execute: async (input, ctx) => {
      const agent = ctx.extras?.agent as Agent | null | undefined;
      if (!agent || !d.actions || !d.chatNetwork) return { error: 'no_agent', details: 'ця розмова не з агентом каналу — звернись через @handle' };
      const c = await d.chatNetwork(agent);
      if (!c) return { error: 'no_network', details: 'this channel is not part of a network' };
      const dry = await d.service.run(c.net, c.card, input, { decidedBy: 'owner', dryRun: true });
      if ('error' in dry) return dry;
      const src = input.source.slot_id ? `slot ${input.source.slot_id}` : input.source.platform_post_id ? `platform post #${input.source.platform_post_id}` : `Telegram post #${input.source.published_post_id}`;
      const summary = `Repurpose ${src} → ${input.targets.map((t) => `${t.resource_ref} (${t.treatment})`).join(', ')}`;
      return proposeCard({ actions: d.actions }, ctx, 'repurpose', { handle: agent.handle, ...input }, summary, agent.id);
    },
  });

  return [repurposePost, proposeRepurpose];
}
