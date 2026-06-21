import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { TableAction, RowActions } from '../components/ui/table';
import {
  useAgentInbox,
  useAgentStatus,
  usePatchAgentThread,
  useAgentActions,
  useCreateAgentAction,
  useApproveAgentAction,
  useRejectAgentAction,
} from '../api/agent';
import type { AgentCategory, AgentAction } from '../api/types';

export const Route = createFileRoute('/app/agent')({ component: AgentPage });

type CatFilter = 'all' | AgentCategory;

const CAT_TONE: Record<AgentCategory, 'accent' | 'success' | 'neutral' | 'warning'> = {
  ad:       'accent',
  vp:       'success',
  question: 'neutral',
  spam:     'warning',
  other:    'neutral',
};

const TABS: ReadonlyArray<{ key: CatFilter; label: string }> = [
  { key: 'all',      label: 'All' },
  { key: 'ad',       label: 'Ad' },
  { key: 'vp',       label: 'ВП' },
  { key: 'question', label: 'Questions' },
  { key: 'spam',     label: 'Spam' },
  { key: 'other',    label: 'Other' },
];

// ─── Pending action card row ───────────────────────────────────────────────────

/**
 * Edit-on-approve choice (MVP):
 * The textarea is editable local state. On Approve:
 *   - If text is unchanged from the stored payload → approve the existing action as-is.
 *   - If text was edited → create a NEW action with the edited text, then reject the
 *     old one. This avoids a PATCH endpoint (out of scope for SP2) while still
 *     letting the owner tweak a reply before sending. The flow is: create → approve
 *     (done by the server on the new action's approve call) → reject old.
 *     The new action lands in 'pending' until the owner clicks Approve on it, so
 *     we do NOT auto-approve the newly created action here — the list simply
 *     refreshes and the owner approves the new row.
 */
