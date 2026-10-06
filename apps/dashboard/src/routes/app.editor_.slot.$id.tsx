import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { useCrumbs } from '../nav/hooks';
import { SectionCard, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { describeError } from '../components/ui/Toast';
import { JsonBlock, RUN_TONE, SLOT_TONE, fmtUsd } from '../components/editor/EditorUi';
import { useEditorRuns, useEditorSlot, useRunSlot, useSkipSlot } from '../api/editor';
import { sanitizeTelegramHtml } from '../lib/tg-html';
import { fmtDate } from '../lib/format';

export const Route = createFileRoute('/app/editor_/slot/$id')({ component: EditorSlotPage });

function EditorSlotPage() {
  const trail = useCrumbs('editor-slot');
  const { id } = Route.useParams();
  const slot = useEditorSlot(id);
  const runs = useEditorRuns({ slot: id, limit: 10 });
  const run = useRunSlot();
  const skip = useSkipSlot();
  const confirm = useConfirm();
  const preview = useMemo(
    () => (slot.data?.renderedPreview ? sanitizeTelegramHtml(slot.data.renderedPreview) : null),
    [slot.data?.renderedPreview],
  );

  if (slot.error) return <div className="callout-danger">{describeError(slot.error)}</div>;
  if (!slot.data) return <div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} />;
  const s = slot.data;
  const planned = s.status === 'planned' && s.kind === 'content';
  const busy = run.isPending || skip.isPending;

  return (
    <div>
      <PageHeader
        crumbs={[...trail, { label: s.channelKey, to: '/app/editor/$channel', params: { channel: s.channelKey } }]}
        title={s.topic}
        subtitle={`${s.channelKey} · ${fmtDate(s.scheduledAt)} · ${s.format}${s.isExperiment ? ' · experiment' : ''}`}
        actions={planned ? <>
          <button className="btn-secondary" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={async () => { if (await confirm('skip this slot', { confirmLabel: 'Skip' })) skip.mutate({ id: s.id }); }}>
            <Icon name="skip-forward" size={14} /> Skip
          </button>
          <button className="btn-primary" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={async () => { if (await confirm('run this slot now (all publish guards apply)', { danger: false, confirmLabel: 'Run now' })) run.mutate(s.id); }}>
            <Icon name="rocket" size={14} /> Run now
          </button>
        </> : undefined}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }} className="compose-rise">
        <Badge tone={SLOT_TONE[s.status]}>{s.status}</Badge>
        <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>attempt {s.attempts}</span>
        {s.angle && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>· angle: {s.angle}</span>}
        {s.sourceHints.length > 0 && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>· hints: {s.sourceHints.join(', ')}</span>}
        {s.publishedPostId != null && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>· published post #{s.publishedPostId}</span>}
      </div>

      {s.error && <div className={s.status === 'failed' ? 'callout-danger' : 'callout-warning'} style={{ marginBottom: 16 }}>{s.error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 }}>
        <SectionCard title="Rendered preview" icon="telegram" delay={30}>
          {preview
            ? (
              <div style={{ background: 'var(--color-surface-1)', borderRadius: 'var(--radius-lg)', padding: 14, maxWidth: 440 }}>
                <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}
                  dangerouslySetInnerHTML={{ __html: preview }} />
              </div>
            )
            : <EmptyState icon="telegram" title="No preview yet" note="The executor stores the rendered post when it publishes or shadows the slot." />}
        </SectionCard>
        <SectionCard title="PostSpec" icon="logs" delay={60}>
          {s.postSpec ? <JsonBlock value={s.postSpec} maxHeight={520} /> : <EmptyState icon="logs" title="No PostSpec yet" />}
        </SectionCard>
      </div>

      <SectionCard title="Runs" icon="bots" delay={90}>
        {(runs.data ?? []).length === 0
          ? <EmptyState icon="bots" title="No runs for this slot yet" />
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {runs.data!.map((r) => (
                <Link key={r.id} to="/app/editor/run/$id" params={{ id: r.id }} className="card row-lift"
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', textDecoration: 'none', color: 'var(--color-ink)' }}>
                  <Badge tone={RUN_TONE[r.status]}>{r.status}</Badge>
                  <span className="text-body-sm">{r.role}</span>
                  <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>{fmtDate(r.startedAt)} · {r.steps} steps · {fmtUsd(r.costUsd)}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--color-ink-muted)', display: 'inline-flex' }}><Icon name="chevron-right" size={14} /></span>
                </Link>
              ))}
            </div>}
      </SectionCard>
    </div>
  );
}
