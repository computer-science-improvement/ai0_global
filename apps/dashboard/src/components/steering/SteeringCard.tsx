// Steering (spec 045 FR-008): one set as a compact card (target ← reference, status, rules on / total, conflicts,
// date); the dialog has the summary, the rules with a switch and an edit each, the evidence posts and the actions.

import { useState } from 'react';
import { CompactCard } from '../ui/CompactCard';
import { Badge } from '../ui/Badge';
import { Field } from '../ui/primitives';
import { Modal } from '../Modal';
import { Toggle } from '../agents/AgentsUi';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { errorBody } from '../../api/agents';
import {
  usePatchSteeringRule, useSteeringAction, useSteeringSet, type SteeringAction, type SteeringPostRef, type SteeringRule, type SteeringSetBrief,
} from '../../api/steering';
import {
  ACTION_LABEL, isBusy, refLabel, RULE_KIND_LABEL, rulesEditable, rulesLine, STEERING_STATUS, steeringActions, steeringErrorText,
} from '../../lib/steering';

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });

/** The API error as owner text: the specific reasons when there is a list, else the known code, else the details. */
export function steeringError(e: unknown): string {
  const b = errorBody(e);
  if (Array.isArray(b?.details) && b!.details.length) return (b!.details as string[]).join(' ');
  return steeringErrorText(b?.error, typeof b?.details === 'string' ? b.details : describeError(e));
}

export function SteeringCard({ s, focused, delay }: { s: SteeringSetBrief; focused: boolean; delay: number }) {
  const st = STEERING_STATUS[s.status];
  const source = s.sourceTitle ? `${refLabel(s.sourceRef)} «${s.sourceTitle}»` : refLabel(s.sourceRef);
  const line = rulesLine(s);
  return (
    <CompactCard
      id={`steering-${s.id}`}
      focused={focused}
      delay={delay}
      attention={s.status === 'ready'}
      top={<><Badge tone={st.tone} title={s.reason ?? st.hint}>{st.label}</Badge><span className="chip">{refLabel(s.targetRef)}</span></>}
      meta={when(s.activatedAt ?? s.createdAt)}
      title={<>← {source}</>}
      body={s.summary ?? s.reason ?? (isBusy(s.status) ? 'Reading the reference and writing the rules. It takes about a minute.' : null)}
      extra={line ? <span className="text-micro" style={{ color: s.conflicts ? 'var(--color-warning)' : 'var(--color-ink-muted)' }}>{line}</span> : undefined}
      note={s.status === 'ready' ? 'Review the rules and activate them' : undefined}
      hint="Open the rules"
      dialog={{
        title: `${refLabel(s.targetRef)} ← ${refLabel(s.sourceRef)}`,
        subtitle: st.label,
        icon: 'compass',
        size: 'lg',
        body: () => <SteeringDetails id={s.id} />,
        actions: (close) => <SteeringActions s={s} onDone={close} />,
      }}
    />
  );
}

export function SteeringDetails({ id }: { id: string }) {
  const q = useSteeringSet(id);
  if (q.error) return <div className="callout-danger">{describeError(q.error)}</div>;
  if (!q.data) return <div className="panel" style={{ height: 120, opacity: 0.55 }} />;
  const { set, posts } = q.data;
  const st = STEERING_STATUS[set.status];
  const byKey = new Map(posts.map((p) => [p.key, p]));
  const editable = rulesEditable(set.status);
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {(set.reason || st.hint) && (
        <div className={set.status === 'failed' || set.status === 'no_access' ? 'callout-danger' : 'text-body-sm'} style={{ color: 'var(--color-ink-muted)' }}>
          {set.reason ?? st.hint}
        </div>
      )}
      {isBusy(set.status) && (
        <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
          Reading {refLabel(set.sourceRef)} and writing the rules. It takes about a minute; this dialog updates by itself.
        </div>
      )}
      {set.summary && <Field label="Summary"><div className="text-body-sm">{set.summary}</div></Field>}
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
        Steering is the lowest-priority rule source: your owner rules, the playbook, the profile, formatting and examples win.
        The agent learns the form and the direction of the content, never the reference's text or facts.
      </div>
      {set.rules.length > 0 && (
        <Field label={`Rules (${set.rules.length})`}>
          <div style={{ display: 'grid', gap: 8 }}>
            {set.rules.map((r) => <RuleRow key={r.id} setId={set.id} r={r} posts={byKey} editable={editable} />)}
          </div>
        </Field>
      )}
      {posts.length > 0 && (
        <Field label={`Reference posts (${posts.length})`} hint={isBusy(set.status) ? undefined : 'r1 is the newest'}>
          <div style={{ display: 'grid', gap: 4 }}>
            {posts.map((p) => <PostLine key={p.key} p={p} />)}
          </div>
        </Field>
      )}
      {set.costUsd > 0 && <div className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>Analysis cost ${set.costUsd.toFixed(4)}</div>}
    </div>
  );
}

function PostLine({ p }: { p: SteeringPostRef }) {
  const stats = [p.views != null ? `${p.views} views` : null, p.reactions != null ? `${p.reactions} reactions` : null, p.mediaType].filter(Boolean).join(' · ');
  return (
    <div className="text-body-sm" style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
      <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)', width: 28, flexShrink: 0 }}>{p.key}</span>
      <span className="clamp" style={{ ['--clamp' as string]: 1, flex: 1, minWidth: 0, color: p.firstLine ? 'var(--color-ink)' : 'var(--color-ink-dim)' }}>
        {p.link ? <a href={p.link} target="_blank" rel="noreferrer" className="link-accent">{p.firstLine || '(no text)'}</a> : (p.firstLine || '(no text)')}
      </span>
      <span className="text-micro" style={{ color: 'var(--color-ink-dim)', whiteSpace: 'nowrap' }}>{stats}</span>
    </div>
  );
}

