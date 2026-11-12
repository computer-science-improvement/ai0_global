import { randomUUID } from 'crypto';
import type { ChannelMode, EditorCard } from '../../editor/card';
import { lintPost } from '../../editor/post/lint-post';
import { AgentPostSpecSchema, POST_FORMATS, type PostSpec } from '../../editor/post/post-spec';
import { renderTelegram } from '../../editor/post/render-telegram';
import type { PreparedRender } from '../../editor/publish/publish-spec';
import { addDays } from '../../editor/approval/approval-timing';
import { connectorSkipError } from '../../editor/repo/slot-lock';
import type { EditorSlot } from '../../editor/repo/editor-plans.repository';
import { isQuietHour, localDate, localHour, localTimeLabel, zonedToUtc } from '../../editor/roles/time';
import { PREVIEW_MAX, clip, refuse, requireTime, timeOut } from '../tools/common';
import { defaultNeedsApproval } from './default-approval';
import type { ConnectorPostsStore, PreparedFields } from './connector-posts.repository';

/**
 * The connector's post operations (spec 103 §7): prepare_post, plan_post, update_post, cancel_post, reject_post,
 * approve_post and check_post. Pure orchestration over ports, so every refusal is unit-tested with fakes. All text a
 * post carries is checked by the same lint and rendered by the same code the owner's edit in the dashboard uses.
 */

/** A prepared post goes out no sooner than this from now (the approval flow's reschedule floor). */
export const PREPARE_MIN_LEAD_MS = 5 * 60_000;
/** …and no later than this. */
export const PREPARE_MAX_AHEAD_MS = 60 * 86_400_000;
/** An approved or waiting post can be edited until this long before its time (the approval flow's edit lock). */
export const EDIT_LOCK_MS = 2 * 60_000;

export interface PostsApprovalsPort {
  approve(id: string): Promise<{ movedTo: Date | null }>;
  reject(id: string, body: unknown): Promise<{ replacementId: string | null }>;
}

export interface ConnectorPostsDeps {
  store:     ConnectorPostsStore;
  card(channelKey: string): Promise<EditorCard | null>;
  /** The mode the channel really runs in (its agent's mode ∧ its card's). */
  modeOf(card: EditorCard): Promise<ChannelMode>;
  /** Lint passed: prepare media and render the Telegram calls, exactly what an owner edit stores. */
  render(card: EditorCard, spec: PostSpec, mediaKey: string): Promise<PreparedRender | { error: string; details: string }>;
  approvals: PostsApprovalsPort;
  now?:      () => Date;
}

export interface PostWarnings { warnings: string[] }

/** Telegram: a slot of the channel itself (no other resource). */
const isTelegramSlot = (s: EditorSlot) => !s.resourceRef || s.resourceRef.startsWith('telegram:');

/** An HTTP exception of an editor service (`{error, details}`) as a short tool reason. */
export function reasonOfHttp(err: unknown): never {
  const r = (err as { getResponse?: () => unknown })?.getResponse?.();
  if (r && typeof r === 'object' && typeof (r as { error?: unknown }).error === 'string') {
    const o = r as { error: string; details?: unknown };
    const d = typeof o.details === 'string' ? o.details : Array.isArray(o.details) ? o.details.map(String).join('; ') : '';
    return refuse(`${o.error}${d ? `: ${clip(d, 300)}` : ''}.`);
  }
  throw err;
}

