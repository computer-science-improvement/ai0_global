import type { EditorCard } from '../card';
import type { PostSpec } from '../post/post-spec';
import { renderTelegram, TgMessage } from '../post/render-telegram';
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

/**
 * The live publish of a PostSpec, shared by the executor's publish_post and the
 * editor chat (publish now and scheduled drafts): prepare media → render → send
 * → published_posts → throttle → mirrors. Callers run their own guards first.
 * A Telegram failure of the first message throws (nothing went out); mirror
 * failures are returned as warnings, never thrown.
 */
export async function publishSpecNow(d: PublishSpecDeps, i: PublishSpecInput): Promise<PublishSpecResult> {
  const { channelKey, spec, card } = i;
  // The one place that uploads slides or creates Telegraph pages — after every guard.
  let prep: PreparedPublish = { prepared: {}, cleanup: async () => {} };
  if (NEEDS_PREPARE.has(spec.format)) {
    if (!d.media) return { error: 'format_unavailable', details: `${spec.format}: підготовка медіа не налаштована — обери інший формат` };
    try {
      prep = await d.media.prepare(spec, { channelKey, slotId: i.mediaKey });
    } catch (err: any) {
      return { error: 'prepare_failed', details: `${spec.format}: ${err?.message ?? err} — обери інший формат або пропусти слот` };
    }
  }
  try {
    const rendered = renderTelegram(spec, card, prep.prepared);
    const sent = await d.publisher.send(channelKey, rendered.messages);
    const messageId = sent.messageIds[rendered.primary] ?? sent.messageIds[0];
    const postId = await d.plans.insertPublication({
      channelKey, messageId, sourceUrl: i.sourceRef, title: spec.title, tags: spec.hashtags, format: spec.format, slotId: i.slotId,
      ...(i.strategyType ? { strategyType: i.strategyType } : {}),
    });
    d.recordPublish(channelKey);
    const published: PublishedPost = {
      messageId, postId, preview: rendered.preview, ...(sent.partialError ? { partialError: sent.partialError } : {}),
    };
    if (i.onPublished) await i.onPublished(published);

    // Mirrors (spec 009 T003). The Telegram post is already out: a mirror failure is a warning, never an error.
    let mirrorWarnings: string[] = [];
    if (card.crosspost !== false && d.crosspost) {
      try {
        mirrorWarnings = await d.crosspost.fanOut({ channelKey, messageId, spec, card, prepared: prep.prepared });
      } catch (err: any) {
        mirrorWarnings = [`crosspost: ${err?.message ?? err}`];
      }
    }
    return { ok: true, ...published, mirrorWarnings };
  } finally {
    await prep.cleanup();
  }
}
