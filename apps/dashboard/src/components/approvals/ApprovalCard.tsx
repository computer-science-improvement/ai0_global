// A post an agent wrote that waits for the owner (spec 031): the exact preview
// of what will be sent (Telegram bubbles or the platform post), the slot time
// in the resource's zone, the agent's rationale and the owner's actions —
// approve, edit and approve, reschedule, reject. A lost race with another tab
// (409 already_decided) is shown as a toast and the list refreshes.
// Spec 078 D4: status tone and label from lib/status-tone.ts, facts in insets with overline keys, no inline colour. Styles: approvals.css (appr-).

import { useMemo, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { Field } from '../ui/primitives';
import { toast, describeError } from '../ui/Toast';
import { Modal } from '../Modal';
import { SegmentedTabs } from '../SegmentedTabs';
import { TelegramPreview } from '../chat/TelegramPreview';
import { CriticBlock } from '../critic/CriticBlock';
import { ApprovalFindings } from './ApprovalFindings';
import { CompactCard, plainText } from '../ui/CompactCard';
import { CriticBadge } from '../editor/SlotPlan';
import { heldByCritic } from '../../lib/critic';
import { slotLabel, slotTone } from '../../lib/status-tone';
import { errorBody } from '../../api/agents';
import {
  fmtDay, toZonedInput, useApprovalAction, zonedInputToIso, type ApprovalCardData, type RenderedPlatformPost,
} from '../../api/approvals';

/** The post's status as the owner reads it: tone from the app's one status map; a post that ended `skipped` here is one the owner rejected. */
const statusLabel = (status: string) => (status === 'skipped' ? 'Rejected' : slotLabel(status));

const PLATFORM_ICON: Record<string, IconName> = {
  telegram: 'telegram', instagram: 'instagram', facebook: 'facebook', threads: 'threads', tiktok: 'tiktok', youtube: 'globe',
};

/** Owner-facing copy for the server's error codes. */
function explain(err: unknown): string {
  const b = errorBody(err);
  switch (b?.error) {
    case 'already_decided': return 'This post was already decided — in another tab, or its time ran out. The list is refreshed.';
    case 'lint_failed':     return `The edit did not pass the checks: ${Array.isArray(b.details) ? b.details.map((d: any) => d.message ?? d).join('; ') : ''}`;
    case 'quiet_hours':     return `The new time falls in quiet hours: ${b.details ?? ''}`;
    case 'too_close':       return `Too close to another post: ${b.details ?? ''}`;
    case 'too_soon':        return 'The new time must be at least 5 minutes from now.';
    case 'too_far':         return 'The new time must be within 14 days.';
    default:                return describeError(err);
  }
}

/** The card's text line: the platform caption, else the plain text of the Telegram preview. */
function cardText(item: ApprovalCardData): string {
  if (item.render?.kind === 'platform') return item.render.rendered.caption;
  if (item.render?.kind === 'forward') return `Repost of ${item.render.fromKey}/${item.render.messageId}`;
  return plainText(item.preview);
}

function mediaCount(item: ApprovalCardData): number {
  const r = item.render;
  if (r?.kind === 'platform') return r.rendered.imageUrls.length + (r.rendered.videoUrl ? 1 : 0);
  if (r?.kind === 'telegram') return r.messages.reduce((n, m) => n + ('photos' in m ? m.photos.length : 'photo' in m && m.photo ? 1 : 0), 0);
  return 0;
}

/**
 * A post that waits for the owner as a compact card: time, status, resource, format, topic, two lines of
 * the text and what the checks say. A click opens the dialog with the exact preview, the rationale, the
 * critic and the findings, and the actions.
 */
export function ApprovalCard({ item, delay = 0, focused = false }: { item: ApprovalCardData; delay?: number; focused?: boolean }) {
  const waiting = item.status === 'awaiting_approval';
  const issues = item.findings?.length || item.lintWarnings.length;
  const held = heldByCritic(item.critic);
  const media = mediaCount(item);

  return (
    <CompactCard id={`approval-${item.id}`} delay={delay} focused={focused} attention={waiting && (!!issues || held)} hint="Open the post"
      top={<>
        <span className="appr-time mono tabular-nums"><Icon name="clock" size={12} /> {item.localTime}</span>
        <Badge tone={slotTone(item.status)}>{statusLabel(item.status)}</Badge>
        <span className="chip mono appr-format" title={item.resourceRef}>
          <Icon name={PLATFORM_ICON[item.platform] ?? 'globe'} size={11} /> {item.format}
        </span>
        {item.ownerEdited && <span className="chip">edited</span>}
        {item.replacesSlotId && <span className="chip">replacement</span>}
        {item.isExperiment && <span className="chip">experiment</span>}
      </>}
      title={item.topic}
      body={cardText(item) || undefined}
      extra={(item.critic || media > 0) ? (
        <span className="appr-extra">
          <CriticBadge critic={item.critic} />
          {media > 0 && <span className="text-micro mono appr-dim appr-media-count" title="Images and videos"><Icon name="image" size={11} /> {media}</span>}
        </span>
      ) : undefined}
      note={issues ? `${issues} ${issues === 1 ? 'finding' : 'findings'} — check before approving` : undefined}
      dialog={{
        size: 'lg', icon: PLATFORM_ICON[item.platform] ?? 'globe', title: item.topic,
        subtitle: `${item.platform === 'telegram' ? item.channelKey : item.resourceRef} · ${fmtDay(item.planDate)} ${item.localTime} (${item.timezone})`,
        body: () => <ApprovalDetails item={item} />,
        actions: (waiting || item.status === 'approved') ? (close) => <ApprovalActions item={item} onDone={close} /> : undefined,
      }} />
  );
}

/** Everything about the post: the exact preview, the rationale, the critic, the findings and the expiry. */
function ApprovalDetails({ item }: { item: ApprovalCardData }) {
  const title = item.channelTitle || item.channelKey;
  return (
    <div className="appr-details">
      <div className="appr-tags">
        <Badge tone={slotTone(item.status)}>{statusLabel(item.status)}</Badge>
        <span className="chip mono">{item.format}</span>
        {item.ownerEdited && <span className="chip">edited</span>}
        {item.replacesSlotId && <span className="chip">replacement</span>}
        {item.isExperiment && <span className="chip">experiment</span>}
      </div>

      {item.render?.kind === 'telegram'
        ? <TelegramPreview messages={item.render.messages} channelTitle={item.channelTitle} channelKey={item.channelKey} time={item.localTime} />
        : item.render?.kind === 'platform'
          ? <PlatformPreview platform={item.platform} title={title} post={item.render.rendered} time={item.localTime} />
          : item.render?.kind === 'forward'
            ? (
              <div className="inset text-body-sm appr-forward">
                ↪️ Repost of {item.render.fromKey}/{item.render.messageId} into {item.channelKey}
                <span className="text-micro appr-dim appr-block">Forwarded as is at the slot time; it cannot be edited.</span>
              </div>
            )
            : <div className="text-micro appr-dim">Preview unavailable.</div>}

      <Rationale item={item} />

      {item.critic && <CriticBlock critic={item.critic} where="approval" />}

      {/* Spec 037 FR-014: the checks' findings (stories, numbers, dates, lint) with the rule and the fix. */}
      <ApprovalFindings findings={item.findings} />

      {item.lintWarnings.length > 0 && (
        <div className="appr-notes">
          {!item.findings?.length && item.lintWarnings.map((w, i) => <span key={i} className="text-micro appr-warn">⚠ {w}</span>)}
          <span className="text-micro appr-dim">Posts with warnings or a critic verdict other than pass are left out of "Approve all".</span>
        </div>
      )}
      {item.status === 'awaiting_approval' && (
        <div className="text-micro appr-dim appr-expiry">
          If it is not approved by {toZonedInput(new Date(item.expiresAt), item.timezone).replace('T', ' ')} ({item.timezone}), the post will not go out.
        </div>
      )}
    </div>
  );
}

/** Approve, edit, reschedule, reject — the dialog's footer. `onDone` closes the dialog once the post is decided. */
function ApprovalActions({ item, onDone }: { item: ApprovalCardData; onDone: () => void }) {
  const action = useApprovalAction();
  const [modal, setModal] = useState<null | 'edit' | 'reschedule' | 'reject'>(null);
  const busy = action.isPending;
  const waiting = item.status === 'awaiting_approval';
  const approved = item.status === 'approved';
  // A repost (spec 022) is a native forward: it can be approved, moved or rejected, not edited.
  const forward = item.render?.kind === 'forward';
  const editable = waiting || (approved && new Date(item.editableUntil).getTime() > Date.now());
  const settled = () => { setModal(null); onDone(); };

  const approve = () => action.mutate({ id: item.id, action: 'approve' }, {
    onSuccess: (r) => {
      toast.success(r.movedTo
        ? `Approved and moved to ${toZonedInput(new Date(r.movedTo), item.timezone).replace('T', ' ')} — the slot time has passed`
        : 'Approved — it goes out at the slot time');
      onDone();
    },
    onError: (e) => toast.error(explain(e)),
  });

  return (
    <div className="appr-actions">
      {approved && !editable && <span className="text-micro appr-dim appr-locked">Less than 2 minutes to publication — the post is locked.</span>}
      {editable && (
        <button className="btn-ghost appr-reject" disabled={busy} onClick={() => setModal('reject')}>
          <Icon name="ban" size={14} /> Reject
        </button>
      )}
      {editable && (
        <button className="btn-secondary" disabled={busy} onClick={() => setModal('reschedule')}>
          <Icon name="calendar" size={14} /> Reschedule
        </button>
      )}
      {editable && !forward && (
        <button className="btn-secondary" disabled={busy} onClick={() => setModal('edit')}>
          <Icon name="pencil" size={14} /> {waiting ? 'Edit and approve' : 'Edit'}
        </button>
      )}
      {waiting && (
        <button className="btn-primary" disabled={busy} onClick={approve}>
          <Icon name="check" size={14} /> Approve
        </button>
      )}
      {modal === 'edit' && <EditModal item={item} onClose={() => setModal(null)} onSaved={settled} />}
      {modal === 'reschedule' && <RescheduleModal item={item} onClose={() => setModal(null)} onSaved={settled} />}
      {modal === 'reject' && <RejectModal item={item} onClose={() => setModal(null)} onSaved={settled} />}
    </div>
  );
}

function Rationale({ item }: { item: ApprovalCardData }) {
  const r = item.rationale;
  const rows: Array<[string, React.ReactNode]> = [];
  if (r.idea) rows.push(['Idea', <>{r.idea.title}{r.idea.why ? <span className="appr-muted"> — {r.idea.why}</span> : null}</>]);
  if (r.angle) rows.push(['Angle', r.angle]);
  if (r.source) {
    rows.push(['Source', /^https?:\/\//i.test(r.source.url)
      ? <a href={r.source.url} target="_blank" rel="noopener noreferrer nofollow" className="link-accent appr-break">{r.source.label || r.source.url}</a>
      : r.source.url]);
  }
  if (r.plan) rows.push(['Why this time', r.plan]);
  if (!rows.length) return null;
  return (
    <div className="inset appr-rationale">
      {rows.map(([k, v]) => (
        <div key={k} className="appr-kv">
          <span className="text-overline">{k}</span>
          <span className="appr-kv-value">{v}</span>
        </div>
      ))}
    </div>
  );
}

/** How a native post will look on Instagram / Facebook / Threads / TikTok: media, caption, first comment. */
export function PlatformPreview({ platform, title, post, time }: { platform: string; title: string; post: RenderedPlatformPost; time: string }) {
  const media = post.imageUrls.filter((u) => /^https?:\/\//i.test(u));
  return (
    <div className="appr-platform">
      <div className="appr-platform-head">
        <Icon name={PLATFORM_ICON[platform] ?? 'globe'} size={14} />
        <span className="appr-platform-title">{title}</span>
        <span className="appr-platform-meta">{platform} · {time}</span>
      </div>
      {media.length > 0 && (
        <div className={`appr-media${media.length > 1 ? ' is-multi' : ''}`}>
          {media.map((u, i) => <img key={i} src={u} alt="" loading="lazy" referrerPolicy="no-referrer" />)}
        </div>
      )}
      {post.videoUrl && <div className="text-micro appr-muted appr-pad appr-break">🎬 {post.videoUrl}</div>}
      {platform === 'tiktok' && post.title && <div className="text-body-sm appr-pad appr-platform-tt">{post.title}</div>}
      <div className="text-body-sm appr-caption">{post.caption}</div>
      {post.firstComment && <div className="text-micro appr-muted appr-first-comment">💬 {post.firstComment}</div>}
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

function EditModal({ item, onClose, onSaved }: { item: ApprovalCardData; onClose: () => void; onSaved: () => void }) {
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
    try { next = build(); } catch { setError('Could not parse the JSON — check the syntax.'); return; }
    setError(null);
    action.mutate({ id: item.id, action: 'edit', spec: next }, {
      onSuccess: (r) => { toast.success(`Saved and approved${r.warnings?.length ? ` (warnings: ${r.warnings.join('; ')})` : ''}`); onSaved(); },
      onError: (e) => setError(explain(e)),
    });
  };

  return (
    <Modal open onClose={onClose} title={item.status === 'approved' ? 'Edit post' : 'Edit and approve'} subtitle={`${item.resourceRef} · ${item.localTime}`} icon="pencil" size="lg">
      <div className="appr-mode">
        <SegmentedTabs size="sm" value={mode} onChange={setMode}
          options={isPlatform || hasBody ? [{ key: 'text' as const, label: 'Text' }, { key: 'json' as const, label: 'JSON' }] : [{ key: 'json' as const, label: 'JSON' }]} />
      </div>
      {mode === 'text' ? (
        <>
          <Field label={isPlatform ? 'Caption' : 'Text'} hint={isPlatform ? undefined : 'Separate paragraphs with a blank line; "• " starts a list, "> " a quote. The first paragraph stays the headline if it was one.'}>
            <textarea className="input-field appr-textarea" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label="Hashtags" hint="Space-separated, without #">
            <input className="input-field appr-field" value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </>
      ) : (
        <Field label="PostSpec (JSON)" hint="The full post spec: poll, media, buttons.">
          <textarea className="input-field appr-textarea appr-json" rows={16} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
        </Field>
      )}
      {error && <div className="callout-danger appr-err" role="alert"><span className="text-micro">{error}</span></div>}
      <p className="text-micro appr-muted appr-note">Your edit goes through the same checks as the agent's post; the preview updates after saving.</p>
      <div className="modal-foot">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={action.isPending} onClick={save}>{item.status === 'approved' ? 'Save' : 'Save and approve'}</button>
      </div>
    </Modal>
  );
}

function RescheduleModal({ item, onClose, onSaved }: { item: ApprovalCardData; onClose: () => void; onSaved: () => void }) {
  const action = useApprovalAction();
  const [value, setValue] = useState(() => toZonedInput(new Date(item.scheduledAt), item.timezone));
  const [error, setError] = useState<string | null>(null);
  const min = useMemo(() => toZonedInput(new Date(Date.now() + 5 * 60_000), item.timezone), [item.timezone]);
  const submit = () => action.mutate({ id: item.id, action: 'reschedule', at: zonedInputToIso(value, item.timezone) }, {
    onSuccess: () => { toast.success('Time changed'); onSaved(); },
    onError: (e) => setError(explain(e)),
  });
  return (
    <Modal open onClose={onClose} title="Reschedule post" subtitle={`${item.resourceRef} · ${item.topic}`} icon="calendar">
      <Field label="Date and time" hint={`The resource's time zone (${item.timezone}). Quiet hours and the gap to neighbouring posts are checked.`}>
        <input type="datetime-local" value={value} min={min} step={300}
          onChange={(e) => setValue(e.target.value)} className="input-field appr-field appr-datetime" />
      </Field>
      {error && <div className="callout-danger appr-err" role="alert"><span className="text-micro">{error}</span></div>}
      <div className="modal-foot">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={action.isPending || !value} onClick={submit}>Reschedule</button>
      </div>
    </Modal>
  );
}

function RejectModal({ item, onClose, onSaved }: { item: ApprovalCardData; onClose: () => void; onSaved: () => void }) {
  const action = useApprovalAction();
  const [reason, setReason] = useState('');
  const submit = () => action.mutate({ id: item.id, action: 'reject', reason: reason.trim() || undefined }, {
    onSuccess: (r) => {
      toast.success(r.replacementId ? 'Rejected — the agent will write a replacement, which will also wait for approval' : 'Rejected');
      onSaved();
    },
    onError: (e) => { toast.error(explain(e)); onSaved(); },
  });
  return (
    <Modal open onClose={onClose} title="Reject post" subtitle={`${item.resourceRef} · ${item.topic}`} icon="ban">
      <Field label="Reason (optional)" hint="The agent sees it when it writes the replacement.">
        <textarea className="input-field appr-textarea" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="modal-foot">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-danger" disabled={action.isPending} onClick={submit}>Reject</button>
      </div>
    </Modal>
  );
}