function PendingActionRow({ action }: { action: AgentAction }) {
  const [editedText, setEditedText] = useState<string>(
    typeof action.payload.text === 'string' ? action.payload.text : '',
  );
  const approve = useApproveAgentAction();
  const reject  = useRejectAgentAction();
  const create  = useCreateAgentAction();

  const storedText = typeof action.payload.text === 'string' ? action.payload.text : '';
  const textChanged = editedText !== storedText;
  const busy = approve.isPending || reject.isPending || create.isPending;

  function handleApprove() {
    if (textChanged) {
      // Text was edited: create a new action with the updated text, then reject
      // the old one. The new action will appear in the pending list for a second
      // Approve click. We do not auto-approve the new action to keep the guard.
      create.mutate(
        { type: action.type, threadId: action.thread_id ?? undefined, payload: { ...action.payload, text: editedText } },
        { onSuccess: () => reject.mutate(action.id) },
      );
    } else {
      approve.mutate(action.id);
    }
  }

  const target = action.type === 'reply'
    ? (action.thread_id ? `thread ${action.thread_id.slice(0, 8)}…` : '—')
    : (action.payload.channelId ?? '—');

  return (
    <div
      className="card"
      style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '13px 18px' }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <Badge tone={action.type === 'reply' ? 'accent' : 'neutral'}>{action.type}</Badge>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
            {target}
          </span>
          {action.type === 'schedule_post' && action.payload.scheduledAt && (
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
              {new Date(action.payload.scheduledAt).toLocaleString()}
            </span>
          )}
        </div>
        <textarea
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          rows={3}
          style={{
            width: '100%',
            resize: 'vertical',
            background: 'var(--color-surface)',
            color: 'var(--color-ink)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
            fontSize: '0.85rem',
            fontFamily: 'inherit',
          }}
        />
        {textChanged && (
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 3 }}>
            Text edited — Approve will create a new action with the updated text.
          </div>
        )}
        {action.error && (
          <div className="text-micro" style={{ color: 'var(--color-danger)', marginTop: 3 }}>
            {action.error}
          </div>
        )}
      </div>
      <RowActions
        danger={
          <TableAction
            icon="trash"
            danger
            title="Reject"
            disabled={busy}
            onClick={() => reject.mutate(action.id)}
          />
        }
      >
        <TableAction
          icon="check"
          title={textChanged ? 'Approve (with edits)' : 'Approve'}
          disabled={busy}
          onClick={handleApprove}
        />
      </RowActions>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function AgentPage() {
  const [cat, setCat] = useState<CatFilter>('all');
  const status  = useAgentStatus();
  const inbox   = useAgentInbox(cat === 'all' ? {} : { category: cat });
  const patch   = usePatchAgentThread();
  const actions = useAgentActions('pending');
  const create  = useCreateAgentAction();

  return (
    <div>
      <PageHeader
        title="Agent"
        subtitle="Incoming DMs triaged by the agent. Review drafts here — nothing is sent automatically."
      />

      <SectionCard title="Agent status" icon="bots" delay={20} style={{ marginBottom: 16 }}>
        {!status.data?.hasAgentSession ? (
          <EmptyState
            icon="bots"
            title="No agent session"
            note="Add an MTProto session and set its role to 'agent' in Connections → Sessions."
          />
        ) : (
          <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
            Polling {status.data?.enabled ? 'on' : 'off'} · cadence {status.data?.cadence} ·{' '}
            last polled{' '}
            {status.data?.lastPolledAt
              ? new Date(status.data.lastPolledAt).toLocaleString()
              : 'never'}
          </div>
        )}
      </SectionCard>

      {/* ── Pending actions ─────────────────────────────────────────────────── */}
      <SectionCard
        title={`Pending actions${actions.data && actions.data.length > 0 ? ` (${actions.data.length})` : ''}`}
        icon="check"
        delay={40}
        style={{ marginBottom: 16 }}
      >
        {!actions.data || actions.data.length === 0 ? (
          <div className="text-body-sm" style={{ color: 'var(--color-ink-dim)', padding: '4px 0' }}>
            No pending actions.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {actions.data.map((a) => (
              <PendingActionRow key={a.id} action={a} />
            ))}
          </div>
        )}
      </SectionCard>

      {/* ── Inbox ───────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <SegmentedTabs<CatFilter> value={cat} onChange={setCat} options={TABS} />
      </div>

      {inbox.data && inbox.data.length === 0 && (
        <EmptyState
          icon="bots"
          title="Inbox empty"
          note="Triaged DM threads will show up here."
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {inbox.data?.map((t) => (
          <div
            key={t.id}
            className="card row-lift"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '13px 18px' }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span
                  className="text-body"
                  style={{ color: 'var(--color-ink)', fontWeight: 500 }}
                >
                  {t.peer_name ?? (t.peer_username ? '@' + t.peer_username : t.peer_id)}
                </span>
                <Badge tone={CAT_TONE[t.category]}>{t.category}</Badge>
                <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                  score {t.score}
                </span>
              </div>
              {t.summary && (
                <div
                  className="text-body-sm"
                  style={{ color: 'var(--color-ink-muted)', marginTop: 4 }}
                >
                  {t.summary}
                </div>
              )}
              {t.draft_reply && (
                <details style={{ marginTop: 6 }}>
                  <summary
                    className="text-micro"
                    style={{ color: 'var(--color-accent)', cursor: 'pointer' }}
                  >
                    Draft reply
                  </summary>
                  <div
                    className="text-body-sm"
                    style={{ color: 'var(--color-ink)', marginTop: 4, whiteSpace: 'pre-wrap' }}
                  >
                    {t.draft_reply}
                  </div>
                </details>
              )}
            </div>
            <RowActions
              danger={
                <TableAction
                  icon="trash"
                  danger
                  title="Archive"
                  onClick={() => patch.mutate({ id: t.id, status: 'archived' })}
                />
              }
            >
              {/* Queue reply: creates a pending action from the draft_reply text.
                  Sending only happens when the action is Approved in the Pending
                  section above — this button never sends directly. */}
              <TableAction
                icon="play"
                title="Queue reply"
                disabled={create.isPending}
                onClick={() =>
                  create.mutate({
                    type: 'reply',
                    threadId: t.id,
                    payload: { text: t.draft_reply ?? '' },
                  })
                }
              />
              <TableAction
                icon="check"
                title="Mark reviewed"
                onClick={() => patch.mutate({ id: t.id, status: 'reviewed' })}
              />
            </RowActions>
          </div>
        ))}
      </div>
    </div>
  );
}
