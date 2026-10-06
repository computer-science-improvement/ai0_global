// A post an agent wrote that waits for the owner (spec 031): the exact preview
// of what will be sent (Telegram bubbles or the platform post), the slot time
// in the resource's zone, the agent's rationale and the owner's actions —
// approve, edit and approve, reschedule, reject. A lost race with another tab
// (409 already_decided) is shown as a toast and the list refreshes.

import { useMemo, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { Field } from '../ui/primitives';
import type { Tone } from '../ui/primitives';
import { toast, describeError } from '../ui/Toast';
import { Modal } from '../Modal';
import { SegmentedTabs } from '../SegmentedTabs';
import { TelegramPreview } from '../chat/TelegramPreview';
import { errorBody } from '../../api/agents';
import {
  toZonedInput, useApprovalAction, zonedInputToIso, type ApprovalCardData, type RenderedPlatformPost,
} from '../../api/approvals';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  awaiting_approval: { label: 'Чекає апруву', tone: 'warning' },
  approved:          { label: 'Апрувнуто', tone: 'accent' },
  expired:           { label: 'Прострочено', tone: 'neutral' },
  skipped:           { label: 'Відхилено', tone: 'neutral' },
  published:         { label: 'Опубліковано', tone: 'success' },
};

const PLATFORM_ICON: Record<string, IconName> = {
  telegram: 'telegram', instagram: 'instagram', facebook: 'facebook', threads: 'threads', tiktok: 'tiktok', youtube: 'globe',
};

/** Ukrainian copy for the server's error codes. */
function explain(err: unknown): string {
  const b = errorBody(err);
  switch (b?.error) {
    case 'already_decided': return 'Цей пост уже вирішено — в іншій вкладці або минув час. Список оновлено.';
    case 'lint_failed':     return `Правка не пройшла перевірку: ${Array.isArray(b.details) ? b.details.map((d: any) => d.message ?? d).join('; ') : ''}`;
    case 'quiet_hours':     return `Тихі години: ${b.details ?? ''}`;
    case 'too_close':       return `Занадто близько до іншого поста: ${b.details ?? ''}`;
    case 'too_soon':        return 'Новий час — щонайменше за 5 хвилин.';
    case 'too_far':         return 'Новий час — не далі 14 днів.';
    default:                return describeError(err);
  }
}

