import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { EditorCard } from '../card';
import { parseResourceRef, type Platform } from '../agents/agent.types';
import { lintPost } from '../post/lint-post';
import { PostSpecSchema } from '../post/post-spec';
import { lintPlatformPost, PlatformPostSpecSchema, renderPlatform } from '../platform/platform-spec';
import { prepareAndRender, type PublishSpecDeps } from '../publish/publish-spec';
import type { PreparedPublish } from '../publish/prepare-media';
import type { PlatformPostSpec } from '../platform/platform-spec';
import type { EditorSlot } from '../repo/editor-plans.repository';
import { isQuietHour, localDate, localHour, localTimeLabel } from '../roles/time';
import {
  APPROVE_LATE_MAX_MS, EDIT_LOCK_MS, REPLACEMENT_MIN_LEAD_MS, addDays, expiresAt,
} from './approval-timing';
import type { ApprovalItem, ApprovalsRepository } from './approvals.repository';
import { editPreference, rejectPreference, type OwnerPreference } from './owner-preferences';

export interface ApprovalsServiceDeps {
  repo:  ApprovalsRepository;
  card:  (channelKey: string) => Promise<EditorCard | null>;
  /** Carousel slides / longread pages of an edited Telegram post are prepared again. */
  media?: PublishSpecDeps['media'];
  /** Slides of an edited platform post are rendered and hosted again. */
  hostSlides?: (slides: NonNullable<PlatformPostSpec['slides']>, key: { channelKey: string; slotId: string }) => Promise<PreparedPublish>;
  /**
   * Spec 031 FR-008: an owner edit (compact before/after) or a reject reason
   * becomes an owner preference in the channel memory. Best effort: a failed
   * write never undoes the decision.
   */
  remember?: (channelKey: string, pref: OwnerPreference) => Promise<unknown>;
  log?:  (msg: string) => void;
  now?:  () => Date;
}

/** What the owner's card shows: the post, its exact preview, the agent's rationale and what can still be done. */
export interface ApprovalCard {
  id:            string;
  channelKey:    string;
  channelTitle:  string | null;
  resourceRef:   string;
  platform:      Platform;
  status:        string;
  scheduledAt:   Date;
  timezone:      string;
  localDate:     string;
  localTime:     string;
  planDate:      string;
  format:        string;
  topic:         string;
  isExperiment:  boolean;
  spec:          unknown;
  preview:       string | null;
  render:        EditorSlot['renderMessages'] | null;
  lintWarnings:  string[];
  ownerEdited:   boolean;
  approvedAt:    Date | null;
  expiresAt:     Date;
  editableUntil: Date;
  replacesSlotId: string | null;
  error:         string | null;
  rationale: {
    idea:   { id: string; title: string; angle: string | null; why: string | null } | null;
    source: { url: string; label: string | null } | null;
    angle:  string | null;
    plan:   string | null;
  };
}

