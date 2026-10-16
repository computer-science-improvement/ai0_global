import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { TableAction, RowActions } from '../components/ui/table';
import { Icon } from '../components/ui/Icon';
import { Field } from '../components/ui/primitives';
import { describeError } from '../components/ui/Toast';
import { CompactCard } from '../components/ui/CompactCard';
import {
  useAgentInbox,
  useAgentStatus,
  usePatchAgentThread,
  useAgentActions,
  useCreateAgentAction,
  useApproveAgentAction,
  useRejectAgentAction,
  useAgentChats,
  useSetChatMonitor,
  useAgentOpportunities,
  usePatchOpportunity,
} from '../api/agent';
import type { AgentCategory, AgentAction, AgentThread, OpportunityKind } from '../api/types';
import { fmtDate, fmtRelative } from '../lib/format';

type CatFilter = 'all' | AgentCategory;

const CATS: CatFilter[] = ['all', 'ad', 'vp', 'question', 'spam', 'other'];

// Spec 027 FR-002: the DM triage page ("DM inbox", formerly "Agent" at /app/agent,
// which now redirects here with its search params). ?cat= keeps the category tab linkable.
export const Route = createFileRoute('/app/dm')({
  validateSearch: (s: Record<string, unknown>): { cat?: CatFilter } =>
    CATS.includes(s.cat as CatFilter) && s.cat !== 'all' ? { cat: s.cat as CatFilter } : {},
  component: AgentPage,
});

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
  { key: 'vp',       label: 'Cross-promo' },
  { key: 'question', label: 'Questions' },
  { key: 'spam',     label: 'Spam' },
  { key: 'other',    label: 'Other' },
];

/** Landing CTA placements (spec 026 FR-003) as the owner reads them on the DM chip. */
const LANDING_PLACEMENT_LABEL: Record<string, string> = {
  hero: 'hero', topbar: 'top bar', network: 'network card', resource: 'channel card',
  mediakit: 'media kit', advertise: 'advertise block', footer: 'footer', howitworks: 'how it works',
};

const KIND_TONE: Record<OpportunityKind, 'accent' | 'success' | 'neutral'> = {
  ad_offer:   'accent',
  vp_request: 'success',
  pricing:    'neutral',
  other:      'neutral',
};

const KIND_LABEL: Record<OpportunityKind, string> = {
  ad_offer:   'Ad offer',
  vp_request: 'Cross-promo request',
  pricing:    'Pricing',
  other:      'Other',
};

const ACTION_LABEL: Record<string, string> = {
  advertise: 'Advertise',
  do_vp:     'Do cross-promo',
  skip:      'Skip',
};

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

  function handleApprove(onDone: () => void) {
    if (textChanged) {
      // Text was edited: create a new action with the updated text, then reject
      // the old one. The new action will appear in the pending list for a second
      // Approve click. We do not auto-approve the new action to keep the guard.
      create.mutate(
        { type: action.type, threadId: action.thread_id ?? undefined, payload: { ...action.payload, text: editedText } },
        { onSuccess: () => reject.mutate(action.id, { onSuccess: onDone }) },
      );
    } else {
      approve.mutate(action.id, { onSuccess: onDone });
    }
  }

  const target = action.type === 'reply'
    ? (action.thread_id ? `thread ${action.thread_id.slice(0, 8)}…` : '—')
    : (action.payload.channelId ?? '—');
  const when = action.type === 'schedule_post' && action.payload.scheduledAt ? fmtDate(action.payload.scheduledAt) : null;
  const err = approve.error ?? reject.error ?? create.error;

  return (
    <CompactCard hint="Open the action" attention={!!action.error}
      top={<>
        <Badge tone={action.type === 'reply' ? 'accent' : 'neutral'}>{action.type}</Badge>
        <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{target}</span>
        {textChanged && <span className="chip" style={{ fontSize: 11 }}>edited</span>}
      </>}
      meta={when ?? fmtRelative(action.created_at)}
      body={editedText || <span style={{ color: 'var(--color-ink-dim)' }}>No text</span>}
      note={action.error ?? undefined}
      noteTone="danger"
      dialog={{
        size: 'lg', icon: 'check', title: action.type === 'reply' ? 'Reply' : action.type.replace(/_/g, ' '),
        subtitle: `${target}${when ? ` · ${when}` : ''} · nothing is sent until you approve`,
        body: () => (
          <div style={{ minWidth: 0 }}>
            <Field label="Text" hint="Edit it before approving; an edited text becomes a new action to approve.">
              <textarea className="input-field" value={editedText} onChange={(e) => setEditedText(e.target.value)} rows={8}
                style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '0.85rem' }} />
            </Field>
            {textChanged && (
              <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: -6 }}>
                Text edited — Approve will create a new action with the updated text.
              </div>
            )}
            {action.error && (
              <div className="callout-danger" style={{ marginTop: 8 }}><span className="text-micro" style={{ overflowWrap: 'anywhere' }}>{action.error}</span></div>
            )}
            {err && (
              <div className="callout-danger" style={{ marginTop: 8 }}><span className="text-micro">{describeError(err)}</span></div>
            )}
          </div>
        ),
        actions: (close) => (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', width: '100%' }}>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => reject.mutate(action.id, { onSuccess: close })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)', marginRight: 'auto' }}>
              <Icon name="ban" size={14} /> Reject
            </button>
            {textChanged && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditedText(storedText)}>Undo edits</button>
            )}
            <button type="button" className="btn-primary" disabled={busy} onClick={() => handleApprove(close)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="check" size={14} /> {textChanged ? 'Approve with edits' : 'Approve'}
            </button>
          </div>
        ),
      }} />
  );
}

