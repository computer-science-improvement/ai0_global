import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { useCrumbs } from '../nav/hooks';
import { SectionCard, StatStrip, StatTile, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { Modal } from '../components/Modal';
import { describeError } from '../components/ui/Toast';
import { JsonBlock, RUN_TONE, fmtDuration, fmtUsd, runStatusLabel } from '../components/editor/EditorUi';
import '../components/editor/editor.css';
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
        eyebrow={<>{run.channelKey && <span className="no-caps">{run.channelKey} · </span>}{fmtDate(run.startedAt)}</>}
        title={`${run.role} run`}
        subtitle={<span className="mono text-caption">{run.model}</span>} />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <Badge tone={RUN_TONE[run.status]}>{runStatusLabel(run.status)}</Badge>
      </div>
      {run.error && (
        <div className="callout-danger" style={{ marginBottom: 16 }}>
          <Icon name="warning" size={16} />
          <span className="mono text-caption" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{run.error}</span>
        </div>
      )}

      <div className="compose-rise" style={{ marginBottom: 16 }}>
        <StatStrip label="Run numbers">
          <StatTile label="Steps" value={run.steps} delta={`${toolCalls.length} tool calls · ${toolCalls.filter((s) => s.isError).length} errors`} />
          <StatTile label="Tokens" value={(run.promptTokens + run.completionTokens).toLocaleString()} delta={`${run.promptTokens.toLocaleString()} in · ${run.completionTokens.toLocaleString()} out`} />
          <StatTile label="Cost" value={fmtUsd(run.costUsd)} />
          <StatTile label="Duration" value={fmtDuration(run.startedAt, run.finishedAt)} />
        </StatStrip>
      </div>

      <SectionCard title="Trace" flush delay={40}
        action={steps.length > 0 ? <span className="mono text-caption ink-muted">{steps.length} step{steps.length === 1 ? '' : 's'}</span> : undefined}>
        {steps.length === 0
          ? (
            <EmptyState icon="logs" title="No steps recorded"
              // A running run has none yet; a run that counted steps lost their details to retention (30 days, the run row stays 180).
              note={run.status === 'running' ? 'No step has finished yet.' : run.steps > 0 ? 'The step details were removed after 30 days.' : 'The run ended before its first model turn.'} />
          )
          : steps.map((s) => <StepRow key={s.id} step={s} />)}
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

/** A trace step as a row of the timeline (index, dot on the spine, what happened); a click opens its args and result (or the model message) in a dialog. */
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
  const kind = step.type === 'llm' ? 'model turn' : step.isError ? 'tool error' : 'tool call';

  return (
    <>
      <button type="button" className={`panel-row trace-row${step.isError ? ' is-error' : ''}`} onClick={() => setOpen(true)} aria-haspopup="dialog" title="Open the step">
        <span className="mono tabular-nums trace-idx">#{step.idx}</span>
        <span className={`trace-dot${step.type === 'tool' ? (step.isError ? ' is-error' : ' is-tool') : ''}`} role="img" aria-label={kind} />
        <span className="trace-main">
          <span className="trace-title">
            <Badge tone={step.type === 'llm' ? 'neutral' : step.isError ? 'danger' : 'success'}>{step.type === 'llm' ? 'llm' : step.isError ? 'error' : 'tool'}</Badge>
            <span className="text-body-sm trace-name">{name}</span>
          </span>
          {summary && <span className="text-micro clamp ink-muted" style={{ ['--clamp' as string]: 1, marginTop: 3 }}>{summary}</span>}
          {excerpt && <span className="text-micro clamp ink-danger" style={{ ['--clamp' as string]: 2, marginTop: 3 }}>{excerpt}</span>}
        </span>
        <span className="trace-stats mono tabular-nums">
          {stats}
          <Icon name="chevron-right" size={14} />
        </span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="xl" icon="logs" title={`#${step.idx} · ${name}`}
        subtitle={`${kind}${stats ? ` · ${stats}` : ''}`}>
        {open && (
          <div style={{ display: 'grid', gridTemplateColumns: step.type === 'tool' ? 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))' : '1fr', gap: 12, minWidth: 0 }}>
            {step.type === 'tool' && (
              <div style={{ minWidth: 0 }}>
                <div className="text-overline" style={{ marginBottom: 6 }}>Args</div>
                <JsonBlock value={step.input} />
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <div className="text-overline" style={{ marginBottom: 6 }}>{step.type === 'tool' ? 'Result' : 'Message'}</div>
              <JsonBlock value={step.output} />
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
