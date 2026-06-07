// apps/automation/src/config/api/meta-crossposts.controller.ts
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode,
  NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { MetaCrosspostTargetsRepository } from '../meta-crosspost-targets.repository';
import { MetaAccountsRepository } from '../meta-accounts.repository';
import { CreateCrosspostDto, PatchCrosspostDto } from './dto/meta-crossposts.dto';

@Controller('api/channels/:channelId/crossposts')
@UseGuards(TrackingAuthGuard)
export class MetaCrosspostsController {
  constructor(
    private readonly targets:  MetaCrosspostTargetsRepository,
    private readonly accounts: MetaAccountsRepository,
  ) {}

  @Get()
  list(@Param('channelId') channelId: string) {
    return this.targets.listByChannel(channelId);
  }

  @Post()
  async create(@Param('channelId') channelId: string, @Body() body: CreateCrosspostDto) {
    const account = await this.accounts.findById(body.metaAccountId);
    if (!account) throw new BadRequestException(`Meta account ${body.metaAccountId} not found`);
    if (account.platform !== body.platform) {
      throw new BadRequestException(`Account platform ${account.platform} ≠ ${body.platform}`);
    }
    // Instagram captions have no clickable links → teaser-with-link is pointless;
    // IG only makes sense as a mirror (with image).
    if (body.platform === 'instagram' && body.mode !== 'mirror') {
      throw new BadRequestException('Instagram supports only "mirror" mode');
    }
    try {
      return await this.targets.insert({
        channel_id: channelId, platform: body.platform,
        meta_account_id: body.metaAccountId, mode: body.mode,
      });
    } catch (err: any) {
      if (String(err?.code) === '23505') {
        throw new BadRequestException('This account is already a target for this channel');
      }
      throw err;
    }
  }

  @Patch(':targetId')
  async patch(@Param('targetId') targetId: string, @Body() body: PatchCrosspostDto) {
    const t = await this.targets.findById(targetId);
    if (!t) throw new NotFoundException(`Cross-post target ${targetId} not found`);
    await this.targets.setEnabled(targetId, body.enabled);
    return { ok: true };
  }

  @Delete(':targetId')
  @HttpCode(204)
  async remove(@Param('targetId') targetId: string) {
    const deleted = await this.targets.delete(targetId);
    if (!deleted) throw new NotFoundException(`Cross-post target ${targetId} not found`);
  }
}
