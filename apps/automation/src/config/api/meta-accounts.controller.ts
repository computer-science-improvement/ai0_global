// apps/automation/src/config/api/meta-accounts.controller.ts
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get,
  HttpCode, NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { MetaAccountsRepository } from '../meta-accounts.repository';
import { MetaGraphClient } from '../meta-graph.client';
import { CreateMetaAccountDto, PatchMetaAccountDto } from './dto/meta-accounts.dto';

@Controller('api/meta-accounts')
@UseGuards(TrackingAuthGuard)
export class MetaAccountsController {
  constructor(
    private readonly accounts: MetaAccountsRepository,
    private readonly graph:    MetaGraphClient,
    private readonly env:      ConfigService,
  ) {}

  @Get()
  async list() {
    const rows = await this.accounts.list();
    // Never return token values — only the env-var name.
    return rows.map(r => ({
      id: r.id, platform: r.platform, account_id: r.account_id,
      token_env: r.token_env, target_id: r.target_id,
      username: r.username, display_name: r.display_name,
      followers: r.followers, picture_url: r.picture_url,
      active: r.active, last_verified_at: r.last_verified_at,
      verify_error: r.verify_error, created_at: r.created_at,
    }));
  }

  @Post()
  async create(@Body() body: CreateMetaAccountDto) {
    const existing = await this.accounts.findByPlatformAccount(body.platform, body.accountId);
    if (existing) throw new ConflictException(`${body.platform} account ${body.accountId} already exists`);
    return this.accounts.insert({
      platform: body.platform, account_id: body.accountId,
      token_env: body.tokenEnv, target_id: body.targetId,
    });
  }

  @Post(':id/verify')
  async verify(@Param('id') id: string) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);

    const token = this.env.get<string>(acc.token_env);
    if (!token) {
      await this.accounts.markVerifyError(id, `Env var ${acc.token_env} is not set`);
      throw new BadRequestException(`Env var ${acc.token_env} is not set`);
    }

    try {
      const r = await this.graph.verify(acc.platform, acc.target_id, token);
      await this.accounts.markVerified(id, {
        username: r.username, display_name: r.displayName,
        followers: r.followers, picture_url: r.pictureUrl,
      });
      return { ok: true, ...r };
    } catch (err: any) {
      await this.accounts.markVerifyError(id, err.message);
      return { ok: false, error: err.message };
    }
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchMetaAccountDto) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);
    if (typeof body.active === 'boolean') await this.accounts.setActive(id, body.active);
    return { ok: true };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    const deleted = await this.accounts.delete(id);
    if (!deleted) throw new NotFoundException(`Meta account ${id} not found`);
  }
}
