import type { EditorCard } from '../card';
import type { PostSpec } from '../post/post-spec';
import { renderTelegram, type PreparedMedia, type RenderResult, type TgMessage } from '../post/render-telegram';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import type { SendResult } from './telegram-editor.publisher';
import { NEEDS_PREPARE, PreparedPublish } from './prepare-media';
import type { CrossPostRequest } from './editor-crosspost';

export interface PublishSpecDeps {
  plans:         Pick<EditorPlansRepository, 'insertPublication'>;
  publisher:     { send(channelKey: string, messages: TgMessage[]): Promise<SendResult> };
  recordPublish: (channelKey: string) => void;
  /** Live-only media stage for carousel (render + host slides) and longread (Telegraph page). */
  media?:        { prepare(spec: PostSpec, key: { channelKey: string; slotId: string }): Promise<PreparedPublish> };
  /** Live-only fan-out to the channel's Meta mirrors; returns warnings, never throws (EditorCrossPoster). */
  crosspost?:    { fanOut(r: CrossPostRequest): Promise<string[]> };
}

export interface PublishSpecInput {
  channelKey: string;
  spec:       PostSpec;
  card:       Pick<EditorCard, 'linkStyle' | 'footer' | 'crosspost'>;
  /** published_posts.source_url: the dedup key (library_ref or source.url). */
  sourceRef:  string | null;
  /** Key for hosted media paths (the slot or draft id). */
  mediaKey:   string;
  /** published_posts.editor_slot_id. */
  slotId:     string | null;
  /** published_posts.strategy_type; omitted → the repository default ('editor'). */
  strategyType?: 'editor' | 'ad' | 'chat';
  /** Runs once the publication row exists and before the mirrors (e.g. mark the slot published). */
  onPublished?: (p: PublishedPost) => Promise<void>;
}

export interface PublishedPost {
  messageId:     number;
  postId:        number;
  preview:       string;
  partialError?: string;
}

export type PublishSpecResult =
  | ({ ok: true; mirrorWarnings: string[] } & PublishedPost)
  | { error: 'format_unavailable' | 'prepare_failed'; details: string };

/** A PostSpec rendered with its media prepared: what goes out, byte for byte. */
export interface PreparedRender {
  rendered: Pick<RenderResult, 'messages' | 'primary' | 'preview'>;
  prepared: PreparedMedia;
  cleanup:  () => Promise<void>;
}

/**
 * Prepare media (render + host carousel slides, create the longread's
 * Telegraph page) and render the Telegram calls. The only place that uploads
 * slides or creates Telegraph pages — callers run every guard first. Used by
 * the live publish and by approval mode (spec 031), which stores the result
 * so the owner approves exactly what is later sent.
 */
export async function prepareAndRender(
  d: Pick<PublishSpecDeps, 'media'>, i: { channelKey: string; spec: PostSpec; card: Pick<EditorCard, 'linkStyle' | 'footer'>; mediaKey: string },
): Promise<PreparedRender | { error: 'format_unavailable' | 'prepare_failed'; details: string }> {
  const { spec } = i;
  let prep: PreparedPublish = { prepared: {}, cleanup: async () => {} };
  if (NEEDS_PREPARE.has(spec.format)) {
    if (!d.media) return { error: 'format_unavailable', details: `${spec.format}: підготовка медіа не налаштована — обери інший формат` };
    try {
      prep = await d.media.prepare(spec, { channelKey: i.channelKey, slotId: i.mediaKey });
    } catch (err: any) {
      return { error: 'prepare_failed', details: `${spec.format}: ${err?.message ?? err} — обери інший формат або пропусти слот` };
    }
  }
  try {
    const r = renderTelegram(spec, i.card, prep.prepared);
    return { rendered: { messages: r.messages, primary: r.primary, preview: r.preview }, prepared: prep.prepared, cleanup: prep.cleanup };
  } catch (err) {
    await prep.cleanup();
    throw err;
  }
}

/**
 * Send already rendered Telegram calls → published_posts → throttle →
 * onPublished → mirrors. A Telegram failure of the first message throws
 * (nothing went out); mirror failures are returned as warnings, never thrown.
 */
export async function sendRendered(
  d: PublishSpecDeps, i: PublishSpecInput, r: Pick<PreparedRender, 'rendered' | 'prepared'>,
): Promise<{ ok: true; mirrorWarnings: string[] } & PublishedPost> {
  const { channelKey, spec, card } = i;
  const sent = await d.publisher.send(channelKey, r.rendered.messages);
  const messageId = sent.messageIds[r.rendered.primary] ?? sent.messageIds[0];
  // The content ledger gets every source ref of the post; published_posts.source_url keeps only one.
  const extraRefs = [spec.library_ref, spec.source?.url].filter((x): x is string => !!x && x !== i.sourceRef);
  const postId = await d.plans.insertPublication({
    channelKey, messageId, sourceUrl: i.sourceRef, title: spec.title, tags: spec.hashtags, format: spec.format, slotId: i.slotId,
    ...(i.strategyType ? { strategyType: i.strategyType } : {}),
    ...(extraRefs.length ? { refs: extraRefs } : {}),
  });
  d.recordPublish(channelKey);
  const published: PublishedPost = {
    messageId, postId, preview: r.rendered.preview, ...(sent.partialError ? { partialError: sent.partialError } : {}),
  };
  if (i.onPublished) await i.onPublished(published);

  // Mirrors (spec 009 T003). The Telegram post is already out: a mirror failure is a warning, never an error.
  let mirrorWarnings: string[] = [];
  if (card.crosspost !== false && d.crosspost) {
    try {
      mirrorWarnings = await d.crosspost.fanOut({ channelKey, messageId, spec, card, prepared: r.prepared });
    } catch (err: any) {
      mirrorWarnings = [`crosspost: ${err?.message ?? err}`];
    }
  }
  return { ok: true, ...published, mirrorWarnings };
}

/**
 * The live publish of a PostSpec, shared by the executor's publish_post and the
 * editor chat (publish now and scheduled drafts): prepare media → render → send
 * → published_posts → throttle → mirrors. Callers run their own guards first.
 */
export async function publishSpecNow(d: PublishSpecDeps, i: PublishSpecInput): Promise<PublishSpecResult> {
  const prep = await prepareAndRender(d, { channelKey: i.channelKey, spec: i.spec, card: i.card, mediaKey: i.mediaKey });
  if ('error' in prep) return prep;
  try {
    return await sendRendered(d, i, prep);
  } finally {
    await prep.cleanup();
  }
}
