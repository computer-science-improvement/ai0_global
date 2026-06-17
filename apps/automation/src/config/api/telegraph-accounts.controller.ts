// apps/automation/src/config/api/telegraph-accounts.controller.ts
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  HttpCode, NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { TelegraphAccountsRepository } from '../telegraph-accounts.repository';
import { TelegraphGetInfoClient } from '../telegraph-getinfo.client';
import { ConfigEventsPublisher } from '../config-events.publisher';
import { SecretsService } from '../../common/crypto/secrets.service';
import { CreateTelegraphAccountDto, PatchTelegraphAccountDto } from './dto/telegraph-accounts.dto';

/**
 * CRUD for Telegraph sessions, mirroring MyBotsController. The actual access
 * token stays in `.env` under the name in `token_env`; the row only references
 * it. `verify` calls getAccountInfo to confirm the token is alive.
 */
@Controller('api/telegraph-accounts')
@UseGuards(TrackingAuthGuard)
export class TelegraphAccountsController {
  constructor(
    private readonly accounts:  TelegraphAccountsRepository,
    private readonly getInfo:   TelegraphGetInfoClient,
    private readonly env:       ConfigService,
    private readonly publisher: ConfigEventsPublisher,
    private readonly secrets:   SecretsService,
  ) {}

  @Get()
  async list() {
    const rows = await this.accounts.list();
    return rows.map(r => ({
      id: r.id, account_id: r.account_id, token_env: r.token_env,
      short_name: r.short_name, author_name: r.author_name, author_url: r.author_url,
      active: r.active, last_verified_at: r.last_verified_at,
      verify_error: r.verify_error, created_at: r.created_at,
    }));
  }

  @Post()
  async create(@Body() body: CreateTelegraphAccountDto) {
    const existing = await this.accounts.findByAccountId(body.account_id);
    if (existing) throw new ConflictException(`account_id ${body.account_id} already exists`);
    const row = await this.accounts.insert(body);
    await this.publisher.publish('telegraph', row.id);
    return row;
  }

  @Post(':id/verify')
  async verify(@Param('id') id: string) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Telegraph account ${id} not found`);

    const token = this.secrets.resolveToken(
      { enc: acc.token_enc, env: acc.token_env }, (k) => this.env.get<string>(k),
    );
    if (!token) {
      await this.accounts.markVerifyError(id, `Env var ${acc.token_env} is not set`);
      throw new BadRequestException(`Env var ${acc.token_env} is not set`);
    }

    try {
      const info = await this.getInfo.getAccountInfo(token);
      await this.accounts.markVerified(id, {
        short_name:  info.short_name,
        author_name: info.author_name ?? null,
        author_url:  info.author_url ?? null,
      });
      await this.publisher.publish('telegraph', id);
      return { ok: true, short_name: info.short_name, page_count: info.page_count };
    } catch (err: any) {
      await this.accounts.markVerifyError(id, err.message);
      await this.publisher.publish('telegraph', id);
      return { ok: false, error: err.message };
    }
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchTelegraphAccountDto) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Telegraph account ${id} not found`);
    if (typeof body.active === 'boolean') {
      await this.accounts.setActive(id, body.active);
    }
    await this.publisher.publish('telegraph', id);
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    const ok = await this.accounts.delete(id);
    if (!ok) throw new NotFoundException(`Telegraph account ${id} not found`);
    await this.publisher.publish('telegraph', id);
  }
}
