import {
  BadGatewayException, BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpException, Inject,
  NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { EditorChatService, ChatStreamEvent } from '../chat/editor-chat.service';
import type { DraftError, DraftsService } from '../chat/drafts.service';
import { parseKyivTime } from '../chat/intent';
import { DRAFT_STATUSES, DraftStatus } from '../repo/editor-chat.repository';

export const EDITOR_CHAT   = 'EDITOR_CHAT';
export const EDITOR_DRAFTS = 'EDITOR_DRAFTS';

const NOT_FOUND = new Set(['draft_not_found']);
const CONFLICT = new Set([
  'already_published', 'slot_in_progress', 'in_progress', 'cancel_first', 'channel_paused',
  'source_already_posted', 'library_item_already_posted', 'quiz_answer_mismatch',
]);

/** A refused draft action → the matching HTTP error, with the same {error, details} body the tools return. */
function raise(e: DraftError): never {
  const body = { error: e.error, ...(e.details !== undefined ? { details: e.details } : {}) };
  if (NOT_FOUND.has(e.error)) throw new NotFoundException(body);
  if (CONFLICT.has(e.error)) throw new ConflictException(body);
  if (e.error === 'publish_failed') throw new BadGatewayException(body);
  throw new BadRequestException(body);
}

function unwrap<T extends object>(r: ({ ok: true } & T) | DraftError): { ok: true } & T {
  if ('error' in r) raise(r);
  return r as { ok: true } & T;
}

/**
 * Editor chat (spec 010), owner-only. Messages stream newline-delimited JSON
 * (one ChatStreamEvent per line, flushed as it happens, ending with
 * {type:'done'}). A client that disconnects only stops the stream: the agent
 * run finishes and its answer is saved to the chat.
 */
@Controller('api/editor')
@UseGuards(TrackingAuthGuard)
export class EditorChatController {
  constructor(
    @Inject(EDITOR_CHAT) private readonly chat: EditorChatService,
    @Inject(EDITOR_DRAFTS) private readonly drafts: DraftsService,
  ) {}

  @Get('chats')
  listChats() {
    return this.chat.listChats();
  }

  @Post('chats')
  createChat() {
    return this.chat.createChat();
  }

  @Get('chats/:id')
  getChat(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.getChat(id);
  }

  @Delete('chats/:id')
  deleteChat(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.deleteChat(id);
  }

  @Post('chats/:id/messages')
  async send(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res() res: Response): Promise<void> {
    const b = (body ?? {}) as { text?: unknown; channel?: unknown };
    // Validation errors are plain HTTP errors (Nest's filter still handles throws with @Res).
    const text = await this.chat.validateSend(id, b.text);
    const channel = typeof b.channel === 'string' && b.channel.trim() ? b.channel.trim() : null;

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    let open = true;
    res.on('close', () => { open = false; });
    const write = (e: ChatStreamEvent) => {
      if (!open || res.writableEnded) return;
      res.write(`${JSON.stringify(e)}\n`);
    };

    try {
      await this.chat.sendMessage(id, text, { channel, onEvent: write });
    } catch (err: any) {
      const r = err instanceof HttpException ? err.getResponse() : null;
      write({ type: 'error', error: typeof r === 'object' && r && 'error' in r ? String((r as any).error) : String(err?.message ?? err) });
    }
    write({ type: 'done' });
    if (open && !res.writableEnded) res.end();
  }

  @Get('drafts')
  listDrafts(@Query('status') status?: string, @Query('chat') chat?: string) {
    if (status && !(DRAFT_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException({ error: 'invalid_status', details: DRAFT_STATUSES.join(', ') });
    }
    return this.drafts.list({ status: (status as DraftStatus) || null, chatId: chat || null, limit: 100 });
  }

  @Post('drafts/:id/publish')
  async publish(@Param('id', ParseUUIDPipe) id: string) {
    const r = unwrap(await this.drafts.publish(id));
    return { draft: r.draft, messageId: r.messageId, warnings: r.warnings };
  }

  @Post('drafts/:id/schedule')
  async schedule(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const at = (body as { at?: unknown } | null)?.at;
    const when = typeof at === 'string' ? parseKyivTime(at) : null;
    if (!when) throw new BadRequestException({ error: 'invalid_time', details: 'at: "YYYY-MM-DD HH:MM" (Kyiv) or ISO with an offset' });
    const r = unwrap(await this.drafts.schedule(id, when));
    return { draft: r.draft, local: r.local };
  }

  @Post('drafts/:id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    return { draft: unwrap(await this.drafts.cancel(id)).draft };
  }
}
