// apps/automation/src/config/api/my-bots.controller.ts
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  HttpCode, NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { MyBotsRepository } from '../my-bots.repository';
import { TelegramGetMeClient } from '../telegram-getme.client';
import { ConfigEventsPublisher } from '../config-events.publisher';
import { CreateBotDto, PatchBotDto } from './dto/my-bots.dto';

@Controller('api/my-bots')
@UseGuards(TrackingAuthGuard)
export class MyBotsController {
  constructor(
    private readonly bots:       MyBotsRepository,
    private readonly tgGetMe:    TelegramGetMeClient,
    private readonly env:        ConfigService,
    private readonly publisher:  ConfigEventsPublisher,
  ) {}

  @Get()
  async list() {
    const rows = await this.bots.list();
    return rows.map(r => ({
      id: r.id, bot_id: r.bot_id, username: r.username, first_name: r.first_name,
      platform: r.platform, token_env: r.token_env, active: r.active,
      last_verified_at: r.last_verified_at, verify_error: r.verify_error,
      created_at: r.created_at,
    }));
  }

  @Post()
  async create(@Body() body: CreateBotDto) {
    const existing = await this.bots.findByBotId(body.bot_id);
    if (existing) throw new ConflictException(`bot_id ${body.bot_id} already exists`);
    const row = await this.bots.insert(body);
    await this.publisher.publish('bot', row.id);
    return row;
  }

  @Post(':id/verify')
  async verify(@Param('id') id: string) {
    const bot = await this.bots.findById(id);
    if (!bot) throw new NotFoundException(`Bot ${id} not found`);

    const token = this.env.get<string>(bot.token_env);
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
    const bound = await this.bots.countChannelsBound(id);
    if (bound > 0) {
      throw new ConflictException(`Bot still bound to ${bound} channel(s) — reassign first`);
    }
    const ok = await this.bots.delete(id);
    if (!ok) throw new NotFoundException(`Bot ${id} not found`);
    await this.publisher.publish('bot', id);
  }
}
