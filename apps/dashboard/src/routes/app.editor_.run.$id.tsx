import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { useCrumbs } from '../nav/hooks';
import { SectionCard, StatTile, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { Modal } from '../components/Modal';
import { describeError } from '../components/ui/Toast';
import { JsonBlock, RUN_TONE, fmtDuration, fmtUsd } from '../components/editor/EditorUi';
import { useEditorRun } from '../api/editor';
import { fmtDate } from '../lib/format';
import type { EditorRunStep } from '../api/types';

export const Route = createFileRoute('/app/editor_/run/$id')({ component: EditorRunPage });

/** Run trace viewer (spec 006 T009): every LLM turn and tool call with args, result, tokens and $. */
function EditorRunPage() {
  const trail = useCrumbs('editor-run');
  const { id } = Route.useParams();
  const q = useEditorRun(id);

  if (q.error) return <div className="callout-danger">{describeError(q.error)}</div>;
  if (!q.data) return <div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} />;
  const { run, steps } = q.data;
  const toolCalls = steps.filter((s) => s.type === 'tool');

  return (
    <div>
      <PageHeader
        crumbs={[
          ...trail,
          ...(run.channelKey ? [{ label: run.channelKey, to: '/app/editor/$channel', params: { channel: run.channelKey } }] : []),
          ...(run.slotId ? [{ label: 'Slot', to: '/app/editor/slot/$id', params: { id: run.slotId } }] : []),
        ]}
        title={`${run.role} run`} subtitle={`${fmtDate(run.startedAt)} · ${run.model}`} />

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

/** The 1-line error excerpt of a failed step (its output as text). */
function errorExcerpt(step: EditorRunStep): string | null {
  if (!step.isError) return null;
  const o = step.output as unknown;
  const text = typeof o === 'string' ? o
    : o && typeof o === 'object' && typeof (o as { error?: unknown }).error === 'string' ? (o as { error: string }).error
    : JSON.stringify(o ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 240) || null;
}

/** A trace step as a compact row; a click opens its args and result (or the model message) in a dialog. */
function StepRow({ step }: { step: EditorRunStep }) {
  const [open, setOpen] = useState(false);
  const tokens = (step.promptTokens ?? 0) + (step.completionTokens ?? 0);
  const llmText = step.type === 'llm' ? (step.output as { content?: string | null; toolCalls?: Array<{ name: string }> } | null) : null;
  const summary = step.type === 'llm'
    ? (llmText?.toolCalls?.length ? `→ ${llmText.toolCalls.map((c) => c.name).join(', ')}` : (llmText?.content ?? '').slice(0, 140))
    : '';
  const stats = `${tokens ? `${tokens.toLocaleString()} tok · ` : ''}${step.costUsd != null ? `${fmtUsd(step.costUsd)} · ` : ''}${step.durationMs != null ? `${step.durationMs} ms` : ''}`;
  const excerpt = errorExcerpt(step);
  const name = step.toolName ?? 'model turn';

  return (
    <>
      <button type="button" className="card row-lift" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Open the step"
        style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%', padding: '10px 14px', color: 'inherit', cursor: 'pointer', textAlign: 'left', font: 'inherit',
          boxShadow: step.isError ? 'inset 0 0 0 1px var(--color-danger-soft)' : undefined }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minWidth: 0 }}>
          <span className="tabular-nums text-micro" style={{ width: 24, color: 'var(--color-ink-dim)' }}>#{step.idx}</span>
          <Badge tone={step.type === 'llm' ? 'neutral' : step.isError ? 'danger' : 'success'}>{step.type === 'llm' ? 'llm' : step.isError ? 'error' : 'tool'}</Badge>
          <span className="text-body-sm" style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{name}</span>
          <span className="text-micro" style={{ color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{summary}</span>
          <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)', whiteSpace: 'nowrap' }}>{stats}</span>
          <Icon name="chevron-right" size={14} />
        </span>
        {excerpt && (
          <span className="text-micro clamp" style={{ ['--clamp' as string]: 1, color: 'var(--color-danger)', paddingLeft: 34 }}>{excerpt}</span>
        )}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="xl" icon="logs" title={`#${step.idx} · ${name}`}
        subtitle={`${step.type === 'llm' ? 'model turn' : step.isError ? 'tool call · error' : 'tool call'}${stats ? ` · ${stats}` : ''}`}>
        {open && (
          <div style={{ display: 'grid', gridTemplateColumns: step.type === 'tool' ? 'repeat(auto-fit, minmax(280px, 1fr))' : '1fr', gap: 10, minWidth: 0 }}>
            {step.type === 'tool' && (
              <div style={{ minWidth: 0 }}>
                <div className="text-eyebrow" style={{ marginBottom: 6 }}>Args</div>
                <JsonBlock value={step.input} />
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <div className="text-eyebrow" style={{ marginBottom: 6 }}>{step.type === 'tool' ? 'Result' : 'Message'}</div>
              <JsonBlock value={step.output} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
