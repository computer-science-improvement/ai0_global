// The owner's post composer. Two layouts of one form:
//   page    /app/compose: editor on the left, Telegram preview on the right, datetime in the browser's own zone.
//   drawer  the Calendar's side sheet (spec 078 B4): channel chips, text, a day and a Kyiv time, "More options"
//           (sender, media, buttons), the preview, and a footer with the hint and the actions. With `ask` it also
//           offers "Ask the agent": the same text box becomes a brief and Submit pins one post on the agent's schedule.
// Both show a field's problem only after the owner left the field or pressed Schedule (lib/post-problems.ts); the button
// stays enabled until the first press and is disabled while problems remain after it.

import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import './composer.css';
import { TelegramPreview } from './TelegramPreview';
import { scheduledPostsApi } from '../../api/scheduled-posts';
import { trackingApi } from '../../api/tracking';
import { apiMessage } from '../../api/calendar';
import { useBots } from '../../api/bots';
import { ChannelAvatar } from '../ChannelAvatar';
import { SegmentedTabs } from '../SegmentedTabs';
import { Icon, type IconName } from '../ui/Icon';
import { useMediaQuery } from '../../lib/useMediaQuery';
import {
  BRIEF_MAX, DEFAULT_TIME, askProblems, dayLabel, defaultComposeDay, isDay, isTime, kyivInstant, kyivToday, splitKyiv,
} from '../../lib/calendar';
import { limitFor, postInputOf, postProblems, shownProblems, visibleLen, type PostField, type PostProblem } from '../../lib/post-problems';
import { KYIV_TZ, zoneLabel } from '../../lib/zoned-time';
import type { ComposedPostInput, ScheduledPost, TrackedChannel } from '../../api/types';

const pick = postInputOf;

const BLANK: ComposedPostInput = {
  channelId: '', sender: 'bot', botId: null, text: '', mediaType: 'none',
  mediaUrl: null, mediaPlacement: 'above', buttons: [], scheduledAt: '',
};

/** Convert a stored UTC ISO into a `YYYY-MM-DDTHH:mm` string in local wall-clock
 *  for a <input type="datetime-local"> value (which is timezone-naive). */