const QuerySchema = z.object({
  status:   z.string().optional(),
  resource: z.string().max(200).optional(),
  channel:  z.string().max(200).optional(),
  from:     z.string().datetime({ offset: true }).optional(),
  to:       z.string().datetime({ offset: true }).optional(),
  idea:     z.string().uuid().optional(),
  date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const BulkSchema = z.object({
  channel:  z.string().max(200).optional(),
  resource: z.string().max(200).optional(),
  date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  idea_id:  z.string().uuid().optional(),
}).strict().refine((b) => !!(b.channel || b.resource || b.idea_id), { message: 'потрібно channel, resource або idea_id' });

const STATUSES = new Set(['awaiting_approval', 'approved', 'expired']);

const badRequest = (r: z.ZodError) => new BadRequestException({ error: 'invalid_body', issues: r.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });

/** 409 for the second tab: the post was approved, rejected, edited, moved or expired meanwhile. */
function alreadyDecided(current: ApprovalItem | null) {
  return new ConflictException({ error: 'already_decided', status: current?.status ?? null, details: 'цей пост уже вирішено (інша вкладка або минув час)' });
}

/**
 * The owner's approval surface (spec 031 FR-005/FR-006/FR-011): list the
 * waiting posts with their exact preview and rationale; approve, edit and
 * approve, reschedule, reject; bulk-approve a day of a resource. Every
 * decision is single-flight in the repository (409 already_decided).
 */
export class ApprovalsService {
  constructor(private readonly d: ApprovalsServiceDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  toCard(i: ApprovalItem): ApprovalCard {
    const resourceRef = i.resourceRef ?? `telegram:${i.channelKey}`;
    const spec = i.postSpec as Record<string, any> | null;
    const source = spec?.source?.url ? { url: String(spec.source.url), label: spec.source.label ?? null }
      : spec?.library_ref ? { url: String(spec.library_ref), label: null } : null;
    return {
      id: i.id, channelKey: i.channelKey, channelTitle: i.channelTitle, resourceRef,
      platform: (parseResourceRef(resourceRef)?.platform ?? 'telegram') as Platform,
      status: i.status, scheduledAt: i.scheduledAt, timezone: i.timezone,
      localDate: localDate(i.scheduledAt, i.timezone), localTime: localTimeLabel(i.scheduledAt, i.timezone), planDate: i.planDate,
      format: i.format, topic: i.topic, isExperiment: i.isExperiment, spec: i.postSpec, preview: i.renderedPreview,
      render: i.renderMessages ?? null, lintWarnings: i.lintWarnings ?? [], ownerEdited: !!i.ownerEdited, approvedAt: i.approvedAt ?? null,
      expiresAt: expiresAt(i, { approvalHoldHours: i.holdHours }), editableUntil: new Date(i.scheduledAt.getTime() - EDIT_LOCK_MS),
      replacesSlotId: i.replacesSlotId ?? null, error: i.error,
      rationale: { idea: i.idea, source, angle: i.angle, plan: i.planRationale },
    };
  }

  async list(raw: Record<string, unknown> = {}): Promise<{ items: ApprovalCard[]; waiting: number }> {
    const p = QuerySchema.safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    const q = p.data;
    const status = (q.status ?? '').split(',').map((s) => s.trim()).filter((s) => STATUSES.has(s)) as Array<'awaiting_approval' | 'approved' | 'expired'>;
    const items = await this.d.repo.list({
      status: status.length ? status : undefined, resource: q.resource ?? null, channel: q.channel ?? null,
      from: q.from ? new Date(q.from) : null, to: q.to ? new Date(q.to) : null, ideaId: q.idea ?? null, planDate: q.date ?? null,
    });
    return { items: items.map((i) => this.toCard(i)), waiting: await this.d.repo.waitingCount() };
  }

  async count(): Promise<{ waiting: number }> {
    return { waiting: await this.d.repo.waitingCount() };
  }

  private async learn(channelKey: string, pref: OwnerPreference | null): Promise<void> {
    if (!pref || !this.d.remember) return;
    try { await this.d.remember(channelKey, pref); } catch (err: any) { this.d.log?.(`owner preference not saved: ${err?.message ?? err}`); }
  }

  private async require(id: string): Promise<ApprovalItem> {
    const it = await this.d.repo.get(id);
    if (!it) throw new NotFoundException({ error: 'slot_not_found' });
    return it;
  }

  private async cardOf(it: ApprovalItem): Promise<EditorCard> {
    const card = await this.d.card(it.channelKey);
    if (!card) throw new NotFoundException({ error: 'channel_not_found', channel: it.channelKey });
    return card;
  }

  /** The first free time from `from` on: outside quiet hours and `minGap` away from the channel's other slots. */
  private async nextFreeTime(it: ApprovalItem, card: EditorCard, from: Date): Promise<Date> {
    const step = 5 * 60_000;
    const gap = Math.max(card.minGapMinutes, 1) * 60_000;
    let t = Math.ceil(from.getTime() / step) * step;
    const busy = await this.d.repo.busyTimes(it.channelKey, new Date(t - gap), new Date(t + 36 * 3600_000), it.id);
    for (let n = 0; n < 36 * 12; n++, t += step) {
      if (isQuietHour(localHour(new Date(t), card.timezone), card.quietStartHour, card.quietEndHour)) continue;
      if (busy.some((b) => Math.abs(b.getTime() - t) < gap)) continue;
      return new Date(t);
    }
    return new Date(Math.ceil(from.getTime() / step) * step);
  }

  /**
   * Approve. On time → published at its slot time by the approval publisher.
   * Late by under 2 h → published now. Later than that → moved to the next
   * free time (in the same single-flight statement).
   */
  async approve(id: string): Promise<{ card: ApprovalCard; movedTo: Date | null }> {
    const it = await this.require(id);
    if (it.status !== 'awaiting_approval') throw alreadyDecided(it);
    const now = this.now();
    let moveTo: Date | null = null;
    if (now.getTime() - it.scheduledAt.getTime() > APPROVE_LATE_MAX_MS) {
      moveTo = await this.nextFreeTime(it, await this.cardOf(it), new Date(now.getTime() + 10 * 60_000));
    }
    const done = await this.d.repo.approve(id, moveTo);
    if (!done) throw alreadyDecided(await this.d.repo.get(id));
    return { card: this.toCard((await this.d.repo.get(id))!), movedTo: moveTo };
  }

  /**
   * Edit and approve: the edited spec passes lint again (400 lint_failed with
   * the reasons), is rendered (media prepared again where needed), stored and
   * approved with owner_edited. An approved post can be edited until 2 minutes
   * before its time.
   */
  async edit(id: string, body: unknown): Promise<{ card: ApprovalCard; warnings: string[] }> {
    const it = await this.require(id);
    const now = this.now();
    const lockBefore = new Date(now.getTime() + EDIT_LOCK_MS);
    const editable = it.status === 'awaiting_approval' || (it.status === 'approved' && it.scheduledAt > lockBefore);
    if (!editable) throw alreadyDecided(it);
    const card = await this.cardOf(it);
    const raw = (body as { spec?: unknown } | null)?.spec;
    const target = it.resourceRef ? parseResourceRef(it.resourceRef) : null;

    let stored: { postSpec: unknown; renderedPreview: string; renderMessages: unknown; preparedMedia: unknown; warnings: string[]; caption?: string };
    if (target && target.platform !== 'telegram') {
      const platform = target.platform as Exclude<Platform, 'telegram'>;
      const parsed = PlatformPostSpecSchema.safeParse(raw);
      if (!parsed.success) throw badRequest(parsed.error);
      const lint = lintPlatformPost(parsed.data, { platform, bannedTerms: card.bannedTerms });
      if (!lint.ok) throw new BadRequestException({ error: 'lint_failed', details: lint.errors });
      let slideUrls: string[] = [];
      if (parsed.data.slides?.length) {
        if (!this.d.hostSlides) throw new BadRequestException({ error: 'slides_unavailable', details: 'рендер слайдів не налаштований' });
        slideUrls = (await this.d.hostSlides(parsed.data.slides, { channelKey: it.resourceRef!, slotId: `${it.id}-e${now.getTime()}` })).prepared.slideUrls ?? [];
      }
      const rendered = renderPlatform(parsed.data, platform, slideUrls);
      stored = {
        postSpec: parsed.data, renderedPreview: rendered.caption, caption: rendered.caption,
        renderMessages: { kind: 'platform', platform, rendered }, preparedMedia: { slideUrls }, warnings: lint.warnings.map((w) => w.message),
      };
    } else {
      const parsed = PostSpecSchema.safeParse(raw);
      if (!parsed.success) throw badRequest(parsed.error);
      const lint = lintPost(parsed.data, card);
      if (!lint.ok) throw new BadRequestException({ error: 'lint_failed', details: lint.errors });
      const prep = await prepareAndRender({ media: this.d.media }, { channelKey: it.channelKey, spec: parsed.data, card, mediaKey: `${it.id}-e${now.getTime()}` });
      if ('error' in prep) throw new BadRequestException(prep);
      stored = {
        postSpec: parsed.data, renderedPreview: prep.rendered.preview,
        renderMessages: { kind: 'telegram', messages: prep.rendered.messages, primary: prep.rendered.primary },
        preparedMedia: prep.prepared, warnings: lint.warnings.map((w) => w.message),
      };
    }
    const done = await this.d.repo.editAndApprove(id, {
      postSpec: stored.postSpec, renderedPreview: stored.renderedPreview, renderMessages: stored.renderMessages,
      preparedMedia: stored.preparedMedia, lintWarnings: stored.warnings, lockBefore,
    });
    if (!done) throw alreadyDecided(await this.d.repo.get(id));
    if (done.platformPostId && stored.caption !== undefined) await this.d.repo.updateWaitingPlatformPost(done.platformPostId, stored.caption, stored.postSpec);
    await this.learn(it.channelKey, editPreference({ slotId: it.id, topic: it.topic, resourceRef: it.resourceRef ?? null, before: it.postSpec, after: stored.postSpec }));
    return { card: this.toCard((await this.d.repo.get(id))!), warnings: stored.warnings };
  }

  /** A new time for a waiting or approved post: in the future, outside quiet hours, away from the series' other slots. */
  async reschedule(id: string, body: unknown): Promise<{ card: ApprovalCard }> {
    const p = z.object({ at: z.string().datetime({ offset: true }) }).strict().safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const it = await this.require(id);
    const now = this.now();
    const lockBefore = new Date(now.getTime() + EDIT_LOCK_MS);
    if (!(it.status === 'awaiting_approval' || (it.status === 'approved' && it.scheduledAt > lockBefore))) throw alreadyDecided(it);
    const card = await this.cardOf(it);
    const at = new Date(p.data.at);
    if (at.getTime() < now.getTime() + 5 * 60_000) throw new BadRequestException({ error: 'too_soon', details: 'щонайменше за 5 хвилин' });
    if (at.getTime() > now.getTime() + 14 * 86_400_000) throw new BadRequestException({ error: 'too_far', details: 'не далі 14 днів' });
    if (isQuietHour(localHour(at, card.timezone), card.quietStartHour, card.quietEndHour)) {
      throw new BadRequestException({ error: 'quiet_hours', details: `тихі години ${card.quietStartHour}:00–${card.quietEndHour}:00 (${card.timezone})` });
    }
    const gap = card.minGapMinutes * 60_000;
    const busy = await this.d.repo.busyTimes(it.channelKey, new Date(at.getTime() - gap), new Date(at.getTime() + gap), it.id);
    const clash = busy.find((b) => Math.abs(b.getTime() - at.getTime()) < gap);
    if (clash) {
      throw new BadRequestException({ error: 'too_close', details: `інший пост о ${localTimeLabel(clash, card.timezone)}; мінімальний інтервал ${card.minGapMinutes} хв` });
    }
    const done = await this.d.repo.reschedule(id, at, lockBefore);
    if (!done) throw alreadyDecided(await this.d.repo.get(id));
    return { card: this.toCard((await this.d.repo.get(id))!) };
  }

  /**
   * Reject with an optional reason: the post becomes `skipped`. With enough
   * time before the slot, the agent gets one retry — a replacement slot at the
   * same time that is written and waits for approval like any other.
   */
  async reject(id: string, body: unknown): Promise<{ card: ApprovalCard; replacementId: string | null }> {
    const p = z.object({ reason: z.string().trim().max(500).optional() }).strict().safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const it = await this.require(id);
    const now = this.now();
    const done = await this.d.repo.reject(id, p.data.reason || null, new Date(now.getTime() + EDIT_LOCK_MS));
    if (!done) throw alreadyDecided(it.status === 'awaiting_approval' ? await this.d.repo.get(id) : it);
    await this.learn(it.channelKey, rejectPreference({ slotId: it.id, topic: it.topic, resourceRef: it.resourceRef ?? null, reason: p.data.reason || null }));
    let replacementId: string | null = null;
    if (!done.replacesSlotId && done.kind === 'content' && done.scheduledAt.getTime() - now.getTime() >= REPLACEMENT_MIN_LEAD_MS) {
      const note = [
        `Заміна поста, який власник відхилив («${done.topic}»).`,
        p.data.reason ? `Причина: ${p.data.reason}.` : 'Причину не вказано — зроби інший кут або інше джерело.',
        it.angle ? `Попередній кут: ${it.angle}.` : '',
      ].filter(Boolean).join(' ');
      replacementId = await this.d.repo.insertReplacement(done, note);
    }
    return { card: this.toCard((await this.d.repo.get(id))!), replacementId };
  }

  /**
   * «Апрувнути все на завтра» for a resource, a network (channel) or the
   * variants of one idea. Posts with lint warnings are never bulk-approved.
   */
  async bulk(body: unknown): Promise<{ approved: number; skippedWithWarnings: number; conflicts: number; ids: string[] }> {
    const p = BulkSchema.safeParse(body ?? {});
    if (!p.success) throw badRequest(p.error);
    const items = await this.d.repo.list({
      status: ['awaiting_approval'], channel: p.data.channel ?? null, resource: p.data.resource ?? null,
      planDate: p.data.date ?? null, ideaId: p.data.idea_id ?? null,
    });
    const out = { approved: 0, skippedWithWarnings: 0, conflicts: 0, ids: [] as string[] };
    for (const it of items) {
      if ((it.lintWarnings ?? []).length) { out.skippedWithWarnings++; continue; }
      try {
        await this.approve(it.id);
        out.approved++;
        out.ids.push(it.id);
      } catch (err) {
        if (err instanceof ConflictException) out.conflicts++;
        else throw err;
      }
    }
    return out;
  }

  /** «Завтра» in a resource zone (the bulk button's default day). */
  static tomorrow(now: Date, tz: string): string {
    return addDays(localDate(now, tz), 1);
  }
}
