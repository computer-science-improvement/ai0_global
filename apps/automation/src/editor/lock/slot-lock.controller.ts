import { Controller, Inject, NotFoundException, ConflictException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { rowToSlot } from '../repo/editor-plans.repository';

/** Statuses a lock still means something for: the slot has not gone out or closed. */
const OPEN_STATUSES = ['planned', 'awaiting_approval', 'approved'];

/**
 * Spec 103 §8: the owner locks or unlocks a slot from the dashboard. A locked slot is the owner's — the automation
 * never replaces or rewrites it (slot-lock.ts). Unlock hands a planned slot back to the agent; a written post stays.
 */
@Controller('api/editor/slots')
@UseGuards(TrackingAuthGuard)
export class SlotLockController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Post(':id/unlock')
  async unlock(@Param('id', new ParseUUIDPipe()) id: string) {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET locked_by = NULL, locked_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [id]);
    if (!rows[0]) throw new NotFoundException({ error: 'slot_not_found' });
    return { slot: rowToSlot(rows[0]) };
  }

  @Post(':id/lock')
  async lock(@Param('id', new ParseUUIDPipe()) id: string) {
    const { rows } = await this.pool.query(
      `UPDATE editor_slots SET locked_by = COALESCE(locked_by, 'owner'), locked_at = COALESCE(locked_at, now()), updated_at = now()
        WHERE id = $1 AND status = ANY($2::text[]) RETURNING *`, [id, OPEN_STATUSES]);
    if (rows[0]) return { slot: rowToSlot(rows[0]) };
    const { rows: any } = await this.pool.query(`SELECT status FROM editor_slots WHERE id = $1`, [id]);
    if (!any[0]) throw new NotFoundException({ error: 'slot_not_found' });
    throw new ConflictException({ error: 'slot_closed', details: `a ${any[0].status} slot cannot be locked` });
  }
}