function RuleRow({ setId, r, posts, editable }: { setId: string; r: SteeringRule; posts: Map<string, SteeringPostRef>; editable: boolean }) {
  const patch = usePatchSteeringRule();
  const [editing, setEditing] = useState(false);
  const toggle = (enabled: boolean) => patch.mutate({ id: setId, ruleId: r.id, enabled }, { onError: (e) => toast.error(steeringError(e)) });
  return (
    <div className="card" style={{ padding: '10px 12px', display: 'grid', gap: 6, opacity: r.enabled && !r.conflict ? 1 : 0.75 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone="accent">{RULE_KIND_LABEL[r.kind] ?? r.kind}</Badge>
        {r.conflict && <Badge tone="warning" title={r.conflict.note}>Conflict</Badge>}
        {r.edited && <Badge tone="neutral">Edited</Badge>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 10, alignItems: 'center' }}>
          {editable && !r.conflict && (
            <button type="button" className="btn-tiny" onClick={() => setEditing(true)} disabled={patch.isPending}>Edit</button>
          )}
          <Toggle checked={r.enabled && !r.conflict} onChange={toggle} label={r.enabled ? 'On' : 'Off'}
            disabled={!editable || !!r.conflict || patch.isPending}
            title={r.conflict ? 'A conflicting rule is never given to the agent' : r.enabled ? 'Switch this rule off' : 'Switch this rule on'} />
        </span>
      </div>
      <div className="text-body-sm">{r.text}</div>
      {r.conflict && (
        <div className="text-micro" style={{ color: 'var(--color-warning)' }}>
          Contradicts {r.conflict.with}: {r.conflict.note}. The channel's own rules win, so the agent never gets this rule.
        </div>
      )}
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
        Seen in{' '}
        {r.evidence.post_ids.map((k, i) => {
          const p = posts.get(k);
          return (
            <span key={k}>
              {i > 0 && ', '}
              {p?.link ? <a href={p.link} target="_blank" rel="noreferrer" className="link-accent" title={p.firstLine}>{k}</a> : k}
            </span>
          );
        })}
        {' '}— {r.evidence.note}
      </div>
      {editing && <RuleEditDialog setId={setId} r={r} onClose={() => setEditing(false)} />}
    </div>
  );
}

function RuleEditDialog({ setId, r, onClose }: { setId: string; r: SteeringRule; onClose: () => void }) {
  const patch = usePatchSteeringRule();
  const [text, setText] = useState(r.text);
  const [error, setError] = useState<string | null>(null);
  const t = text.trim();
  const invalid = t.length < 10 || t.length > 300;
  const save = () => patch.mutate({ id: setId, ruleId: r.id, text: t }, {
    onSuccess: () => { toast.success('Rule saved'); onClose(); },
    onError: (e) => setError(steeringError(e)),
  });
  return (
    <Modal open onClose={onClose} title="Edit the rule" subtitle={RULE_KIND_LABEL[r.kind]} icon="pencil">
      <Field label="Rule" hint={`${t.length}/300 · describe the technique in your own words`}>
        <textarea className="input-field" rows={4} value={text} onChange={(e) => { setText(e.target.value); setError(null); }} style={{ width: '100%', boxSizing: 'border-box' }} />
      </Field>
      {error && <div className="callout-danger" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={invalid || t === r.text || patch.isPending} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}

const DONE: Record<SteeringAction, string> = {
  activate: 'Activated: the agent follows these rules from its next run',
  pause: 'Paused', resume: 'Resumed', discard: 'Discarded', reanalyze: 'Queued a new analysis. It takes about a minute.',
};

export function SteeringActions({ s, onDone }: { s: Pick<SteeringSetBrief, 'id' | 'status' | 'sourceRef'>; onDone: () => void }) {
  const act = useSteeringAction();
  const confirm = useConfirm();
  const actions = steeringActions(s.status);
  const run = async (action: SteeringAction) => {
    if (action === 'discard' && !(await confirm(`discard the steering from ${refLabel(s.sourceRef)}`, { danger: true, confirmLabel: 'Discard' }))) return;
    if (action === 'reanalyze' && !(await confirm(`read ${refLabel(s.sourceRef)} again and write new rules (one model run)`, { danger: false, confirmLabel: 'Analyze' }))) return;
    act.mutate({ id: s.id, action }, {
      onSuccess: () => { toast.success(DONE[action]); if (action !== 'pause' && action !== 'resume') onDone(); },
      onError: (e) => toast.error(steeringError(e)),
    });
  };
  if (!actions.length) return <button type="button" className="btn-ghost" onClick={onDone}>Close</button>;
  return (
    <>
      {actions.includes('discard') && (
        <button type="button" className="btn-ghost" style={{ color: 'var(--color-danger)', marginRight: 'auto' }} disabled={act.isPending} onClick={() => run('discard')}>
          Discard
        </button>
      )}
      {actions.filter((a) => a !== 'discard').map((a, i) => (
        <button key={a} type="button" className={i === 0 && (a === 'activate' || a === 'resume') ? 'btn-primary' : 'btn-ghost'} disabled={act.isPending} onClick={() => run(a)}>
          {ACTION_LABEL[a]}
        </button>
      ))}
    </>
  );
}
