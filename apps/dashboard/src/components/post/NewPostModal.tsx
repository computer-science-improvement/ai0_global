import { useMemo, useState, useEffect } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { TelegramPreview } from './TelegramPreview';
import { scheduledPostsApi } from '../../api/scheduled-posts';
import { trackingApi } from '../../api/tracking';
import { useBots } from '../../api/bots';
import type { ComposedPostInput, ScheduledPost } from '../../api/types';

const visibleLen = (html: string) => html.replace(/<[^>]+>/g, '').length;
const limitFor = (s: ComposedPostInput['sender'], m: ComposedPostInput['mediaType']) =>
  m === 'none' ? 4096 : s === 'mtproto_user' ? 2048 : 1024;

export function NewPostModal({ open, onClose, editing }:
  { open: boolean; onClose: () => void; editing?: ScheduledPost | null }) {
  const qc = useQueryClient();
  const { data: bots } = useBots();
  const channelsQ = useQuery({ queryKey: ['channels','mine',1,'',undefined],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', page: 1, pageSize: 100 }) });

  const [post, setPost] = useState<ComposedPostInput>(() => editing ?? {
    channelId: '', sender: 'bot', botId: null, text: '', mediaType: 'none',
    mediaUrl: null, mediaPlacement: 'above', buttons: [], scheduledAt: '',
  });
  useEffect(() => { if (editing) setPost(editing); }, [editing]);

  const hasButtons = post.buttons.some(r => r.buttons.length > 0);
  const len = visibleLen(post.text);
  const limit = limitFor(post.sender, post.mediaType);
  const overLimit = len > limit;
  const set = (patch: Partial<ComposedPostInput>) => setPost(p => ({ ...p, ...patch }));

  // Guardrail: buttons → force bot.
  useEffect(() => { if (hasButtons && post.sender !== 'bot') set({ sender: 'bot' }); }, [hasButtons]);

  const save = useMutation({
    mutationFn: (input: ComposedPostInput) => editing ? scheduledPostsApi.update(editing.id, input) : scheduledPostsApi.create(input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled-posts'] }); onClose(); },
  });

  const errors = useMemo(() => {
    const e: string[] = [];
    if (!post.channelId) e.push('Оберіть канал');
    if (post.sender === 'bot' && !post.botId) e.push('Оберіть бота');
    if ((post.mediaType !== 'none') && !/^https?:\/\//i.test(post.mediaUrl ?? '')) e.push('Медіа-URL має бути http(s)');
    if (!post.scheduledAt) e.push('Вкажіть час');
    if (overLimit) e.push(`Текст ${len}/${limit} — перевищено ліміт`);
    if (hasButtons && post.mediaType !== 'none' && post.mediaPlacement === 'above' && len > 1024)
      e.push('Кнопки + фото з підписом >1024 неможливі в одному пості');
    return e;
  }, [post, len, limit, overLimit, hasButtons]);

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Редагувати пост' : 'Новий пост'} size="lg">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
                  <option value="above">над текстом</option><option value="below">під текстом</option>
                </select>
              </>
            )}
          </div>
          {/* buttons */}
          <ButtonsEditor rows={post.buttons} onChange={buttons => set({ buttons })} />
          {/* schedule */}
          <input className="input-field" type="datetime-local"
            value={post.scheduledAt ? post.scheduledAt.slice(0,16) : ''}
            onChange={e => set({ scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : '' })} />
          {errors.length > 0 && <ul className="text-micro" style={{ color: 'var(--color-danger)', margin: 0, paddingLeft: 16 }}>{errors.map((x,i) => <li key={i}>{x}</li>)}</ul>}
          {save.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(save.error as Error).message}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn-secondary" onClick={onClose}>Скасувати</button>
            <button className="btn-primary" disabled={errors.length > 0 || save.isPending}
              onClick={() => save.mutate(post)}>{save.isPending ? 'Зберігаю…' : 'Запланувати'}</button>
          </div>
        </div>
        <div><div className="text-eyebrow" style={{ marginBottom: 8 }}>Прев'ю</div><TelegramPreview post={post} /></div>
      </div>
    </Modal>
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
