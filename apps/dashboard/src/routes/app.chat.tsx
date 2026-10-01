import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../components/ui/Icon';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/primitives';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { describeError, toast } from '../components/ui/Toast';
import { DraftCard, DRAFT_TONE } from '../components/chat/DraftCard';
import { ToolChips, type ToolActivity } from '../components/chat/ToolChips';
import { MarkdownLite } from '../lib/markdown-lite';
import { fmtKyiv } from '../lib/kyiv-time';
import { fmtRelative } from '../lib/format';
import { useMediaQuery } from '../lib/useMediaQuery';
import {
  streamChatMessage, useChat, useChatChannels, useChats, useCreateChat, useDeleteChat, useDrafts, useInvalidateChat,
} from '../api/chat';
import type { EditorChatEvent, EditorChatMessage, EditorDraft } from '../api/types';

// Editor chat (spec 010): a Claude-style conversation with the composer agent.
// Left: chats + upcoming scheduled posts. Centre: the thread with live tool
// chips and draft cards (publish now / schedule / cancel). Bottom: the composer.

export const Route = createFileRoute('/app/chat')({
  validateSearch: (s: Record<string, unknown>): { c?: string } => ({ c: typeof s.c === 'string' ? s.c : undefined }),
  component: ChatPage,
});

interface LiveTurn {
  userText:   string;
  activities: ToolActivity[];
  text:       string;
  drafts:     Record<string, EditorDraft>;
  /** How many saved messages existed when this turn started (later ones belong to the turn). */
  base:       number;
}

const EXAMPLES = [
  'Зроби пост про найсвіжішу новину з космосу',
  'Підготуй вікторину з 4 варіантами на тему фільму тижня',
  'Зроби пост про цю статтю і заплануй на завтра о 19:00: https://',
];

