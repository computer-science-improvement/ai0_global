import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import { scheduledPostsApi } from '../api/scheduled-posts';
import { trackingApi } from '../api/tracking';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { fmtDate } from '../lib/format';
import type { ScheduledPost } from '../api/types';

export const Route = createFileRoute('/scheduled')({ component: ScheduledPage });

const TONE: Record<ScheduledPost['status'], 'neutral'|'success'|'warning'|'danger'> = {
  pending: 'neutral', sending: 'neutral', sent: 'success', failed: 'danger', canceled: 'warning',
};

function ScheduledPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ['scheduled-posts'], queryFn: () => scheduledPostsApi.list() });
  const channelsQ = useQuery({ queryKey: ['channels','mine',1,'',undefined],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', page: 1, pageSize: 100 }) });
  const channelLabel = (id: string) => {
    const c = channelsQ.data?.items.find(x => x.id === id);
    return c?.title ?? c?.channelKey ?? id.slice(0, 8);
  };
  const cancel = useMutation({ mutationFn: (id: string) => scheduledPostsApi.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-posts'] }) });

  return (
    <div>
      <PageHeader title="Scheduled" subtitle="Scheduled posts in Telegram"
        actions={<button className="btn-primary" onClick={() => navigate({ to: '/compose' })}>+ New post</button>} />
      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      <div className="table-wrap"><table className="table"><thead><tr>
        <th>Time</th><th>Channel</th><th>Sender</th><th>Status</th><th>Text</th><th style={{ textAlign:'right' }}>Actions</th>
      </tr></thead><tbody>
        {data?.map(p => (
          <tr key={p.id}>
            <td className="num">{fmtDate(p.scheduledAt)}</td>
            <td>{channelLabel(p.channelId)}</td>
            <td>{p.sender === 'bot' ? 'Bot' : 'MTProto'}</td>
            <td><Badge tone={TONE[p.status]}>{p.status}</Badge>{p.error && <span className="text-micro" title={p.error} style={{ color:'var(--color-danger)', marginLeft:6 }}>!</span>}</td>
            <td className="meta" style={{ maxWidth: 280, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.text.replace(/<[^>]+>/g,'')}</td>
            <td style={{ textAlign:'right' }}>
              {p.status === 'pending' && <>
                <button className="btn-tiny" onClick={() => navigate({ to: '/compose', search: { id: p.id } })}>Edit</button>
                <button className="btn-tiny-danger" style={{ marginLeft: 6 }}
                  onClick={async () => { if (await confirm(`cancel the scheduled post`)) cancel.mutate(p.id); }}>Cancel</button>
              </>}
            </td>
          </tr>
        ))}
      </tbody></table></div>
    </div>
  );
}