/** A triaged DM thread as a compact card; the dialog has the full summary, the draft reply and the actions. */
function ThreadCard({ t, index }: { t: AgentThread; index: number }) {
  const patch  = usePatchAgentThread();
  const create = useCreateAgentAction();
  const peer = t.peer_name ?? (t.peer_username ? '@' + t.peer_username : t.peer_id);
  const landing = t.fields?.source === 'landing'
    ? `From landing · ${LANDING_PLACEMENT_LABEL[t.fields.placement ?? ''] ?? t.fields.placement ?? 'unknown'}${t.fields.channel ? ` · ${t.fields.channel.startsWith('@') || /^-?\d+$/.test(t.fields.channel) ? t.fields.channel : `@${t.fields.channel}`}` : ''}`
    : null;
  const busy = patch.isPending || create.isPending;
  const err = patch.error ?? create.error;

  return (
    <CompactCard hint="Open the thread" delay={Math.min(index, 12) * 30}
      top={<>
        <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 600 }}>{peer}</span>
        <Badge tone={CAT_TONE[t.category]}>{t.category}</Badge>
        <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>score {t.score}</span>
        {/* Spec 026 FR-016: the DM came from a landing CTA (its prefilled ai0web tag). */}
        {landing && <span className="chip" style={{ fontSize: 11 }} title={`Opened from the public landing (${t.fields.placement ?? 'unknown'} button)${t.fields.channel ? `, about ${t.fields.channel}` : ''}`}>{landing}</span>}
      </>}
      meta={<span title={fmtDate(t.last_message_at)}>{fmtRelative(t.last_message_at)}</span>}
      body={t.summary ?? t.last_text ?? undefined}
      extra={t.draft_reply ? <span className="text-micro" style={{ color: 'var(--color-accent)' }}>Draft reply ready</span> : undefined}
      dialog={{
        size: 'lg', icon: 'chat', title: peer,
        subtitle: `${t.category} · score ${t.score} · last message ${fmtDate(t.last_message_at)}`,
        body: () => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Badge tone={CAT_TONE[t.category]}>{t.category}</Badge>
              <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>score {t.score}</span>
              {t.peer_username && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>@{t.peer_username}</span>}
              {landing && <span className="chip" style={{ fontSize: 11 }}>{landing}</span>}
            </div>
            {t.summary && (
              <div>
                <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 3 }}>Summary</div>
                <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.summary}</div>
              </div>
            )}
            {t.last_text && (
              <div>
                <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 3 }}>Last message</div>
                <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.last_text}</div>
              </div>
            )}
            <div>
              <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 3 }}>Draft reply</div>
              {t.draft_reply
                ? <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px 10px', background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline-soft)', borderRadius: 'var(--radius-md)' }}>{t.draft_reply}</div>
                : <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>No draft reply.</span>}
              <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 4 }}>
                Queue reply adds it to Pending actions above; it is sent only when you approve it there.
              </div>
            </div>
            {err && <div className="callout-danger"><span className="text-micro">{describeError(err)}</span></div>}
          </div>
        ),
        actions: (close) => (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', width: '100%' }}>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => patch.mutate({ id: t.id, status: 'archived' }, { onSuccess: close })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)', marginRight: 'auto' }}>
              <Icon name="trash" size={14} /> Archive
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => patch.mutate({ id: t.id, status: 'reviewed' }, { onSuccess: close })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="check" size={14} /> Mark reviewed
            </button>
            {/* Queue reply: creates a pending action from the draft_reply text. Sending only happens when the
                action is Approved in the Pending section — this button never sends directly. */}
            <button type="button" className="btn-primary" disabled={busy}
              onClick={() => create.mutate({ type: 'reply', threadId: t.id, payload: { text: t.draft_reply ?? '' } }, { onSuccess: close })}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="play" size={14} /> Queue reply
            </button>
          </div>
        ),
      }} />
  );
}

