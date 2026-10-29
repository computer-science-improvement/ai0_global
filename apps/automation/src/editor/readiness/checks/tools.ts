import type { Finding } from '../../sysadmin/audit.types';
import { mkFinding } from '../finding';
import type { ChannelFacts } from '../facts.types';
import { SOURCE_READ_TOOLS } from '../slot-config';
import type { DoctorCheck } from './index';

/**
 * Spec 072 FR-003.3, A29, I13: the read tools a source needs. A source the writer cannot read from is a series that skips
 * every slot (F28: the card's allowlist hid `query_data`). One finding per missing tool, however many sources need it.
 */

/** What a kind of source needs: any of `anyOf`, and the one tool a fix adds. */
export interface ToolNeed { anyOf: readonly string[]; add: string }

/**
 * I13: the "any of" lists are 073's `SOURCE_READ_TOOLS` (the one map the runner's `config_tools_missing` reads too); this file
 * only adds the tool a fix allows. A card `url` source is a page: it is read with `web_fetch` alone (the map has no page kind).
 */
export const SOURCE_TOOLS: Readonly<Record<'library' | 'feed' | 'url' | 'api' | 'network_highlights', ToolNeed>> = {
  library:            { anyOf: SOURCE_READ_TOOLS.library, add: 'query_data' },
  feed:               { anyOf: SOURCE_READ_TOOLS.feed, add: 'fetch_feed' },
  url:                { anyOf: ['web_fetch'], add: 'web_fetch' },
  api:                { anyOf: SOURCE_READ_TOOLS.api, add: 'fetch_api' },
  network_highlights: { anyOf: SOURCE_READ_TOOLS.network_highlights, add: 'get_network_highlights' },
};

type NeedKind = keyof typeof SOURCE_TOOLS;

/** An allowlist with nothing in it is no limit (`intersectAllow`). */
const limit = (list: readonly string[] | null | undefined): readonly string[] | null => (list && list.length ? list : null);
const lacks = (list: readonly string[], need: ToolNeed) => !need.anyOf.some((t) => list.includes(t));

interface Needer { kind: NeedKind; what: string; series: boolean }

/**
 * The active series and the card sources that read something through a tool. `free` and no source need none (A29); a
 * `network_highlights` series needs its read tool, as 073's `config_tools_missing` says at run time (A29, at the merge).
 */
export function toolNeeders(f: Pick<ChannelFacts, 'series' | 'card'>): Needer[] {
  const out: Needer[] = [];
  for (const s of f.series) {
    if (s.active === false || !s.source) continue;
    if (s.source.kind === 'library') out.push({ kind: 'library', what: `series «${s.name}» (library:${s.source.table})`, series: true });
    else if (s.source.kind === 'feed') out.push({ kind: 'feed', what: `series «${s.name}» (a feed)`, series: true });
    else if (s.source.kind === 'api') out.push({ kind: 'api', what: `series «${s.name}» (api:${s.source.source})`, series: true });
    else if (s.source.kind === 'network_highlights') out.push({ kind: 'network_highlights', what: `series «${s.name}» (network highlights)`, series: true });
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
