import { dailyRef, type OwnerInbox } from '../agents/owner-inbox';
import type { ResourceCatalog } from '../agents/resource-catalog';
import type { HealthState, ResourceHealth, ResourceProfilesRepository } from '../agents/resource-profile';
import { kyivDay } from '../../common/ai/usage/kyiv-day';

export interface HealthDeps {
  catalog:  Pick<ResourceCatalog, 'list' | 'access'>;
  profiles: Pick<ResourceProfilesRepository, 'setHealth' | 'get'>;
  /** `postOnce` sends the daily reminder (spec 049 FR-002); without it only state changes are posted. */
  inbox:    Pick<OwnerInbox, 'post'> & Partial<Pick<OwnerInbox, 'postOnce'>>;
  now?:     () => Date;
}

const BAD = new Set<HealthState>(['no_access', 'token_invalid', 'token_expiring', 'rate_limited']);

/** Spec 049 FR-002: states in which a post cannot go out — the slots of such a resource are skipped, not run. */
export const BLOCKING_STATES = new Set<HealthState>(['no_access', 'token_invalid']);
/** A token that expires within this many days is reminded about daily (the first note comes at 7 days). */
export const EXPIRING_REMIND_DAYS = 2;
/** A blocking state older than this is re-checked before a slot is skipped (the owner may have reconnected). */
export const RECHECK_MS = 30 * 60_000;
/** The ref prefix of a skipped slot's reason (the dashboard plan reads it). */
export const UNAVAILABLE_ERROR = 'resource_unavailable';

const DAY = 86_400_000;
const fmtDay = (iso: string) => iso.slice(0, 10);
const daysSince = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY));

/**
 * Daily (and on demand) access check of every connected resource (spec 019 FR-011, spec 049 FR-002).
 * - The planner never schedules on a resource that is not ok (`usable`); a slot already planned on a resource
 *   that cannot publish is skipped with the reason (`blocked`).
 * - A change into a bad state notifies the owner; a resource that stays broken reminds once a day until it is
 *   fixed or the owner mutes the reminders (`dismiss`, until the state changes); a fix is announced.
 */
