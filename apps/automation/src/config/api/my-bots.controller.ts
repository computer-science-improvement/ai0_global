// apps/automation/src/config/api/my-bots.controller.ts
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  HttpCode, NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { MyBotsRepository, type MyBotRow } from '../my-bots.repository';
import { TelegramGetMeClient } from '../telegram-getme.client';
import { ConfigEventsPublisher } from '../config-events.publisher';
import { SecretsService } from '../../common/crypto/secrets.service';
import { CreateBotDto, PatchBotDto, SetDefaultBotDto } from './dto/my-bots.dto';

@Controller('api/my-bots')
@UseGuards(TrackingAuthGuard)
export class MyBotsController {
  constructor(
    private readonly bots:       MyBotsRepository,
    private readonly tgGetMe:    TelegramGetMeClient,
    private readonly env:        ConfigService,
    private readonly publisher:  ConfigEventsPublisher,
    private readonly secrets:    SecretsService,
  ) {}

  @Get()
  async list() {
    const rows = await this.bots.list();
    return rows.map(r => this.toListItem(r));
  }

  /** Public projection of a bot row. NEVER includes token_enc (the encrypted
   *  secret) — only the env-var NAME. */
  private toListItem(r: MyBotRow) {
    return {
      id: r.id, bot_id: r.bot_id, username: r.username, first_name: r.first_name,
      platform: r.platform, token_env: r.token_env, active: r.active,
      is_default: r.is_default,
      last_verified_at: r.last_verified_at, verify_error: r.verify_error,
      created_at: r.created_at,
    };
  }

  @Post()
  async create(@Body() body: CreateBotDto) {
    if (!body.token && !body.token_env) {
      throw new BadRequestException('provide a token value or an env var name');
    }
    const existing = await this.bots.findByBotId(body.bot_id);
    if (existing) throw new ConflictException(`bot_id ${body.bot_id} already exists`);
    // A token VALUE is encrypted into token_enc; never stored in plaintext,
    // logged, or echoed back. The env-var NAME (legacy) is stored as-is.
    const tokenEnc = body.token ? this.secrets.encrypt(body.token.trim()) : null;
    const row = await this.bots.insert({
      bot_id: body.bot_id, token_env: body.token_env ?? null, token_enc: tokenEnc,
    });
    await this.publisher.publish('bot', row.id);
    return this.toListItem(row);
  }

  @Post(':id/verify')
  async verify(@Param('id') id: string) {
    const bot = await this.bots.findById(id);
    if (!bot) throw new NotFoundException(`Bot ${id} not found`);

    const token = this.secrets.resolveToken(
      { enc: bot.token_enc, env: bot.token_env }, (k) => this.env.get<string>(k),
    );
    if (!token) {
      await this.bots.markVerifyError(id, `Env var ${bot.token_env} is not set`);
      throw new BadRequestException(`Env var ${bot.token_env} is not set`);
    }

    try {
      const me = await this.tgGetMe.getMe(token);
      await this.bots.markVerified(id, { username: me.username, first_name: me.first_name });
      await this.publisher.publish('bot', id);
      return { ok: true, username: me.username, first_name: me.first_name };
    } catch (err: any) {
      await this.bots.markVerifyError(id, err.message);
      await this.publisher.publish('bot', id);
      return { ok: false, error: err.message };
    }
  }

  /**
   * Toggle the default-bot flag. The default bot is the publish fallback for
   * channels with no specific bot bound. Toggling one on clears any other
   * (enforced both here, in the repo transaction, and by a DB unique index).
   */
  @Post(':id/set-default')
  async setDefault(@Param('id') id: string, @Body() body: SetDefaultBotDto) {
    const bot = await this.bots.findById(id);
    if (!bot) throw new NotFoundException(`Bot ${id} not found`);
    await this.bots.setDefault(id, body.default);
    await this.publisher.publish('bot', id);
    return { ok: true };
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchBotDto) {
    const bot = await this.bots.findById(id);
    if (!bot) throw new NotFoundException(`Bot ${id} not found`);
    if (typeof body.active === 'boolean') {
      await this.bots.setActive(id, body.active);
    }
    await this.publisher.publish('bot', id);
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    // Atomic: count + delete happen under a row-level FOR UPDATE lock,
    // so a concurrent rebind to this bot can't slip between the two queries.
    const result = await this.bots.deleteIfUnbound(id);
    if (!result.ok) {
      throw new ConflictException(`Bot still bound to ${result.bound} channel(s) — reassign first`);
    }
    if (!result.deleted) {
      throw new NotFoundException(`Bot ${id} not found`);
    }
    await this.publisher.publish('bot', id);
  }
}