function ChatPage() {
  const { c: chatId } = Route.useSearch();
  const navigate = Route.useNavigate();
  const isMobile = useMediaQuery('(max-width: 860px)');
  const [listOpen, setListOpen] = useState(false);

  const chat = useChat(chatId);
  const createChat = useCreateChat();
  const invalidate = useInvalidateChat();

  const [input, setInput] = useState('');
  const [channel, setChannel] = useState('');
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [activityByMsg, setActivityByMsg] = useState<Record<number, ToolActivity[]>>({});
  const activitiesRef = useRef<ToolActivity[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const messages = chat.data?.messages ?? [];
  const shown = live ? messages.slice(0, live.base) : messages;

  // Drafts by id: server state, overlaid with the live turn's fresher copies.
  const drafts = useMemo(() => {
    const m: Record<string, EditorDraft> = {};
    for (const d of chat.data?.drafts ?? []) m[d.id] = d;
    return { ...m, ...(live?.drafts ?? {}) };
  }, [chat.data?.drafts, live?.drafts]);

  // A draft card renders under the LAST message that touched it; earlier mentions get a short pointer.
  const lastMention = useMemo(() => {
    const m: Record<string, number> = {};
    for (const msg of shown) for (const id of msg.draftIds) m[id] = msg.id;
    return m;
  }, [shown]);

  // The chat's channel defaults to its latest draft's channel.
  useEffect(() => {
    const latest = [...(chat.data?.drafts ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    setChannel(latest?.channelKey ?? '');
  }, [chatId, chat.data?.drafts]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [shown.length, live?.activities.length, live?.text, chatId]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const gotReplyRef = useRef(false);
  const onEvent = (e: EditorChatEvent) => {
    if (e.type === 'message' || e.type === 'error') gotReplyRef.current = true;
    if (e.type === 'tool_call') {
      const a: ToolActivity = { id: activitiesRef.current.length + 1, name: e.name, args: e.args };
      activitiesRef.current = [...activitiesRef.current, a];
    } else if (e.type === 'tool_result') {
      const list = [...activitiesRef.current];
      const i = list.map((x) => x.name === e.name && x.ok === undefined).lastIndexOf(true);
      if (i >= 0) list[i] = { ...list[i], ok: e.ok, summary: e.summary };
      activitiesRef.current = list;
    } else if (e.type === 'message') {
      const acts = activitiesRef.current;
      if (acts.length) setActivityByMsg((m) => ({ ...m, [e.message.id]: acts }));
    } else if (e.type === 'error') {
      toast.error(`Agent: ${e.error}`);
    }
    setLive((t) => {
      if (!t) return t;
      if (e.type === 'text') return { ...t, text: e.text };
      if (e.type === 'draft') return { ...t, drafts: { ...t.drafts, [e.draft.id]: e.draft } };
      return { ...t, activities: activitiesRef.current };
    });
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || live) return;
    let id = chatId;
    try {
      if (!id) {
        id = (await createChat.mutateAsync()).id;
        if (!id) throw new Error('the server did not return a chat id');
        navigate({ search: { c: id } });
      }
    } catch (err: any) {
      toast.error(`Could not start a chat: ${describeError(err)}`);
      return;
    }
    const first = !id || !messages.length || id !== chatId;
    const full = first && channel && !text.includes(channel) ? `Канал: ${channel}\n${text}` : text;
    setInput('');
    activitiesRef.current = [];
    setLive({ userText: full, activities: [], text: '', drafts: {}, base: id === chatId ? messages.length : 0 });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    gotReplyRef.current = false;
    try {
      await streamChatMessage(id, { text: full, channel: channel || null }, onEvent, ctrl.signal);
      // The stream closed without a reply or an error (server restarted mid-run, proxy cut it…):
      // never let the user's text vanish silently.
      if (!gotReplyRef.current) {
        setInput(text);
        toast.error('No reply from the agent — your message is back in the box, try again.');
      }
    } catch (err: any) {
      if (ctrl.signal.aborted) {
        toast.success('Stopped. The agent may still finish in the background — its reply will appear here.');
        setTimeout(() => invalidate(), 15_000);
      } else {
        setInput(text);
        toast.error(describeError(err));
      }
    } finally {
      abortRef.current = null;
      await invalidate();
      setLive(null);
    }
  };

  const stop = () => abortRef.current?.abort();

  const sidebar = <ChatSidebar activeId={chatId} onPick={(id) => { setListOpen(false); navigate({ search: { c: id } }); }}
    onNew={() => { setListOpen(false); navigate({ search: {} }); }} />;

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '260px 1fr', gap: 16,
      height: isMobile ? 'calc(100dvh - 120px)' : 'calc(100dvh - 140px)', minHeight: 420,
    }}>
      {!isMobile && sidebar}
      {isMobile && listOpen && (
        <>
          <div onClick={() => setListOpen(false)} aria-hidden
            style={{ position: 'fixed', inset: 0, zIndex: 55, background: 'rgba(0,0,0,0.5)' }} />
          <div style={{ position: 'fixed', top: 0, bottom: 0, left: 0, width: 'min(300px, 85vw)', zIndex: 56, padding: 12, background: 'var(--color-canvas)', borderRight: '1px solid var(--color-hairline)' }}>
            {sidebar}
          </div>
        </>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10, borderBottom: '1px solid var(--color-hairline-soft)' }}>
          {isMobile && (
            <button className="btn-icon" onClick={() => setListOpen(true)} aria-label="Chats" style={{ width: 34, height: 34 }}>
              <Icon name="panel-left" size={16} />
            </button>
          )}
          <h1 className="text-subhead" style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {chat.data?.chat?.title ?? 'New chat'}
          </h1>
          {live && <span className="text-micro" style={{ color: 'var(--color-ink-muted)', marginLeft: 'auto' }}>agent is working…</span>}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 2px' }}>
          {chat.data?.enabled === false && (
            <div className="callout-warning" style={{ marginBottom: 12 }}>
              <Icon name="warning" size={16} /><span>Chat is disabled: <code>OPENROUTER_API_KEY</code> is not set on the server.</span>
            </div>
          )}
          {chat.error && <div className="callout-danger">{describeError(chat.error)}</div>}

          {!shown.length && !live && (
            <EmptyState icon="chat" title="What are we writing?"
              note="Name a channel and a topic. The agent researches sources, saves a draft and shows a preview. It publishes or schedules only when you ask explicitly or press a button. Write to it in Ukrainian."
              action={
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
                  {EXAMPLES.map((x) => <button key={x} className="btn-tiny" onClick={() => setInput(x)}>{x}</button>)}
                </div>
              } />
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 780, margin: '0 auto' }}>
            {shown.map((m) => (
              <Message key={m.id} m={m} drafts={drafts} lastMention={lastMention} activities={activityByMsg[m.id] ?? []} />
            ))}
            {live && (
              <>
                <UserBubble text={live.userText} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <AgentGlyph />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <ToolChips items={live.activities} />
                    {live.text && <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginBottom: 8 }}><MarkdownLite text={live.text} /></div>}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {Object.values(live.drafts).map((d) => <DraftCard key={d.id} draft={d} />)}
                    </div>
                    <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>…</span>
                  </div>
                </div>
              </>
            )}
            <div ref={endRef} />
          </div>
        </div>

        <Composer value={input} onChange={setInput} onSend={() => send()} onStop={stop} busy={!!live}
          channel={channel} onChannel={setChannel} disabled={chat.data?.enabled === false} />
      </section>
    </div>
  );
}

