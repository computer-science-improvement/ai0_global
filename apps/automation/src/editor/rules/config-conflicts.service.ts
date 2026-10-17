import { resourceRef, telegramKeyOf, type Agent } from '../agents/agent.types';
import { profileCaps, type ResourceProfilesRepository } from '../agents/resource-profile';
import type { NetworkRepository } from '../network/network.repository';
import type { EditorChannelsRepository } from '../repo/editor-channels.repository';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { configConflicts, patchPlaybook, type ConfigConflict, type ResourceConfig } from './config-conflicts';

export interface ConfigConflictsDeps {
  memory:   Pick<EditorMemoryRepository, 'listActive'>;
  network:  Pick<NetworkRepository, 'groupOfChannel' | 'groupResources' | 'activePlaybook' | 'applyOwnerPatch'>;
  channels: Pick<EditorChannelsRepository, 'get' | 'setHashtagMin'>;
  profiles: Pick<ResourceProfilesRepository, 'get' | 'setProfile' | 'patchFormat'>;
}

/**
 * Spec 040 FR-011: reads an orchestrator's owner rules, resources, profiles and active playbook and runs
 * `configConflicts` on them. Read on demand (agent page, manager digest, after a rule is stored), so it is never stale;
 * `apply` is the owner's `fix_config_conflicts` card.
 */
export class ConfigConflictsService {
  constructor(private readonly d: ConfigConflictsDeps) {}

  async forAgent(orch: Agent): Promise<ConfigConflict[]> {
    const key = telegramKeyOf(orch);
    if (!key) return [];
    const rules = (await this.d.memory.listActive(key, 60)).filter((m) => m.createdBy === 'owner').map((m) => ({ id: m.id, text: m.text }));
    const group = await this.d.network.groupOfChannel(key);
    const refs = group ? (await this.d.network.groupResources(group.id)).map((r) => r.ref) : [resourceRef('telegram', key)];
    const anchor = resourceRef('telegram', key);
    if (!refs.includes(anchor)) refs.unshift(anchor);
    const card = await this.d.channels.get(key);
    const resources: ResourceConfig[] = [];
    for (const ref of refs) {
      const profile = (await this.d.profiles.get(ref).catch(() => null))?.profile ?? null;
      const prefs = (profile?.format_prefs ?? {}) as Record<string, any>;
      resources.push(ref === anchor && card
        ? { ref, style: card.style ?? null, slang: card.slang === true, pollsPerWeek: card.pollsPerWeek ?? null, profile, vocabulary: card.hashtags, hashtagMin: card.hashtagMin }
        : { ref, style: prefs.style ?? null, slang: prefs.slang === true, pollsPerWeek: profileCaps(profile).pollsPerWeek, profile });
    }
    const pb = await this.d.network.activePlaybook(orch.id);
    return configConflicts({ rules, playbook: pb?.body ?? null, resources });
  }

  /** Apply every current fix (recomputed now, so the card never writes a stale change). */
  async apply(orch: Agent): Promise<{ applied: string[]; playbook_version: number | null; remaining: ConfigConflict[] }> {
    const conflicts = await this.forAgent(orch);
    const applied: string[] = [];
    let version: number | null = null;
    const fixes = conflicts.map((c) => c.fix);
    if (fixes.some((f) => f.target === 'playbook')) {
      const r = await this.d.network.applyOwnerPatch(orch.id, (pb) => patchPlaybook(pb, fixes), 'Owner rules: config conflicts fixed from the @ai0 card');
      if (!('error' in r) && !r.noop) { version = r.row.version; applied.push(...conflicts.filter((c) => c.fix.target === 'playbook').map((c) => c.code)); }
    }
    for (const c of conflicts) {
      const f = c.fix;
      if (f.target === 'card') {
        if (await this.d.channels.setHashtagMin(f.channelKey, 0)) applied.push(c.code);
        continue;
      }
      if (f.target !== 'profile') continue;
      if (f.op === 'style') {
        const r = await this.d.profiles.patchFormat(f.ref, { style: f.style, ...(f.slang === false ? { slang: false } : {}) }, { by: 'owner', reason: 'owner rules: written into the style' });
        if ('ok' in r) applied.push(c.code);
      } else if (f.op === 'hashtags_off') {
        const r = await this.d.profiles.patchFormat(f.ref, { hashtags: null }, { by: 'owner', reason: 'owner rules: hashtags off' });
        if ('ok' in r) applied.push(c.code);
      } else if (f.op === 'tone' && f.field === 'format_prefs.tone') {
        const r = await this.d.profiles.patchFormat(f.ref, { tone: f.tone || null }, { by: 'owner', reason: 'owner rules: no slang' });
        if ('ok' in r) applied.push(c.code);
      } else {
        const stored = (await this.d.profiles.get(f.ref))?.profile;
        if (!stored) continue;
        const next = f.op === 'tone' ? { ...stored, tone: f.tone || undefined } : { ...stored, audience: { ...stored.audience, who: f.who } };
        await this.d.profiles.setProfile(f.ref, next, 'owner', { reason: `owner rules: ${c.code}` });
        applied.push(c.code);
      }
    }
    return { applied, playbook_version: version, remaining: await this.forAgent(orch) };
  }
}
