import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { AgentsRepository } from '../agents/agents.repository';
import { DIRECTIVE_KINDS, DIRECTIVE_STATUSES, DirectiveKind, DirectiveStatus, DirectivesRepository } from './directives.repository';
import type { KpiDigestService } from './kpi-digest.service';
import type { ManagerRunner } from './manager-runner';

const STATUSES: readonly string[] = DIRECTIVE_STATUSES;

/** Query filters of GET /api/directives (spec 021 FR-009, spec 025 FR-018). */
export interface DirectiveFilters { status?: string; agent?: string; binding?: string; kind?: string; verified?: string }

/** Owner surface of the MANAGER (spec 021 FR-009). */
export class ManagerService {
  constructor(private readonly d: {
    repo: DirectivesRepository; agents: Pick<AgentsRepository, 'getByHandle' | 'list'>; digest: Pick<KpiDigestService, 'build' | 'render'>;
    runner: Pick<ManagerRunner, 'run' | 'manager'>; log?: (m: string) => void;
  }) {}

  async directives(f: DirectiveFilters = {}) {
    const { status, agent } = f;
    const st = status ? status.split(',').filter((s) => STATUSES.includes(s)) as DirectiveStatus[] : null;
    if (f.binding && f.binding !== 'directive' && f.binding !== 'advice') throw new BadRequestException({ error: 'invalid_binding', details: 'directive | advice' });
    if (f.verified && f.verified !== 'true' && f.verified !== 'false') throw new BadRequestException({ error: 'invalid_verified', details: 'true | false' });
    const kinds = f.kind ? f.kind.split(',').map((k) => k.trim()).filter((k) => (DIRECTIVE_KINDS as readonly string[]).includes(k)) as DirectiveKind[] : null;
    if (f.kind && !kinds?.length) throw new BadRequestException({ error: 'invalid_kind', details: DIRECTIVE_KINDS.join(', ') });
    const to = agent ? await this.d.agents.getByHandle(agent) : null;
    if (agent && !to) throw new NotFoundException({ error: 'agent_not_found' });
    const handles = new Map((await this.d.agents.list()).map((a) => [a.id, a.handle]));
    const list = await this.d.repo.list({
      status: st?.length ? st : null, toAgentId: to?.id ?? null, limit: 200,
      binding: (f.binding as 'directive' | 'advice' | undefined) ?? null, kinds, verified: f.verified ? f.verified === 'true' : null,
    });
    return { directives: list.map((x) => ({ ...x, to: handles.get(x.toAgentId) ?? null, from: x.fromAgentId ? handles.get(x.fromAgentId) ?? null : null })) };
  }

  async decide(id: string, approve: boolean) {
    const dir = await this.d.repo.get(id);
    if (!dir) throw new NotFoundException({ error: 'directive_not_found' });
    if (dir.status !== 'awaiting_owner') throw new ConflictException({ error: 'not_awaiting_owner', details: dir.status });
    const out = await this.d.repo.update(id, approve
      ? { status: 'new', ownerDecision: 'approved', shadow: false }
      : { status: 'rejected', ownerDecision: 'declined', resolution: 'owner declined', reasonKind: 'owner_rule' }, ['awaiting_owner']);
    return { directive: out };
  }

  async reviews(limit?: string) {
    return { reviews: await this.d.repo.reviews(Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200)) };
  }

  async digest() {
    const dg = await this.d.digest.build();
    const { raw: _raw, ...rest } = dg;
    return rest;
  }

  async runNow() {
    const m = await this.d.runner.manager();
    if (!m) throw new BadRequestException({ error: 'no_manager' });
    if (m.mode === 'off') throw new ConflictException({ error: 'manager_off', details: 'turn @manager on (shadow or live) on its page' });
    void this.d.runner.run(m).catch((err) => this.d.log?.(`manager run failed: ${err?.message ?? err}`));
    return { started: true };
  }
}