function AgentGlyph() {
  return (
    <div aria-hidden style={{
      width: 28, height: 28, flexShrink: 0, borderRadius: 'var(--radius-pill)', display: 'grid', placeItems: 'center',
      background: 'var(--color-success-soft)', color: 'var(--color-accent)',
    }}>
      <Icon name="sparkles" size={14} />
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div className="text-body-sm" style={{
        maxWidth: '85%', background: 'var(--color-surface-3)', color: 'var(--color-ink)', borderRadius: 'var(--radius-lg)',
        padding: '9px 13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>{text}</div>
    </div>
  );
}

function Message({ m, drafts, lastMention, activities }: {
  m: EditorChatMessage; drafts: Record<string, EditorDraft>; lastMention: Record<string, number>; activities: ToolActivity[];
}) {
  if (m.role === 'user') return <UserBubble text={m.content} />;
  const own = m.draftIds.filter((id) => drafts[id]);
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <AgentGlyph />
      <div style={{ minWidth: 0, flex: 1 }}>
        <ToolChips items={activities} />
        <div className="text-body-sm" style={{ color: 'var(--color-ink)', lineHeight: 1.55, wordBreak: 'break-word' }}>
          <MarkdownLite text={m.content} />
        </div>
        {own.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
            {own.map((id) => (lastMention[id] === m.id
              ? <DraftCard key={id} draft={drafts[id]} />
              : (
                <span key={id} className="text-micro" style={{ color: 'var(--color-ink-dim)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="pencil" size={11} /> draft “{drafts[id].spec.title ?? id.slice(0, 8)}” — updated version below
                </span>
              )))}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ value, onChange, onSend, onStop, busy, channel, onChannel, disabled }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; busy: boolean;
  channel: string; onChannel: (v: string) => void; disabled: boolean;
}) {
  const channels = useChatChannels();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure from 0 — with 'auto' the layout can report the stretched box, not the content (was always 200px).
    el.style.height = '0px';
    el.style.height = `${Math.max(48, Math.min(el.scrollHeight, 200))}px`;
  }, [value]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!busy && !disabled) onSend();
    }
  };
  return (
    <div className="panel" style={{ padding: 10, marginTop: 6 }}>
      <textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} rows={2} disabled={disabled}
        placeholder="Describe the post you want… Enter to send, Shift+Enter for a new line"
        className="text-body-sm"
        style={{ width: '100%', resize: 'none', border: 'none', outline: 'none', background: 'transparent', color: 'var(--color-ink)', lineHeight: 1.5, padding: '4px 4px 8px' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <select className="input-field" value={channel} onChange={(e) => onChannel(e.target.value)} disabled={busy}
          style={{ padding: '5px 10px', fontSize: 13, maxWidth: 240 }} aria-label="Channel">
          <option value="">Channel: agent will ask</option>
          {(channels.data ?? []).map((c) => (
            <option key={c.channelKey} value={c.channelKey}>
              {c.channelKey}{c.title ? ` · ${c.title}` : ''}{c.hasCard ? '' : ' (no card)'}
            </option>
          ))}
        </select>
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Publishes only when you explicitly ask</span>
        {busy
          ? (
            <button className="btn-secondary" onClick={onStop} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="stop" size={13} /> Stop
            </button>
          )
          : (
            <button className="btn-primary" onClick={onSend} disabled={!value.trim() || disabled} aria-label="Send"
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="arrow-up" size={14} /> Send
            </button>
          )}
      </div>
    </div>
  );
}

