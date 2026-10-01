// A draft from the editor chat (spec 010): the sanitized Telegram preview, its
// channel / format / status and lint notes, with the owner's buttons. The
// buttons call the same deterministic DraftsService as the agent, so every
// publish guard applies; "Запланувати" picks a date/time in Kyiv time.

import { useMemo, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';
import { Modal } from '../Modal';
import { Field } from '../ui/primitives';
import type { Tone } from '../ui/primitives';
import { sanitizeTelegramHtml } from '../../lib/tg-html';
import { KYIV_TZ, fmtKyiv, inputToApi, nextRoundHourKyiv, toKyivInput } from '../../lib/kyiv-time';
import { useDraftAction } from '../../api/chat';
import type { EditorDraft, EditorDraftStatus } from '../../api/types';

export const DRAFT_TONE: Record<EditorDraftStatus, Tone> = {
  draft: 'neutral', scheduled: 'warning', published: 'success', failed: 'danger', canceled: 'neutral',
};

const STATUS_LABEL: Record<EditorDraftStatus, string> = {
  draft: 'чернетка', scheduled: 'заплановано', published: 'опубліковано', failed: 'помилка', canceled: 'скасовано',
};

export function DraftCard({ draft }: { draft: EditorDraft }) {
  const confirm = useConfirm();
  const action = useDraftAction();
  const [scheduling, setScheduling] = useState(false);
  const preview = useMemo(() => (draft.preview ? sanitizeTelegramHtml(draft.preview) : null), [draft.preview]);
  const lintOk = draft.lint?.ok !== false;
  const busy = action.isPending;
  const title = draft.spec.title ?? 'пост';
  const done = draft.status === 'published';

  const publish = async () => {
    const ok = await confirm(`publish "${title}" to ${draft.channelKey} now`, {
      danger: false, confirmLabel: 'Опублікувати',
      details: (
        <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
          The post goes to the real channel right away. Lint, the channel pause and the 7-day source dedup still apply.
          {draft.status === 'scheduled' ? ' The scheduled copy is canceled.' : ''}
        </p>
      ),
    });
    if (!ok) return;
    action.mutate({ id: draft.id, action: 'publish' }, {
      onSuccess: (r) => toast.success(`Опубліковано в ${draft.channelKey}${r.warnings?.length ? ` (${r.warnings.join('; ')})` : ''}`),
    });
  };

  const cancel = async () => {
    const what = draft.status === 'scheduled' ? `cancel the post scheduled for ${fmtKyiv(draft.scheduledAt)}` : `cancel the draft "${title}"`;
    if (await confirm(what, { confirmLabel: 'Скасувати' })) action.mutate({ id: draft.id, action: 'cancel' });
  };

  return (
    <div className="card compose-rise" style={{ padding: 14, maxWidth: 560 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <Badge tone={DRAFT_TONE[draft.status]}>{STATUS_LABEL[draft.status]}</Badge>
        <span className="text-caption" style={{ color: 'var(--color-ink)', fontWeight: 600 }}>{draft.channelKey}</span>
        {draft.spec.format && <span className="chip">{draft.spec.format}</span>}
        {draft.status === 'scheduled' && (
          <span className="text-micro tabular-nums" style={{ color: 'var(--color-warning)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="clock" size={12} /> {fmtKyiv(draft.scheduledAt)} (Київ)
          </span>
        )}
        {done && draft.publishedPostId != null && (
          <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>post #{draft.publishedPostId}</span>
        )}
      </div>

      <div style={{ background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline-soft)', borderRadius: 'var(--radius-lg)', padding: 12 }}>
        {preview
          ? <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}
              dangerouslySetInnerHTML={{ __html: preview }} />
          : <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Превʼю недоступне — виправ помилки нижче.</span>}
      </div>

      {(draft.lint?.errors.length ?? 0) > 0 && (
        <div className="callout-danger" style={{ marginTop: 10, flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          {draft.lint!.errors.map((e, i) => <span key={i} className="text-micro">{e.code}: {e.message}</span>)}
        </div>
      )}
      {(draft.lint?.warnings.length ?? 0) > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {draft.lint!.warnings.map((w, i) => (
            <span key={i} className="text-micro" style={{ color: 'var(--color-warning)' }}>⚠ {w.message}</span>
          ))}
        </div>
      )}
      {draft.error && (
        <div className={draft.status === 'failed' ? 'callout-danger' : 'callout-warning'} style={{ marginTop: 10 }}>
          <span className="text-micro">{draft.error}</span>
        </div>
      )}

      {!done && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button className="btn-primary" disabled={busy || !lintOk} onClick={publish}
            title={lintOk ? 'Publish now (all guards apply)' : 'Fix the lint errors first'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="rocket" size={14} /> Опублікувати зараз
          </button>
          <button className="btn-secondary" disabled={busy || !lintOk} onClick={() => setScheduling(true)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="calendar" size={14} /> {draft.status === 'scheduled' ? 'Перенести' : 'Запланувати'}
          </button>
          {draft.status !== 'canceled' && (
            <button className="btn-ghost" disabled={busy} onClick={cancel}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-danger)' }}>
              <Icon name="ban" size={14} /> Скасувати
            </button>
          )}
        </div>
      )}

      {scheduling && (
        <ScheduleModal
          draft={draft}
          onClose={() => setScheduling(false)}
          onSubmit={(at) => action.mutate({ id: draft.id, action: 'schedule', at }, {
            onSuccess: (r) => { setScheduling(false); toast.success(`Заплановано: ${r.local ?? fmtKyiv(r.draft.scheduledAt)}`); },
          })}
          busy={busy}
        />
      )}
    </div>
  );
}

function ScheduleModal({ draft, onClose, onSubmit, busy }: {
  draft: EditorDraft; onClose: () => void; onSubmit: (at: string) => void; busy: boolean;
}) {
  const [value, setValue] = useState(() => (draft.scheduledAt ? toKyivInput(new Date(draft.scheduledAt)) : nextRoundHourKyiv()));
  const min = toKyivInput(new Date(Date.now() + 3 * 60_000));
  return (
    <Modal open onClose={onClose} title={draft.status === 'scheduled' ? 'Перенести пост' : 'Запланувати пост'}
      subtitle={`${draft.channelKey} · ${draft.spec.title ?? ''}`} icon="calendar">
      <Field label="Дата й час" hint={`за Києвом (${KYIV_TZ})`}>
        <input className="input-field" type="datetime-local" value={value} min={min} step={300}
          onChange={(e) => setValue(e.target.value)} style={{ width: '100%', colorScheme: 'dark' }} />
      </Field>
      <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
        Code publishes it at this time without the LLM, even when the editor is off. At least 2 minutes ahead, at most 60 days.
      </p>
      <div className="modal-foot">
        <button className="btn-secondary" onClick={onClose}>Скасувати</button>
        <button className="btn-primary" disabled={busy || !value} onClick={() => onSubmit(inputToApi(value))}>Запланувати</button>
      </div>
    </Modal>
  );
}
