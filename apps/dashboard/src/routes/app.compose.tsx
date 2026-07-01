import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/ui/Icon';
import { PostComposer } from '../components/post/PostComposer';
import { scheduledPostsApi } from '../api/scheduled-posts';

interface Search { id?: string; }

export const Route = createFileRoute('/app/compose')({
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
  const done = () => navigate({ to: '/app/scheduled' });

  const loading = !!id && postQ.isLoading;

  return (
    <div style={{ maxWidth: 1080 }}>
      <Link
        to={'/app/scheduled' as never}
        className="link-accent text-body-sm compose-rise"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16, animationDelay: '0ms' }}
      >
        <span style={{ display: 'inline-flex' }}><Icon name="chevron-left" size={15} /></span>
        Back to scheduled
      </Link>

      <div className="compose-rise" style={{ animationDelay: '40ms' }}>
        <PageHeader
          title={id ? 'Edit post' : 'New post'}
          subtitle={
            id
              ? 'Adjust this scheduled Telegram post — changes apply once you save.'
              : 'Compose a Telegram post and pick a future time to publish it to a channel.'
          }
        />
      </div>

      {/* Contextual hint band — sets expectations before the form, mode-aware. */}
      <div
        className="compose-rise"
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 10,
          padding: '11px 14px', marginBottom: 22,
          background: 'var(--color-success-soft)',
          border: '1px solid var(--color-hairline-soft)',
          borderRadius: 'var(--radius-lg)',
          animationDelay: '80ms',
        }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--color-accent)', marginTop: 1, flexShrink: 0 }}>
          <Icon name="info" size={16} />
        </span>
        <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.45 }}>
          Edit the message on the left and preview the rendered Telegram bubble on the right.
          {' '}Formatting accepts Telegram HTML — <code style={{ color: 'var(--color-ink)' }}>&lt;b&gt;</code>,{' '}
          <code style={{ color: 'var(--color-ink)' }}>&lt;i&gt;</code>,{' '}
          <code style={{ color: 'var(--color-ink)' }}>&lt;a href&gt;</code>.
        </span>
      </div>

      {loading ? (
        <div
          className="card compose-rise"
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '18px 20px', animationDelay: '120ms',
          }}
        >
          <span style={{ display: 'inline-flex', color: 'var(--color-ink-dim)' }}>
            <Icon name="refresh" size={16} />
          </span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
            Loading post…
          </span>
        </div>
      ) : (
        // Remount when the edit target changes so PostComposer re-seeds state.
        <PostComposer key={id ?? 'new'} editing={editing} onDone={done} />
      )}
    </div>
  );
}
