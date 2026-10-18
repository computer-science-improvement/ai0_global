// Memory (read-only) and History (runs with a `before` cursor) tabs of
// /app/agents/$handle.

import { Link } from '@tanstack/react-router';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { CompactCard } from '../ui/CompactCard';
import { Icon } from '../ui/Icon';
import { describeError, toast } from '../ui/Toast';
import { useConfirm } from '../ui/ConfirmDialog';
import { useQueryClient } from '@tanstack/react-query';
import { useRetireEditorMemory } from '../../api/editor';
import { RUN_TONE, fmtDuration, fmtUsd } from '../editor/EditorUi';
import { fmtDate } from '../../lib/format';
import { useAgentConfigConflicts, useAgentMemory, useAgentRuns, type AgentDetail, type AgentMemoryEntry } from '../../api/agents';

const KIND_TONE: Record<AgentMemoryEntry['kind'], 'accent' | 'warning' | 'neutral'> = { rule: 'accent', avoid: 'warning', insight: 'neutral' };

/** Spec 040 FR-011: the playbook / profiles against the owner's rules; @ai0 aligns them with one card. */
function ConfigConflicts({ handle }: { handle: string }) {
  const q = useAgentConfigConflicts(handle);
  const list = q.data?.conflicts ?? [];
  if (!list.length) return null;
  return (
    <div className="callout-warning" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        The playbook or a profile contradicts your rules · {list.length}
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
        {list.map((c, i) => <li key={i} className="text-body-sm" style={{ overflowWrap: 'anywhere' }}>{c.detail}</li>)}
      </ul>
      <div className="text-micro" style={{ marginTop: 8, color: 'var(--color-ink-muted)' }}>
        Ask in the chat: “@ai0 fix config conflicts for @{q.data?.handle ?? handle}” — one card aligns them.
      </div>
    </div>
  );
}

const LINT_LABEL: Record<string, string> = {
  pointer_only: 'Points at other text', too_vague: 'Too vague', meta_request: 'A request, not a rule', unknown_skill: 'Unknown skill', unknown_agent: 'Unknown agent',
};

/** Spec 047 FR-004: retire an owner rule the lint flags (soft delete; the row stays in the history). */
function RetireRule({ channelKey, entry, handle, onDone }: { channelKey: string; entry: AgentMemoryEntry; handle: string; onDone: () => void }) {
  const confirm = useConfirm();
  const qc = useQueryClient();
  const retire = useRetireEditorMemory(channelKey);
  const onClick = async () => {
    if (!(await confirm(`retire rule #${entry.id}`, { confirmLabel: 'Retire' }))) return;
    retire.mutate(entry.id, {
      onSuccess: () => { qc.invalidateQueries({ queryKey: ['agents', 'memory', handle] }); toast.success(`Rule #${entry.id} retired`); onDone(); },
      onError: (e) => toast.error(describeError(e)),
    });
  };
  return (
    <button type="button" className="btn-secondary" disabled={retire.isPending} onClick={onClick} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Icon name="trash" size={14} /> Retire rule
    </button>
  );
}

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
      <ConfigConflicts handle={data.agent.handle} />
      {memory.some((m) => m.lint?.length) && (
        <div className="callout-warning" style={{ marginBottom: 12 }}>
          {memory.filter((m) => m.lint?.length).length} owner rule{memory.filter((m) => m.lint?.length).length === 1 ? '' : 's'} need fixing — the agent cannot follow them as written. Open one to see why and retire it; then tell the agent the rule itself.
        </div>
      )}
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!q.data && !q.error && <div className="panel" style={{ height: 80, opacity: 0.5 }} />}
      {q.data && memory.length === 0 && (
        <EmptyState icon="bots" title="No memory yet"
          note={key ? 'Owner rules and the reviewer’s weekly insights for this resource appear here.' : 'Memory is kept per Telegram resource; this agent has none.'} />
      )}
      {memory.length > 0 && (
        <div className="compact-grid">
          {memory.map((m, i) => {
            const who = m.createdBy === 'owner' ? 'owner' : 'reviewer';
            const badges = (
              <>
                <Badge tone={KIND_TONE[m.kind]}>{m.kind}</Badge>
                <Badge tone={m.createdBy === 'owner' ? 'success' : 'neutral'} title={m.createdBy === 'owner' ? 'Written by you' : 'Learned by the weekly reviewer'}>{who}</Badge>
                {m.lint?.length ? <Badge tone="danger" title={m.lint.map((x) => x.detail).join('; ')}>needs fixing</Badge> : null}
              </>
            );
            return (
              <CompactCard key={m.id} delay={Math.min(i, 12) * 25} hint="Open the memory entry"
                top={badges}
                meta={<span className="tabular-nums">{fmtDate(m.createdAt)}</span>}
                body={m.text}
                note={m.lint?.length ? m.lint.map((x) => LINT_LABEL[x.code] ?? x.code).join(' · ') : undefined}
                dialog={{
                  size: 'md', icon: 'bots', title: `Memory ${m.kind}`, subtitle: `${who} · ${fmtDate(m.createdAt)}`,
                  body: () => (
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>{badges}</div>
                      <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55 }}>{m.text}</div>
                      {m.lint?.length ? (
                        <div className="callout-danger" style={{ marginTop: 12 }}>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>The agent cannot follow this rule as written</div>
                          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 2 }}>
                            {m.lint.map((x, j) => <li key={j} className="text-body-sm"><strong>{LINT_LABEL[x.code] ?? x.code}:</strong> {x.detail}</li>)}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ),
                  actions: key ? (close) => (
                    <>
                    {m.lint?.length ? <RetireRule channelKey={key} entry={m} handle={data.agent.handle} onDone={close} /> : null}
                    <Link to="/app/editor/$channel" params={{ channel: key }} className="btn-secondary" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Icon name="pencil" size={14} /> Manage memory
                    </Link>
                    </>
                  ) : undefined,
                }} />
            );
          })}
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
