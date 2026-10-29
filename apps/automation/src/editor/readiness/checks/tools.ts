import type { Finding } from '../../sysadmin/audit.types';
import { mkFinding } from '../finding';
import type { ChannelFacts } from '../facts.types';
import type { DoctorCheck } from './index';

/**
 * Spec 072 FR-003.3, A29, I13: the read tools a source needs. A source the writer cannot read from is a series that skips
 * every slot (F28: the card's allowlist hid `query_data`). One finding per missing tool, however many sources need it.
 */

/** What a kind of source needs: any of `anyOf`, and the one tool a fix adds. */
export interface ToolNeed { anyOf: readonly string[]; add: string }

/** Replaced by 073's SOURCE_READ_TOOLS at merge (I13). The same "any of" idea: `search_library` reads a dataset as well as `query_data`. */
export const SOURCE_TOOLS: Readonly<Record<'library' | 'feed' | 'url' | 'api', ToolNeed>> = {
  library: { anyOf: ['query_data', 'search_library'], add: 'query_data' },
  feed:    { anyOf: ['fetch_feed', 'web_fetch'], add: 'fetch_feed' },
  url:     { anyOf: ['web_fetch'], add: 'web_fetch' },
  api:     { anyOf: ['fetch_api'], add: 'fetch_api' },
};

type NeedKind = keyof typeof SOURCE_TOOLS;

/** An allowlist with nothing in it is no limit (`intersectAllow`). */
const limit = (list: readonly string[] | null | undefined): readonly string[] | null => (list && list.length ? list : null);
const lacks = (list: readonly string[], need: ToolNeed) => !need.anyOf.some((t) => list.includes(t));

interface Needer { kind: NeedKind; what: string; series: boolean }

/** The active series and the card sources that read something through a tool. `free`, `network_highlights` and no source need none (A29). */
export function toolNeeders(f: Pick<ChannelFacts, 'series' | 'card'>): Needer[] {
  const out: Needer[] = [];
  for (const s of f.series) {
    if (s.active === false || !s.source) continue;
    if (s.source.kind === 'library') out.push({ kind: 'library', what: `series «${s.name}» (library:${s.source.table})`, series: true });
    else if (s.source.kind === 'feed') out.push({ kind: 'feed', what: `series «${s.name}» (a feed)`, series: true });
    else if (s.source.kind === 'api') out.push({ kind: 'api', what: `series «${s.name}» (api:${s.source.source})`, series: true });
  }
  for (const c of f.card.sources) {
    const kind: NeedKind = c.kind === 'rss' ? 'feed' : c.kind;
    out.push({ kind, what: `the card source ${c.kind}:${c.ref}`, series: false });
  }
  return out;
}

export const toolsCheck: DoctorCheck = {
  code: 'tools_missing_for_source',
  run(f: ChannelFacts): Finding[] {
    const effective = f.effectiveTools;
    if (effective === null) return [];

    // The tool each need would be fixed with, with everyone who needs it.
    const byTool = new Map<string, { need: ToolNeed; by: Needer[] }>();
    for (const n of toolNeeders(f)) {
      const need = SOURCE_TOOLS[n.kind];
      if (!lacks(effective, need)) continue;
      const slot = byTool.get(need.add) ?? { need, by: [] };
      slot.by.push(n);
      byTool.set(need.add, slot);
    }

    const out: Finding[] = [];
    const cardList = limit(f.card.toolsAllow);
    const loadout = limit(f.loadoutTools);
    for (const [tool, { need, by }] of byTool) {
      const cardIsCause = !!cardList && lacks(cardList, need);
      const loadoutIsCause = !!loadout && lacks(loadout, need);
      // Adding to the card list cannot help while the loadout holds the tool back as well.
      const fixable = cardIsCause && !loadoutIsCause;
      // The loadout may hold `search_library` but not `query_data`: the card must add one the intersection keeps.
      const addTool = !loadout || loadout.includes(tool) ? tool : need.anyOf.find((t) => loadout.includes(t)) ?? tool;
      const cause = loadoutIsCause ? 'the executor\'s loadout' : cardIsCause ? 'the card\'s tool list' : 'the tool list of the run';
      const needed = by.map((n) => n.what);
      out.push(mkFinding(f, {
        code: 'tools_missing_for_source',
        severity: by.some((n) => n.series) ? 'error' : 'warn',
        subject: { type: 'tool', id: tool, label: tool },
        detail: `${needed.join(', ')} ${needed.length > 1 ? 'need' : 'needs'} ${need.anyOf.length > 1 ? `${need.anyOf.join(' or ')}` : tool}, which the writer will not have: it is missing from ${cause}.`,
        evidence: { tool, any_of: need.anyOf, needed_by: needed, card_tools_allow: f.card.toolsAllow, loadout_tools: f.loadoutTools, effective_tools: effective },
        ...(fixable ? { fix: { kind: 'tools_allow_add' as const, channel: f.channelKey, tools: [addTool] } } : {}),
        ...(loadoutIsCause && f.agent ? { link: '/app/agents/:agent?tab=loadout' } : {}),
      }));
    }
    return out;
  },
};
