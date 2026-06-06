import { useMemo, useState, useEffect } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { TelegramPreview } from './TelegramPreview';
import { scheduledPostsApi } from '../../api/scheduled-posts';
import { trackingApi } from '../../api/tracking';
import { useBots } from '../../api/bots';
import { ChannelAvatar } from '../ChannelAvatar';
import { Icon, type IconName } from '../ui/Icon';
import { useMediaQuery } from '../../lib/useMediaQuery';
import type { ComposedPostInput, ScheduledPost } from '../../api/types';

const visibleLen = (html: string) => html.replace(/<[^>]+>/g, '').length;
const limitFor = (s: ComposedPostInput['sender'], m: ComposedPostInput['mediaType']) =>
  m === 'none' ? 4096 : s === 'mtproto_user' ? 2048 : 1024;

/** Project ONLY the 9 input fields — strips ScheduledPost extras (id/status/etc)
 *  so PATCH bodies pass the backend's forbidNonWhitelisted ValidationPipe. */
const pick = (p: ComposedPostInput | ScheduledPost): ComposedPostInput => ({
  channelId: p.channelId, sender: p.sender, botId: p.botId, text: p.text,
  mediaType: p.mediaType, mediaUrl: p.mediaUrl, mediaPlacement: p.mediaPlacement,
  buttons: p.buttons, scheduledAt: p.scheduledAt,
});

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
          title={p.enabled ? p.label : `${p.label} — скоро`}
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
            <span className="chip" style={{ padding: '1px 6px', fontSize: 10, lineHeight: 1.3 }}>soon</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function PostComposer({ editing, onDone }:
  { editing?: ScheduledPost | null; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: bots } = useBots();
  const stacked = useMediaQuery('(max-width: 900px)');
  const channelsQ = useQuery({ queryKey: ['channels','mine',1,'',undefined],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', page: 1, pageSize: 100 }) });

  const [post, setPost] = useState<ComposedPostInput>(() => editing ? pick(editing) : {
    channelId: '', sender: 'bot', botId: null, text: '', mediaType: 'none',
    mediaUrl: null, mediaPlacement: 'above', buttons: [], scheduledAt: '',
  });
  useEffect(() => { if (editing) setPost(pick(editing)); }, [editing]);

  const hasButtons = post.buttons.some(r => r.buttons.length > 0);
  const len = visibleLen(post.text);
  const limit = limitFor(post.sender, post.mediaType);
  const overLimit = len > limit;
  const set = (patch: Partial<ComposedPostInput>) => setPost(p => ({ ...p, ...patch }));

  // Guardrail: buttons → force bot.
  useEffect(() => { if (hasButtons && post.sender !== 'bot') set({ sender: 'bot' }); }, [hasButtons]);

  // Guardrail: MTProto-user can't put media below text → coerce to 'above'.
  useEffect(() => {
    if (post.sender === 'mtproto_user' && post.mediaType !== 'none' && post.mediaPlacement === 'below')
      set({ mediaPlacement: 'above' });
  }, [post.sender, post.mediaType, post.mediaPlacement]);

  const save = useMutation({
    mutationFn: (input: ComposedPostInput) => editing ? scheduledPostsApi.update(editing.id, input) : scheduledPostsApi.create(input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled-posts'] }); onDone(); },
  });

  const errors = useMemo(() => {
    const e: string[] = [];
    if (!post.channelId) e.push('Оберіть канал');
    if (post.sender === 'bot' && !post.botId) e.push('Оберіть бота');
    if ((post.mediaType !== 'none') && !/^https?:\/\//i.test(post.mediaUrl ?? '')) e.push('Медіа-URL має бути http(s)');
    if (!post.scheduledAt) e.push('Вкажіть час');
    else if (Date.parse(post.scheduledAt) <= Date.now()) e.push('Час публікації має бути в майбутньому');
    if (overLimit) e.push(`Текст ${len}/${limit} — перевищено ліміт`);
    if (hasButtons && post.mediaType !== 'none' && post.mediaPlacement === 'above' && len > 1024)
      e.push('Кнопки + фото з підписом >1024 неможливі в одному пості');
    return e;
  }, [post, len, limit, overLimit, hasButtons]);

  const selectedChannel = channelsQ.data?.items.find(c => c.id === post.channelId);
  const channelTitle = selectedChannel?.title ?? selectedChannel?.channelKey ?? null;

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
          <select className="input-field" value={post.channelId} onChange={e => set({ channelId: e.target.value })}>
            <option value="">— канал —</option>
            {channelsQ.data?.items.map(c => <option key={c.id} value={c.id}>{c.title ?? c.channelKey ?? c.id}</option>)}
          </select>
          {/* sender */}
          <div className="tabs-pill" style={{ width: 'fit-content' }}>
            {(['bot','mtproto_user'] as const).map(s => (
              <button key={s} type="button" disabled={hasButtons && s === 'mtproto_user'}
                onClick={() => set({ sender: s })}
                className={`tabs-pill-item${post.sender === s ? ' is-selected' : ''}`}>
                {s === 'bot' ? 'Бот' : 'MTProto-user'}
              </button>
            ))}
          </div>
          {post.sender === 'bot' && (
            <select className="input-field" value={post.botId ?? ''} onChange={e => set({ botId: e.target.value || null })}>
              <option value="">— бот —</option>
              {bots?.map(b => <option key={b.id} value={b.id}>{b.username ?? b.bot_id}</option>)}
            </select>
          )}
          {/* text */}
          <textarea className="input-field" rows={6} placeholder="Текст (Telegram HTML: <b>, <i>, <a href>)"
            value={post.text} onChange={e => set({ text: e.target.value })} />
          <div className="text-micro" style={{ color: overLimit ? 'var(--color-danger)' : 'var(--color-ink-dim)' }}>{len}/{limit}</div>
          {/* media */}
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="input-field" value={post.mediaType} onChange={e => set({ mediaType: e.target.value as ComposedPostInput['mediaType'] })}>
              <option value="none">без медіа</option><option value="photo">фото</option><option value="video">відео</option>
            </select>
            {post.mediaType !== 'none' && (
              <>
                <input className="input-field" style={{ flex: 1 }} placeholder="media URL"
                  value={post.mediaUrl ?? ''} onChange={e => set({ mediaUrl: e.target.value })} />
                <select className="input-field" value={post.mediaPlacement} onChange={e => set({ mediaPlacement: e.target.value as ComposedPostInput['mediaPlacement'] })}>
                  <option value="above">над текстом</option>
                  {post.sender !== 'mtproto_user' && <option value="below">під текстом</option>}
                </select>
              </>
            )}
          </div>
          {/* buttons */}
          <ButtonsEditor rows={post.buttons} onChange={buttons => set({ buttons })} />
          {/* schedule */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <input className="input-field" type="datetime-local"
              min={toLocalInput(new Date().toISOString())}
              value={toLocalInput(post.scheduledAt)}
              onChange={e => set({ scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : '' })} />
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>(локальний час)</span>
          </div>
          {errors.length > 0 && <ul className="text-micro" style={{ color: 'var(--color-danger)', margin: 0, paddingLeft: 16 }}>{errors.map((x,i) => <li key={i}>{x}</li>)}</ul>}
          {save.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(save.error as Error).message}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
            <button className="btn-secondary" onClick={onDone}>Скасувати</button>
            <button className="btn-primary" disabled={errors.length > 0 || save.isPending}
              onClick={() => save.mutate(post)}>{save.isPending ? 'Зберігаю…' : 'Запланувати'}</button>
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
          <div className="text-eyebrow">Прев'ю</div>
          {/* Faux "Telegram chat" frame — channel header above the message bubble. */}
          <div style={{
            background: 'var(--color-surface-1)',
            border: '1px solid var(--color-hairline)',
            borderRadius: 'var(--radius-lg)',
            padding: 12,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              paddingBottom: 10, marginBottom: 12,
              borderBottom: '1px solid var(--color-hairline-soft)',
            }}>
              <ChannelAvatar name={channelTitle} src={null} size={36} />
              <div style={{ minWidth: 0 }}>
                <div className="text-body-sm" style={{
                  color: 'var(--color-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {channelTitle ?? 'Оберіть канал'}
                </div>
                <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Telegram</div>
              </div>
            </div>
            <TelegramPreview post={post} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ButtonsEditor({ rows, onChange }: { rows: ComposedPostInput['buttons']; onChange: (r: ComposedPostInput['buttons']) => void }) {
  const flat = rows[0]?.buttons ?? [];
  const setBtn = (i: number, patch: Partial<{ label: string; url: string }>) => {
    const next = flat.map((b, bi) => bi === i ? { ...b, ...patch } : b);
    onChange(next.length ? [{ buttons: next }] : []);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="text-eyebrow">Кнопки (url)</div>
      {flat.map((b, i) => (
        <div key={i} style={{ display: 'flex', gap: 6 }}>
          <input className="input-field" style={{ flex: 1 }} placeholder="назва" value={b.label} onChange={e => setBtn(i, { label: e.target.value })} />
          <input className="input-field" style={{ flex: 2 }} placeholder="https://…" value={b.url} onChange={e => setBtn(i, { url: e.target.value })} />
          <button className="btn-tiny" onClick={() => onChange([{ buttons: flat.filter((_, bi) => bi !== i) }].filter(r => r.buttons.length))}>✕</button>
        </div>
      ))}
      <button className="btn-tiny" style={{ width: 'fit-content' }}
        onClick={() => onChange([{ buttons: [...flat, { label: '', url: '' }] }])}>+ кнопка</button>
    </div>
  );
}
