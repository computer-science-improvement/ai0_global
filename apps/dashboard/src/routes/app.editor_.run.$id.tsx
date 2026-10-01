import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, StatTile, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { describeError } from '../components/ui/Toast';
import { JsonBlock, RUN_TONE, fmtDuration, fmtUsd } from '../components/editor/EditorUi';
import { useEditorRun } from '../api/editor';
import { fmtDate } from '../lib/format';
import type { EditorRunStep } from '../api/types';

export const Route = createFileRoute('/app/editor_/run/$id')({ component: EditorRunPage });

/** Run trace viewer (spec 006 T009): every LLM turn and tool call with args, result, tokens and $. */
function EditorRunPage() {
  const { id } = Route.useParams();
  const q = useEditorRun(id);

  if (q.error) return <div className="callout-danger">{describeError(q.error)}</div>;
  if (!q.data) return <div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} />;
  const { run, steps } = q.data;
  const toolCalls = steps.filter((s) => s.type === 'tool');

  return (
    <div>
      <div className="text-micro" style={{ marginBottom: 10, display: 'flex', gap: 12 }}>
        {run.channelKey
          ? <Link to="/app/editor/$channel" params={{ channel: run.channelKey }} className="link-accent">← {run.channelKey}</Link>
          : <Link to="/app/editor" className="link-accent">← Editor</Link>}
        {run.slotId && <Link to="/app/editor/slot/$id" params={{ id: run.slotId }} className="link-accent">slot</Link>}
      </div>
      <PageHeader title={`${run.role} run`} subtitle={`${fmtDate(run.startedAt)} · ${run.model}`} />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>
        {run.error && <span className="text-micro" style={{ color: 'var(--color-danger)' }}>{run.error}</span>}
      </div>

      <div className="stat-grid compose-rise" style={{ marginBottom: 18 }}>
        <StatTile label="Steps" value={run.steps} icon="logs" delta={`${toolCalls.length} tool calls · ${toolCalls.filter((s) => s.isError).length} errors`} />
        <StatTile label="Tokens" value={(run.promptTokens + run.completionTokens).toLocaleString()} icon="analytics" delta={`${run.promptTokens.toLocaleString()} in · ${run.completionTokens.toLocaleString()} out`} />
        <StatTile label="Cost" value={fmtUsd(run.costUsd)} icon="analytics" accent />
        <StatTile label="Duration" value={fmtDuration(run.startedAt, run.finishedAt)} icon="calendar" />
      </div>

      <SectionCard title="Trace" icon="logs" delay={40}>
        {steps.length === 0
          ? <EmptyState icon="logs" title="No steps recorded" />
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {steps.map((s) => <StepRow key={s.id} step={s} />)}
            </div>}
      </SectionCard>
    </div>
  );
}

function StepRow({ step }: { step: EditorRunStep }) {
  const [open, setOpen] = useState(step.isError);
  const tokens = (step.promptTokens ?? 0) + (step.completionTokens ?? 0);
  const llmText = step.type === 'llm' ? (step.output as { content?: string | null; toolCalls?: Array<{ name: string }> } | null) : null;
  const summary = step.type === 'llm'
    ? (llmText?.toolCalls?.length ? `→ ${llmText.toolCalls.map((c) => c.name).join(', ')}` : (llmText?.content ?? '').slice(0, 140))
    : '';

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button type="button" onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 14px', background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
        <span className="tabular-nums text-micro" style={{ width: 24, color: 'var(--color-ink-dim)' }}>#{step.idx}</span>
        <Badge tone={step.type === 'llm' ? 'neutral' : step.isError ? 'danger' : 'success'}>{step.type === 'llm' ? 'llm' : step.isError ? 'error' : 'tool'}</Badge>
        <span className="text-body-sm" style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{step.toolName ?? 'model turn'}</span>
        <span className="text-micro" style={{ color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{summary}</span>
        <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)', whiteSpace: 'nowrap' }}>
          {tokens ? `${tokens.toLocaleString()} tok · ` : ''}{step.costUsd != null ? `${fmtUsd(step.costUsd)} · ` : ''}{step.durationMs != null ? `${step.durationMs} ms` : ''}
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
      </button>
      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: step.type === 'tool' ? 'repeat(auto-fit, minmax(280px, 1fr))' : '1fr', gap: 10, padding: '0 14px 14px' }}>
          {step.type === 'tool' && (
            <div>
              <div className="text-eyebrow" style={{ marginBottom: 6 }}>Args</div>
              <JsonBlock value={step.input} />
            </div>
          )}
          <div>
            <div className="text-eyebrow" style={{ marginBottom: 6 }}>{step.type === 'tool' ? 'Result' : 'Message'}</div>
            <JsonBlock value={step.output} />
          </div>
        </div>
      )}
    </div>
  );
}
