import { BadRequestException, ConflictException, Controller, Get, Inject, NotFoundException, Param, ParseIntPipe, Post, Query, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import type { AutonomyDecision, AutonomyDecisionsRepository, AutonomyUndo, UndoResult } from './autonomy-decisions.repository';
import { gateFamily } from './autonomy-decisions.repository';

export const AUTONOMY_DECISIONS = 'AUTONOMY_DECISIONS';
export interface AutonomyDecisionsDeps { repo: AutonomyDecisionsRepository; undo: AutonomyUndo }

/** One decision as the dashboard reads it (dates as ISO strings, the family precomputed, `canUndo` decided by the registered handlers). */
export interface DecisionView {
  id: number; gate: string; family: string; refType: string; refId: string; channelKey: string | null;
  action: AutonomyDecision['action']; summary: string; decidedAt: string; undoneAt: string | null; undoneBy: string | null; canUndo: boolean;
}

export const decisionView = (d: AutonomyDecision, canUndo: boolean): DecisionView => ({
  id: d.id, gate: d.gate, family: gateFamily(d.gate), refType: d.refType, refId: d.refId, channelKey: d.channelKey, action: d.action,
  summary: d.summary, decidedAt: d.decidedAt.toISOString(), undoneAt: d.undoneAt ? d.undoneAt.toISOString() : null, undoneBy: d.undoneBy, canUndo,
});

/** Maps an undo failure to its HTTP status: 404 unknown, 409 already undone, 422 nothing to undo / no handler / handler failed. */
export function undoFailure(r: Extract<UndoResult, { ok: false }>): never {
  const body = { error: r.error, ...(r.message ? { details: r.message } : {}) };
  if (r.error === 'not_found') throw new NotFoundException(body);
  if (r.error === 'already_undone') throw new ConflictException(body);
  throw new UnprocessableEntityException(body);
}

/** Spec 090 FR-010: the decisions the system made on the owner's silence, and their undo (dashboard /app/health). */
@Controller('api/autonomy/decisions')
@UseGuards(TrackingAuthGuard)
export class AutonomyDecisionsController {
  constructor(@Inject(AUTONOMY_DECISIONS) private readonly d: AutonomyDecisionsDeps) {}

  /** `?channel=<key>&since=<ISO date>&limit=<1..500>`, newest first. */
  @Get()
  async list(@Query('channel') channel?: string, @Query('since') since?: string, @Query('limit') limit?: string) {
    let sinceDate: Date | undefined;
    if (since) {
      sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) throw new BadRequestException({ error: 'bad_since', details: 'since must be an ISO date' });
    }
    const n = limit ? Number(limit) : undefined;
    if (n !== undefined && !Number.isFinite(n)) throw new BadRequestException({ error: 'bad_limit' });
    const rows = await this.d.repo.list({ channelKey: channel || null, since: sinceDate, limit: n });
    return { decisions: rows.map((r) => decisionView(r, this.d.undo.canUndo(r))) };
  }

  @Post(':id/undo')
  async undo(@Param('id', ParseIntPipe) id: number) {
    const r = await this.d.undo.undo(id, 'owner');
    if (!r.ok) undoFailure(r);
    return { decision: decisionView(r.decision, this.d.undo.canUndo(r.decision)) };
  }
}