// ─── Chat intel section ───────────────────────────────────────────────────────

function ChatIntelSection() {
  const chats       = useAgentChats();
  const setMonitor  = useSetChatMonitor();
  const opps        = useAgentOpportunities('new');
  const patchOpp    = usePatchOpportunity();

  return (
    <SectionCard title="Chat intel" icon="bots" delay={30} style={{ marginBottom: 16 }}>
      {/* ── Monitored chats ── */}
      <div style={{ marginBottom: 16 }}>
        <div
          className="text-eyebrow"
          style={{ color: 'var(--color-ink-dim)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}
        >
          Monitored chats
        </div>
        {chats.data && chats.data.length === 0 && (
          <EmptyState
            icon="bots"
            title="No joined groups"
            note="Add the agent account to chats in Telegram first, then refresh."
          />
        )}
        {chats.data && chats.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Group</th>
                  <th style={{ width: 80, textAlign: 'right' }}>Monitor</th>
                </tr>
              </thead>
              <tbody>
                {chats.data.map((c) => (
                  <tr key={c.chatId}>
                    <td className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
                      {c.title}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        disabled={setMonitor.isPending}
                        onChange={(e) =>
                          setMonitor.mutate({ chatId: c.chatId, enabled: e.target.checked })
                        }
                        title={c.enabled ? 'Disable monitoring' : 'Enable monitoring'}
                        style={{ cursor: 'pointer', width: 16, height: 16 }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Opportunities feed ── */}
      <div>
        <div
          className="text-eyebrow"
          style={{ color: 'var(--color-ink-dim)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}
        >
          New opportunities
        </div>
        {opps.data && opps.data.length === 0 && (
          <div className="text-body-sm" style={{ color: 'var(--color-ink-dim)', padding: '4px 0' }}>
            No new opportunities.
          </div>
        )}
        {opps.data && opps.data.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {opps.data.map((o) => (
              <div
                key={o.id}
                className="card"
                style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '13px 18px' }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    <Badge tone={KIND_TONE[o.kind]}>{KIND_LABEL[o.kind]}</Badge>
                    <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                      score {o.score}
                    </span>
                    {o.chat_title && (
                      <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
                        {o.chat_title}
                      </span>
                    )}
                    {o.suggested_action && (
                      <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                        → {ACTION_LABEL[o.suggested_action] ?? o.suggested_action}
                      </span>
                    )}
                  </div>
                  {o.summary && (
                    <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
                      {o.summary}
                    </div>
                  )}
                </div>
                <RowActions
                  danger={
                    <TableAction
                      icon="trash"
                      danger
                      title="Archive"
                      disabled={patchOpp.isPending}
                      onClick={() => patchOpp.mutate({ id: o.id, status: 'archived' })}
                    />
                  }
                >
                  <TableAction
                    icon="check"
                    title="Mark reviewed"
                    disabled={patchOpp.isPending}
                    onClick={() => patchOpp.mutate({ id: o.id, status: 'reviewed' })}
                  />
                </RowActions>
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function AgentPage() {
  const cat: CatFilter = Route.useSearch().cat ?? 'all';
  const navigate = Route.useNavigate();
  const setCat = (c: CatFilter) => navigate({ search: c === 'all' ? {} : { cat: c }, replace: true });
  const status  = useAgentStatus();
  const inbox   = useAgentInbox(cat === 'all' ? {} : { category: cat });
  const actions = useAgentActions('pending');

  return (
    <div>
      <PageHeader
        title="DM inbox"
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
              ? fmtDate(status.data.lastPolledAt)
              : 'never'}
          </div>
        )}
      </SectionCard>

      {/* ── Chat intel ──────────────────────────────────────────────────────── */}
      <ChatIntelSection />

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
          <div className="compact-grid">
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

      <div className="compact-grid">
        {inbox.data?.map((t, i) => <ThreadCard key={t.id} t={t} index={i} />)}
      </div>
    </div>
  );
}