export function ApprovalCard({ item, delay = 0 }: { item: ApprovalCardData; delay?: number }) {
  const action = useApprovalAction();
  const [modal, setModal] = useState<null | 'edit' | 'reschedule' | 'reject'>(null);
  const busy = action.isPending;
  const waiting = item.status === 'awaiting_approval';
  const approved = item.status === 'approved';
  const editable = waiting || (approved && new Date(item.editableUntil).getTime() > Date.now());
  const st = STATUS[item.status] ?? { label: item.status, tone: 'neutral' as Tone };
  const title = item.channelTitle || item.channelKey;

  const approve = () => action.mutate({ id: item.id, action: 'approve' }, {
    onSuccess: (r) => toast.success(r.movedTo
      ? `Апрувнуто й перенесено на ${toZonedInput(new Date(r.movedTo), item.timezone).replace('T', ' ')} — час слота вже минув`
      : 'Апрувнуто — вийде в час слота'),
    onError: (e) => toast.error(explain(e)),
  });

  return (
    <div className="card compose-rise" style={{ padding: 14, minWidth: 0, animationDelay: `${delay}ms` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <Badge tone={st.tone}>{st.label}</Badge>
        <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="clock" size={12} /> {item.localTime}
        </span>
        <span className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.resourceRef}>
          <Icon name={PLATFORM_ICON[item.platform] ?? 'globe'} size={11} /> {item.platform === 'telegram' ? item.channelKey : item.resourceRef}
        </span>
        <span className="chip">{item.format}</span>
        {item.ownerEdited && <span className="chip">редаговано</span>}
        {item.replacesSlotId && <span className="chip">заміна</span>}
        {item.isExperiment && <span className="chip">експеримент</span>}
      </div>

      <div className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 600, marginBottom: 8, overflowWrap: 'anywhere' }}>{item.topic}</div>

      {item.render?.kind === 'telegram'
        ? <TelegramPreview messages={item.render.messages} channelTitle={item.channelTitle} channelKey={item.channelKey} time={item.localTime} />
        : item.render?.kind === 'platform'
          ? <PlatformPreview platform={item.platform} title={title} post={item.render.rendered} time={item.localTime} />
          : <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Превʼю недоступне.</div>}

      <Rationale item={item} />

      {item.lintWarnings.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {item.lintWarnings.map((w, i) => <span key={i} className="text-micro" style={{ color: 'var(--color-warning)' }}>⚠ {w}</span>)}
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Пости з попередженнями не входять у «Апрувнути все».</span>
        </div>
      )}
      {waiting && (
        <div className="text-micro" style={{ marginTop: 8, color: 'var(--color-ink-dim)' }}>
          Якщо не апрувнути до {toZonedInput(new Date(item.expiresAt), item.timezone).replace('T', ' ')} ({item.timezone}), пост не вийде.
        </div>
      )}

      {(waiting || approved) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          {waiting && (
            <button className="btn-primary" disabled={busy} onClick={approve} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="check" size={14} /> Апрувнути
            </button>
          )}
          {editable && (
            <button className="btn-secondary" disabled={busy} onClick={() => setModal('edit')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="pencil" size={14} /> {waiting ? 'Редагувати й апрувнути' : 'Редагувати'}
            </button>
          )}
          {editable && (
            <button className="btn-secondary" disabled={busy} onClick={() => setModal('reschedule')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="calendar" size={14} /> Перенести
            </button>
          )}
          {editable && (
            <button className="btn-ghost" disabled={busy} onClick={() => setModal('reject')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)' }}>
              <Icon name="ban" size={14} /> Відхилити
            </button>
          )}
          {approved && !editable && <span className="text-micro" style={{ color: 'var(--color-ink-dim)', alignSelf: 'center' }}>Менше 2 хвилин до публікації — картку заблоковано.</span>}
        </div>
      )}

      {modal === 'edit' && <EditModal item={item} onClose={() => setModal(null)} />}
      {modal === 'reschedule' && <RescheduleModal item={item} onClose={() => setModal(null)} />}
      {modal === 'reject' && <RejectModal item={item} onClose={() => setModal(null)} />}
    </div>
  );
}

