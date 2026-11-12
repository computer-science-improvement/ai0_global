import type { EditorCard } from '../../editor/card';
import { makeChatCard } from '../../editor/chat/default-card';
import type { RenderedDraft } from '../../editor/chat/drafts.service';
import { PostSpecSchema } from '../../editor/post/post-spec';
import { renderTelegram } from '../../editor/post/render-telegram';
import { reasonFor, reasonOfError } from '../../editor/reasons/catalogue';
import type { SlotDetail } from '../queries/connector-queries';
import { clip, timeOut, type TimeOut } from '../tools/common';
import { parseTelegramHtml, safeHref, type TgNode } from './tg-markup';

/**
 * Spec 104 — what the MCP Apps view of the connector renders: one `structuredContent` shape per kind (a post, a
 * schedule, a channel, an agent chat). Built on the server from the same data the text result comes from; every
 * string in it is untrusted data the widget shows as text (captions arrive as allowlisted nodes, never as HTML).
 * The text result is never changed by a view.
 */

export const VIEW_VERSION = 1;

export interface ViewButton { text: string; url: string }

/** One Telegram call of a post, as the view draws it (a rich message is drawn from its HTML fallback). */
export type ViewMessage =
  | { type: 'text'; text: TgNode[]; link: { url: string; above: boolean } | null; buttons: ViewButton[][] }
  | { type: 'photo' | 'video'; media: string | null; caption: TgNode[]; caption_above: boolean; buttons: ViewButton[][] }
  | { type: 'album'; photos: string[]; caption: TgNode[] }
  | { type: 'poll'; question: string; options: string[]; quiz: boolean; correct: number | null; explanation: string | null; anonymous: boolean };

export interface PostView {
  kind:          'post';
  /** post: a scheduled post (slot); draft: a draft from an agent chat; check: check_post, nothing saved. */
  source:        'post' | 'draft' | 'check';
  id:            string | null;
  channel:       string;
  channel_title: string | null;
  status:        string;
  when:          TimeOut | null;
  format:        string | null;
  title:         string | null;
  origin:        string | null;
  locked:        boolean;
  /** A planned post has no text yet: what the agent will write about. */
  brief:         { topic: string; angle: string | null } | null;
  messages:      ViewMessage[];
  /** It goes out as a rich message (the view shows its HTML fallback). */
  rich:          boolean;
  errors:        string[];
  warnings:      string[];
  critic:        { verdict: string; notes: string } | null;
  reason:        { label: string; fix: string | null } | null;
  link:          string | null;
  note:          string | null;
}

export interface ScheduleItemView {
  post_id: string; channel: string; when: TimeOut; status: string; origin: string | null; locked: boolean;
  title: string; format: string | null; needs_approval: boolean;
}

export interface ScheduleView {
  kind:      'schedule';
  title:     string;
  items:     ScheduleItemView[];
  truncated: boolean;
}

export interface ChannelView {
  kind:      'channel';
  channel:   string;
  title:     string | null;
  mode:      string | null;
  tz:        string | null;
  agent:     string | null;
  today:     { published: number | null; target: number | null; state: string | null } | null;
  problems:  number;
  items:     ScheduleItemView[];
}

export interface ChatCardView { id: string; kind: string; status: string; summary: string }
export interface ChatMessageView { id: number; agent: string | null; at: string | null; text: string; cards: ChatCardView[]; drafts: PostView[] }

export interface ChatView {
  kind:          'chat';
  chat_id:       string;
  agent:         string | null;
  running:       boolean;
  messages:      ChatMessageView[];
  cards_waiting: number;
  /** Drafts named in the messages but not drawn (over the limit). */
  more_drafts:   number;
}

export type AnyView = PostView | ScheduleView | ChannelView | ChatView;

/** The structuredContent of a call: `{ai0_view, view}`. */
export const viewContent = (view: AnyView): Record<string, unknown> => ({ ai0_view: VIEW_VERSION, view });

// ── small validators (render_messages and specs are JSON from the database) ──

