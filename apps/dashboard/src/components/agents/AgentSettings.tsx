// Settings > General leaf of /app/agents/$handle (spec 078 D6, `?tab=settings`): the sections that used to fill the Overview and are
// rarely changed — the agent's profile (with Edit), an orchestrator's resource (health + profile, spec 018), its formatting per
// resource (spec 024) and how its sources behaved (spec 049). Every section but the profile is an orchestrator's, so a role agent,
// @manager, the builder and the sysadmin see their profile only.

import type { AgentDetail } from '../../api/agents';
import { AgentProfileCard } from './AgentOverview';
import { ResourceSection } from './ResourceProfile';
import { FormattingSection } from './ResourceFormatting';
import { SourcesSection } from './SourcesSection';

export function AgentSettings({ data }: { data: AgentDetail }) {
  const a = data.agent;
  const orchestrator = a.kind === 'orchestrator' && !!a.scopeId;
  return (
    <div>
      <AgentProfileCard data={data} />
      <div style={{ height: 16 }} />
      {orchestrator && <ResourceSection handle={a.handle} />}
      {orchestrator && <FormattingSection handle={a.handle} />}
      {orchestrator && a.scopeId?.startsWith('telegram:') && <SourcesSection handle={a.handle} />}
    </div>
  );
}