function ChatSidebar({ activeId, onPick, onNew }: { activeId?: string; onPick: (id: string) => void; onNew: () => void }) {
  const chats = useChats();
  const scheduled = useDrafts('scheduled');
  const del = useDeleteChat();
  const confirm = useConfirm();
  const navigate = Route.useNavigate();
  return (
    <aside style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0, overflowY: 'auto' }}>
      <button className="btn-primary" onClick={onNew} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <Icon name="plus" size={14} /> New chat
      </button>

      <div>
        <div className="text-eyebrow" style={{ marginBottom: 6 }}>Chats</div>
        {(chats.data ?? []).length === 0
          ? <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{chats.isLoading ? '…' : 'No conversations yet'}</span>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {chats.data!.map((c) => (
                <div key={c.id} className="row-lift" style={{
                  display: 'flex', alignItems: 'center', gap: 6, borderRadius: 'var(--radius-sm)', padding: '6px 6px 6px 10px',
                  background: c.id === activeId ? 'var(--color-surface-3)' : 'transparent',
                }}>
                  <button type="button" onClick={() => onPick(c.id)} style={{
                    flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-ink)', padding: 0,
                  }}>
                    <div className="text-body-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</div>
                    <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{fmtRelative(c.updatedAt)}</div>
                  </button>
                  <button className="btn-act btn-act-danger" title="Delete chat" aria-label="Delete chat" disabled={del.isPending}
                    onClick={async () => {
                      if (!(await confirm(`delete the chat "${c.title}" (drafts and scheduled posts stay)`))) return;
                      del.mutate(c.id, { onSuccess: () => { if (c.id === activeId) navigate({ search: {} }); } });
                    }}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
      </div>

      <div>
        <div className="text-eyebrow" style={{ marginBottom: 6 }}>Scheduled</div>
        {(scheduled.data ?? []).length === 0
          ? <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>No scheduled posts</span>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {scheduled.data!.map((d) => (
                <button key={d.id} type="button" className="card row-lift" disabled={!d.chatId}
                  onClick={() => d.chatId && onPick(d.chatId)}
                  style={{ textAlign: 'left', padding: '8px 10px', cursor: d.chatId ? 'pointer' : 'default', color: 'var(--color-ink)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span className="text-micro tabular-nums" style={{ color: 'var(--color-warning)', fontWeight: 600 }}>{fmtKyiv(d.scheduledAt)}</span>
                    <Badge tone={DRAFT_TONE[d.status]}>{d.spec.format ?? 'post'}</Badge>
                  </div>
                  <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{d.channelKey}</div>
                  <div className="text-body-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.spec.title ?? '—'}</div>
                </button>
              ))}
            </div>
          )}
      </div>
    </aside>
  );
}
