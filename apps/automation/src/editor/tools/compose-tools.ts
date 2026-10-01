import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import { cardSummary, EditorCard } from '../card';
import { PostSpecSchema } from '../post/post-spec';
import { lintPost } from '../post/lint-post';
import { renderTelegram } from '../post/render-telegram';
import { safeGet, RawGet } from '../net/safe-http';
import type { Lookup } from '../net/ssrf-guard';
import { extractPage } from '../net/extract-page';

export interface ComposeToolDeps {
  http?: { lookup?: Lookup; get?: RawGet };
}

/** The runner puts the channel card into ctx.extras.card for every run. */
export function cardFrom(ctx: ToolContext): EditorCard {
  const card = ctx.extras?.card as EditorCard | undefined;
  if (!card) throw new Error('no channel card in context');
  return card;
}

export function buildComposeTools(d: ComposeToolDeps = {}): EditorTool[] {
  const getChannelCard = defineTool({
    name: 'get_channel_card',
    description: 'Редакційна картка каналу: тематика, формати з вагами, словник хештегів, стиль посилань, футер, політика емодзі, джерела, ліміти, можливості Telegram.',
    kind: 'read', roles: ['planner', 'executor', 'reviewer'],
    input: z.object({}),
    execute: async (_i, ctx) => cardSummary(cardFrom(ctx)),
  });

  const lint = defineTool({
    name: 'lint_post',
    description: 'Перевірити PostSpec за правилами каналу (формат, хештеги, атрибуція, довжина, мова, заборонені фрази, емодзі). Виправ усі errors перед publish_post.',
    kind: 'read', roles: ['executor'],
    input: z.object({ spec: PostSpecSchema }),
    execute: async ({ spec }, ctx) => lintPost(spec, cardFrom(ctx)),
  });

  const preview = defineTool({
    name: 'preview_post',
    description: 'Показати, як PostSpec виглядатиме в Telegram після рендеру (HTML/текст), разом із результатом lint.',
    kind: 'read', roles: ['executor'],
    input: z.object({ spec: PostSpecSchema }),
    execute: async ({ spec }, ctx) => {
      const card = cardFrom(ctx);
      const l = lintPost(spec, card);
      if (l.errors.some((e) => e.code === 'format_not_supported_yet' || e.code === 'poll_missing')) return { lint: l };
      const r = renderTelegram(spec, card);
      return { preview: r.preview, messages: r.messages.map((m) => m.method), lint: l };
    },
  });

  const extractImages = defineTool({
    name: 'extract_images',
    description: 'Знайти зображення на сторінці (og:image і картинки зі статті). Використовуй лише зображення з джерела, яке цитуєш.',
    kind: 'read', roles: ['executor'],
    input: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      const res = await safeGet(url, { lookup: d.http?.lookup, get: d.http?.get });
      if (res.status >= 400) return { error: 'http_error', details: `status ${res.status}` };
      const p = extractPage(res.body, res.url);
      return { og_image: p.image, images: p.images };
    },
  });

  return [getChannelCard, lint, preview, extractImages];
}
