import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { useCrumbs } from '../nav/hooks';
import { Icon } from '../components/ui/Icon';
import { describeError } from '../components/ui/Toast';
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
  const crumbs = useCrumbs('compose');

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
      <div className="compose-rise" style={{ animationDelay: '40ms' }}>
        <PageHeader
          crumbs={crumbs}
          title={id ? 'Edit post' : 'New post'}
          subtitle={
            id
              ? 'Adjust this scheduled Telegram post — changes apply once you save.'
              : 'Compose a Telegram post and pick a future time to publish it to a channel.'
          }
        />
      </div>

      {/* Contextual hint band: sets expectations before the form. */}
      <div className="inset compose-rise"
        style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 16px', marginBottom: 24, animationDelay: '80ms' }}>
        <span style={{ display: 'inline-flex', color: 'var(--color-accent)', marginTop: 1, flexShrink: 0 }}>
          <Icon name="info" size={16} />
        </span>
        <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)', minWidth: 0 }}>
          Edit the message on the left and preview the rendered Telegram bubble on the right.
          {' '}Formatting accepts Telegram HTML: <code style={{ color: 'var(--color-ink)' }}>&lt;b&gt;</code>,{' '}
          <code style={{ color: 'var(--color-ink)' }}>&lt;i&gt;</code>,{' '}
          <code style={{ color: 'var(--color-ink)' }}>&lt;a href&gt;</code>.
        </span>
      </div>

      {id && postQ.error && (
        <div className="callout-danger" style={{ marginBottom: 16 }}>
          <Icon name="warning" size={16} />
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>This post could not be loaded: {describeError(postQ.error)}</span>
        </div>
      )}

      {loading ? (
        <div className="panel compose-rise" aria-busy="true"
          style={{ display: 'flex', alignItems: 'center', gap: 10, animationDelay: '120ms' }}>
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
