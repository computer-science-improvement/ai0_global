// Spec 078 B1: Today's "Agents" panel: one row per channel agent with its mode switch (off / shadow / in approval / live;
// live asks for confirmation in the autonomy dialog), the runs and the spend of today. The system agents (manager, builder,
// auditor) are the footer. Names and emoji come from the agent tree when it matches the channel, else the channel title.

import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Button } from '../ui/Button';
import { AgentGlyph } from '../agents/AgentsUi';
import { ModeSwitch } from '../editor/EditorUi';
import { useAgentTree } from '../../api/agents';
import { fmtRelative } from '../../lib/format';
import { fmtUsd } from '../../lib/spend';
import { orchestratorsByChannel, systemAgents } from '../../lib/today';
import type { TodayDay } from './useTodayDay';
import './today.css';

export function AgentsPanel({ day, delay }: { day: TodayDay; delay?: number }) {
  const tree = useAgentTree();
  const orchestrators = useMemo(() => orchestratorsByChannel(tree.data?.agents), [tree.data]);
  const system = useMemo(() => systemAgents(tree.data?.agents), [tree.data]);
  const channels = day.channels ?? [];

  const action = <Link to="/app/agents" className="panel-link">Open agents →</Link>;

  return (
    <SectionCard title="Agents" flush delay={delay} action={action}>
      {day.channelsQ.isError && !day.channelsQ.data ? (
        <EmptyState icon="warning" title="The agents could not be loaded" note="The server did not answer. The rest of the page still works."
          action={<Button type="button" variant="secondary" size="sm" onClick={() => { void day.channelsQ.refetch(); }}>Try again</Button>} />
      ) : day.channelsQ.isLoading ? (
        <p className="text-caption ink-muted" role="status" style={{ margin: 0, padding: '28px 20px', textAlign: 'center' }}>Loading agents…</p>
      ) : channels.length === 0 ? (
        <EmptyState icon="agents" title="No channel agents yet" note="A channel gets an agent when you set it up. Until then nothing is planned or posted for it."
          action={<Link to="/app/setup" className="btn-secondary btn-sm">Set up a channel</Link>} />
      ) : (
        channels.map((c) => {
          const agent = orchestrators.get(c.channelKey);
          const name = agent?.name || c.title || c.channelKey;
          return (
            <div className="panel-row agent-row" key={c.channelKey}>
              <AgentGlyph agent={{ emoji: agent?.emoji ?? null, kind: 'orchestrator' }} size={32} />
              <div className="agent-id">
                {agent
                  ? <Link to="/app/agents/$handle" params={{ handle: agent.handle }} className="agent-name" title={name}>{name}</Link>
                  : <Link to="/app/editor/$channel" params={{ channel: c.channelKey }} className="agent-name" title={name}>{name}</Link>}
                <span className="mono agent-handle" title={c.channelKey}>{c.channelKey}</span>
              </div>
              <div className="agent-switch" role="group" aria-label={`Mode of ${name}`}>
                <ModeSwitch channelKey={c.channelKey} mode={c.mode} title={name} />
              </div>
              <div className="agent-stats">
                <span className="agent-stat tabular-nums"><span className="mono">{c.today.runs}</span> {c.today.runs === 1 ? 'run' : 'runs'}</span>
                <span className="agent-stat tabular-nums mono" title="Spend today">{fmtUsd(c.today.spendUsd)}</span>
              </div>
            </div>
          );
        })
      )}

      {day.editorOff && (
        <div className="panel-foot text-micro ink-muted">
          The editor is switched off on the server, so a mode change has no effect until it is on.
        </div>
      )}

      {system.length > 0 && (
        <div className="panel-foot agent-system">
          {system.map((a) => (
            <Link key={a.id} to="/app/agents/$handle" params={{ handle: a.handle }} className="agent-sys text-micro">
              <AgentGlyph agent={a} size={22} />
              <span className="agent-sys-name">{a.name}</span>
              <span className="agent-sys-meta">
                {a.activity.lastRunAt ? `ran ${fmtRelative(a.activity.lastRunAt)}` : 'has not run yet'} · <span className="mono">{fmtUsd(a.activity.spentTodayUsd)}</span> today
              </span>
            </Link>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
