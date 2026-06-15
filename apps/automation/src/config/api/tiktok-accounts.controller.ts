import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { TikTokAccountsRepository } from '../tiktok-accounts.repository';

@Controller('api/tiktok-accounts')
@UseGuards(TrackingAuthGuard)
export class TikTokAccountsController {
  constructor(private readonly accounts: TikTokAccountsRepository) {}

  /** Token-free projection — never return access/refresh tokens. */
  @Get()
  async list() {
    const rows = await this.accounts.list();
    return rows.map(r => ({
      id: r.id, open_id: r.open_id, username: r.username, display_name: r.display_name,
      avatar_url: r.avatar_url, active: r.active, last_refreshed_at: r.last_refreshed_at,
      refresh_error: r.refresh_error, created_at: r.created_at,
    }));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    const ok = await this.accounts.delete(id);
    if (!ok) throw new NotFoundException(`tiktok account ${id} not found`);
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: { active?: boolean }): Promise<{ ok: true }> {
    if (typeof body?.active !== 'boolean') throw new BadRequestException('active (boolean) is required');
    await this.accounts.setActive(id, body.active);
    return { ok: true };
  }
}
