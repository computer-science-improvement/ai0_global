import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import { PostSpecSchema } from '../post/post-spec';
import { DRAFT_STATUSES, EditorDraft } from '../repo/editor-chat.repository';
import type { EditorChatRepository } from '../repo/editor-chat.repository';
import type { DraftsService } from './drafts.service';
import { parseKyivTime } from './intent';

/**
 * Per-run chat state the chat service puts into ctx.extras (spec 010). It is
 * mutable on purpose: save_draft switches the chat's channel and card so the
 * channel-scoped read and compose tools follow the draft.
 */
export interface ComposerExtras {
  chat:        { chatId: string | null; channelKey: string | null };
  card?:       unknown;
  /** The owner's latest message explicitly asks to publish / schedule (hasPublishIntent). */
  userIntent:  boolean;
  /** Called for every draft a tool created or changed (streams a draft card to the UI). */
  onDraft?:    (draft: EditorDraft) => void;
}

export interface ComposerToolDeps {
  drafts: Pick<DraftsService, 'save' | 'publish' | 'schedule' | 'cancel' | 'list'>;
  repo:   Pick<EditorChatRepository, 'myChannels'>;
}

function chatOf(ctx: ToolContext): ComposerExtras {
  const x = ctx.extras as ComposerExtras | undefined;
  if (!x?.chat) throw new Error('composer tools run only inside an editor chat');
  return x;
}

/** What the model sees about a draft. */
export function draftBrief(d: EditorDraft) {
  return {
    draft_id: d.id, channel: d.channelKey, status: d.status, format: (d.spec as any)?.format ?? null, title: (d.spec as any)?.title ?? null,
    scheduled_at: d.scheduledAt?.toISOString() ?? null, error: d.error,
  };
}

const NEEDS_REQUEST = {
  error: 'needs_explicit_request',
  details: 'власник не просив публікувати чи планувати в останньому повідомленні — покажи чернетку і запропонуй кнопки Publish now / Schedule під чернеткою',
};

export function buildComposerTools(d: ComposerToolDeps): EditorTool[] {
  const emit = (x: ComposerExtras, draft: EditorDraft) => {
    try { x.onDraft?.(draft); } catch { /* UI stream only */ }
  };

  const listMyChannels = defineTool({
    name: 'list_my_channels',
    description: 'Канали мережі, у які можна публікувати: ключ (@username), назва, чи є редакційна картка і її режим. Використовуй, коли власник не назвав канал.',
    kind: 'read', roles: ['composer'],
    input: z.object({}),
    execute: async () => ({
      channels: (await d.repo.myChannels()).map((c) => ({ channel: c.channelKey, title: c.title, has_card: c.hasCard, mode: c.mode })),
    }),
  });

  const saveDraft = defineTool({
    name: 'save_draft',
    description: [
      'Зберегти чернетку поста для каналу (нову або оновити існуючу через draft_id) і показати її власнику як превʼю.',
      'Перевіряє за карткою каналу (або типовою, якщо картки немає) і повертає {draft_id, preview, lint}.',
      'Якщо lint.ok=false — виправ помилки і збережи знову з тим самим draft_id. Нічого не публікує.',
    ].join(' '),
    kind: 'act', roles: ['composer'],
    input: z.object({
      channel:  z.string().min(2).max(200).describe('Ключ каналу, напр. @my_channel (з list_my_channels)'),
      spec:     PostSpecSchema,
      draft_id: z.string().uuid().optional().describe('Оновити цю чернетку замість створення нової'),
    }),
    execute: async ({ channel, spec, draft_id }, ctx) => {
      const x = chatOf(ctx);
      const r = await d.drafts.save({ chatId: x.chat.chatId, channel: channel.trim(), spec, draftId: draft_id ?? null });
      if ('error' in r) return r;
      // The chat now works on this channel: channel-scoped tools follow the draft.
      x.chat.channelKey = r.draft.channelKey;
      x.card = r.card;
      emit(x, r.draft);
      return { draft_id: r.draft.id, status: r.draft.status, preview: r.draft.preview, lint: r.lint };
    },
  });

  const publishDraft = defineTool({
    name: 'publish_draft',
    description: 'Опублікувати збережену чернетку в канал ЗАРАЗ. Лише коли власник прямо попросив опублікувати в останньому повідомленні. Код перевіряє lint, паузу каналу і повтори джерела.',
    kind: 'act', roles: ['composer'],
    input: z.object({ draft_id: z.string().uuid() }),
    execute: async ({ draft_id }, ctx) => {
      const x = chatOf(ctx);
      if (!x.userIntent) return NEEDS_REQUEST;
      const r = await d.drafts.publish(draft_id);
      if ('error' in r) return r;
      emit(x, r.draft);
      return { ok: true, ...draftBrief(r.draft), message_id: r.messageId, ...(r.warnings.length ? { warnings: r.warnings } : {}) };
    },
  });

  const scheduleDraft = defineTool({
    name: 'schedule_draft',
    description: 'Запланувати чернетку на дату й час (публікує код, без LLM). Лише коли власник прямо попросив запланувати в останньому повідомленні. at — "YYYY-MM-DD HH:MM" за Києвом або ISO з часовим поясом; щонайменше +2 хв, не далі 60 днів.',
    kind: 'act', roles: ['composer'],
    input: z.object({ draft_id: z.string().uuid(), at: z.string().min(10).max(40) }),
    execute: async ({ draft_id, at }, ctx) => {
      const x = chatOf(ctx);
      if (!x.userIntent) return NEEDS_REQUEST;
      const when = parseKyivTime(at);
      if (!when) return { error: 'invalid_time', details: 'формат: "YYYY-MM-DD HH:MM" (Київ) або ISO з часовим поясом' };
      const r = await d.drafts.schedule(draft_id, when);
      if ('error' in r) return r;
      emit(x, r.draft);
      return { ok: true, ...draftBrief(r.draft), kyiv_time: r.local };
    },
  });

  const cancelDraft = defineTool({
    name: 'cancel_draft',
    description: 'Скасувати чернетку або запланований пост (запланований слот знімається).',
    kind: 'act', roles: ['composer'],
    input: z.object({ draft_id: z.string().uuid() }),
    execute: async ({ draft_id }, ctx) => {
      const x = chatOf(ctx);
      const r = await d.drafts.cancel(draft_id);
      if ('error' in r) return r;
      emit(x, r.draft);
      return { ok: true, ...draftBrief(r.draft) };
    },
  });

  const listDrafts = defineTool({
    name: 'list_drafts',
    description: 'Чернетки й заплановані пости (усіх чатів), заплановані — найближчі першими.',
    kind: 'read', roles: ['composer'],
    input: z.object({ status: z.enum(DRAFT_STATUSES).optional() }),
    execute: async ({ status }) => ({ drafts: (await d.drafts.list({ status: status ?? null, limit: 30 })).map(draftBrief) }),
  });

  return [listMyChannels, saveDraft, publishDraft, scheduleDraft, cancelDraft, listDrafts];
}
