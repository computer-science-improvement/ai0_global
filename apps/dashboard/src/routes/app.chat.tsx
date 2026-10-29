import { createFileRoute, Link } from '@tanstack/react-router';
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';
import { Icon } from '../components/ui/Icon';
import { Badge } from '../components/ui/Badge';
import { EmptyState } from '../components/ui/primitives';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { describeError, toast } from '../components/ui/Toast';
import { DraftCard } from '../components/chat/DraftCard';
import { ToolChips, type ToolActivity } from '../components/chat/ToolChips';
import { ActionCard, FocusedCardContext } from '../components/chat/ActionCard';
import { NeedsYou, chatsWaiting } from '../components/nav/NeedsYou';
import { useNavAttention } from '../api/nav';
import { MENTION_LIST_ID, MentionMenu, useMentionMenu } from '../components/chat/MentionMenu';
import { chatGroup } from '../lib/chat-groups';
import { artifactMention, artifactParam, parseArtifactParam } from '../lib/artifacts';
import type { ArtifactType } from '../api/artifacts';
import { ArtifactChips, ArtifactOpenContext, mentionedArtifacts } from '../components/artifacts/ArtifactChip';
import { ArtifactPanel } from '../components/artifacts/ArtifactPanel';
import { isSlashCommand, SLASH_LIST_ID, SlashMenu, useSlashMenu } from '../components/chat/SlashMenu';
import { indexTree } from '../components/agents/AgentsUi';
import { ApprovalList } from '../components/approvals/ApprovalList';
import { useApprovals } from '../api/approvals';
import { MarkdownLite } from '../lib/markdown-lite';
import { fmtKyiv } from '../lib/kyiv-time';
import { fmtRelative } from '../lib/format';
import { useMediaQuery } from '../lib/useMediaQuery';
import {
  streamChatMessage, useChat, useChatChannels, useChats, useCreateChat, useDeleteChat, useDrafts, useInvalidateChat,
} from '../api/chat';
import { useAgentHandles, useAgentTree } from '../api/agents';
import type { ChatAgentRef, EditorChatEvent, EditorChatMessage, EditorDraft, PendingAction } from '../api/types';
import '../components/chat/chat.css';

// Editor chat (spec 010): a Claude-style conversation with the composer agent.
// Left: chats + upcoming scheduled posts. Centre: the thread with live tool
// chips and draft cards (publish now / schedule / cancel). Bottom: the composer.
// Spec 018: `@handle` addresses an agent (the manager, the @ai0 builder, an
// orchestrator); the header shows the current addressee, bubbles show who
// answered and agents' confirmation cards render with [Apply] / [Discard].

export const Route = createFileRoute('/app/chat')({
  // `q` prefills the composer once (e.g. "Discuss" on a contested directive → "@manager about …").
  // `card`: a confirmation card to scroll to and open (from "Waiting for you").
  // `art`: the artifact open in the side panel (`type:id`, spec 048 FR-005).
  validateSearch: (s: Record<string, unknown>): { c?: string; q?: string; card?: string; art?: string } => ({
    c: typeof s.c === 'string' ? s.c : undefined,
    card: typeof s.card === 'string' && s.card ? s.card : undefined,
    q: typeof s.q === 'string' && s.q ? s.q.slice(0, 2000) : undefined,
    art: typeof s.art === 'string' && parseArtifactParam(s.art) ? s.art : undefined,
  }),
  component: ChatPage,
});

interface LiveTurn {
  userText:   string;
  activities: ToolActivity[];
  text:       string;
  drafts:     Record<string, EditorDraft>;
  actions:    Record<string, PendingAction>;
  agent:      ChatAgentRef | null;
  /** Spec 047 FR-003: every addressee of a message to several agents, in answer order. */
  addressees: ChatAgentRef[];
  /** Answers already finished in this turn (several addressees): shown before the live one. */
  done:       EditorChatMessage[];
  /** How many saved messages existed when this turn started (later ones belong to the turn). */
  base:       number;
}

type AgentIndex = Map<string, ChatAgentRef>;

const ts = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

const EXAMPLES = [
  'Write a post about the latest space news',
  'Prepare a 4-option quiz about the movie of the week',
  'Write a post about this article and schedule it for tomorrow at 19:00: https://',
];

