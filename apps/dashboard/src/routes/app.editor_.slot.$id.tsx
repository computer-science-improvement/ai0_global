import { createFileRoute, Link } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { useCrumbs } from '../nav/hooks';
import { SectionCard, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { describeError } from '../components/ui/Toast';
import { JsonBlock, RUN_TONE, SLOT_TONE, fmtUsd, slotView } from '../components/editor/EditorUi';
import { PlanStamp, SlotDescription, SlotPost } from '../components/editor/SlotPlan';
import { useEditorChannel, useEditorRuns, useEditorSlot, useRunSlot, useSkipSlot } from '../api/editor';
import { fmtDate } from '../lib/format';
import { feedsOf } from '../lib/slot-plan';
import { formatIn, zoneLabel } from '../lib/zoned-time';

export const Route = createFileRoute('/app/editor_/slot/$id')({ component: EditorSlotPage });

function EditorSlotPage() {
  const trail = useCrumbs('editor-slot');
  const { id } = Route.useParams();
  const slot = useEditorSlot(id);
  const runs = useEditorRuns({ slot: id, limit: 10 });
  const run = useRunSlot();
  const skip = useSkipSlot();
  const confirm = useConfirm();
  const channel = useEditorChannel(slot.data?.channelKey ?? '');

  if (slot.error) return <div className="callout-danger">{describeError(slot.error)}</div>;
  if (!slot.data) return <div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} />;
  const s = slot.data;
  const planned = s.status === 'planned' && s.kind === 'content';
  const busy = run.isPending || skip.isPending;
  // The channel's zone (spec 024): every time on this page is the resource's, never the browser's.
  const tz = channel.data?.timezone ?? 'Europe/Kyiv';
  const view = slotView(s);
  const platform = s.resourceRef ? s.resourceRef.split(':')[0] : 'telegram';

  return (
    <div>
      <PageHeader
        crumbs={[...trail, { label: s.channelKey, to: '/app/editor/$channel', params: { channel: s.channelKey } }]}
        title={s.topic}
        subtitle={`${s.resourceRef ?? s.channelKey} · ${fmtDate(s.scheduledAt)} (${formatIn(s.scheduledAt, tz)} ${zoneLabel(tz)}) · ${s.format}${s.isExperiment ? ' · experiment' : ''}`}
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

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }} className="compose-rise">
        <Badge tone={SLOT_TONE[s.status]}>{s.status}</Badge>
        <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>attempt {s.attempts}</span>
        {s.publishedPostId != null && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>· published post #{s.publishedPostId}</span>}
      </div>

      {/* Spec 034 FR-012: what the slot will do (or why it did not), and when / by which run it was planned. */}
      <div className="card compose-rise" style={{ padding: '12px 14px', marginBottom: 16, display: 'grid', gap: 10, minWidth: 0 }}>
        <SlotDescription slot={view} tz={tz} feeds={feedsOf(channel.data)} />
        {s.error && s.status !== 'skipped' && s.status !== 'failed' && s.status !== 'expired' && (
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }}>{s.error}</div>
        )}
        <div style={{ borderTop: '1px solid var(--color-hairline-soft)', paddingTop: 8 }}>
          <PlanStamp tz={tz} data={{
            planDate: s.plan?.planDate ?? '', plannedAt: s.plan?.createdAt ?? null, runId: s.plan?.runId ?? null, runRole: s.plan?.runRole ?? null,
            schedule: channel.data ? { planHour: channel.data.planHour, timezone: tz, approval: channel.data.mode === 'approve', batchHour: 20 } : null,
          }} />
          {s.plan?.status === 'superseded' && (
            <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 4 }}>This slot belongs to a plan that was replaced later that day.</div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 16, marginBottom: 16 }}>
        <SectionCard title={s.renderedPreview ? 'Post' : 'Post preview'} icon="telegram" delay={30}>
          {s.kind === 'reserved'
            ? <EmptyState icon="telegram" title="Reserved slot" note="Ads and promos are posted as booked; the editor does not write them." />
            : (
              <>
                {!s.renderedPreview && !s.previewDraft && s.status !== 'planned' && (
                  <EmptyState icon="telegram" title="No post" note="Nothing was written for this slot." />
                )}
                <SlotPost slot={view} tz={tz} estimateUsd={s.previewEstimateUsd} plain={platform !== 'telegram'} />
              </>
            )}
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
                  <span className="text-body-sm">{r.role === 'checker' ? 'critic' : r.role}</span>
                  {r.id === s.previewDraft?.runId && <Badge tone="neutral" title="The owner's dry-run preview: nothing was published">preview (dry run)</Badge>}
                  <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>{fmtDate(r.startedAt)} · {r.steps} steps · {fmtUsd(r.costUsd)}</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--color-ink-muted)', display: 'inline-flex' }}><Icon name="chevron-right" size={14} /></span>
                </Link>
              ))}
            </div>}
      </SectionCard>
    </div>
  );
}
