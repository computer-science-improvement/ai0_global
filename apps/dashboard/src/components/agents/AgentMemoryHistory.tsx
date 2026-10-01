// Memory (read-only) and History (runs with a `before` cursor) tabs of
// /app/agents/$handle.

import { Link } from '@tanstack/react-router';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { describeError } from '../ui/Toast';
import { RUN_TONE, fmtDuration, fmtUsd } from '../editor/EditorUi';
import { fmtDate } from '../../lib/format';
import { useAgentMemory, useAgentRuns, type AgentDetail, type AgentMemoryEntry } from '../../api/agents';

const KIND_TONE: Record<AgentMemoryEntry['kind'], 'accent' | 'warning' | 'neutral'> = { rule: 'accent', avoid: 'warning', insight: 'neutral' };

export function AgentMemory({ data }: { data: AgentDetail }) {
  const q = useAgentMemory(data.agent.handle);
  const key = q.data?.channelKey ?? data.channelKey;
  const memory = q.data?.memory ?? [];
  return (
    <SectionCard title={`Memory${q.data ? ` · ${memory.length}` : ''}`} icon="bots" delay={0}
      action={key ? (
        <Link to="/app/editor/$channel" params={{ channel: key }} className="btn-tiny" style={{ textDecoration: 'none', gap: 6 }}>
          <Icon name="pencil" size={12} /> Manage memory
        </Link>
      ) : undefined}>
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!q.data && !q.error && <div className="panel" style={{ height: 80, opacity: 0.5 }} />}
      {q.data && memory.length === 0 && (
        <EmptyState icon="bots" title="No memory yet"
          note={key ? 'Owner rules and the reviewer’s weekly insights for this resource appear here.' : 'Memory is kept per Telegram resource; this agent has none.'} />
      )}
      {memory.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {memory.map((m, i) => (
            <div key={m.id} className="card compose-rise" style={{ padding: '10px 14px', animationDelay: `${Math.min(i, 12) * 25}ms` }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                <Badge tone={KIND_TONE[m.kind]}>{m.kind}</Badge>
                <Badge tone={m.createdBy === 'owner' ? 'success' : 'neutral'} title={m.createdBy === 'owner' ? 'Written by you' : 'Learned by the weekly reviewer'}>
                  {m.createdBy === 'owner' ? 'owner' : 'reviewer'}
                </Badge>
                <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)', marginLeft: 'auto' }}>{fmtDate(m.createdAt)}</span>
              </div>
              <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text}</div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

export function AgentHistory({ data }: { data: AgentDetail }) {
  const q = useAgentRuns(data.agent.handle);
  const runs = q.data?.pages.flatMap((p) => p.runs) ?? [];
  const showAgent = data.children.length > 0;
  const handleOf = new Map([[data.agent.id, data.agent.handle], ...data.children.map((c) => [c.id, c.handle] as [string, string])]);

  return (
    <SectionCard title="Run history" icon="history" delay={0}
      action={showAgent ? <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>includes the role agents</span> : undefined}>
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!q.data && !q.error && <div className="panel" style={{ height: 80, opacity: 0.5 }} />}
      {q.data && runs.length === 0 && <EmptyState icon="logs" title="No runs yet" note="Runs appear here after the agent’s first scheduled run or “Run now”." />}
      {runs.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th>Started</th>
              <th>Role</th>
              <th>Status</th>
              <th className="num">Steps</th>
              <th className="num">Cost</th>
              <th className="num">Duration</th>
              <th>Error</th>
              <th style={{ textAlign: 'right' }}>Trace</th>
            </tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="tabular-nums" style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.startedAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.role}
                    {showAgent && r.agentId && handleOf.get(r.agentId) && r.agentId !== data.agent.id && (
                      <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>@{handleOf.get(r.agentId)}</div>
                    )}
                  </td>
                  <td><Badge tone={RUN_TONE[r.status]}>{r.status}</Badge></td>
                  <td className="num">{r.steps}</td>
                  <td className="num">{fmtUsd(r.costUsd)}</td>
                  <td className="num">{fmtDuration(r.startedAt, r.finishedAt)}</td>
                  <td className="text-micro" style={{ color: 'var(--color-danger)', maxWidth: 260 }} title={r.error ?? undefined}>
                    {r.error ? (r.error.length > 90 ? `${r.error.slice(0, 90)}…` : r.error) : <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Link to="/app/editor/run/$id" params={{ id: r.id }} className="btn-act" title="Open trace" aria-label="Open trace">
                      <Icon name="eye" size={14} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <button className="btn-secondary" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </SectionCard>
  );
}
