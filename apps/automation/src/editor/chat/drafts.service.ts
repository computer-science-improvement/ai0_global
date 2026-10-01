import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import { PostSpec, PostSpecSchema } from '../post/post-spec';
import { lintPost, LintResult } from '../post/lint-post';
import { renderTelegram } from '../post/render-telegram';
import { checkQuizGroundTruth } from '../post/quiz-ground-truth';
import { checkVerbatim } from '../post/verbatim-guard';
import { publishSpecNow, PublishSpecDeps } from '../publish/publish-spec';
import { ChannelPausedForEditorError } from '../publish/telegram-editor.publisher';
import { RESERVED_MAX_LATE_MS } from '../publish/sponsored.publisher';
import type { EditorChannelsRepository } from '../repo/editor-channels.repository';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import type { DraftStatus, EditorChatRepository, EditorDraft } from '../repo/editor-chat.repository';
import { localDate, localTimeLabel } from '../roles/time';
import { CHAT_TIMEZONE, makeDefaultCard } from './default-card';

export const DEDUP_DAYS = 7;
export const SCHEDULE_MIN_LEAD_MS = 2 * 60_000;
export const SCHEDULE_MAX_AHEAD_MS = 60 * 86_400_000;
export const CHAT_SLOT_HINT = 'chat_draft:';

export interface DraftsDeps {
  pool:      Pick<Pool, 'query'>;
  repo:      Pick<EditorChatRepository, 'insertDraft' | 'updateDraft' | 'getDraft' | 'findDraftBySlot' | 'listDrafts' | 'myChannels'>;
  channels:  Pick<EditorChannelsRepository, 'get' | 'insertIfMissing'>;
  plans:     Pick<EditorPlansRepository, 'reserveSlot' | 'skipPlannedSlot' | 'updateSlot' | 'sourcePostedSince' | 'insertPublication'>;
  publisher: PublishSpecDeps['publisher'];
  recordPublish: (channelKey: string) => void;
  media?:     PublishSpecDeps['media'];
  crosspost?: PublishSpecDeps['crosspost'];
  /** tracked_channels.publish_paused (the publisher enforces it too; this check runs before any media work). */
  isPaused:  (channelKey: string) => boolean;
  notify:    (text: string) => Promise<void>;
  now?:      () => Date;
  log?:      (msg: string) => void;
}

/** A refused action, returned as data (tools hand it to the model; REST maps it to 4xx). */
export interface DraftError { error: string; details?: unknown }
export type DraftResult<T> = ({ ok: true } & T) | DraftError;

export interface ResolvedCard { card: EditorCard; hasCard: boolean }

const isError = (v: unknown): v is DraftError => !!v && typeof v === 'object' && typeof (v as any).error === 'string';

function previewOf(spec: PostSpec, card: EditorCard, lint: LintResult): string | null {
  if (lint.errors.some((e) => e.code === 'format_not_supported_yet' || e.code === 'poll_missing')) return null;
  try { return renderTelegram(spec, card).preview; } catch { return null; }
}

/**
 * Deterministic draft actions of the editor chat (spec 010 FR-004). The
 * composer's tools and the owner's REST buttons both call this service, so a
 * post from the chat passes the same guards whoever triggers it: lint, quiz
 * ground truth, verbatim copy of retold library content, publish_paused, and a 7-day dedup on source.url / library_ref.
 * Scheduling reuses 008's reserved slots; ReservedDispatcher publishes them.
 */
export class DraftsService {
  private readonly inFlight = new Set<string>();

