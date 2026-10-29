import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/ui/Icon';
import { SectionCard, StatStrip, StatTile, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { StatusMark } from '../components/ui/StatusMark';
import { RowActions, TableAction } from '../components/ui/table';
import { scheduledPostsApi } from '../api/scheduled-posts';
import { trackingApi } from '../api/tracking';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { fmtDate } from '../lib/format';
import { publicationLabel, publicationTone } from '../lib/status-tone';
import type { ScheduledPost } from '../api/types';
import '../components/calendar/calendar.css';

export const Route = createFileRoute('/app/scheduled')({ component: ScheduledPage });

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
    <button className={variant} onClick={() => navigate({ to: '/app/compose' })}>
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
        <div className="compose-rise" style={{ marginBottom: 16 }}>
          <StatStrip label="Scheduled post numbers">
            {/* The tiles use the rows' status words (lib/status-tone): a pending post reads "Scheduled" in both places. */}
            <StatTile label="All posts" value={data.length} />
            <StatTile label={publicationLabel('pending')} value={pendingCount} />
            <StatTile label={publicationLabel('sent')} value={sentCount} delta={sentCount ? 'delivered' : undefined} deltaTone="success" />
            <StatTile label={publicationLabel('failed')} value={failedCount} delta={failedCount ? 'needs attention' : undefined} deltaTone={failedCount ? 'danger' : 'neutral'} />
          </StatStrip>
        </div>
      )}

      {isLoading && <div className="panel compose-rise" aria-busy="true" style={{ height: 120, opacity: 0.55 }} />}

      {error && (
        <div className="callout-danger">
          <Icon name="warning" size={16} />
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{(error as Error).message}</span>
        </div>
      )}

      {data && data.length === 0 && !isLoading && (
        <EmptyState
          icon="calendar"
          title="Nothing scheduled"
          note="Compose a post and pick a send time. It will queue up here."
          action={newPostBtn('btn-secondary')}
        />
      )}

      {data && data.length > 0 && (
        <SectionCard title="Queue" flush delay={60}
          action={<span className="mono text-caption tabular-nums ink-muted">{data.length} post{data.length === 1 ? '' : 's'}</span>}>
          {data.map((p) => (
            <PostRow
              key={p.id}
              p={p}
              channelLabel={channelLabel}
              onEdit={() => navigate({ to: '/app/compose', search: { id: p.id } })}
              onCancel={async () => { if (await confirm(`cancel the scheduled post`)) cancel.mutate(p.id); }}
            />
          ))}
        </SectionCard>
      )}
    </div>
  );
}

/** One scheduled post: the owner's mark, when and through what it goes out, where to, the start of the text, its status. */
function PostRow({
  p, channelLabel, onEdit, onCancel,
}: {
  p: ScheduledPost;
  channelLabel: (id: string) => string;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const plainText = p.text.replace(/<[^>]+>/g, '').trim();

  return (
    <div className="panel-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* The owner's own post (spec 078 D2): the mark is a lead, the status is the Badge. */}
      <span style={{ display: 'inline-flex', paddingTop: 4, flexShrink: 0 }}><StatusMark status="yours" decorative /></span>

      {/* Time: the primary anchor. */}
      <div style={{ flex: '0 0 152px', minWidth: 0 }}>
        <div className="mono text-caption tabular-nums">{fmtDate(p.scheduledAt)}</div>
        <div className="text-micro ink-dim" style={{ marginTop: 2 }}>
          {p.sender === 'bot' ? 'Bot' : 'MTProto'}
        </div>
      </div>

      {/* Channel, status and the start of the text. */}
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <Icon name="telegram" size={12} />
            <span className="text-body-sm sched-channel" style={{ overflowWrap: 'anywhere' }}>{channelLabel(p.channelId)}</span>
          </span>
          <Badge tone={publicationTone(p.status)}>{publicationLabel(p.status)}</Badge>
        </div>
        <div className={`text-body-sm clamp ${plainText ? 'ink-muted' : 'ink-dim'}`} style={{ ['--clamp' as string]: 2, marginTop: 4 }}>
          {plainText || 'No text'}
        </div>
        {p.error && (
          <div className="text-micro clamp ink-danger" title={p.error} style={{ ['--clamp' as string]: 2, marginTop: 4 }}>
            {p.error}
          </div>
        )}
      </div>

      {/* Actions: pending posts only. */}
      {p.status === 'pending' && (
        <div style={{ marginLeft: 'auto' }}>
          <RowActions danger={<TableAction icon="x" danger title="Cancel the scheduled post" onClick={onCancel} />}>
            <TableAction action="edit" title="Edit the post" onClick={onEdit} />
          </RowActions>
        </div>
      )}
    </div>
  );
}