const toLocalInput = (iso: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Platform tab bar — Telegram is live; the rest are placeholders for the
 *  future, shown disabled with a "soon" chip so the surface reads as
 *  multi-platform without pretending the others work yet. */
const PLATFORMS: { id: string; label: string; icon: IconName; enabled: boolean }[] = [
  { id: 'telegram', label: 'Telegram', icon: 'telegram', enabled: true },
  { id: 'meta',     label: 'Meta',     icon: 'facebook', enabled: false },
  { id: 'tiktok',   label: 'TikTok',   icon: 'tiktok',   enabled: false },
];

function PlatformTabs() {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {PLATFORMS.map(p => (
        <button
          key={p.id}
          type="button"
          disabled={!p.enabled}
          aria-pressed={p.enabled}
          title={p.enabled ? p.label : `${p.label} — soon`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 14px',
            borderRadius: 'var(--radius-pill)',
            border: '1px solid',
            borderColor: p.enabled ? 'var(--color-accent)' : 'var(--color-hairline)',
            background: p.enabled ? 'var(--color-success-soft)' : 'var(--color-surface-1)',
            color: p.enabled ? 'var(--color-accent)' : 'var(--color-ink-muted)',
            fontSize: 13, fontWeight: 500, letterSpacing: '-0.13px',
            cursor: p.enabled ? 'default' : 'not-allowed',
            opacity: p.enabled ? 1 : 0.45,
            transition: 'background 0.12s ease, color 0.12s ease',
          }}
        >
          <Icon name={p.icon} size={15} />
          {p.label}
          {!p.enabled && (
            <span className="chip" style={{ padding: '1px 6px', fontSize: 11, lineHeight: 1.3 }}>soon</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * "Ask the agent" (drawer only): the Calendar tells the composer what the agent can be asked for per channel and what
 * Submit does. `submit` rejects with the server's error; the composer shows it under the form.
 */
export interface AskAgent {
  /** Why the agent of this channel cannot be asked (`null` = it can). */
  unavailable: (channelId: string) => string | null;
  /** The IANA zone the agent's clock runs in (the time field is on that clock). */
  zone: (channelId: string) => string;
  /** The sentence under the button: what happens to the brief. */
  hint: (channelId: string, day: string, time: string) => string;
  submit: (v: { channelId: string; brief: string; day: string; time: string }) => Promise<unknown>;
}

interface Props {
  editing?: ScheduledPost | null;
  /** Called after a successful save (and by Cancel when `onCancel` is not given). */
  onDone: () => void;
  variant?: 'page' | 'drawer';
  /** Prefill of a new post (drawer: channel, bot, `scheduledAt` as the Kyiv instant of the clicked cell). */
  initial?: Partial<ComposedPostInput>;
  onCancel?: () => void;
  /** The saved post, before `onDone` (the Calendar offers Undo with its id). */
  onSaved?: (post: ScheduledPost) => void;
  ask?: AskAgent;
  /** Drawer footer, left of Cancel (the Calendar's "Cancel post"). */
  footerExtra?: ReactNode;
  /** Kept up to date with "the form holds changes that are not saved" (the drawer asks before it closes over them). */
  dirtyRef?: MutableRefObject<boolean>;
}

const FIELD_ID: Record<PostField, string> = {
  channel: 'pc-channel', bot: 'pc-bot', text: 'pc-text', media: 'pc-media', buttons: 'pc-buttons', time: 'pc-time',
};

/** Move focus to the control of a field (the first control inside a group). */
function focusField(f: PostField) {
  const el = document.getElementById(FIELD_ID[f]);
  const target = el && el.matches('input,select,textarea,button') ? el : el?.querySelector<HTMLElement>('button,input,select,textarea');
  target?.focus();
}

export function PostComposer({ editing, onDone, variant = 'page', initial, onCancel, onSaved, ask, footerExtra, dirtyRef }: Props) {
  const qc = useQueryClient();
  const drawer = variant === 'drawer';
  const { data: bots } = useBots();
  const stacked = useMediaQuery('(max-width: 900px)');
  const channelsQ = useQuery({ queryKey: ['channels','mine',1,'',undefined],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', page: 1, pageSize: 100 }) });
  const channels = channelsQ.data?.items ?? [];

  const [post, setPost] = useState<ComposedPostInput>(() => editing ? pick(editing) : {
    ...BLANK,
    ...(drawer ? { scheduledAt: kyivInstant(defaultComposeDay(kyivToday()), DEFAULT_TIME) } : null),
    ...initial,
  });
  // Re-sync ONLY when a different post is opened (id change) — depending on
  // the object identity would clobber in-progress edits every time the
  // scheduled-posts query refetches (e.g. on window refocus) and hands the
  // parent a fresh object for the same post.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (editing) setPost(pick(editing)); }, [editing?.id]);

  // What "unchanged" means: the words, media and buttons as they were opened (the channel, bot and time are picked again in a moment).
  // An asked-for brief is typed in the same box, so it counts too.
  const content = (p: ComposedPostInput) => JSON.stringify([p.text, p.mediaType, p.mediaUrl, p.buttons]);
  const baseline = useRef<string | null>(null);
  if (baseline.current === null) baseline.current = content(post);
  if (dirtyRef) dirtyRef.current = content(post) !== baseline.current;
  // Gone from the screen (the post went out while open, the sheet switched to a read-only view): nothing of it is unsaved.
  useEffect(() => () => { if (dirtyRef) dirtyRef.current = false; }, [dirtyRef]);

  // Drawer: the day and the time of day are two controls, kept apart so a half-typed time does not lose the day.
  const [when, setWhen] = useState(() => splitKyiv(post.scheduledAt));
  const [who, setWho] = useState<'self' | 'agent'>('self');
  const agentMode = drawer && !!ask && !editing && who === 'agent';
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<ReadonlySet<PostField>>(() => new Set());
  const [moreOpen, setMoreOpen] = useState(() => !!editing && (editing.mediaType !== 'none' || editing.buttons.some(r => r.buttons.length > 0) || editing.sender !== 'bot'));
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  const hasButtons = post.buttons.some(r => r.buttons.length > 0);
  const len = visibleLen(post.text);
  const limit = limitFor(post.sender, post.mediaType);
  const overLimit = len > limit;
  const set = (patch: Partial<ComposedPostInput>) => setPost(p => ({ ...p, ...patch }));
  const touch = (f: PostField) => setTouched(prev => (prev.has(f) ? prev : new Set(prev).add(f)));
  const changeWhen = (day: string, time: string) => {
    setWhen({ day, time });
    set({ scheduledAt: isDay(day) && isTime(time) ? kyivInstant(day, time) : '' });
  };

  // Guardrail: buttons → force bot.
  useEffect(() => { if (hasButtons && post.sender !== 'bot') set({ sender: 'bot' }); }, [hasButtons]);

  // Guardrail: MTProto-user can't put media below text → coerce to 'above'.
  useEffect(() => {
    if (post.sender === 'mtproto_user' && post.mediaType !== 'none' && post.mediaPlacement === 'below')
      set({ mediaPlacement: 'above' });
  }, [post.sender, post.mediaType, post.mediaPlacement]);

  // Drawer: a channel brings its own bot, else the default bot — the sheet has no bot picker unless neither exists.
  const defaultBotId = bots?.find(b => b.is_default)?.id ?? null;
  const botOf = (c: Pick<TrackedChannel, 'botId'> | undefined) => c?.botId ?? defaultBotId;
  useEffect(() => {
    if (!drawer || editing || post.sender !== 'bot' || post.botId || !post.channelId) return;
    const bot = botOf(channels.find(c => c.id === post.channelId));
    if (bot) set({ botId: bot });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer, editing, post.sender, post.botId, post.channelId, channelsQ.data, bots]);

  // Drawer: the cursor starts where the owner types next. Not on touch screens, where it would raise the keyboard over the form.
  useEffect(() => {
    if (!drawer || typeof window === 'undefined' || !window.matchMedia?.('(pointer: fine)').matches) return;
    const id = setTimeout(() => focusField(post.channelId ? 'text' : 'channel'), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useMutation({
    mutationFn: (input: ComposedPostInput) => editing ? scheduledPostsApi.update(editing.id, input) : scheduledPostsApi.create(input),
    onSuccess: (saved) => { qc.invalidateQueries({ queryKey: ['scheduled-posts'] }); onSaved?.(saved); onDone(); },
  });

  const askReason = agentMode && ask && post.channelId ? ask.unavailable(post.channelId) : null;
  let problems: PostProblem[];
  if (agentMode && ask) {
    const out = askProblems({
      brief: post.text, day: when.day, time: when.time, tz: post.channelId ? ask.zone(post.channelId) : KYIV_TZ, now: new Date(), unavailable: askReason,
    });
    problems = post.channelId ? out : [{ field: 'channel', message: 'Select a channel' }, ...out];
  } else {
    problems = postProblems(post);
  }
  // The reason an agent cannot be asked is already printed under the channels; do not say it twice.
  const shown = shownProblems(problems, submitted, touched).filter((p) => !(askReason && p.message === askReason));
  const errOf = (f: PostField) => shown.find(p => p.field === f)?.message;
  const err = (f: PostField) => {
    const m = errOf(f);
    return m ? <p id={`${FIELD_ID[f]}-error`} className="pc-error" role="alert">{m}</p> : null;
  };
  const invalid = (f: PostField) => (errOf(f) ? { 'aria-invalid': true as const, 'aria-describedby': `${FIELD_ID[f]}-error` } : {});

  const submit = () => {
    setSubmitted(true);
    setAskError(null);
    const first = problems[0];
    if (first) {
      if (['bot', 'media', 'buttons'].includes(first.field)) setMoreOpen(true);
      setTimeout(() => focusField(first.field), 0);
      return;
    }
    if (agentMode && ask) {
      setAskBusy(true);
      ask.submit({ channelId: post.channelId, brief: post.text.trim(), day: when.day, time: when.time })
        .then(() => onDone())
        .catch((e: unknown) => setAskError(apiMessage(e)))
        .finally(() => setAskBusy(false));
      return;
    }
    save.mutate(post);
  };
  const blocked = save.isPending || askBusy || (submitted && problems.length > 0) || !!askReason;
  const cancel = onCancel ?? onDone;

  const selectedChannel = channels.find(c => c.id === post.channelId);
  const channelTitle = selectedChannel?.title ?? selectedChannel?.channelKey ?? null;
  const failure = askError ?? (save.error ? apiMessage(save.error) : null);

  // ─── pieces both layouts use ────────────────────────────────────────────
  const senderFields = (
    <>
      <div className="tabs-pill" style={{ width: 'fit-content' }} role="group" aria-label="Sender">
        {(['bot','mtproto_user'] as const).map(s => (
          <button key={s} type="button" disabled={hasButtons && s === 'mtproto_user'}
            aria-pressed={post.sender === s}
            onClick={() => set({ sender: s })}
            className={`tabs-pill-item${post.sender === s ? ' is-selected' : ''}`}>
            {s === 'bot' ? 'Bot' : 'MTProto-user'}
          </button>
        ))}
      </div>
      {post.sender === 'bot' && (
        <div className="pc-row">
          <select id="pc-bot" className="input-field" aria-label="Bot" value={post.botId ?? ''} {...invalid('bot')}
            onChange={e => set({ botId: e.target.value || null })} onBlur={() => touch('bot')}>
            <option value="">— bot —</option>
            {bots?.map(b => <option key={b.id} value={b.id}>{b.username ?? b.bot_id}</option>)}
          </select>
          {err('bot')}
        </div>
      )}
    </>
  );

  const mediaFields = (
    <div className="pc-row">
      <div id="pc-media" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <select className="input-field" aria-label="Media" style={{ flex: '1 1 120px' }} value={post.mediaType}
          onChange={e => set({ mediaType: e.target.value as ComposedPostInput['mediaType'] })} onBlur={() => touch('media')}>
          <option value="none">no media</option><option value="photo">photo</option><option value="video">video</option>
        </select>
        {post.mediaType !== 'none' && (
          <>
            <input className="input-field" aria-label="Media URL" style={{ flex: '3 1 180px' }} placeholder="media URL" {...invalid('media')}
              value={post.mediaUrl ?? ''} onChange={e => set({ mediaUrl: e.target.value })} onBlur={() => touch('media')} />
            <select className="input-field" aria-label="Media placement" style={{ flex: '1 1 120px' }} value={post.mediaPlacement}
              onChange={e => set({ mediaPlacement: e.target.value as ComposedPostInput['mediaPlacement'] })}>
              <option value="above">above text</option>
              {post.sender !== 'mtproto_user' && <option value="below">below text</option>}
            </select>
          </>
        )}
      </div>
      {err('media')}
    </div>
  );

  const buttonsFields = (
    <div className="pc-row" id="pc-buttons">
      <ButtonsEditor rows={post.buttons} onChange={buttons => set({ buttons })} onBlur={() => touch('buttons')} />
      {err('buttons')}
    </div>
  );

  const counter = agentMode
    ? <div className={`pc-count${post.text.trim().length > BRIEF_MAX ? ' is-over' : ''}`}>{post.text.trim().length}/{BRIEF_MAX}</div>
    : <div className={`pc-count${overLimit ? ' is-over' : ''}`}>{len}/{limit}</div>;

  const preview = (
    <div className="pc-preview">
      {/* Faux "Telegram chat" frame — channel header above the message bubble. */}
      <div className="pc-preview-head">
        <ChannelAvatar name={channelTitle} src={null} size={36} />
        <div style={{ minWidth: 0 }}>
          <div className="text-body-sm pc-preview-name" style={{ color: 'var(--color-ink)' }}>{channelTitle ?? 'Select a channel'}</div>
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Telegram</div>
        </div>
      </div>
      <TelegramPreview post={post} />
    </div>
  );

  // ─── drawer ─────────────────────────────────────────────────────────────
  if (drawer) {
    const showMore = moreOpen || shown.some(p => ['bot', 'media', 'buttons'].includes(p.field));
    const zone = agentMode && ask && post.channelId ? ask.zone(post.channelId) : KYIV_TZ;
    const hint = agentMode && ask
      ? (askReason ?? (post.channelId ? ask.hint(post.channelId, when.day, when.time) : 'Pick a channel to ask its agent.'))
      : isDay(when.day) && isTime(when.time) ? `Goes out at ${when.time} Kyiv on ${dayLabel(when.day)}.` : 'Pick a day and a time.';
    return (
      <>
        <div className="pc-body">
          {ask && !editing && (
            <div className="pc-row">
              <span className="pc-label" id="pc-who">Who writes it</span>
              <SegmentedTabs ariaLabel="Who writes it" value={who} onChange={setWho}
                options={[{ key: 'self', label: 'I’ll write it' }, { key: 'agent', label: 'Ask the agent' }]} />
            </div>
          )}

          <div className="pc-row">
            <span className="pc-label" id="pc-channel-label">Channel</span>
            <div id="pc-channel" className="pc-channels" role="group" aria-labelledby="pc-channel-label">
              {channels.map(c => (
                <button key={c.id} type="button" className="chip-toggle" aria-pressed={c.id === post.channelId} title={c.channelKey ?? undefined}
                  onClick={() => { touch('channel'); set({ channelId: c.id, botId: post.sender === 'bot' ? botOf(c) : post.botId }); }}>
                  {c.title ?? c.channelKey ?? c.id}
                </button>
              ))}
            </div>
            {!channels.length && !channelsQ.isLoading && (
              <p className="pc-note" style={{ color: 'var(--color-ink-muted)' }}>
                {channelsQ.isError ? 'Your channels did not load. Close this and try again.' : 'No channels yet. Add one under Channels first.'}
              </p>
            )}
            {err('channel')}
            {askReason && <p className="pc-note">{askReason}</p>}
          </div>

          <div className="pc-row">
            <label htmlFor="pc-text">{agentMode ? 'What should the agent write about?' : 'Post text'}</label>
            <textarea id="pc-text" className="input-field" rows={agentMode ? 4 : 6} {...invalid('text')}
              placeholder={agentMode ? 'e.g. a short post about this week’s MCP releases, with a source link' : 'Write the post…'}
              value={post.text} onChange={e => set({ text: e.target.value })} onBlur={() => touch('text')} />
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{agentMode ? 'Plain words are fine.' : 'Telegram HTML: <b>, <i>, <a href>'}</span>
              {counter}
            </div>
            {err('text')}
          </div>

          <div className="pc-grid2">
            <div className="pc-row">
              <label htmlFor="pc-day">Day</label>
              <input id="pc-day" className="input-field" type="date" min={kyivToday()} value={when.day}
                onChange={e => changeWhen(e.target.value, when.time)} onBlur={() => touch('time')} />
            </div>
            <div className="pc-row">
              <label htmlFor="pc-time">{`Time, ${zoneLabel(zone)}`}</label>
              <input id="pc-time" className="input-field" type="time" value={when.time} {...invalid('time')}
                onChange={e => changeWhen(when.day, e.target.value)} onBlur={() => touch('time')} />
            </div>
          </div>
          {err('time')}

          {!agentMode && (
            <div className="pc-row">
              <button type="button" className="btn-ghost pc-more-toggle" aria-expanded={showMore} aria-controls="pc-more" onClick={() => setMoreOpen(!showMore)}>
                <Icon name={showMore ? 'chevron-up' : 'chevron-down'} size={14} /> More options
              </button>
              {showMore && (
                <div id="pc-more" className="pc-more">
                  {senderFields}
                  {mediaFields}
                  {buttonsFields}
                </div>
              )}
            </div>
          )}

          <div className="pc-row">
            <span className="pc-label">{`Preview${channelTitle ? ` · ${selectedChannel?.channelKey ?? channelTitle}` : ''}`}</span>
            {agentMode ? (
              <div className="inset">
                <div className="text-overline" style={{ marginBottom: 6 }}>Brief for the agent</div>
                <p className="text-body-sm" style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: post.text.trim() ? 'var(--color-ink)' : 'var(--color-ink-dim)' }}>
                  {post.text.trim() || 'The agent’s draft will appear here for your approval.'}
                </p>
              </div>
            ) : preview}
          </div>

          {failure && <p className="pc-error" role="alert">{failure}</p>}
        </div>

        <div className="modal-foot pc-foot">
          <p className="pc-hint">{hint}</p>
          {footerExtra && <div className="pc-foot-extra">{footerExtra}</div>}
          <button type="button" className="btn-ghost" onClick={cancel}>Cancel</button>
          <button type="button" className="btn-primary" disabled={blocked} onClick={submit}>
            {save.isPending || askBusy ? 'Saving…' : agentMode ? 'Ask for a draft' : editing ? 'Save changes' : 'Schedule'}
          </button>
        </div>
      </>
    );
  }

  // ─── page ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div className="compose-rise" style={{ animationDelay: '0ms' }}>
        <PlatformTabs />
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: stacked ? '1fr' : '1fr 420px',
        gap: 28,
        alignItems: 'start',
      }}>
        {/* ─── Editor ─────────────────────────────────────────────── */}
        <div className="compose-rise" style={{ animationDelay: '60ms', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* channel */}
          <div className="pc-row">
            <select id="pc-channel" className="input-field" aria-label="Channel" value={post.channelId} {...invalid('channel')}
              onChange={e => set({ channelId: e.target.value })} onBlur={() => touch('channel')}>
              <option value="">— channel —</option>
              {channels.map(c => <option key={c.id} value={c.id}>{c.title ?? c.channelKey ?? c.id}</option>)}
            </select>
            {err('channel')}
          </div>
          {/* sender */}
          {senderFields}
          {/* text */}
          <div className="pc-row">
            <textarea id="pc-text" className="input-field" rows={6} aria-label="Post text" placeholder="Text (Telegram HTML: <b>, <i>, <a href>)" {...invalid('text')}
              value={post.text} onChange={e => set({ text: e.target.value })} onBlur={() => touch('text')} />
            {counter}
            {err('text')}
          </div>
          {/* media */}
          {mediaFields}
          {/* buttons */}
          {buttonsFields}
          {/* schedule */}
          <div className="pc-row">
            <input id="pc-time" className="input-field" type="datetime-local" aria-label="Publish time" {...invalid('time')}
              min={toLocalInput(new Date().toISOString())}
              value={toLocalInput(post.scheduledAt)}
              onChange={e => set({ scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : '' })}
              onBlur={() => touch('time')} />
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>(local time)</span>
            {err('time')}
          </div>
          {failure && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }} role="alert">{failure}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button className="btn-secondary" onClick={cancel}>Cancel</button>
            <button className="btn-primary" disabled={blocked} onClick={submit}>{save.isPending ? 'Saving…' : 'Schedule'}</button>
          </div>
        </div>

        {/* ─── Preview ────────────────────────────────────────────── */}
        <div
          className="compose-rise"
          style={{
            animationDelay: '120ms',
            position: stacked ? 'static' : 'sticky',
            top: 24,
            display: 'flex', flexDirection: 'column', gap: 8,
          }}
        >
          <div className="text-eyebrow">Preview</div>
          {preview}
        </div>
      </div>
    </div>
  );
}

function ButtonsEditor({ rows, onChange, onBlur }: { rows: ComposedPostInput['buttons']; onChange: (r: ComposedPostInput['buttons']) => void; onBlur?: () => void }) {
  const flat = rows[0]?.buttons ?? [];
  const setBtn = (i: number, patch: Partial<{ label: string; url: string }>) => {
    const next = flat.map((b, bi) => bi === i ? { ...b, ...patch } : b);
    onChange(next.length ? [{ buttons: next }] : []);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="text-eyebrow">Buttons (url)</div>
      {flat.map((b, i) => (
        <div key={i} style={{ display: 'flex', gap: 6 }}>
          <input className="input-field" aria-label={`Button ${i + 1} label`} style={{ flex: 1, minWidth: 0 }} placeholder="label" value={b.label} onChange={e => setBtn(i, { label: e.target.value })} onBlur={onBlur} />
          <input className="input-field" aria-label={`Button ${i + 1} link`} style={{ flex: 2, minWidth: 0 }} placeholder="https://…" value={b.url} onChange={e => setBtn(i, { url: e.target.value })} onBlur={onBlur} />
          <button type="button" className="btn-tiny" aria-label={`Remove button ${i + 1}`} onClick={() => onChange([{ buttons: flat.filter((_, bi) => bi !== i) }].filter(r => r.buttons.length))}>✕</button>
        </div>
      ))}
      <button type="button" className="btn-tiny" style={{ width: 'fit-content' }}
        onClick={() => onChange([{ buttons: [...flat, { label: '', url: '' }] }])}>+ button</button>
    </div>
  );
}
