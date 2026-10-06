import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { AgentsRepository } from '../agents/agents.repository';
import type { DirectiveStatus, DirectivesRepository } from './directives.repository';
import type { KpiDigestService } from './kpi-digest.service';
import type { ManagerRunner } from './manager-runner';

const STATUSES: DirectiveStatus[] = ['new', 'awaiting_owner', 'accepted', 'rejected', 'applied', 'evaluated', 'expired', 'canceled'];

/** Owner surface of the MANAGER (spec 021 FR-009). */
export class ManagerService {
  constructor(private readonly d: {
    repo: DirectivesRepository; agents: Pick<AgentsRepository, 'getByHandle' | 'list'>; digest: Pick<KpiDigestService, 'build' | 'render'>;
    runner: Pick<ManagerRunner, 'run' | 'manager'>; log?: (m: string) => void;
  }) {}

  async directives(status?: string, agent?: string) {
    const st = status ? status.split(',').filter((s) => (STATUSES as string[]).includes(s)) as DirectiveStatus[] : null;
    const to = agent ? await this.d.agents.getByHandle(agent) : null;
    if (agent && !to) throw new NotFoundException({ error: 'agent_not_found' });
    const handles = new Map((await this.d.agents.list()).map((a) => [a.id, a.handle]));
    const list = await this.d.repo.list({ status: st?.length ? st : null, toAgentId: to?.id ?? null, limit: 200 });
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
