import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/ui/Icon';
import { SectionCard, StatTile, EmptyState, StatusDot, type Tone } from '../components/ui/primitives';
import { scheduledPostsApi } from '../api/scheduled-posts';
import { trackingApi } from '../api/tracking';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { fmtDate } from '../lib/format';
import type { ScheduledPost } from '../api/types';

export const Route = createFileRoute('/app/scheduled')({ component: ScheduledPage });

/** Status → StatusDot tone (keeps the single-green-accent restraint). */
const STATUS_TONE: Record<ScheduledPost['status'], Tone> = {
  pending:  'neutral',
  sending:  'accent',
  sent:     'success',
  failed:   'danger',
  canceled: 'warning',
};

/** chip class per status. */
const STATUS_CHIP: Record<ScheduledPost['status'], string> = {
  pending:  'chip',
  sending:  'chip',
  sent:     'chip chip-success',
  failed:   'chip chip-danger',
  canceled: 'chip chip-warning',
};

function ScheduledPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({ queryKey: ['scheduled-posts'], queryFn: () => scheduledPostsApi.list() });
  const channelsQ = useQuery({ queryKey: ['channels','mine',1,'',undefined],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', page: 1, pageSize: 100 }) });
  const channelLabel = (id: string) => {
    const c = channelsQ.data?.items.find(x => x.id === id);
    return c?.title ?? c?.channelKey ?? id.slice(0, 8);
  };
  const cancel = useMutation({ mutationFn: (id: string) => scheduledPostsApi.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-posts'] }) });

  const newPostBtn = (variant: 'btn-primary' | 'btn-secondary') => (
    <button className={variant} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      onClick={() => navigate({ to: '/app/compose' })}>
      <Icon name="plus" size={14} /> New post
    </button>
  );

  const pendingCount = data?.filter(p => p.status === 'pending').length ?? 0;
  const sentCount = data?.filter(p => p.status === 'sent').length ?? 0;
  const failedCount = data?.filter(p => p.status === 'failed').length ?? 0;

  return (
    <div>
      <PageHeader title="Scheduled" subtitle="Scheduled posts in Telegram"
        actions={newPostBtn('btn-primary')} />

      {data && data.length > 0 && (
        <div className="stat-grid compose-rise" style={{ marginBottom: 18 }}>
          <StatTile label="Scheduled" value={data.length} icon="calendar" accent />
          <StatTile label="Pending" value={pendingCount} icon="calendar" />
          <StatTile label="Sent" value={sentCount} icon="check" delta={sentCount ? 'delivered' : undefined} deltaTone="success" />
          <StatTile label="Failed" value={failedCount} icon="warning" delta={failedCount ? 'needs attention' : undefined} deltaTone={failedCount ? 'danger' : 'neutral'} />
        </div>
      )}

      {isLoading && (
        <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[0, 1, 2].map(i => (
            <div key={i} className="card compose-rise"
              style={{
                height: 78, opacity: 0.55,
                animationDelay: `${i * 60}ms`,
                background: 'var(--color-surface-1)',
              }} />
          ))}
        </div>
      )}

      {error && (
        <div className="card" style={{
          display: 'flex', alignItems: 'center', gap: 10,
          borderColor: 'var(--color-danger-soft)',
        }}>
          <span style={{ display: 'inline-flex', color: 'var(--color-danger)' }}>
            <Icon name="warning" size={16} />
          </span>
          <span className="text-body-sm" style={{ color: 'var(--color-danger)' }}>
            {(error as Error).message}
          </span>
        </div>
      )}

      {data && data.length === 0 && !isLoading && (
        <EmptyState
          icon="calendar"
          title="Nothing scheduled"
          note="Compose a post and pick a send time — it will queue up here."
          action={newPostBtn('btn-secondary')}
        />
      )}

      {data && data.length > 0 && (
        <SectionCard title="Queue" icon="calendar" delay={60}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {data.map((p, i) => (
              <PostRow
                key={p.id}
                p={p}
                index={i}
                channelLabel={channelLabel}
                onEdit={() => navigate({ to: '/app/compose', search: { id: p.id } })}
                onCancel={async () => { if (await confirm(`cancel the scheduled post`)) cancel.mutate(p.id); }}
              />
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function PostRow({
  p, index, channelLabel, onEdit, onCancel,
}: {
  p: ScheduledPost;
  index: number;
  channelLabel: (id: string) => string;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const plainText = p.text.replace(/<[^>]+>/g, '').trim();

  return (
    <div
      className="card row-lift compose-rise"
      style={{
        display: 'flex', alignItems: 'center', gap: 18,
        padding: '14px 18px',
        animationDelay: `${index * 45}ms`,
      }}
    >
      {/* Status dot — the at-a-glance signal. */}
      <span title={p.status} style={{ display: 'inline-flex', flexShrink: 0 }}>
        <StatusDot tone={STATUS_TONE[p.status]} />
      </span>

      {/* Time — the primary anchor. */}
      <div style={{ flexShrink: 0, minWidth: 152 }}>
        <div className="text-body-sm tabular-nums" style={{ color: 'var(--color-ink)' }}>
          {fmtDate(p.scheduledAt)}
        </div>
        <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 2 }}>
          {p.sender === 'bot' ? 'Bot' : 'MTProto'}
        </div>
      </div>

      {/* Channel + status chips. */}
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 130 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--color-ink-muted)' }}>
          <Icon name="telegram" size={12} />
          <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{channelLabel(p.channelId)}</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span className={STATUS_CHIP[p.status]}>{p.status}</span>
          {p.error && (
            <span title={p.error} style={{ display: 'inline-flex', color: 'var(--color-danger)' }}>
              <Icon name="warning" size={12} />
            </span>
          )}
        </span>
      </div>

      {/* Text preview — fills remaining space. */}
      <div className="text-body-sm" style={{
        flex: 1, minWidth: 0,
        color: plainText ? 'var(--color-ink-muted)' : 'var(--color-ink-dim)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {plainText || 'No text'}
      </div>

      {/* Actions — pending posts only. */}
      <div style={{ flexShrink: 0, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {p.status === 'pending' && (
          <>
            <button className="btn-tiny" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={onEdit}>
              <Icon name="pencil" size={12} /> Edit
            </button>
            <button className="btn-tiny-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={onCancel}>
              <Icon name="x" size={12} /> Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
