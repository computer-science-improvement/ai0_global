import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, StatTile, StatStrip, EmptyState, Field } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { TableAction, RowActions } from '../components/ui/table';
import { Icon } from '../components/ui/Icon';
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
import '../components/dm/dm.css';

type CatFilter = 'all' | AgentCategory;

const CATS: CatFilter[] = ['all', 'ad', 'vp', 'question', 'spam', 'other'];

// Spec 027 FR-002: the DM triage page ("DM inbox", formerly "Agent" at /app/agent,
// which now redirects here with its search params). ?cat= keeps the category tab linkable.
export const Route = createFileRoute('/app/dm')({
  validateSearch: (s: Record<string, unknown>): { cat?: CatFilter } =>
    CATS.includes(s.cat as CatFilter) && s.cat !== 'all' ? { cat: s.cat as CatFilter } : {},
  component: DmPage,
});

// Amber is the colour of the human (approve, needs you); spam is not a call the owner has to make, so it reads neutral.
const CAT_TONE: Record<AgentCategory, 'accent' | 'success' | 'neutral' | 'warning'> = {
  ad:       'accent',
  vp:       'success',
  question: 'neutral',
  spam:     'neutral',
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
        <span className="dm-target mono">{target}</span>
        {textChanged && <span className="chip">edited</span>}
      </>}
      meta={when ?? fmtRelative(action.created_at)}
      body={editedText || <span className="dm-meta">No text</span>}
      note={action.error ?? undefined}
      noteTone="danger"
      dialog={{
        size: 'lg', icon: 'check', title: action.type === 'reply' ? 'Reply' : action.type.replace(/_/g, ' '),
        subtitle: `${target}${when ? ` · ${when}` : ''} · nothing is sent until you approve`,
        body: () => (
          <div className="dm-detail">
            <Field label="Text" hint="Edit it before approving; an edited text becomes a new action to approve." style={{ marginBottom: 0 }}>
              <textarea className="input-field dm-textarea" value={editedText} onChange={(e) => setEditedText(e.target.value)} rows={8} />
            </Field>
            {textChanged && (
              <div className="dm-hint" style={{ marginTop: 0 }}>
                Text edited — Approve will create a new action with the updated text.
              </div>
            )}
            {action.error && (
              <div className="callout-danger"><span className="text-micro" style={{ overflowWrap: 'anywhere' }}>{action.error}</span></div>
            )}
            {err && (
              <div className="callout-danger"><span className="text-micro">{describeError(err)}</span></div>
            )}
          </div>
        ),
        actions: (close) => (
          <div className="dm-actions">
            <button type="button" className="btn-ghost dm-danger dm-push" disabled={busy} onClick={() => reject.mutate(action.id, { onSuccess: close })}>
              <Icon name="ban" size={14} /> Reject
            </button>
            {textChanged && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditedText(storedText)}>Undo edits</button>
            )}
            <button type="button" className="btn-primary" disabled={busy} onClick={() => handleApprove(close)}>
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
        <span className="dm-peer">{peer}</span>
        <Badge tone={CAT_TONE[t.category]}>{t.category}</Badge>
        <span className="dm-meta mono">score {t.score}</span>
        {/* Spec 026 FR-016: the DM came from a landing CTA (its prefilled ai0web tag). */}
        {landing && <span className="chip" title={`Opened from the public landing (${t.fields.placement ?? 'unknown'} button)${t.fields.channel ? `, about ${t.fields.channel}` : ''}`}>{landing}</span>}
      </>}
      meta={<span title={fmtDate(t.last_message_at)}>{fmtRelative(t.last_message_at)}</span>}
      body={t.summary ?? t.last_text ?? undefined}
      extra={t.draft_reply ? <span className="dm-ready">Draft reply ready</span> : undefined}
      dialog={{
        size: 'lg', icon: 'chat', title: peer,
        subtitle: `${t.category} · score ${t.score} · last message ${fmtDate(t.last_message_at)}`,
        body: () => (
          <div className="dm-detail">
            <div className="dm-chips">
              <Badge tone={CAT_TONE[t.category]}>{t.category}</Badge>
              <span className="dm-meta mono">score {t.score}</span>
              {t.peer_username && <span className="dm-meta is-muted mono">@{t.peer_username}</span>}
              {landing && <span className="chip">{landing}</span>}
            </div>
            {t.summary && (
              <div>
                <div className="text-overline dm-key">Summary</div>
                <div className="dm-text">{t.summary}</div>
              </div>
            )}
            {t.last_text && (
              <div>
                <div className="text-overline dm-key">Last message</div>
                <div className="dm-text is-muted">{t.last_text}</div>
              </div>
            )}
            <div>
              <div className="text-overline dm-key">Draft reply</div>
              {t.draft_reply
                ? <div className="inset dm-text">{t.draft_reply}</div>
                : <span className="dm-meta">No draft reply.</span>}
              <p className="dm-hint">
                Queue reply adds it to Pending actions above; it is sent only when you approve it there.
              </p>
            </div>
            {err && <div className="callout-danger"><span className="text-micro">{describeError(err)}</span></div>}
          </div>
        ),
        actions: (close) => (
          <div className="dm-actions">
            <button type="button" className="btn-ghost dm-danger dm-push" disabled={busy} onClick={() => patch.mutate({ id: t.id, status: 'archived' }, { onSuccess: close })}>
              <Icon name="trash" size={14} /> Archive
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => patch.mutate({ id: t.id, status: 'reviewed' }, { onSuccess: close })}>
              <Icon name="check" size={14} /> Mark reviewed
            </button>
            {/* Queue reply: creates a pending action from the draft_reply text. Sending only happens when the
                action is Approved in the Pending section — this button never sends directly. */}
            <button type="button" className="btn-primary" disabled={busy}
              onClick={() => create.mutate({ type: 'reply', threadId: t.id, payload: { text: t.draft_reply ?? '' } }, { onSuccess: close })}>
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
  const monitored   = chats.data?.filter((c) => c.enabled).length ?? 0;

  return (
    <div className="dm-intel">
      {/* ── Monitored chats ── */}
      {chats.data && (
        <SectionCard title="Monitored chats" flush delay={30}
          action={chats.data.length > 0 ? <span className="dm-count mono">{monitored} of {chats.data.length}</span> : undefined}>
          {chats.data.length === 0 ? (
            <EmptyState
              icon="bots"
              title="No joined groups"
              note="Add the agent account to chats in Telegram first, then refresh."
            />
          ) : chats.data.map((c) => (
            <div className="panel-row" key={c.chatId}>
              <div className="dm-grow"><span className="dm-chat">{c.title}</span></div>
              <button
                type="button"
                className="chip-toggle"
                aria-pressed={c.enabled}
                aria-label={`Monitor ${c.title}`}
                disabled={setMonitor.isPending}
                title={c.enabled ? 'Disable monitoring' : 'Enable monitoring'}
                onClick={() => setMonitor.mutate({ chatId: c.chatId, enabled: !c.enabled })}
              >
                Monitor
              </button>
            </div>
          ))}
        </SectionCard>
      )}

      {/* ── Opportunities feed ── */}
      {opps.data && (
        <SectionCard title="New opportunities" flush delay={40}
          action={opps.data.length > 0 ? <span className="dm-count mono">{opps.data.length}</span> : undefined}>
          {opps.data.length === 0 ? (
            <EmptyState icon="sparkles" title="No new opportunities" note="Ad offers and cross-promo requests seen in the monitored chats show up here." />
          ) : opps.data.map((o) => (
            <div key={o.id} className="panel-row dm-opp">
              <div className="dm-grow">
                <div className="dm-opp-top">
                  <Badge tone={KIND_TONE[o.kind]}>{KIND_LABEL[o.kind]}</Badge>
                  <span className="dm-meta mono">score {o.score}</span>
                  {o.chat_title && <span className="dm-meta is-muted">{o.chat_title}</span>}
                  {o.suggested_action && (
                    <span className="dm-meta">→ {ACTION_LABEL[o.suggested_action] ?? o.suggested_action}</span>
                  )}
                </div>
                {o.summary && <p className="dm-opp-summary clamp">{o.summary}</p>}
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
        </SectionCard>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function DmPage() {
  const cat: CatFilter = Route.useSearch().cat ?? 'all';
  const navigate = Route.useNavigate();
  const setCat = (c: CatFilter) => navigate({ search: c === 'all' ? {} : { cat: c }, replace: true });
  const status  = useAgentStatus();
  // The unfiltered list gives the tab counts; with the "All" tab selected it is also the list (one request: same query key).
  const everything = useAgentInbox({});
  const inbox   = useAgentInbox(cat === 'all' ? {} : { category: cat });
  const actions = useAgentActions('pending');
  const opps    = useAgentOpportunities('new');

  const counts: Record<CatFilter, number> | null = everything.data
    ? { all: everything.data.length, ad: 0, vp: 0, question: 0, spam: 0, other: 0 }
    : null;
  if (counts && everything.data) for (const t of everything.data) counts[t.category] += 1;
  const tabs = TABS.map((t) => ({ ...t, count: counts?.[t.key] }));

  const pending = actions.data?.length ?? 0;
  const s = status.data;

  return (
    <div>
      <PageHeader
        eyebrow="Telegram · triage"
        title="DM inbox"
        subtitle="Incoming DMs triaged by the agent. Review drafts here — nothing is sent automatically."
      />

      <div className="dm-stack">
        {/* ── Agent status ──────────────────────────────────────────────────── */}
        {status.isLoading ? (
          <div className="panel is-section dm-skeleton compose-rise" aria-hidden />
        ) : !s?.hasAgentSession ? (
          <SectionCard title="Agent status" delay={20}>
            <EmptyState
              icon="bots"
              title="No agent session"
              note={<>Add an MTProto session and set its role to 'agent' in <Link to="/app/connections" search={{ section: 'telegram', tab: 'sessions' }} className="link-accent">Connections → Sessions</Link>.</>}
            />
          </SectionCard>
        ) : (
          <StatStrip label="Agent status">
            <StatTile label="Polling" value={s.enabled ? 'On' : 'Off'} deltaTone={s.enabled ? 'success' : 'warning'} delta={s.cadence} />
            <StatTile label="Last polled" value={s.lastPolledAt ? fmtRelative(s.lastPolledAt) : 'Never'} delta={s.lastPolledAt ? fmtDate(s.lastPolledAt) : undefined} />
            <StatTile label="Pending actions" value={pending} deltaTone="warning" delta={pending > 0 ? 'waiting for you' : undefined} />
            <StatTile label="New opportunities" value={opps.data?.length ?? 0} />
          </StatStrip>
        )}

        {/* ── Chat intel ──────────────────────────────────────────────────────── */}
        <ChatIntelSection />

        {/* ── Pending actions ─────────────────────────────────────────────────── */}
        <SectionCard
          title="Pending actions"
          delay={40}
          action={pending > 0 ? <Badge tone="warning">{pending}</Badge> : undefined}
        >
          {!actions.data || actions.data.length === 0 ? (
            <EmptyState tone="clear" title="Nothing to approve" note="Replies you queue from a thread wait here until you approve them." />
          ) : (
            <div className="compact-grid">
              {actions.data.map((a) => (
                <PendingActionRow key={a.id} action={a} />
              ))}
            </div>
          )}
        </SectionCard>

        {/* ── Inbox ───────────────────────────────────────────────────────────── */}
        <SectionCard title="Triaged threads" delay={60}>
          <div className="dm-tabs">
            <SegmentedTabs<CatFilter> value={cat} onChange={setCat} options={tabs} ariaLabel="Thread category" />
          </div>

          {inbox.data && inbox.data.length === 0 && (
            <EmptyState
              icon="bots"
              title="Inbox empty"
              note={cat === 'all' ? 'Triaged DM threads will show up here.' : 'No threads in this category.'}
            />
          )}

          <div className="compact-grid">
            {inbox.data?.map((t, i) => <ThreadCard key={t.id} t={t} index={i} />)}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
