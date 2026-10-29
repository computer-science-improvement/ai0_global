import type { NetworkRepository } from '../network/network.repository';
import type { Series } from '../network/playbook';
import type { AgentsRepository } from './agents.repository';
import type { SeriesSourceFact } from './skill-warnings';

/**
 * Spec 073 FR-012: the series that must read a library, a feed or an API — active, `source_mode: required` — as the facts
 * `seriesSourceConflict` judges a skill against. A series with another source (or none) is not here: it may be replaced.
 */
export function seriesSourceFacts(series: readonly Series[]): SeriesSourceFact[] {
  const out: SeriesSourceFact[] = [];
  for (const s of series) {
    if (s.active === false || s.source_mode !== 'required' || !s.source) continue;
    const src = s.source;
    const ref = src.kind === 'library' ? src.table : src.kind === 'feed' ? src.ref : src.kind === 'api' ? src.source : null;
    if (!ref || (src.kind !== 'library' && src.kind !== 'feed' && src.kind !== 'api')) continue;
    out.push({ series: s.name, kind: src.kind, ref, format: s.format, brief: s.brief });
  }
  return out;
}

/**
 * The `SkillStore`'s `seriesSources` port: the required series sources in the active playbook of the agent's orchestrator (a
 * child agent's parent). No agent, no playbook or a failing read gives none.
 */
export function requiredSeriesSources(d: { agents: Pick<AgentsRepository, 'get'>; network: Pick<NetworkRepository, 'activePlaybook'> }) {
  return async (agentId: string): Promise<SeriesSourceFact[]> => {
    const a = await d.agents.get(agentId);
    if (!a) return [];
    const orch = a.parentId ? (await d.agents.get(a.parentId)) ?? a : a;
    const pb = await d.network.activePlaybook(orch.id);
    return seriesSourceFacts(pb?.body.series ?? []);
  };
}
