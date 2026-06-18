// apps/automation/src/config/api/meta-account-groups.controller.ts
//
// Manage the named groups that link a brand's Facebook + Instagram + Threads
// accounts. Accounts join a group via PATCH /api/meta-accounts/:id { groupId }.
// Deleting a group un-groups its members (ON DELETE SET NULL) — it never
// deletes accounts.
import {
  Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { MetaAccountGroupsRepository } from '../meta-account-groups.repository';
import { CreateMetaAccountGroupDto, PatchMetaAccountGroupDto } from './dto/meta-accounts.dto';

@Controller('api/meta-account-groups')
@UseGuards(TrackingAuthGuard)
export class MetaAccountGroupsController {
  constructor(private readonly groups: MetaAccountGroupsRepository) {}

  @Get()
  async list() {
    return this.groups.list();
  }

  @Post()
  async create(@Body() body: CreateMetaAccountGroupDto) {
    const name = body.name.trim();
    const existing = await this.groups.findByName(name);
    if (existing) return existing; // idempotent: reuse a same-named group
    return this.groups.create(name);
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchMetaAccountGroupDto) {
    const updated = await this.groups.setSourcePlatform(id, body.sourcePlatform);
    if (!updated) throw new NotFoundException(`Group ${id} not found`);
    return updated;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    const ok = await this.groups.delete(id);
    if (!ok) throw new NotFoundException(`Group ${id} not found`);
  }
}