  constructor(private readonly d: DraftsDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /** The channel's card, or the default card for an own channel without one; null for an unknown channel. */
  async resolveCard(channelKey: string): Promise<ResolvedCard | null> {
    const card = await this.d.channels.get(channelKey);
    if (card) return { card, hasCard: true };
    const mine = (await this.d.repo.myChannels()).find((c) => c.channelKey === channelKey);
    return mine ? { card: makeDefaultCard(channelKey, mine.title), hasCard: false } : null;
  }

  get(id: string): Promise<EditorDraft | null> {
    return this.d.repo.getDraft(id);
  }

  list(f: { status?: DraftStatus | null; chatId?: string | null; limit?: number } = {}): Promise<EditorDraft[]> {
    return this.d.repo.listDrafts(f);
  }

  // ── save ──────────────────────────────────────────────────────────────────

  async save(i: { chatId: string | null; channel: string; spec: unknown; draftId?: string | null }): Promise<DraftResult<{ draft: EditorDraft; card: EditorCard; lint: LintResult }>> {
    const parsed = PostSpecSchema.safeParse(i.spec);
    if (!parsed.success) return { error: 'invalid_spec', details: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`) };
    const spec = parsed.data;
    const resolved = await this.resolveCard(i.channel);
    if (!resolved) return { error: 'unknown_channel', details: `${i.channel} не є каналом мережі — див. list_my_channels` };
    const lint = lintPost(spec, resolved.card);
    const preview = previewOf(spec, resolved.card, lint);

    if (!i.draftId) {
      const draft = await this.d.repo.insertDraft({ chatId: i.chatId, channelKey: i.channel, spec, preview, lint });
      return { ok: true, draft, card: resolved.card, lint };
    }
    const existing = await this.d.repo.getDraft(i.draftId);
    if (!existing) return { error: 'draft_not_found' };
    if (existing.status === 'published') return { error: 'already_published', details: 'чернетку вже опубліковано — збережи нову (без draft_id)' };
    if (existing.status === 'scheduled') {
      if (existing.channelKey !== i.channel) return { error: 'cancel_first', details: 'чернетка запланована в іншому каналі — спершу cancel_draft' };
      if (!lint.ok) return { error: 'lint_failed', details: lint.errors };
      if (existing.slotId) await this.d.plans.updateSlot(existing.slotId, { postSpec: spec });
    }
    const draft = await this.d.repo.updateDraft(existing.id, {
      channelKey: i.channel, spec, preview, lint,
      ...(existing.status === 'scheduled' ? {} : { status: 'draft' as const, error: null }),
    });
    return { ok: true, draft: draft!, card: resolved.card, lint };
  }

  // ── guards shared by publish-now and the scheduled path ───────────────────

  private async guards(channelKey: string, spec: PostSpec, card: EditorCard, now: Date): Promise<DraftError | { ref: string | null }> {
    const lint = lintPost(spec, card);
    if (!lint.ok) return { error: 'lint_failed', details: lint.errors };
    const truth = await checkQuizGroundTruth(this.d.pool, spec);
    if (truth) return truth;
    const verbatim = await checkVerbatim(this.d.pool, spec);
    if (verbatim) return verbatim;
    if (this.d.isPaused(channelKey)) return { error: 'channel_paused', details: `${channelKey}: publish_paused=true` };
    const since = new Date(now.getTime() - DEDUP_DAYS * 86_400_000);
    if (spec.library_ref && await this.d.plans.sourcePostedSince(channelKey, spec.library_ref, since)) {
      return { error: 'library_item_already_posted', details: `цей запис уже публікувався в ${channelKey} за ${DEDUP_DAYS} днів` };
    }
    if (spec.source && await this.d.plans.sourcePostedSince(channelKey, spec.source.url, since)) {
      return { error: 'source_already_posted', details: `це джерело вже публікувалось у ${channelKey} за ${DEDUP_DAYS} днів` };
    }
    return { ref: spec.library_ref ?? spec.source?.url ?? null };
  }

  private publishDeps(): PublishSpecDeps {
    return { plans: this.d.plans, publisher: this.d.publisher, recordPublish: this.d.recordPublish, media: this.d.media, crosspost: this.d.crosspost };
  }

  /** Mirrors only for a channel that really has a card with crosspost on. */
  private publishCard(r: ResolvedCard): EditorCard {
    return r.hasCard ? r.card : { ...r.card, crosspost: false };
  }

  // ── publish now ───────────────────────────────────────────────────────────

  async publish(draftId: string): Promise<DraftResult<{ draft: EditorDraft; messageId: number; warnings: string[] }>> {
    if (this.inFlight.has(draftId)) return { error: 'in_progress', details: 'ця чернетка вже публікується' };
    this.inFlight.add(draftId);
    try {
      const draft = await this.d.repo.getDraft(draftId);
      if (!draft) return { error: 'draft_not_found' };
      if (draft.status === 'published') return { error: 'already_published' };
      const spec = PostSpecSchema.safeParse(draft.spec);
      if (!spec.success) return { error: 'invalid_spec' };
      const resolved = await this.resolveCard(draft.channelKey);
      if (!resolved) return { error: 'unknown_channel' };
      const now = this.now();
      const g = await this.guards(draft.channelKey, spec.data, resolved.card, now);
      if (isError(g)) return g;

      if (draft.status === 'scheduled' && draft.slotId) {
        // The scheduled copy must never go out as well.
        const skipped = await this.d.plans.skipPlannedSlot(draft.slotId, 'published from the chat right away');
        if (!skipped) return { error: 'slot_in_progress', details: 'запланований пост саме публікується' };
      }

      let res;
      try {
        res = await publishSpecNow(this.publishDeps(), {
          channelKey: draft.channelKey, spec: spec.data, card: this.publishCard(resolved), sourceRef: g.ref,
          mediaKey: `draft-${draft.id}`, slotId: null, strategyType: 'chat',
        });
      } catch (err: any) {
        const reason = err instanceof ChannelPausedForEditorError ? err.message : `send failed: ${err?.message ?? err}`;
        await this.d.repo.updateDraft(draft.id, { status: 'failed', error: reason, slotId: null, scheduledAt: null });
        return { error: 'publish_failed', details: reason };
      }
      if ('error' in res) {
        if (draft.status === 'scheduled') await this.d.repo.updateDraft(draft.id, { status: 'draft', slotId: null, scheduledAt: null });
        return res;
      }
      const warnings = [res.partialError ? `partial: ${res.partialError}` : null, ...res.mirrorWarnings].filter((x): x is string => !!x);
      const updated = await this.d.repo.updateDraft(draft.id, {
        status: 'published', publishedPostId: res.postId, preview: res.preview, slotId: null, scheduledAt: null,
        error: warnings.length ? warnings.join(' | ').slice(0, 2000) : null,
      });
      return { ok: true, draft: updated!, messageId: res.messageId, warnings };
    } finally {
      this.inFlight.delete(draftId);
    }
  }

  // ── schedule ──────────────────────────────────────────────────────────────

  async schedule(draftId: string, at: Date): Promise<DraftResult<{ draft: EditorDraft; local: string }>> {
    const draft = await this.d.repo.getDraft(draftId);
    if (!draft) return { error: 'draft_not_found' };
    if (draft.status === 'published') return { error: 'already_published' };
    const now = this.now();
    if (Number.isNaN(at.getTime())) return { error: 'invalid_time' };
    if (at.getTime() < now.getTime() + SCHEDULE_MIN_LEAD_MS) return { error: 'too_soon', details: 'час має бути щонайменше на 2 хвилини пізніше, ніж зараз — або опублікуй одразу' };
    if (at.getTime() > now.getTime() + SCHEDULE_MAX_AHEAD_MS) return { error: 'too_far', details: 'не більше ніж на 60 днів наперед' };
    const spec = PostSpecSchema.safeParse(draft.spec);
    if (!spec.success) return { error: 'invalid_spec' };
    const resolved = await this.resolveCard(draft.channelKey);
    if (!resolved) return { error: 'unknown_channel' };
    const lint = lintPost(spec.data, resolved.card);
    if (!lint.ok) return { error: 'lint_failed', details: lint.errors };

    // A channel without a card gets a minimal one in mode 'off' (the planner ignores it).
    if (!resolved.hasCard) await this.d.channels.insertIfMissing(resolved.card);
    if (draft.status === 'scheduled' && draft.slotId) {
      const skipped = await this.d.plans.skipPlannedSlot(draft.slotId, 'rescheduled from the chat');
      if (!skipped) return { error: 'slot_in_progress', details: 'запланований пост саме публікується' };
    }
    const tz = resolved.card.timezone || CHAT_TIMEZONE;
    const slotId = await this.d.plans.reserveSlot({
      channelKey: draft.channelKey, planDate: localDate(at, tz), scheduledAt: at, format: spec.data.format,
      topic: `Чат: ${spec.data.title}`.slice(0, 200), sourceHints: [`${CHAT_SLOT_HINT}${draft.id}`], postSpec: spec.data,
    });
    const updated = await this.d.repo.updateDraft(draft.id, { status: 'scheduled', scheduledAt: at, slotId, error: null });
    return { ok: true, draft: updated!, local: `${localDate(at, CHAT_TIMEZONE)} ${localTimeLabel(at, CHAT_TIMEZONE)} (Київ)` };
  }

  // ── cancel ────────────────────────────────────────────────────────────────

  async cancel(draftId: string): Promise<DraftResult<{ draft: EditorDraft }>> {
    const draft = await this.d.repo.getDraft(draftId);
    if (!draft) return { error: 'draft_not_found' };
    if (draft.status === 'published') return { error: 'already_published' };
    if (draft.status === 'scheduled' && draft.slotId) {
      const skipped = await this.d.plans.skipPlannedSlot(draft.slotId, 'canceled from the chat');
      if (!skipped) return { error: 'slot_in_progress', details: 'запланований пост саме публікується' };
    }
    const updated = await this.d.repo.updateDraft(draft.id, { status: 'canceled', slotId: null, scheduledAt: null });
    return { ok: true, draft: updated! };
  }

  // ── scheduled publish (ReservedDispatcher manual path, FR-005) ────────────

  /**
   * Publish a claimed (running) reserved slot that carries a chat PostSpec and
   * no ad order. Deterministic, no LLM, at most 6 h late, never retried: any
   * failure marks the slot and the draft failed and alerts the owner.
   */
  async publishScheduled(slot: EditorSlot, now: Date): Promise<boolean> {
    let draft: EditorDraft | null = null;
    try {
      draft = await this.d.repo.findDraftBySlot(slot.id);
      if (draft?.status === 'canceled') {
        await this.d.plans.updateSlot(slot.id, { status: 'skipped', error: 'draft canceled' });
        return false;
      }
      const lateMs = now.getTime() - slot.scheduledAt.getTime();
      if (lateMs > RESERVED_MAX_LATE_MS) return this.failScheduled(slot, draft, `missed window: ${Math.round(lateMs / 60_000)} min late`);
      const spec = PostSpecSchema.safeParse(draft?.spec ?? slot.postSpec);
      if (!spec.success) return this.failScheduled(slot, draft, 'post_spec is not a valid PostSpec');
      const resolved = await this.resolveCard(slot.channelKey)
        ?? { card: makeDefaultCard(slot.channelKey, null), hasCard: false };
      const g = await this.guards(slot.channelKey, spec.data, resolved.card, now);
      if (isError(g)) return this.failScheduled(slot, draft, `${g.error}${g.details ? `: ${typeof g.details === 'string' ? g.details : JSON.stringify(g.details)}` : ''}`);

      let res;
      try {
        res = await publishSpecNow(this.publishDeps(), {
          channelKey: slot.channelKey, spec: spec.data, card: this.publishCard(resolved), sourceRef: g.ref,
          mediaKey: slot.id, slotId: slot.id, strategyType: 'chat',
          onPublished: async (p) => {
            await this.d.plans.updateSlot(slot.id, {
              status: 'published', publishedPostId: p.postId, postSpec: spec.data, renderedPreview: p.preview,
              error: p.partialError ? `partial: ${p.partialError}` : null,
            });
          },
        });
      } catch (err: any) {
        const reason = err instanceof ChannelPausedForEditorError ? err.message : `send failed: ${err?.message ?? err}`;
        return this.failScheduled(slot, draft, reason);
      }
      if ('error' in res) return this.failScheduled(slot, draft, `${res.error}: ${res.details}`);

      const warnings = [res.partialError ? `partial: ${res.partialError}` : null, ...res.mirrorWarnings].filter((x): x is string => !!x);
      if (res.mirrorWarnings.length) {
        try { await this.d.plans.updateSlot(slot.id, { error: warnings.join(' | ').slice(0, 2000) }); } catch { /* best-effort note */ }
      }
      if (draft) {
        await this.d.repo.updateDraft(draft.id, {
          status: 'published', publishedPostId: res.postId, preview: res.preview,
          error: warnings.length ? warnings.join(' | ').slice(0, 2000) : null,
        });
      }
      return true;
    } catch (err: any) {
      return this.failScheduled(slot, draft, `crashed: ${err?.message ?? err}`);
    }
  }

  private async failScheduled(slot: EditorSlot, draft: EditorDraft | null, error: string): Promise<false> {
    try { await this.d.plans.updateSlot(slot.id, { status: 'failed', error }); } catch { /* reported below */ }
    if (draft) {
      try { await this.d.repo.updateDraft(draft.id, { status: 'failed', error }); } catch { /* reported below */ }
    }
    this.d.log?.(`scheduled chat post ${slot.id} failed: ${error}`);
    try {
      await this.d.notify(`⚠️ Запланований пост у ${slot.channelKey} (${localTimeLabel(slot.scheduledAt, CHAT_TIMEZONE)}) не вийшов: ${error}. Відкрий /app/chat.`);
    } catch { /* alerts are best-effort */ }
    return false;
  }
}