export class ConnectorPostsService {
  constructor(private readonly d: ConnectorPostsDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  private async cardOf(channel: string): Promise<EditorCard> {
    const card = await this.d.card(channel);
    if (!card) refuse(`Unknown channel ${clip(channel, 80)}.`);
    return card;
  }

  private async slotOf(id: string): Promise<EditorSlot> {
    const slot = await this.d.store.getSlot(id);
    if (!slot) refuse(`No post ${clip(id, 60)}.`, 'post ids come from list_schedule');
    if (slot.kind !== 'content') refuse('This slot is not a post the connector can change.', 'ads and drafts are managed in the dashboard');
    if (!isTelegramSlot(slot)) refuse('This post belongs to another platform.', 'the connector changes Telegram posts only');
    return slot;
  }

  /** The time must be 5 min to 60 days ahead and outside quiet hours. */
  private checkTime(at: Date, card: EditorCard): void {
    const now = this.now().getTime();
    if (at.getTime() < now + PREPARE_MIN_LEAD_MS) refuse('The time is too soon.', 'pick a time at least 5 minutes from now');
    if (at.getTime() > now + PREPARE_MAX_AHEAD_MS) refuse('The time is too far ahead.', 'pick a time within 60 days');
    if (isQuietHour(localHour(at, card.timezone), card.quietStartHour, card.quietEndHour)) {
      refuse(`${localTimeLabel(at, card.timezone)} is inside the channel's quiet hours (${card.quietStartHour}:00-${card.quietEndHour}:00, ${card.timezone}).`,
        'pick a time outside quiet hours');
    }
  }

  /** Minimum-gap and daily-cap clashes are warnings, not refusals: the owner decides. */
  private async clashWarnings(card: EditorCard, at: Date, excludeId: string | null): Promise<string[]> {
    const out: string[] = [];
    const gap = Math.max(card.minGapMinutes, 1) * 60_000;
    const busy = await this.d.store.busyTimes(card.channelKey, new Date(at.getTime() - gap), new Date(at.getTime() + gap), excludeId);
    const near = busy.find((b) => Math.abs(b.getTime() - at.getTime()) < gap);
    if (near) out.push(`Another post is at ${localTimeLabel(near, card.timezone)}; the channel's minimum gap is ${card.minGapMinutes} min.`);
    const day = localDate(at, card.timezone);
    const n = await this.d.store.countInRange(card.channelKey, zonedToUtc(day, '00:00', card.timezone), zonedToUtc(addDays(day, 1), '00:00', card.timezone), excludeId);
    if (n >= card.postsPerDayMax) out.push(`That day already has ${n} posts; the channel's daily maximum is ${card.postsPerDayMax}.`);
    return out;
  }

  /** Parse, lint and render a post spec; refuses with the reasons when it does not pass. */
  private async writePost(card: EditorCard, raw: unknown): Promise<{ spec: PostSpec; fields: PreparedFields }> {
    const spec = this.parseSpec(raw);
    const lint = this.lint(card, spec);
    const prep = await this.d.render(card, spec, `connector-${randomUUID()}`);
    if ('error' in prep) refuse(`The post could not be prepared: ${clip(`${prep.error}: ${prep.details}`, 300)}`, 'check the media and the format');
    return {
      spec,
      fields: {
        postSpec: spec, renderedPreview: prep.rendered.preview,
        renderMessages: { kind: 'telegram', messages: prep.rendered.messages, primary: prep.rendered.primary },
        preparedMedia: prep.prepared, lintWarnings: lint.warnings.map((w) => w.message),
      },
    };
  }

  private parseSpec(raw: unknown): PostSpec {
    const parsed = AgentPostSpecSchema.safeParse(raw);
    if (!parsed.success) {
      const why = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'post'}: ${i.message}`).join('; ');
      return refuse(`The post is not valid: ${clip(why, 400)}`, 'see the post field of the tool for the shape; check_post tests a post without saving it');
    }
    return parsed.data as PostSpec;
  }

  private lint(card: EditorCard, spec: PostSpec) {
    const lint = lintPost(spec, card);
    if (!lint.ok) {
      refuse(`The post did not pass the text checks: ${clip(lint.errors.map((e) => `${e.code}: ${e.message}`).join('; '), 600)}`,
        'fix them and call again; check_post shows the result without saving');
    }
    return lint;
  }

  // ── prepare_post ──────────────────────────────────────────────────────────

  async prepare(i: { channel: string; at: unknown; post: unknown; needsApproval?: boolean }) {
    const card = await this.cardOf(i.channel);
    const mode = await this.d.modeOf(card);
    if (mode === 'off' || mode === 'shadow') {
      refuse(`${card.channelKey} is in ${mode} mode: nothing is published there.`, 'switch the channel to approve or live in the dashboard; the connector never changes modes');
    }
    const at = requireTime(i.at, card.timezone);
    this.checkTime(at, card);
    const { spec, fields } = await this.writePost(card, i.post);
    const needsApproval = i.needsApproval ?? defaultNeedsApproval(mode);
    const warnings = [...fields.lintWarnings, ...await this.clashWarnings(card, at, null)];
    const id = await this.d.store.insertPrepared({
      ...fields, channelKey: card.channelKey, planDate: localDate(at, card.timezone), at, format: spec.format, topic: spec.title,
      status: needsApproval ? 'awaiting_approval' : 'approved',
    });
    return {
      post_id: id, channel: card.channelKey, ...timeOut(at, card.timezone),
      status: needsApproval ? 'awaiting_approval' : 'approved', needs_approval: needsApproval, locked: true,
      warnings, preview: clip(fields.renderedPreview, PREVIEW_MAX), untrusted_fields: ['preview'],
      next: needsApproval
        ? 'It waits for approval (approve_post, or the dashboard). The automation will not change or replace it.'
        : 'It is approved and goes out at its time. The automation will not change or replace it.',
    };
  }

  // ── plan_post ─────────────────────────────────────────────────────────────

  async plan(i: { channel: string; at: unknown; topic: string; angle?: string; format?: string; notes?: string }) {
    const card = await this.cardOf(i.channel);
    const mode = await this.d.modeOf(card);
    if (mode === 'off') refuse(`${card.channelKey} is off: its agent writes nothing.`, 'switch the channel on in the dashboard first');
    const at = requireTime(i.at, card.timezone);
    this.checkTime(at, card);
    const format = this.formatOf(card, i.format);
    const warnings = await this.clashWarnings(card, at, null);
    if (mode === 'shadow') warnings.push('The channel is in shadow mode: the agent will write a preview, not a post.');
    const notes = (i.notes ?? '').replace(/\s+/g, ' ').trim();
    const id = await this.d.store.insertPlanned({
      channelKey: card.channelKey, planDate: localDate(at, card.timezone), at, format, topic: i.topic, angle: i.angle?.trim() || null,
      sourceHints: ['connector:plan', ...(notes ? [`owner_notes: ${clip(notes, 600)}`] : [])],
    });
    return {
      post_id: id, channel: card.channelKey, ...timeOut(at, card.timezone), status: 'planned', locked: true, format, topic: i.topic,
      angle: i.angle ?? null, warnings,
      next: 'The channel agent writes this post from your brief at its time. Replans and the SLO controller leave it alone.',
    };
  }

  private formatOf(card: EditorCard, wanted: string | undefined): string {
    if (wanted) {
      if (!(POST_FORMATS as readonly string[]).includes(wanted)) refuse(`Unknown format ${clip(wanted, 40)}.`, `formats: ${POST_FORMATS.join(', ')}`);
      return wanted;
    }
    const best = Object.entries(card.formats ?? {}).filter(([f, w]) => Number(w) > 0 && (POST_FORMATS as readonly string[]).includes(f)).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    return best?.[0] ?? 'text';
  }

  // ── update_post ───────────────────────────────────────────────────────────

  async update(i: { postId: string; post?: unknown; at?: unknown; topic?: string; angle?: string; format?: string }) {
    const slot = await this.slotOf(i.postId);
    const card = await this.cardOf(slot.channelKey);
    const now = this.now();
    const lockBefore = new Date(now.getTime() + EDIT_LOCK_MS);
    const hasPost = i.post !== undefined && i.post !== null;
    const hasBrief = i.topic !== undefined || i.angle !== undefined || i.format !== undefined;
    if (!hasPost && !hasBrief && i.at === undefined) refuse('Nothing to change.', 'give post, at, topic, angle or format');
    if (!['planned', 'awaiting_approval', 'approved'].includes(slot.status)) {
      refuse(`This post is ${slot.status} and cannot be changed.`, slot.status === 'published' ? 'a published post stays as it is' : 'prepare or plan a new post');
    }
    if (slot.scheduledAt.getTime() <= lockBefore.getTime()) refuse('This post is within 2 minutes of its time and cannot be changed.');
    const at = i.at !== undefined ? requireTime(i.at, card.timezone) : null;
    if (at) this.checkTime(at, card);
    const warnings = at ? await this.clashWarnings(card, at, slot.id) : [];

    let updated: EditorSlot | null;
    if (slot.status === 'planned') {
      if (hasPost) refuse('A planned post has no text yet: the agent writes it at its time.', 'change topic, angle or format, or cancel it and prepare_post with the text');
      updated = await this.d.store.patchPlanned(slot.id, {
        ...(i.topic !== undefined ? { topic: i.topic } : {}),
        ...(i.angle !== undefined ? { angle: i.angle.trim() || null } : {}),
        ...(i.format !== undefined ? { format: this.formatOf(card, i.format) } : {}),
        ...(at ? { at, planDate: localDate(at, card.timezone) } : {}),
      }, lockBefore);
    } else {
      if (hasBrief) refuse('A written post takes new text (post) and a new time (at), not a topic, angle or format.', 'send the whole post again in post');
      const written = hasPost ? await this.writePost(card, i.post) : null;
      if (written) warnings.push(...written.fields.lintWarnings);
      updated = await this.d.store.patchWritten(slot.id, { ...(written ? { fields: written.fields } : {}), ...(at ? { at, planDate: localDate(at, card.timezone) } : {}) }, lockBefore);
    }
    if (!updated) refuse('The post changed meanwhile (published, moved or closed).', 'call get_post for its current state');
    return {
      post_id: updated.id, channel: updated.channelKey, ...timeOut(updated.scheduledAt, card.timezone), status: updated.status, locked: true,
      warnings, ...(hasPost ? { preview: clip(updated.renderedPreview, PREVIEW_MAX), untrusted_fields: ['preview'] } : {}),
      note: 'The post is locked: the automation will not change or replace it. Its status is unchanged.',
    };
  }

  // ── cancel_post / reject_post / approve_post ──────────────────────────────

  async cancel(i: { postId: string; reason?: string }) {
    const slot = await this.slotOf(i.postId);
    const done = await this.d.store.cancel(slot.id, connectorSkipError(i.reason));
    if (!done) refuse(`This post is ${slot.status}: only planned, waiting or approved posts can be canceled.`);
    return { post_id: done.id, channel: done.channelKey, status: 'skipped', note: 'Canceled. No replacement is made and the SLO controller will not fill the gap for this one.' };
  }

  async reject(i: { postId: string; reason?: string }) {
    const slot = await this.slotOf(i.postId);
    if (slot.createdVia === 'connector' || slot.lockedBy) {
      refuse('This post was made or locked through the connector.', 'use cancel_post: reject_post is for agent posts waiting for approval');
    }
    if (slot.status !== 'awaiting_approval' && slot.status !== 'approved') refuse(`This post is ${slot.status}, not waiting for approval.`);
    try {
      const r = await this.d.approvals.reject(slot.id, i.reason ? { reason: clip(i.reason, 500) } : {});
      return { post_id: slot.id, channel: slot.channelKey, status: 'skipped', replacement: r.replacementId ? 'The agent will write a replacement.' : 'No replacement (too close to its time).' };
    } catch (err) { return reasonOfHttp(err); }
  }

  async approve(i: { postId: string }) {
    const slot = await this.slotOf(i.postId);
    if (slot.status !== 'awaiting_approval') refuse(`This post is ${slot.status}, not waiting for approval.`, 'list_schedule shows what is waiting');
    const card = await this.cardOf(slot.channelKey);
    try {
      const r = await this.d.approvals.approve(slot.id);
      const at = r.movedTo ?? slot.scheduledAt;
      return { post_id: slot.id, channel: slot.channelKey, status: 'approved', ...timeOut(at, card.timezone), ...(r.movedTo ? { moved: 'It was late, so it moved to the next free time.' } : {}) };
    } catch (err) { return reasonOfHttp(err); }
  }

  // ── check_post ────────────────────────────────────────────────────────────

  /** Lint and preview a post without saving anything and without any model call. */
  async check(i: { channel: string; post: unknown }) {
    const card = await this.cardOf(i.channel);
    const parsed = AgentPostSpecSchema.safeParse(i.post);
    if (!parsed.success) {
      return {
        channel: card.channelKey, ok: false,
        errors: parsed.error.issues.slice(0, 8).map((x) => ({ code: 'invalid_post', message: `${x.path.join('.') || 'post'}: ${x.message}` })), warnings: [],
      };
    }
    const spec = parsed.data as PostSpec;
    const lint = lintPost(spec, card);
    let preview: string | null = null;
    try { preview = clip(renderTelegram(spec, card).preview, PREVIEW_MAX); } catch { /* formats that need prepared media have no preview here */ }
    return {
      channel: card.channelKey, ok: lint.ok, errors: lint.errors, warnings: lint.warnings, preview,
      ...(preview ? { untrusted_fields: ['preview'] } : {}), saved: false,
    };
  }
}