export class ResourceHealthService {
  constructor(private readonly d: HealthDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async check(ref: string): Promise<ResourceHealth> {
    const now = this.now();
    const a = await this.d.catalog.access(ref);
    const prev = (await this.d.profiles.get(ref))?.health ?? null;
    const same = prev?.state === a.state;
    const health: ResourceHealth = {
      state: a.state, detail: a.detail, checkedAt: now.toISOString(),
      ...(BAD.has(a.state) ? { since: same && prev?.since ? prev.since : now.toISOString() } : {}),
      ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
      ...(same && prev?.dismissedAt ? { dismissedAt: prev.dismissedAt } : {}),
    };
    await this.d.profiles.setHealth(ref, health);

    if (BAD.has(health.state) && !same) {
      // Spec 060 FR-003: one subject per resource; the reminders below follow the repeat rule (once, then every OWNER_NOTE_REPEAT_DAYS).
      await this.d.inbox.post({ kind: 'resource_health', severity: severity(health.state), ...this.note(ref, health, now, false), refType: 'resource', refId: ref, gate: { subject: `resource:${ref}`, parts: [`state:${health.state}`] } });
    } else if (BAD.has(health.state) && !health.dismissedAt && this.d.inbox.postOnce && this.remindToday(health, now)) {
      await this.d.inbox.postOnce({ kind: 'resource_health_daily', severity: severity(health.state), ...this.note(ref, health, now, true), ...dailyRef(ref, kyivDay(now)), gate: { subject: `resource:${ref}`, parts: [`state:${health.state}`] } });
    } else if (health.state === 'ok' && prev && BAD.has(prev.state)) {
      await this.d.inbox.post({
        kind: 'resource_health_ok', severity: 'info', refType: 'resource', refId: ref, gate: { subject: `resource:${ref}`, parts: ['state:ok'] },
        title: `✅ ${ref}: connection works again`, body: `Was ${prev.state}${prev.since ? ` since ${fmtDay(prev.since)}` : ''}. Planning and publishing resume here.`,
        alert: { title: `✅ ${ref}: зʼєднання знову працює`, body: `Було ${prev.state}${prev.since ? ` з ${fmtDay(prev.since)}` : ''}. Планування й публікації тут відновлюються.` },
      });
    }
    return health;
  }

  private remindToday(h: ResourceHealth, now: Date): boolean {
    if (h.state === 'rate_limited') return false; // passes by itself
    if (h.since && kyivDay(new Date(h.since)) === kyivDay(now)) return false; // the change note went out today
    if (h.state !== 'token_expiring') return true;
    return !!h.expiresAt && Date.parse(h.expiresAt) - now.getTime() <= EXPIRING_REMIND_DAYS * DAY;
  }

  private note(ref: string, h: ResourceHealth, now: Date, reminder: boolean): { title: string; body: string; alert: { title: string; body: string } } {
    const days = h.since ? daysSince(h.since, now) : 0;
    const age = reminder && h.since ? ` (since ${fmtDay(h.since)}, ${days} d)` : '';
    const ageUk = reminder && h.since ? ` (з ${fmtDay(h.since)}, ${days} дн.)` : '';
    const blocking = BLOCKING_STATES.has(h.state);
    const effect = blocking
      ? 'Until then the planner schedules no posts here and planned slots are skipped.'
      : h.state === 'token_expiring' ? 'Reconnect before it expires, or posts here stop.' : 'Publishing may be delayed.';
    const effectUk = blocking
      ? 'До того планувальник не ставить сюди пости, а заплановані слоти пропускаються.'
      : h.state === 'token_expiring' ? 'Перепідключіть до закінчення терміну, інакше пости тут зупиняться.' : 'Публікації можуть затримуватися.';
    const mute = reminder ? '\nMute these reminders on the agent page.' : '';
    return {
      title: `⚠️ ${ref}: ${h.state}${age}`,
      body: `${h.detail ?? ''}\nReconnect it in /app/connections. ${effect}${mute}`,
      alert: { title: `⚠️ ${ref}: ${h.state}${ageUk}`, body: `${h.detail ?? ''}\nПерепідключіть у /app/connections. ${effectUk}` },
    };
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

  /**
   * Spec 049 FR-002: why a slot on this resource cannot publish now (`resource_unavailable: …`), or null. A stored
   * blocking state older than RECHECK_MS is checked again first, so a reconnect counts at once.
   */
  async blocked(ref: string): Promise<string | null> {
    let h = (await this.d.profiles.get(ref))?.health ?? null;
    if (!h || !BLOCKING_STATES.has(h.state)) return null;
    if (this.now().getTime() - Date.parse(h.checkedAt) > RECHECK_MS) {
      try { h = await this.check(ref); } catch { /* keep the stored state */ }
      if (!BLOCKING_STATES.has(h.state)) return null;
    }
    return `${UNAVAILABLE_ERROR}: ${h.state}${h.detail ? ` — ${h.detail}` : ''}`.slice(0, 500);
  }

  /** The owner mutes the daily reminders of a broken resource (until its state changes). False when it is not broken. */
  dismiss(ref: string): Promise<boolean> {
    return dismissHealth(this.d.profiles, ref, this.now());
  }
}

/** See `ResourceHealthService.dismiss` (also used by the agents API, which is built before the platform services). */
export async function dismissHealth(profiles: Pick<ResourceProfilesRepository, 'setHealth' | 'get'>, ref: string, now: Date): Promise<boolean> {
  const h = (await profiles.get(ref))?.health ?? null;
  if (!h || !BAD.has(h.state)) return false;
  await profiles.setHealth(ref, { ...h, dismissedAt: now.toISOString() });
  return true;
}

function severity(state: HealthState): 'action' | 'critical' {
  return state === 'token_expiring' || state === 'rate_limited' ? 'action' : 'critical';
}
