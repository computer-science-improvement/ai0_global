import { Controller, Inject, NotFoundException, ConflictException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';
import { EditorPlansRepository } from '../repo/editor-plans.repository';

/**
 * Spec 103 §8: the owner locks or unlocks a slot from the dashboard. A locked slot is the owner's — the automation
 * never replaces or rewrites it (repo/slot-lock.ts). Unlock hands a planned slot back to the agent; a written post stays.
 */
@Controller('api/editor/slots')
@UseGuards(TrackingAuthGuard)
export class SlotLockController {
  private readonly plans: EditorPlansRepository;
  constructor(@Inject(DB_POOL) pool: Pool) { this.plans = new EditorPlansRepository(pool); }

  @Post(':id/unlock')
  async unlock(@Param('id', new ParseUUIDPipe()) id: string) {
    const slot = await this.plans.unlockSlot(id);
    if (!slot) throw new NotFoundException({ error: 'slot_not_found' });
    return { slot };
  }

  @Post(':id/lock')
  async lock(@Param('id', new ParseUUIDPipe()) id: string) {
    const r = await this.plans.lockSlot(id, 'owner');
    if (!r) throw new NotFoundException({ error: 'slot_not_found' });
    if ('closed' in r) throw new ConflictException({ error: 'slot_closed', details: `a ${r.closed} slot cannot be locked` });
    return { slot: r.slot };
  }
}
