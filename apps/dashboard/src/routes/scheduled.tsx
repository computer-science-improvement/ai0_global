import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import { NewPostModal } from '../components/post/NewPostModal';
import { scheduledPostsApi } from '../api/scheduled-posts';
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
  const [editing, setEditing] = useState<ScheduledPost | null>(null);
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['scheduled-posts'], queryFn: () => scheduledPostsApi.list() });
  const cancel = useMutation({ mutationFn: (id: string) => scheduledPostsApi.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-posts'] }) });

  return (
    <div>
      <PageHeader title="Заплановані" subtitle="Заплановані пости в Telegram"
        actions={<button className="btn-primary" onClick={() => { setEditing(null); setOpen(true); }}>+ Новий пост</button>} />
      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Завантаження…</p>}
      <div className="table-wrap"><table className="table"><thead><tr>
        <th>Час</th><th>Канал</th><th>Відправник</th><th>Статус</th><th>Текст</th><th style={{ textAlign:'right' }}>Дії</th>
      </tr></thead><tbody>
        {data?.map(p => (
          <tr key={p.id}>
            <td className="num">{fmtDate(p.scheduledAt)}</td>
            <td>{p.channelId.slice(0,8)}</td>
            <td>{p.sender === 'bot' ? 'Бот' : 'MTProto'}</td>
            <td><Badge tone={TONE[p.status]}>{p.status}</Badge>{p.error && <span className="text-micro" title={p.error} style={{ color:'var(--color-danger)', marginLeft:6 }}>!</span>}</td>
            <td className="meta" style={{ maxWidth: 280, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.text.replace(/<[^>]+>/g,'')}</td>
            <td style={{ textAlign:'right' }}>
              {p.status === 'pending' && <>
                <button className="btn-tiny" onClick={() => { setEditing(p); setOpen(true); }}>Ред.</button>
                <button className="btn-tiny-danger" style={{ marginLeft: 6 }}
                  onClick={async () => { if (await confirm(`скасувати запланований пост`)) cancel.mutate(p.id); }}>Скасувати</button>
              </>}
            </td>
          </tr>
        ))}
      </tbody></table></div>
      <NewPostModal open={open} onClose={() => setOpen(false)} editing={editing} />
    </div>
  );
}
