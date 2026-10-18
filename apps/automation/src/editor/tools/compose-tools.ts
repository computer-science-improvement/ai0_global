import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import { cardSummary, EditorCard } from '../card';
import { AgentPostSpecSchema } from '../post/post-spec';
import { lintFailed, lintPost } from '../post/lint-post';
import { renderTelegram } from '../post/render-telegram';
import { safeGet, RawGet } from '../net/safe-http';
import type { Lookup } from '../net/ssrf-guard';
import { extractPage } from '../net/extract-page';
import { fetchPageGuarded, isFetchFailure, type HostFailures } from '../net/host-failures';
import { parseSpecArg, specRefInput } from './spec-arg';

export interface ComposeToolDeps {
  http?: { lookup?: Lookup; get?: RawGet };
  /** Spec 040 FR-006: hosts that refused or failed a fetch. */
  hosts?: HostFailures;
}

/** The runner puts the channel card into ctx.extras.card for every run. */
export function cardFrom(ctx: ToolContext): EditorCard {
  const card = ctx.extras?.card as EditorCard | undefined;
  if (!card) throw new Error('no channel card in context (in the chat: name the channel first, see list_my_channels)');
  return card;
}

export function buildComposeTools(d: ComposeToolDeps = {}): EditorTool[] {
  const getChannelCard = defineTool({
    name: 'get_channel_card',
    description: 'Редакційна картка каналу: тематика, формати з вагами, словник хештегів, стиль посилань, футер, політика емодзі, джерела, ліміти, можливості Telegram.',
    kind: 'read', roles: ['planner', 'executor', 'reviewer', 'composer'],
    input: z.object({}),
    execute: async (_i, ctx) => cardSummary(cardFrom(ctx)),
  });

  const lint = defineTool({
    name: 'lint_post',
    description: 'Перевірити PostSpec за правилами каналу (формат, хештеги, атрибуція, довжина, мова, заборонені фрази, емодзі). publish_post / save_draft перевіряють те саме самі — окремо варто лише для складного формату.',
    kind: 'read', roles: ['executor', 'composer'], keepOnError: true,
    // Spec 053 FR-001: no second copy of the PostSpec schema — the terminal tool has it.
    input: specRefInput('publish_post (у чаті — save_draft)'),
    execute: async (input, ctx) => {
      const p = parseSpecArg(AgentPostSpecSchema, input.spec);
      if ('error' in p) return p;
      return lintFailed(lintPost(p.spec, cardFrom(ctx)));
    },
  });

  const preview = defineTool({
    name: 'preview_post',
    description: 'Показати, як PostSpec виглядатиме в Telegram після рендеру (HTML/текст), разом із результатом lint.',
    kind: 'read', roles: ['executor', 'composer'],
    input: specRefInput('publish_post (у чаті — save_draft)'),
    execute: async (input, ctx) => {
      const p = parseSpecArg(AgentPostSpecSchema, input.spec);
      if ('error' in p) return p;
      const spec = p.spec;
      const card = cardFrom(ctx);
      const l = lintPost(spec, card);
      if (l.errors.some((e) => e.code === 'format_not_supported_yet' || e.code === 'poll_missing')) return { lint: l };
      const r = renderTelegram(spec, card);
      return { preview: r.preview, messages: r.messages.map((m) => m.method), lint: l };
    },
  });

  const extractImages = defineTool({
    name: 'extract_images',
    description: 'Знайти зображення на сторінці (og:image і картинки зі статті). Використовуй лише зображення з джерела, яке цитуєш; для новини — лише og_image (головне зображення) або images цієї ж сторінки (альбом), немає їх — пост без зображення.',
    kind: 'read', roles: ['executor', 'composer'],
    input: z.object({ url: z.string().url() }),
    execute: async ({ url }, ctx) => {
      const sources = (ctx.extras?.card as EditorCard | undefined)?.sources;
      const res = await fetchPageGuarded(url, d.hosts, sources, () => safeGet(url, { lookup: d.http?.lookup, get: d.http?.get }));
      if (isFetchFailure(res)) return res;
      const p = extractPage(res.body, res.url);
      return { og_image: p.image, images: p.images };
    },
  });

  return [getChannelCard, lint, preview, extractImages];
}
