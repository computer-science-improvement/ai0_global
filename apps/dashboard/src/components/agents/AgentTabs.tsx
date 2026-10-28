// The tab bar of /app/agents/$handle (spec 078 D6): five section tabs (Overview, Content, Brain, Activity, Settings) as an
// underlined row, and under it a second row with the leaves of a group that has several. `?tab=` stays the leaf (lib/agent-tabs.ts),
// so the group is derived from it; a click on a group opens its first leaf.

import { SegmentedTabs } from '../SegmentedTabs';
import { GROUP_LABEL, TAB_LABEL, firstLeaf, groupOf, visibleGroups, visibleLeaves, type AgentGroup, type AgentTab, type TabContext } from '../../lib/agent-tabs';

export function AgentTabs({ tab, ctx, onChange }: { tab: AgentTab; ctx: TabContext; onChange: (t: AgentTab) => void }) {
  const group = groupOf(tab);
  const leaves = visibleLeaves(group, ctx);
  return (
    <div className="agent-tabs">
      <SegmentedTabs<AgentGroup> variant="underline" ariaLabel="Agent sections" value={group}
        options={visibleGroups(ctx).map((g) => ({ key: g, label: GROUP_LABEL[g] }))}
        onChange={(g) => { if (g !== group) onChange(firstLeaf(g, ctx)); }} />
      {leaves.length > 1 && (
        <div className="agent-subtabs">
          <SegmentedTabs<AgentTab> size="sm" ariaLabel={`${GROUP_LABEL[group]} sections`} value={tab}
            options={leaves.map((t) => ({ key: t, label: TAB_LABEL[t] }))} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
