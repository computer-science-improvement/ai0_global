import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, StatTile, StatStrip, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { describeError } from '../components/ui/Toast';
import { fmtUsd } from '../components/editor/EditorUi';
import { AgentGlyph, FollowsBadge, KIND_LABEL, LastRun, ScopeChip, StateBadges, runsLabel } from '../components/agents/AgentsUi';
import { useAgentInbox, useAgentTree, type AgentNode } from '../api/agents';
import { MigrationBanner } from '../components/strategies/MigrationBanner';
import { NeedsYou } from '../components/nav/NeedsYou';
import '../components/agents-list/agents-list.css';
// The banner's classes live next to it, but a node test imports MigrationBanner (needsAttention), which cannot load CSS: the page imports it.
import '../components/strategies/migration.css';

export const Route = createFileRoute('/app/agents')({ component: AgentsPage });

function InboxButton() {
  const inbox = useAgentInbox(true);
  const unread = inbox.data?.items.length ?? 0;
  return (
    <Link to="/app/agents/inbox" className="btn-secondary">
      <Icon name="inbox" size={14} /> Inbox
      {unread > 0 && <Badge tone="accent">{unread}</Badge>}
    </Link>
  );
}

function AgentsPage() {
  const tree = useAgentTree();
  const all = tree.data?.agents ?? [];
  const system = all.filter((a) => a.kind === 'manager' || a.kind === 'builder' || a.kind === 'auditor');
  const orchestrators = all.filter((a) => a.kind !== 'manager' && a.kind !== 'builder' && a.kind !== 'auditor');
  const spend = all.reduce((s, a) => s + a.activity.spentTodayUsd + a.children.reduce((c, k) => c + k.activity.spentTodayUsd, 0), 0);
  const runs = all.reduce((s, a) => s + a.activity.runsToday + a.children.reduce((c, k) => c + k.activity.runsToday, 0), 0);
  const live = orchestrators.filter((a) => a.mode === 'live').length;
  const paused = orchestrators.filter((a) => a.paused).length;

  return (
    <div>
      <PageHeader
        eyebrow={tree.data ? `${live} live · ${paused} paused` : undefined}
        title="Agents"
        subtitle="Named agents per resource and network: profiles, skills, memory and run history"
        actions={<InboxButton />}
      />

      {/* What the menu counter of Agents counts: unread Inbox notes and directives waiting for a decision. */}
      <NeedsYou show={['inbox', 'directives']} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {tree.error && <div className="callout-danger">{describeError(tree.error)}</div>}
        {!tree.data && !tree.error && <div className="panel is-section agl-skeleton compose-rise" aria-hidden />}

        {tree.data && (
          <StatStrip label="Agents today">
            <StatTile label="Orchestrators" value={orchestrators.length} delta={`${live} live · ${orchestrators.length - live} not live`} />
            <StatTile label="Paused" value={paused} deltaTone={paused ? 'warning' : 'neutral'} delta={paused ? 'skipping their runs' : undefined} />
            <StatTile label="Runs today" value={runs} />
            <StatTile label="Spend today" value={fmtUsd(spend)} />
          </StatStrip>
        )}

        {/* Spec 023 phase B: /app/strategies redirects here; enabled legacy bindings are migrated or cut over here. */}
        <MigrationBanner />

        {tree.data && (
          <SectionCard title="Orchestrators" flush delay={80}>
            {orchestrators.length === 0
              ? <EmptyState icon="agents" title="No orchestrators yet" note="Agents are created from editor cards or in the chat with @ai0." />
              : orchestrators.map((a) => <OrchestratorRow key={a.id} a={a} />)}
          </SectionCard>
        )}

        {tree.data && system.length > 0 && (
          <SectionCard title="System agents" flush delay={120}>
            {system.map((a) => <SystemRow key={a.id} a={a} />)}
          </SectionCard>
        )}
      </div>
    </div>
  );
}

/** A system agent (manager, builder, sysadmin): the whole row opens its page. */
function SystemRow({ a }: { a: AgentNode }) {
  return (
    <Link to="/app/agents/$handle" params={{ handle: a.handle }} className="panel-row">
      <AgentGlyph agent={a} />
      <div className="agl-main">
        <div className="agl-title">
          <span className="agl-name">{a.name}</span>
          <span className="agl-handle mono">@{a.handle}</span>
          <StateBadges agent={a} />
        </div>
        <div className="agl-sub">
          <span>{KIND_LABEL[a.kind]} · system</span>
          <LastRun activity={a.activity} />
        </div>
        {a.description && <p className="agl-desc clamp">{a.description}</p>}
      </div>
      <div className="agl-num">
        <div className="agl-num-main mono">{fmtUsd(a.activity.spentTodayUsd)}</div>
        <div className="agl-num-sub">{runsLabel(a.activity.runsToday)} today</div>
      </div>
    </Link>
  );
}

function OrchestratorRow({ a }: { a: AgentNode }) {
  const [open, setOpen] = useState(false);
  const childSpend = a.children.reduce((s, c) => s + c.activity.spentTodayUsd, 0);
  const childRuns = a.children.reduce((s, c) => s + c.activity.runsToday, 0);
  return (
    <>
      <div className="panel-row">
        <AgentGlyph agent={a} />
        <div className="agl-main">
          <div className="agl-title">
            <Link to="/app/agents/$handle" params={{ handle: a.handle }} className="agl-name">{a.name}</Link>
            <span className="agl-handle mono">@{a.handle}</span>
            <StateBadges agent={a} />
          </div>
          <div className="agl-sub">
            <ScopeChip agent={a} />
            <LastRun activity={a.activity} />
            {a.children.length > 0 && <span className="mono">{a.children.length} role{a.children.length === 1 ? '' : 's'}</span>}
          </div>
        </div>
        <div className="agl-num">
          <div className="agl-num-main mono">{fmtUsd(a.activity.spentTodayUsd + childSpend)}</div>
          <div className="agl-num-sub">{runsLabel(a.activity.runsToday + childRuns)} today</div>
        </div>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          {a.children.length > 0 && (
            <button type="button" className="btn-act" aria-expanded={open} title={open ? 'Hide roles' : `Show roles (${a.children.length})`} aria-label={open ? 'Hide roles' : 'Show roles'} onClick={() => setOpen((v) => !v)}>
              <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
            </button>
          )}
          <Link to="/app/agents/$handle" params={{ handle: a.handle }} className="btn-act" title="Open agent" aria-label="Open agent">
            <Icon name="chevron-right" size={14} />
          </Link>
        </div>
      </div>
      {open && a.children.map((c) => <ChildRow key={c.id} c={c} parent={a} />)}
    </>
  );
}

function ChildRow({ c, parent }: { c: AgentNode; parent: AgentNode }) {
  return (
    <Link to="/app/agents/$handle" params={{ handle: c.handle }} className="panel-row agl-child anim-fade-up">
      <AgentGlyph agent={c} size={28} />
      <div className="agl-main">
        <div className="agl-title">
          <span className="agl-name">{KIND_LABEL[c.kind]}</span>
          <span className="agl-handle mono">@{c.handle}</span>
          <FollowsBadge agent={c} parent={{ handle: parent.handle, mode: parent.effectiveMode ?? parent.mode }} />
          {c.paused && <Badge tone="danger">paused</Badge>}
        </div>
        <div className="agl-sub"><LastRun activity={c.activity} /></div>
      </div>
      <div className="agl-num">
        <div className="agl-num-main mono">{fmtUsd(c.activity.spentTodayUsd)}</div>
        <div className="agl-num-sub">{runsLabel(c.activity.runsToday)} today</div>
      </div>
    </Link>
  );
}
