import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { PostComposer } from '../components/post/PostComposer';
import { scheduledPostsApi } from '../api/scheduled-posts';

interface Search { id?: string; }

export const Route = createFileRoute('/compose')({
  validateSearch: (s: Record<string, unknown>): Search =>
    s.id ? { id: String(s.id) } : {},
  component: ComposePage,
});

function ComposePage() {
  const { id } = Route.useSearch();
  const navigate = Route.useNavigate();

  // Edit mode: fetch the post to prefill. Blank compose when no id.
  const postQ = useQuery({
    queryKey: ['scheduled-posts', id],
    queryFn: () => scheduledPostsApi.get(id as string),
    enabled: !!id,
  });

  const editing = id ? postQ.data ?? null : null;
  const done = () => navigate({ to: '/scheduled' });

  return (
    <div>
      <PageHeader
        title={id ? 'Редагувати пост' : 'Новий пост'}
        subtitle="Запланований пост у Telegram"
      />
      {id && postQ.isLoading ? (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Завантаження…</p>
      ) : (
        // Remount when the edit target changes so PostComposer re-seeds state.
        <PostComposer key={id ?? 'new'} editing={editing} onDone={done} />
      )}
    </div>
  );
}
