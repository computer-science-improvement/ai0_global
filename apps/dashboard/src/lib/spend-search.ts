// URL state of the Spend page (/app/spend, spec 029 FR-010). Pure, so node:test covers it.

export const SPEND_TABS = ['report', 'prices', 'budgets'] as const;
export type SpendTab = typeof SPEND_TABS[number];
const RANGES = ['today', '7d', '30d', 'mtd'] as const;
const GROUPS = ['day', 'agent', 'role', 'resource', 'provider', 'model', 'feature', 'run'] as const;
const STACKS = ['provider', 'feature'] as const;
const PROVIDERS = ['openrouter', 'anthropic', 'openai', 'perplexity', 'xai', 'agent_sdk', 'tool'] as const;

export interface SpendSearch {
  tab?:      SpendTab;
  range?:    typeof RANGES[number];
  from?:     string;
  to?:       string;
  groupBy?:  typeof GROUPS[number];
  stackBy?:  typeof STACKS[number];
  agent?:    string;
  feature?:  string;
  provider?: typeof PROVIDERS[number];
  shadow?:   boolean;
}

const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

/** Unknown or malformed values are dropped, so a bad link falls back to the defaults. */
export function parseSpendSearch(s: Record<string, unknown>): SpendSearch {
  const from = day(s.from);
  const to = day(s.to);
  const agent = typeof s.agent === 'string' && (s.agent === 'none' || /^[0-9a-f-]{36}$/i.test(s.agent)) ? s.agent : undefined;
  const feature = typeof s.feature === 'string' && /^[a-z0-9_.-]{1,80}$/.test(s.feature) ? s.feature : undefined;
  return {
    tab: pick(SPEND_TABS, s.tab),
    range: pick(RANGES, s.range),
    from: from && to ? from : undefined,
    to: from && to ? to : undefined,
    groupBy: pick(GROUPS, s.groupBy),
    stackBy: pick(STACKS, s.stackBy),
    agent,
    feature,
    provider: pick(PROVIDERS, s.provider),
    shadow: s.shadow === true || s.shadow === 'true' || s.shadow === '1' || s.shadow === 1 ? true : undefined,
  };
}