const str = (v: unknown, max: number): string => (typeof v === 'string' ? clip(v, max) : '');
const strOrNull = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? clip(v, max) : null);
const media = (v: unknown): string | null => (typeof v === 'string' ? safeHref(v) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

const MESSAGES_MAX = 6;
const TEXT_MAX = 6000;

function buttonsOf(v: unknown): ViewButton[][] {
  return arr(v).slice(0, 8).map((row) => arr(row).slice(0, 8).flatMap((b) => {
    const o = obj(b);
    const url = safeHref(typeof o.url === 'string' ? o.url : null);
    return url ? [{ text: str(o.text, 80) || 'Open', url }] : [];
  })).filter((row) => row.length);
}

/** The Telegram calls of a post (render_messages or renderTelegram) as view messages; unknown calls are left out. */
export function messagesView(messages: unknown): { messages: ViewMessage[]; rich: boolean } {
  let rich = false;
  const out: ViewMessage[] = [];
  for (const raw of arr(messages).slice(0, MESSAGES_MAX)) {
    let m = obj(raw);
    if (m.method === 'sendRichMessage') { rich = true; m = obj(m.fallback); }
    switch (m.method) {
      case 'sendMessage': {
        const p = obj(m.preview);
        const url = media(p.url);
        out.push({ type: 'text', text: parseTelegramHtml(str(m.text, TEXT_MAX)), link: url ? { url, above: p.showAboveText === true } : null, buttons: buttonsOf(m.buttons) });
        break;
      }
      case 'sendPhoto':
      case 'sendVideo':
        out.push({
          type: m.method === 'sendPhoto' ? 'photo' : 'video', media: media(m.method === 'sendPhoto' ? m.photo : m.video),
          caption: parseTelegramHtml(str(m.caption, TEXT_MAX)), caption_above: m.captionAboveMedia === true, buttons: buttonsOf(m.buttons),
        });
        break;
      case 'sendMediaGroup':
        out.push({ type: 'album', photos: arr(m.photos).slice(0, 10).map(media).filter((u): u is string => !!u), caption: parseTelegramHtml(str(m.caption, TEXT_MAX)) });
        break;
      case 'sendPoll': {
        const options = arr(m.options).slice(0, 12).map((o) => str(o, 120));
        const correct = typeof m.correctIndex === 'number' && Number.isInteger(m.correctIndex) && m.correctIndex >= 0 && m.correctIndex < options.length ? m.correctIndex : null;
        out.push({ type: 'poll', question: str(m.question, 300), options, quiz: m.quiz === true, correct, explanation: strOrNull(m.explanation, 300), anonymous: m.anonymous !== false });
        break;
      }
      default:
        break;
    }
  }
  return { messages: out, rich };
}

/** Render a stored spec the way the publisher would (shadow-safe: nothing is uploaded); null when it does not parse. */
export function renderSpec(spec: unknown, card: EditorCard | null, channelKey: string): unknown[] | null {
  const parsed = PostSpecSchema.safeParse(spec);
  if (!parsed.success) return null;
  try {
    return renderTelegram(parsed.data, card ?? makeChatCard(channelKey, null)).messages;
  } catch {
    return null;
  }
}

const issueText = (v: unknown): string => {
  const o = obj(v);
  if (typeof v === 'string') return clip(v, 300);
  return clip([o.code, o.message].filter((x) => typeof x === 'string' && x).join(': '), 300);
};
const issues = (v: unknown): string[] => arr(v).slice(0, 20).map(issueText).filter(Boolean);

const criticOf = (v: unknown): PostView['critic'] => {
  const o = obj(v);
  return typeof o.verdict === 'string' ? { verdict: clip(o.verdict, 40), notes: str(o.notes, 600) } : null;
};

const STATUS_NOTES: Record<string, string> = {
  planned: 'Planned: the channel agent writes this post at its time.',
  awaiting_approval: 'Waiting for approval. Nothing goes out until it is approved.',
  approved: 'Approved: it goes out at its time through the publisher.',
  running: 'The agent is writing or sending it now.',
};

const originOfSlot = (s: SlotDetail['slot']): string =>
  s.createdVia === 'connector' ? 'connector' : s.scheduleRuleId ? 'pin' : s.promo ? 'promo' : s.slo ? 'slo' : 'agent';

/** A scheduled post (get_post, prepare_post, update_post, plan_post). */
export function postViewOfSlot(detail: SlotDetail, card: EditorCard | null): PostView {
  const s = detail.slot;
  const tz = card?.timezone ?? 'Europe/Kyiv';
  const stored = s.renderMessages && s.renderMessages.kind === 'telegram' ? s.renderMessages.messages : null;
  const rendered = stored ?? (s.postSpec ? renderSpec(s.postSpec, card, s.channelKey) : null);
  const { messages, rich } = messagesView(rendered);
  const code = reasonOfError(s.error);
  const entry = reasonFor(code);
  const spec = obj(s.postSpec);
  return {
    kind: 'post', source: 'post', id: s.id, channel: s.channelKey, channel_title: card?.title ? clip(card.title, 120) : null,
    status: s.status, when: timeOut(s.scheduledAt, tz), format: s.format ?? null, title: strOrNull(spec.title, 200) ?? strOrNull(s.topic, 200),
    origin: originOfSlot(s), locked: !!s.lockedBy,
    brief: !s.postSpec ? { topic: str(s.topic, 300), angle: strOrNull(s.angle, 300) } : null,
    messages, rich, errors: [], warnings: (s.lintWarnings ?? []).slice(0, 20).map((w) => clip(String(w), 300)), critic: criticOf(s.critic),
    reason: s.error ? { label: clip(entry?.en ?? code ?? s.error, 200), fix: entry?.fix?.en ? clip(entry.fix.en, 300) : null } : null,
    link: detail.published && s.channelKey.startsWith('@') ? `https://t.me/${s.channelKey.slice(1)}/${detail.published.messageId}` : null,
    note: STATUS_NOTES[s.status] ?? null,
  };
}

/** A draft from an agent chat (get_draft, and the drafts of a chat view). */
export function postViewOfDraft(d: RenderedDraft, card: EditorCard | null): PostView {
  const spec = obj(d.spec);
  const tz = card?.timezone ?? 'Europe/Kyiv';
  const { messages, rich } = messagesView(d.render?.messages ?? null);
  return {
    kind: 'post', source: 'draft', id: d.id, channel: d.channelKey, channel_title: strOrNull(d.render?.channelTitle ?? card?.title, 120),
    status: d.status, when: d.scheduledAt ? timeOut(d.scheduledAt, tz) : null, format: strOrNull(spec.format, 40), title: strOrNull(spec.title, 200),
    origin: 'chat_draft', locked: false, brief: null, messages, rich,
    errors: issues(d.lint?.errors), warnings: issues(d.lint?.warnings), critic: criticOf(d.critic),
    reason: d.error ? { label: clip(d.error, 200), fix: null } : null, link: null,
    note: d.status === 'draft' ? 'A draft: nothing is published from here. prepare_post schedules a post.' : null,
  };
}

/** check_post: the post as given, rendered and linted, nothing saved. */
export function postViewOfCheck(card: EditorCard, post: unknown, result: { ok?: unknown; errors?: unknown; warnings?: unknown }): PostView {
  const spec = obj(post);
  const { messages, rich } = messagesView(renderSpec(post, card, card.channelKey));
  return {
    kind: 'post', source: 'check', id: null, channel: card.channelKey, channel_title: card.title ? clip(card.title, 120) : null,
    status: result.ok === true ? 'passes_checks' : 'fails_checks', when: null, format: strOrNull(spec.format, 40), title: strOrNull(spec.title, 200),
    origin: null, locked: false, brief: null, messages, rich, errors: issues(result.errors), warnings: issues(result.warnings), critic: null,
    reason: null, link: null, note: 'Checked only: nothing was saved or scheduled.',
  };
}

// ── schedule and channel (built from the text result itself) ────────────────

function scheduleItem(v: unknown): ScheduleItemView | null {
  const o = obj(v);
  if (typeof o.post_id !== 'string' || typeof o.at !== 'string') return null;
  return {
    post_id: clip(o.post_id, 80), channel: str(o.channel, 80), when: { at: o.at, local: str(o.local, 40), tz: str(o.tz, 60) },
    status: str(o.status, 40), origin: strOrNull(o.origin, 40), locked: o.locked === true, title: str(o.title, 200),
    format: strOrNull(o.format, 40), needs_approval: o.needs_approval === true,
  };
}

const items = (v: unknown, max = 100) => arr(v).slice(0, max).map(scheduleItem).filter((x): x is ScheduleItemView => !!x);

/** list_schedule. */
export function scheduleView(result: unknown, channel: string | null): ScheduleView {
  const r = obj(result);
  const hours = typeof r.hours === 'number' ? r.hours : null;
  return {
    kind: 'schedule', title: `${channel ?? 'All channels'}${hours ? ` · next ${hours} h` : ''}`, items: items(r.items), truncated: r.truncated === true,
  };
}

/** get_channel: the channel's head and its next posts. */
export function channelView(result: unknown): ChannelView {
  const r = obj(result);
  const slo = obj(r.slo_today);
  return {
    kind: 'channel', channel: str(r.channel, 80), title: strOrNull(r.title, 120), mode: strOrNull(r.mode, 20), tz: strOrNull(r.tz, 60),
    agent: strOrNull(r.agent, 80),
    today: r.slo_today ? {
      published: typeof slo.published === 'number' ? slo.published : null, target: typeof slo.target === 'number' ? slo.target : null,
      state: strOrNull(slo.state, 40),
    } : null,
    problems: typeof r.open_problems === 'number' ? r.open_problems : 0, items: items(r.next_posts, 20),
  };
}

// ── agent chat ──────────────────────────────────────────────────────────────

/** Drafts drawn in one chat view at most (the newest); the rest are counted. */
export const CHAT_DRAFTS_MAX = 4;

/** talk_to_agent / read_agent_chat: the text result plus the drafts it names, drawn. */
export function chatView(result: unknown, drafts: Map<string, PostView>): ChatView {
  const r = obj(result);
  const msgs = arr(r.messages).slice(-20).map((m): ChatMessageView => {
    const o = obj(m);
    const cards = arr(o.cards).slice(0, 10).map((c) => {
      const x = obj(c);
      return { id: str(x.id, 80), kind: str(x.kind, 60), status: str(x.status, 40), summary: str(x.summary, 400) };
    });
    const named = arr(o.drafts).map((d) => str(obj(d).id, 80)).filter(Boolean);
    return {
      id: typeof o.id === 'number' ? o.id : 0, agent: strOrNull(o.agent, 80), at: strOrNull(o.at, 40), text: str(o.text, 4000), cards,
      drafts: named.map((id) => drafts.get(id)).filter((d): d is PostView => !!d),
    };
  });
  const named = new Set(arr(r.messages).flatMap((m) => arr(obj(m).drafts).map((d) => str(obj(d).id, 80)).filter(Boolean)));
  const drawn = new Set(msgs.flatMap((m) => m.drafts.map((d) => d.id)));
  return {
    kind: 'chat', chat_id: str(r.chat_id, 80), agent: strOrNull(r.agent, 80), running: r.running === true, messages: msgs,
    cards_waiting: typeof r.cards_waiting === 'number' ? r.cards_waiting : 0, more_drafts: [...named].filter((id) => !drawn.has(id)).length,
  };
}

/** The draft ids a chat result names, newest message first, at most `max`. */
export function draftIdsOf(result: unknown, max = CHAT_DRAFTS_MAX): string[] {
  const ids: string[] = [];
  for (const m of arr(obj(result).messages).slice().reverse()) {
    for (const d of arr(obj(m).drafts)) {
      const id = str(obj(d).id, 80);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids.slice(0, max);
}