/** Spec 048 FR-004: the chat list column and the artifact panel (the thread's readable width is `.chat-thread` in chat.css). */
const CHAT_LIST_WIDTH = 272;
const PANEL_WIDTH = 420;

function ChatPage() {
  const { c: chatId, q: prefill, card: focusCard, art: artParam } = Route.useSearch();
  const navigate = Route.useNavigate();
  const isMobile = useMediaQuery('(max-width: 860px)');
  const [listOpen, setListOpen] = useState(false);
  const art = parseArtifactParam(artParam);
  // With the artifact panel open on a narrow desktop, the chat list moves to the drawer so the thread keeps its room.
  const narrow = useMediaQuery('(max-width: 1279px)');
  const listAsDrawer = isMobile || (narrow && !!art);
  // The drawer is a hand-rolled dialog: Escape closes it, like every other dialog.
  useEffect(() => {
    if (!listAsDrawer || !listOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setListOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listAsDrawer, listOpen]);
  const artifactCtx = useMemo(() => ({
    activeKey: artParam ?? null,
    open: (type: ArtifactType, id: string) => navigate({ search: (p) => ({ ...p, art: artifactParam(type, id) }) }),
  }), [artParam, navigate]);
  const closeArtifact = () => navigate({ search: (p) => ({ ...p, art: undefined }) });

  const chat = useChat(chatId);
  const createChat = useCreateChat();
  const invalidate = useInvalidateChat();
  const tree = useAgentTree();
  const handles = useAgentHandles();

  const [input, setInput] = useState(prefill ?? '');
  const [channel, setChannel] = useState('');
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [activityByMsg, setActivityByMsg] = useState<Record<number, ToolActivity[]>>({});
  // Addressees seen in this session's streams (a just-created agent may not be in the tree yet).
  const [seen, setSeen] = useState<Record<string, ChatAgentRef>>({});
  const [lastAgent, setLastAgent] = useState<{ chatId: string; agent: ChatAgentRef } | null>(null);
  const activitiesRef = useRef<ToolActivity[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const messages = chat.data?.messages ?? [];
  const shown = live ? messages.slice(0, live.base) : messages;

  // agentId → who (the registry tree, overlaid with addressees seen in streams).
  const agentIndex: AgentIndex = useMemo(() => {
    const m: AgentIndex = new Map();
    for (const [id, n] of indexTree(tree.data?.agents)) m.set(id, { id, handle: n.handle, name: n.name, emoji: n.emoji, kind: n.kind });
    for (const a of Object.values(seen)) m.set(a.id, a);
    return m;
  }, [tree.data?.agents, seen]);

  const chatAgentId = chat.data?.chat?.agentId ?? null;
  const addressee: ChatAgentRef | null = live?.agent
    ?? (lastAgent && lastAgent.chatId === chatId ? lastAgent.agent : null)
    ?? (chatAgentId ? agentIndex.get(chatAgentId) ?? null : null);

  // Spec 031: the addressed agent's channel, for its "Posts to approve" strip.
  const approvalChannel = useMemo(() => {
    const nodes = indexTree(tree.data?.agents);
    const n = addressee ? nodes.get(addressee.id) : undefined;
    const orch = n?.parentId ? nodes.get(n.parentId) : n;
    const ref = orch?.scope === 'resource' ? orch.scopeId : null;
    return ref?.startsWith('telegram:') ? ref.slice('telegram:'.length) : null;
  }, [tree.data?.agents, addressee]);

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

  // Action cards in place: a card belongs to the reply of the turn that proposed it
  // (the first assistant message at/after its createdAt). A card with no later reply
  // (an aborted turn) stands alone at its time among the messages.
  const placement = useMemo(() => {
    const byMsg: Record<number, PendingAction[]> = {};
    const loose: PendingAction[] = [];
    const acts = (chat.data?.actions ?? []).filter((a) => !live?.actions[a.id]).sort((x, y) => ts(x.createdAt) - ts(y.createdAt));
    for (const a of acts) {
      const host = shown.find((m) => m.role === 'assistant' && ts(m.createdAt) >= ts(a.createdAt));
      if (host) (byMsg[host.id] ??= []).push(a);
      else loose.push(a);
    }
    return { byMsg, loose };
  }, [chat.data?.actions, live?.actions, shown]);

  // The chat's channel defaults to its latest draft's channel.
  useEffect(() => {
    const latest = [...(chat.data?.drafts ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    setChannel(latest?.channelKey ?? '');
  }, [chatId, chat.data?.drafts]);

  useEffect(() => {
    if (focusCard) return; // the linked card scrolls itself into view
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [shown.length, live?.activities.length, live?.text, live && Object.keys(live.actions).length, chatId, focusCard]);
  // The card has scrolled into view and opened: drop the param so the thread follows new messages again.
  useEffect(() => {
    if (!focusCard || !chat.data) return;
    const t = setTimeout(() => navigate({ search: (s) => ({ ...s, card: undefined }), replace: true }), 1500);
    return () => clearTimeout(t);
  }, [focusCard, chat.data, navigate]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // A prefilled message (?q=) lands in the composer once; the URL drops it so a reload does not refill it.
  useEffect(() => {
    if (!prefill) return;
    setInput((cur) => cur || prefill);
    navigate({ search: (s) => ({ ...s, q: undefined }), replace: true });
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const gotReplyRef = useRef(false);
  const onEvent = (e: EditorChatEvent, forChat: string) => {
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
    } else if (e.type === 'addressees') {
      setSeen((s) => ({ ...s, ...Object.fromEntries(e.agents.map((a) => [a.id, a])) }));
    } else if (e.type === 'agent') {
      setSeen((s) => ({ ...s, [e.agent.id]: e.agent }));
      setLastAgent({ chatId: forChat, agent: e.agent });
    } else if (e.type === 'error') {
      toast.error(`Agent: ${e.error}`);
    }
    setLive((t) => {
      if (!t) return t;
      if (e.type === 'text') return { ...t, text: e.text };
      if (e.type === 'draft') return { ...t, drafts: { ...t.drafts, [e.draft.id]: e.draft } };
      if (e.type === 'action') return { ...t, actions: { ...t.actions, [e.action.id]: e.action } };
      if (e.type === 'agent') return { ...t, agent: e.agent };
      if (e.type === 'addressees') return { ...t, addressees: e.agents };
      // Several addressees: a finished answer moves above the live bubble, the next agent streams from scratch.
      if (e.type === 'message' && t.addressees.length > 1) {
        activitiesRef.current = [];
        return { ...t, done: [...t.done, e.message], text: '', activities: [] };
      }
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
    // A message to an agent goes without the "Channel:" line — its @channel would read as a mention.
    const known = new Set((handles.data?.agents ?? []).map((a) => a.handle.toLowerCase()));
    const toAgent = [...text.matchAll(/(^|[^\p{L}\p{N}_@])@([A-Za-z][A-Za-z0-9_]{1,63})/gu)].some((m) => known.has(m[2].toLowerCase()));
    // A slash command (spec 048 FR-003) goes as typed: the server reads the picked channel from the request.
    const full = first && channel && !toAgent && !isSlashCommand(text) && !text.includes(channel) ? `Channel: ${channel}\n${text}` : text;
    setInput('');
    activitiesRef.current = [];
    setLive({ userText: full, activities: [], text: '', drafts: {}, actions: {}, agent: null, addressees: [], done: [], base: id === chatId ? messages.length : 0 });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    gotReplyRef.current = false;
    const forChat = id;
    try {
      await streamChatMessage(id, { text: full, channel: channel || null }, (e) => onEvent(e, forChat), ctrl.signal);
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

  /** "Ask the agent": the artifact's reference and the cursor go into the composer (spec 048 FR-005). */
  const askAbout = (type: ArtifactType, id: string) => {
    const ref = artifactMention(type, id);
    const next = input.includes(ref) ? input : `${ref} ${input}`.trimEnd() + ' ';
    setInput(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) { el.focus(); el.setSelectionRange(next.length, next.length); }
    });
  };

  const pick = (x: string) => {
    setInput(x);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) { el.focus(); el.setSelectionRange(x.length, x.length); }
    });
  };

  const sidebar = <ChatSidebar activeId={chatId} onPick={(id) => { setListOpen(false); navigate({ search: { c: id } }); }}
    onNew={() => { setListOpen(false); navigate({ search: {} }); }} />;

  const firstOrch = (handles.data?.agents ?? []).find((a) => a.kind === 'orchestrator');
  const agentExamples = [
    '@ai0 create an agent for my new channel',
    '@manager what is the weakest spot in the network right now?',
    ...(firstOrch ? [`@${firstOrch.handle} why did you skip a slot yesterday?`] : []),
  ];

  return (
    // Spec 048 FR-004: the page fills the shell's full-bleed main — chat list | thread (readable width) | artifact panel.
    <div className="chat-grid" style={{
      gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : `${listAsDrawer ? '' : `${CHAT_LIST_WIDTH}px `}minmax(0, 1fr)${art ? ` ${PANEL_WIDTH}px` : ''}`,
    }}>
      {!listAsDrawer && <div className="chat-list">{sidebar}</div>}
      {listAsDrawer && listOpen && (
        <>
          <div className="chat-scrim" onClick={() => setListOpen(false)} aria-hidden />
          <div className="chat-drawer anim-fade-up" role="dialog" aria-label="Chats">{sidebar}</div>
        </>
      )}

      <section className="chat-main">
        <div className="chat-head">
          {listAsDrawer && (
            <button type="button" className="btn-ghost" onClick={() => setListOpen(true)} aria-label="Chats" style={{ flexShrink: 0 }}>
              <Icon name="panel-left" size={16} />
            </button>
          )}
          <h1 className="text-subhead chat-title">{chat.data?.chat?.title ?? 'New chat'}</h1>
          <span className="chat-head-end">
            {live && (
              <span className="text-micro chat-live"
                title={live.addressees.length > 1 ? live.addressees.map((a) => `@${a.handle}`).join(', ') : undefined}>
                {live.addressees.length > 1
                  ? `To ${live.addressees.map((a) => `@${a.handle}`).join(', ')} · ${live.agent ? `${live.agent.name} is answering (${live.done.length + 1}/${live.addressees.length})` : 'starting…'}`
                  : live.agent ? `${live.agent.name} is working…` : 'agent is working…'}
              </span>
            )}
            {addressee && !live && <Addressee agent={addressee} compact={isMobile} />}
          </span>
        </div>

        {/* What the Chat menu counter counts: cards in any chat that still need a confirmation. Above the thread,
            which scrolls to its end, so it is always in view. */}
        <NeedsYou show={['chatCards']} currentChatId={chatId} style={{ margin: '10px 0 0', maxHeight: 180, overflowY: 'auto', flexShrink: 0 }} />
        <div className="chat-scroll">
          {approvalChannel && <ApprovalStrip channel={approvalChannel} />}
          {chat.data?.enabled === false && (
            <div className="callout-warning" style={{ marginBottom: 12 }}>
              <Icon name="warning" size={16} /><span>Chat is disabled: <code className="mono">OPENROUTER_API_KEY</code> is not set on the server.</span>
            </div>
          )}
          {chat.error && <div className="callout-danger">{describeError(chat.error)}</div>}

          {!shown.length && !live && (
            <EmptyState icon="chat" title="What are we writing?"
              note="Name a channel and a topic. The agent researches sources, saves a draft and shows a preview. It publishes or schedules only when you ask explicitly or press a button. Write to it in Ukrainian."
              action={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
                  <div className="chat-suggest-group">
                    {EXAMPLES.map((x) => <button key={x} type="button" className="chat-suggest" onClick={() => pick(x)}>{x}</button>)}
                  </div>
                  <div className="text-micro ink-muted" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="agents" size={13} /> Type <kbd className="kbd">@</kbd> to talk to an agent
                  </div>
                  <div className="chat-suggest-group">
                    {agentExamples.map((x) => <button key={x} type="button" className="chat-suggest" onClick={() => pick(x)}>{x}</button>)}
                  </div>
                </div>
              } />
          )}

          <ArtifactOpenContext.Provider value={artifactCtx}>
          <FocusedCardContext.Provider value={focusCard}>
          <div className="chat-thread">
            {shown.map((m, i) => {
              const before = placement.loose.filter((a) => ts(a.createdAt) < ts(m.createdAt) && (i === 0 || ts(a.createdAt) >= ts(shown[i - 1].createdAt)));
              return (
                <Fragment key={m.id}>
                  {before.map((a) => <LooseAction key={a.id} action={a} />)}
                  <Message m={m} drafts={drafts} lastMention={lastMention} activities={activityByMsg[m.id] ?? []}
                    agent={m.agentId ? agentIndex.get(m.agentId) ?? null : null} actions={placement.byMsg[m.id] ?? []} />
                </Fragment>
              );
            })}
            {placement.loose.filter((a) => !shown.length || ts(a.createdAt) >= ts(shown[shown.length - 1].createdAt)).map((a) => <LooseAction key={a.id} action={a} />)}
            {live && (
              <>
                <UserBubble text={live.userText} />
                {live.done.map((m) => (
                  <Message key={m.id} m={m} drafts={drafts} lastMention={lastMention} activities={activityByMsg[m.id] ?? []}
                    agent={m.agentId ? agentIndex.get(m.agentId) ?? null : null} actions={[]} />
                ))}
                <div className="chat-row">
                  <BotGlyph agent={live.agent} />
                  <div className="chat-body">
                    {live.agent && <AgentLine agent={live.agent} />}
                    <ToolChips items={live.activities} />
                    {live.text && <div className="text-body-sm chat-text is-live"><MarkdownLite text={live.text} /></div>}
                    <div className="chat-cards">
                      {Object.values(live.drafts).map((d) => <DraftCard key={d.id} draft={d} />)}
                      {Object.values(live.actions).map((a) => <ActionCard key={a.id} action={a} />)}
                    </div>
                    <span className="text-micro ink-dim">…</span>
                  </div>
                </div>
              </>
            )}
            <div ref={endRef} />
          </div>
          </FocusedCardContext.Provider>
          </ArtifactOpenContext.Provider>
        </div>

        <div className="chat-compose-wrap">
        <Composer value={input} onChange={setInput} onSend={() => send()} onStop={stop} busy={!!live}
          channel={channel} onChannel={setChannel} disabled={chat.data?.enabled === false}
          textareaRef={textareaRef} isMobile={isMobile} />
        </div>
      </section>

      {art && (
        <aside aria-label="Artifact" className={`chat-aside${isMobile ? ' is-sheet' : ''}`}>
          <ArtifactPanel key={artParam} type={art.type} id={art.id} onClose={closeArtifact}
            onAsk={(type, id) => { if (isMobile) closeArtifact(); askAbout(type, id); }} />
        </aside>
      )}
    </div>
  );
}

/** The addressed agent's posts that wait for approval (spec 031), collapsed above the conversation. */
function ApprovalStrip({ channel }: { channel: string }) {
  const q = useApprovals({ channel, status: ['awaiting_approval', 'approved'] });
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const waiting = (q.data?.items ?? []).filter((i) => i.status === 'awaiting_approval').length;
  if (!waiting) return null;
  return (
    // Collapsed by default: one line above the conversation (a button disclosure); the list inside is compact cards.
    <div className="chat-strip">
      <button type="button" className="chat-strip-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <Icon name="check" size={14} />
        <Badge tone="warning">{waiting}</Badge>
        <span className="chat-strip-label">{waiting === 1 ? 'post' : 'posts'} to approve · <span className="mono">{channel}</span></span>
        <span className="chat-strip-chevron"><Icon name="chevron-down" size={14} /></span>
      </button>
      {open && (
        <div id={bodyId} className="chat-strip-body">
          <ApprovalList filter={{ channel }} />
        </div>
      )}
    </div>
  );
}

/** "Talking to 🚀 Space Daily @space_daily" — links to the agent's page. */
function Addressee({ agent, compact }: { agent: ChatAgentRef; compact: boolean }) {
  return (
    <Link to="/app/agents/$handle" params={{ handle: agent.handle }} className="chat-addressee"
      title={`Talking to ${agent.name} @${agent.handle} — mention @someone to switch`}>
      {!compact && <span className="chat-addressee-label">Talking to</span>}
      <span aria-hidden style={{ flexShrink: 0 }}>{agent.emoji ?? '🤖'}</span>
      <span className="chat-addressee-name">{agent.name}</span>
      <span className="chat-addressee-handle mono">@{agent.handle}</span>
    </Link>
  );
}

/** The agent's emoji (or a sparkle when nobody is addressed yet) in the same tinted glyph the agent lists use. */
function BotGlyph({ agent }: { agent?: ChatAgentRef | null }) {
  return (
    <div aria-hidden className="hub-glyph chat-glyph">
      {agent?.emoji ? agent.emoji : <Icon name="sparkles" size={14} />}
    </div>
  );
}

/** Who answered: name + @handle above an assistant bubble. */
function AgentLine({ agent }: { agent: ChatAgentRef }) {
  return (
    <div className="text-micro chat-agent-line">
      <span className="chat-agent-name">{agent.name}</span>
      <Link to="/app/agents/$handle" params={{ handle: agent.handle }} className="link-accent mono" style={{ flexShrink: 0 }}>@{agent.handle}</Link>
    </div>
  );
}

/** A card without a reply after it (the turn was stopped): shown alone at its time. */
function LooseAction({ action }: { action: PendingAction }) {
  return (
    <div className="chat-row">
      <div style={{ width: 28, flexShrink: 0 }} />
      <div className="chat-body"><ActionCard action={action} /></div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  const named = mentionedArtifacts(text);
  return (
    <div className="chat-user">
      <div className="text-body-sm chat-user-bubble">{text}</div>
      {named.length > 0 && <div style={{ maxWidth: '85%' }}><ArtifactChips chips={named} /></div>}
    </div>
  );
}

function Message({ m, drafts, lastMention, activities, agent, actions }: {
  m: EditorChatMessage; drafts: Record<string, EditorDraft>; lastMention: Record<string, number>; activities: ToolActivity[];
  agent: ChatAgentRef | null; actions: PendingAction[];
}) {
  if (m.role === 'user') return <UserBubble text={m.content} />;
  const own = m.draftIds.filter((id) => drafts[id]);
  return (
    <div className="chat-row">
      <BotGlyph agent={agent} />
      <div className="chat-body">
        {agent && <AgentLine agent={agent} />}
        <ToolChips items={activities} />
        <div className="text-body-sm chat-text">
          <MarkdownLite text={m.content} />
        </div>
        <ArtifactChips chips={m.artifacts ?? []} />
        {(own.length > 0 || actions.length > 0) && (
          <div className="chat-cards" style={{ marginTop: 6 }}>
            {own.map((id) => (lastMention[id] === m.id
              ? <DraftCard key={id} draft={drafts[id]} />
              : (
                <span key={id} className="text-micro chat-pointer">
                  <Icon name="pencil" size={11} /> draft “{drafts[id].spec.title ?? id.slice(0, 8)}” — updated version below
                </span>
              )))}
            {actions.map((a) => <ActionCard key={a.id} action={a} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ value, onChange, onSend, onStop, busy, channel, onChannel, disabled, textareaRef, isMobile }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; busy: boolean;
  channel: string; onChannel: (v: string) => void; disabled: boolean;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>; isMobile: boolean;
}) {
  const channels = useChatChannels();
  const handles = useAgentHandles();
  const ref = textareaRef;
  const mention = useMentionMenu({ value, onChange, handles: handles.data?.agents ?? [], disabled, textarea: () => ref.current });
  const slash = useSlashMenu({ value, onChange, disabled, textarea: () => ref.current });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measure from 0 — with 'auto' the layout can report the stretched box, not the content (was always 200px).
    el.style.height = '0px';
    el.style.height = `${Math.max(48, Math.min(el.scrollHeight, 200))}px`;
  }, [value, ref]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.onKeyDown(e)) return;
    if (mention.onKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!busy && !disabled) onSend();
    }
  };
  return (
    <div className="chat-composer">
      {slash.open && (
        <SlashMenu matches={slash.matches} hi={slash.hi} onHover={slash.setHi} onPick={slash.insert} isMobile={isMobile} />
      )}
      {!slash.open && mention.open && (
        <MentionMenu matches={mention.matches} hi={mention.hi} onHover={mention.setHi} onPick={mention.insert} isMobile={isMobile} />
      )}
      <textarea ref={ref} value={value} rows={2} disabled={disabled}
        onChange={(e) => { onChange(e.target.value); mention.track(e.target); slash.track(e.target); }}
        onSelect={(e) => { mention.track(e.currentTarget); slash.track(e.currentTarget); }}
        onKeyDown={onKey}
        role="combobox" aria-expanded={slash.open || mention.open} aria-autocomplete="list" aria-haspopup="listbox"
        aria-controls={slash.open ? SLASH_LIST_ID : mention.open ? MENTION_LIST_ID : undefined}
        aria-activedescendant={slash.open && slash.matches[slash.hi]
          ? `slash-${slash.matches[slash.hi].name}`
          : mention.open && mention.matches[mention.hi] ? `mention-${mention.matches[mention.hi].handle}` : undefined}
        placeholder="Describe the post, type @ to talk to an agent or / for a command… Enter to send, Shift+Enter for a new line"
        className="text-body-sm chat-input" />
      <div className="chat-composer-bar">
        <select className="input-field chat-channel" value={channel} onChange={(e) => onChannel(e.target.value)} disabled={busy}
          aria-label="Channel">
          <option value="">Channel: agent will ask</option>
          {(channels.data ?? []).map((c) => (
            <option key={c.channelKey} value={c.channelKey}>
              {c.channelKey}{c.title ? ` · ${c.title}` : ''}{c.hasCard ? '' : ' (no card)'}
            </option>
          ))}
        </select>
        <span className="text-micro chat-hint">Publishes only when you explicitly ask</span>
        {busy
          ? (
            <button type="button" className="btn-secondary btn-sm chat-send" onClick={onStop}>
              <Icon name="stop" size={13} /> Stop
            </button>
          )
          : (
            <button type="button" className="btn-primary btn-sm chat-send" onClick={onSend} disabled={!value.trim() || disabled} aria-label="Send">
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
  const waiting = chatsWaiting(useNavAttention().data);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const found = (chats.data ?? []).filter((c) => !q || c.title.toLowerCase().includes(q));
  const groups = found.reduce<Array<{ name: string; items: typeof found }>>((acc, c) => {
    const name = chatGroup(c.updatedAt);
    const g = acc.find((x) => x.name === name);
    if (g) g.items.push(c); else acc.push({ name, items: [c] });
    return acc;
  }, []);
  return (
    <aside className="chat-side" aria-label="Chats and scheduled posts">
      <button type="button" className="btn-primary" onClick={onNew} style={{ flexShrink: 0 }}>
        <Icon name="plus" size={14} /> New chat
      </button>
      {(chats.data ?? []).length > 5 && (
        <input className="input-field chat-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search chats" aria-label="Search chats" />
      )}

      <div>
        {(chats.data ?? []).length === 0
          ? (
            <>
              <div className="text-overline chat-side-title">Chats</div>
              <span className="text-micro chat-side-empty">{chats.isLoading ? '…' : 'No conversations yet'}</span>
            </>
          )
          : !found.length
            ? <span className="text-micro chat-side-empty">No chat matches “{query.trim()}”</span>
            : groups.map((g) => (
            <div key={g.name} style={{ marginBottom: 10 }}>
              <div className="text-overline chat-side-title">{g.name}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {g.items.map((c) => (
                <div key={c.id} className={`chat-item hover-parent${c.id === activeId ? ' is-active' : ''}`}>
                  <button type="button" className="chat-item-main" onClick={() => onPick(c.id)} aria-current={c.id === activeId ? 'page' : undefined}>
                    <div className="text-body-sm chat-item-title">
                      <span className="chat-item-name">{c.title}</span>
                      {waiting.has(c.id) && <Badge tone="warning">to confirm</Badge>}
                    </div>
                    <div className="text-micro mono chat-item-age">{fmtRelative(c.updatedAt)}</div>
                  </button>
                  <button type="button" className="btn-act btn-act-danger hover-reveal" title="Delete chat" aria-label="Delete chat" disabled={del.isPending}
                    onClick={async () => {
                      if (!(await confirm(`delete the chat "${c.title}" (drafts and scheduled posts stay)`))) return;
                      del.mutate(c.id, { onSuccess: () => { if (c.id === activeId) navigate({ search: {} }); } });
                    }}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
              </div>
            </div>
          ))}
      </div>

      <div>
        <div className="text-overline chat-side-title">Scheduled</div>
        {(scheduled.data ?? []).length === 0
          ? <span className="text-micro chat-side-empty">No scheduled posts</span>
          : (
            <div className="chat-sched-list">
              {scheduled.data!.map((d) => (
                <button key={d.id} type="button" className="chat-sched" disabled={!d.chatId}
                  onClick={() => d.chatId && onPick(d.chatId)}>
                  <div className="chat-sched-head">
                    <span className="text-micro mono tabular-nums chat-sched-time">{fmtKyiv(d.scheduledAt)}</span>
                    <Badge>{d.spec.format ?? 'post'}</Badge>
                  </div>
                  <div className="text-micro mono chat-sched-channel">{d.channelKey}</div>
                  <div className="text-body-sm chat-sched-title">{d.spec.title ?? '—'}</div>
                </button>
              ))}
            </div>
          )}
      </div>
    </aside>
  );
}