function Rationale({ item }: { item: ApprovalCardData }) {
  const r = item.rationale;
  const rows: Array<[string, React.ReactNode]> = [];
  if (r.idea) rows.push(['Ідея', <>{r.idea.title}{r.idea.why ? <span style={{ color: 'var(--color-ink-muted)' }}> — {r.idea.why}</span> : null}</>]);
  if (r.angle) rows.push(['Кут', r.angle]);
  if (r.source) {
    rows.push(['Джерело', /^https?:\/\//i.test(r.source.url)
      ? <a href={r.source.url} target="_blank" rel="noopener noreferrer nofollow" className="link-accent" style={{ wordBreak: 'break-all' }}>{r.source.label || r.source.url}</a>
      : r.source.url]);
  }
  if (r.plan) rows.push(['Чому цей час', r.plan]);
  if (!rows.length) return null;
  return (
    <div style={{ marginTop: 10, padding: '8px 10px', background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline-soft)', borderRadius: 'var(--radius-md)', display: 'grid', gap: 4 }}>
      {rows.map(([k, v]) => (
        <div key={k} className="text-micro" style={{ display: 'flex', gap: 8, minWidth: 0 }}>
          <span style={{ color: 'var(--color-ink-dim)', flexShrink: 0, width: 92 }}>{k}</span>
          <span style={{ color: 'var(--color-ink)', minWidth: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

/** How a native post will look on Instagram / Facebook / Threads / TikTok: media, caption, first comment. */
export function PlatformPreview({ platform, title, post, time }: { platform: string; title: string; post: RenderedPlatformPost; time: string }) {
  const media = post.imageUrls.filter((u) => /^https?:\/\//i.test(u));
  return (
    <div style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline-soft)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', maxWidth: 480 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--color-hairline-soft)' }}>
        <Icon name={PLATFORM_ICON[platform] ?? 'globe'} size={14} />
        <span className="text-micro" style={{ color: 'var(--color-ink)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <span className="text-micro" style={{ marginLeft: 'auto', color: 'var(--color-ink-dim)' }}>{platform} · {time}</span>
      </div>
      {media.length > 0 && (
        <div style={{ display: 'flex', gap: 2, overflowX: 'auto', scrollSnapType: 'x mandatory' }}>
          {media.map((u, i) => (
            <img key={i} src={u} alt="" loading="lazy" referrerPolicy="no-referrer"
              style={{ width: media.length > 1 ? '80%' : '100%', flexShrink: 0, aspectRatio: '1 / 1', objectFit: 'cover', scrollSnapAlign: 'start', background: 'var(--color-surface-2)' }} />
          ))}
        </div>
      )}
      {post.videoUrl && <div className="text-micro" style={{ padding: '6px 10px', color: 'var(--color-ink-muted)', wordBreak: 'break-all' }}>🎬 {post.videoUrl}</div>}
      {platform === 'tiktok' && post.title && <div className="text-body-sm" style={{ padding: '8px 10px 0', fontWeight: 600, color: 'var(--color-ink)' }}>{post.title}</div>}
      <div className="text-body-sm" style={{ padding: '8px 10px', color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}>{post.caption}</div>
      {post.firstComment && (
        <div className="text-micro" style={{ padding: '0 10px 8px', color: 'var(--color-ink-muted)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>💬 {post.firstComment}</div>
      )}
    </div>
  );
}

// ── editing ────────────────────────────────────────────────────────────────

type Block = { type: 'lead' | 'p' | 'quote'; text: string } | { type: 'list'; items: string[] };

/** PostSpec body → editable text: blocks separated by blank lines; "• " list lines, "> " quotes. */
function bodyToText(body: Block[]): string {
  return body.map((b) => b.type === 'list' ? b.items.map((i) => `• ${i}`).join('\n') : b.type === 'quote' ? `> ${b.text}` : b.text).join('\n\n');
}

function textToBody(text: string, firstIsLead: boolean): Block[] {
  return text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).map((chunk, i): Block => {
    const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.every((l) => /^[•\-–]\s+/.test(l))) return { type: 'list', items: lines.map((l) => l.replace(/^[•\-–]\s+/, '')) };
    if (chunk.startsWith('> ')) return { type: 'quote', text: chunk.slice(2).trim() };
    return { type: i === 0 && firstIsLead ? 'lead' : 'p', text: chunk };
  });
}

function EditModal({ item, onClose }: { item: ApprovalCardData; onClose: () => void }) {
  const action = useApprovalAction();
  const spec = item.spec ?? {};
  const isPlatform = item.platform !== 'telegram';
  const hasBody = !isPlatform && Array.isArray(spec.body) && spec.body.length > 0;
  const [mode, setMode] = useState<'text' | 'json'>(isPlatform || hasBody ? 'text' : 'json');
  const [text, setText] = useState(() => isPlatform ? String(spec.caption ?? '') : hasBody ? bodyToText(spec.body) : '');
  const [tags, setTags] = useState(() => (Array.isArray(spec.hashtags) ? spec.hashtags.join(' ') : ''));
  const [json, setJson] = useState(() => JSON.stringify(spec, null, 2));
  const [error, setError] = useState<string | null>(null);

  const build = (): unknown => {
    if (mode === 'json') return JSON.parse(json);
    const hashtags = tags.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
    if (isPlatform) return { ...spec, caption: text, hashtags };
    return { ...spec, body: textToBody(text, spec.body?.[0]?.type === 'lead'), hashtags };
  };

  const save = () => {
    let next: unknown;
    try { next = build(); } catch { setError('JSON не розібрано — перевірте синтаксис.'); return; }
    setError(null);
    action.mutate({ id: item.id, action: 'edit', spec: next }, {
      onSuccess: (r) => { toast.success(`Збережено й апрувнуто${r.warnings?.length ? ` (попередження: ${r.warnings.join('; ')})` : ''}`); onClose(); },
      onError: (e) => setError(explain(e)),
    });
  };

  return (
    <Modal open onClose={onClose} title={item.status === 'approved' ? 'Редагувати пост' : 'Редагувати й апрувнути'} subtitle={`${item.resourceRef} · ${item.localTime}`} icon="pencil" size="lg">
      <div style={{ marginBottom: 10 }}>
        <SegmentedTabs size="sm" value={mode} onChange={setMode}
          options={isPlatform || hasBody ? [{ key: 'text' as const, label: 'Текст' }, { key: 'json' as const, label: 'JSON' }] : [{ key: 'json' as const, label: 'JSON' }]} />
      </div>
      {mode === 'text' ? (
        <>
          <Field label={isPlatform ? 'Підпис' : 'Текст'} hint={isPlatform ? undefined : 'Абзаци через порожній рядок; «• » — список, «> » — цитата. Перший абзац лишається заголовком, якщо був ним.'}>
            <textarea className="input-field" rows={10} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
          </Field>
          <Field label="Хештеги" hint="Через пробіл, без #">
            <input className="input-field" value={tags} onChange={(e) => setTags(e.target.value)} style={{ width: '100%' }} />
          </Field>
        </>
      ) : (
        <Field label="PostSpec (JSON)" hint="Повна специфікація поста: опитування, медіа, кнопки.">
          <textarea className="input-field" rows={16} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false}
            style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }} />
        </Field>
      )}
      {error && <div className="callout-danger" style={{ marginTop: 8 }}><span className="text-micro" style={{ overflowWrap: 'anywhere' }}>{error}</span></div>}
      <p className="text-micro" style={{ margin: '8px 0 0', color: 'var(--color-ink-muted)' }}>Правка проходить ту саму перевірку, що й пост агента; превʼю оновиться після збереження.</p>
      <div className="modal-foot">
        <button className="btn-secondary" onClick={onClose}>Скасувати</button>
        <button className="btn-primary" disabled={action.isPending} onClick={save}>{item.status === 'approved' ? 'Зберегти' : 'Зберегти й апрувнути'}</button>
      </div>
    </Modal>
  );
}

function RescheduleModal({ item, onClose }: { item: ApprovalCardData; onClose: () => void }) {
  const action = useApprovalAction();
  const [value, setValue] = useState(() => toZonedInput(new Date(item.scheduledAt), item.timezone));
  const [error, setError] = useState<string | null>(null);
  const min = useMemo(() => toZonedInput(new Date(Date.now() + 5 * 60_000), item.timezone), [item.timezone]);
  const submit = () => action.mutate({ id: item.id, action: 'reschedule', at: zonedInputToIso(value, item.timezone) }, {
    onSuccess: () => { toast.success('Час змінено'); onClose(); },
    onError: (e) => setError(explain(e)),
  });
  return (
    <Modal open onClose={onClose} title="Перенести пост" subtitle={`${item.resourceRef} · ${item.topic}`} icon="calendar">
      <Field label="Дата й час" hint={`Час ресурсу (${item.timezone}). Код перевірить тихі години й інтервал із сусідніми постами.`}>
        <input className="input-field" type="datetime-local" value={value} min={min} step={300}
          onChange={(e) => setValue(e.target.value)} style={{ width: '100%', colorScheme: 'dark' }} />
      </Field>
      {error && <div className="callout-danger" style={{ marginTop: 8 }}><span className="text-micro">{error}</span></div>}
      <div className="modal-foot">
        <button className="btn-secondary" onClick={onClose}>Скасувати</button>
        <button className="btn-primary" disabled={action.isPending || !value} onClick={submit}>Перенести</button>
      </div>
    </Modal>
  );
}

function RejectModal({ item, onClose }: { item: ApprovalCardData; onClose: () => void }) {
  const action = useApprovalAction();
  const [reason, setReason] = useState('');
  const submit = () => action.mutate({ id: item.id, action: 'reject', reason: reason.trim() || undefined }, {
    onSuccess: (r) => {
      toast.success(r.replacementId ? 'Відхилено — агент напише заміну, вона теж чекатиме апруву' : 'Відхилено');
      onClose();
    },
    onError: (e) => { toast.error(explain(e)); onClose(); },
  });
  return (
    <Modal open onClose={onClose} title="Відхилити пост" subtitle={`${item.resourceRef} · ${item.topic}`} icon="ban">
      <Field label="Причина (необовʼязково)" hint="Агент побачить її, коли писатиме заміну.">
        <textarea className="input-field" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />
      </Field>
      <div className="modal-foot">
        <button className="btn-secondary" onClick={onClose}>Скасувати</button>
        <button className="btn-danger" disabled={action.isPending} onClick={submit}>Відхилити</button>
      </div>
    </Modal>
  );
}
