import type { OwnerInbox } from '../agents/owner-inbox';
import type { ResourceCatalog } from '../agents/resource-catalog';
import type { ResourceHealth, ResourceProfilesRepository } from '../agents/resource-profile';

export interface HealthDeps {
  catalog:  Pick<ResourceCatalog, 'list' | 'access'>;
  profiles: Pick<ResourceProfilesRepository, 'setHealth' | 'get'>;
  inbox:    Pick<OwnerInbox, 'post'>;
  now?:     () => Date;
}

const BAD = new Set(['no_access', 'token_invalid', 'token_expiring', 'rate_limited']);

/**
 * Daily (and on demand) access check of every connected resource (spec 019
 * FR-011). The planner never schedules on a resource that is not ok; a change
 * into a bad state notifies the owner once.
 */
export class ResourceHealthService {
  constructor(private readonly d: HealthDeps) {}

  async check(ref: string): Promise<ResourceHealth> {
    const a = await this.d.catalog.access(ref);
    const health: ResourceHealth = { state: a.state, detail: a.detail, checkedAt: (this.d.now ?? (() => new Date()))().toISOString() };
    const prev = await this.d.profiles.setHealth(ref, health);
    if (prev !== health.state && BAD.has(health.state)) {
      await this.d.inbox.post({
        kind: 'resource_health', severity: health.state === 'token_expiring' ? 'action' : 'critical',
        title: `⚠️ ${ref}: ${health.state}`, body: `${health.detail}\nReconnect it in /app/connections — until then the planner schedules no posts here.`,
        alert: { title: `⚠️ ${ref}: ${health.state}`, body: `${health.detail}\nПерепідключіть у /app/connections — до того планувальник не ставить сюди пости.` },
        refType: 'resource', refId: ref,
      });
    }
    return health;
  }

  async run(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const r of await this.d.catalog.list()) {
      try { out[r.ref] = (await this.check(r.ref)).state; } catch { out[r.ref] = 'unknown'; }
    }
    return out;
  }

  /** Planner gate: unknown counts as usable (never-checked resources are not blocked). */
  async usable(ref: string): Promise<boolean> {
    const h = (await this.d.profiles.get(ref))?.health;
    return !h || !BAD.has(h.state) || h.state === 'token_expiring';
  }
}
