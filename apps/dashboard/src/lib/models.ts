// Pure helpers of the Models page (spec 035) — node tests import this file, so
// only type imports here.
import type { AgentModelRow, CatalogModel, ModelSource } from '../api/models';

/** "$0.15" / "$12" per 1M tokens; "—" when unknown. */
export function fmtPerM(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return 'free';
  const s = n.toFixed(n >= 1 ? 2 : 4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return `$${s}`;
}

/** "200K" / "1M" context window; "" when unknown. */
export function fmtContext(n: number | null | undefined): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}

export const SOURCE_LABEL: Record<ModelSource, string> = { agent: 'Agent', channel: 'Channel', env: 'Env', default: 'Default' };
export const SOURCE_TONE: Record<ModelSource, 'accent' | 'warning' | 'neutral'> = { agent: 'accent', channel: 'warning', env: 'warning', default: 'neutral' };
export const SOURCE_HINT: Record<ModelSource, string> = {
  agent:   "the agent's own model",
  channel: "the channel card's legacy override",
  env:     'an EDITOR_MODEL_* environment variable on the server',
  default: 'the default model',
};

/**
 * Search the catalog: every whitespace-separated term must match the id or the
 * name; id-prefix matches first, then the catalog order. Empty query → all.
 */
export function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return models;
  const hit = models.filter((m) => {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const q = terms[0];
  const rank = (m: CatalogModel) => {
    const id = m.id.toLowerCase();
    return id.startsWith(q) || id.split('/')[1]?.startsWith(q) ? 0 : 1;
  };
  return hit.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
}

/** Agent rows grouped for the table: system agents first, each orchestrator followed by its role children. */
export interface AgentGroup { root: AgentModelRow; children: AgentModelRow[] }

export function groupAgents(rows: AgentModelRow[]): AgentGroup[] {
  const ids = new Set(rows.map((r) => r.id));
  const groups: AgentGroup[] = [];
  const byId = new Map<string, AgentGroup>();
  for (const r of rows) {
    if (r.parentId && ids.has(r.parentId)) continue;
    const g = { root: r, children: [] as AgentModelRow[] };
    groups.push(g);
    byId.set(r.id, g);
  }
  for (const r of rows) if (r.parentId && byId.has(r.parentId)) byId.get(r.parentId)!.children.push(r);
  return groups;
}

/** How many agents have their own model / own effort (bulk reset preview). */
export function ownCounts(rows: AgentModelRow[]): { models: number; efforts: number } {
  return { models: rows.filter((r) => r.model).length, efforts: rows.filter((r) => r.reasoningEffort).length };
}
