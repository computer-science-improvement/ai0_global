// Spec 034 FR-008: the body of @ai0's "Example posts" card (shown in its details dialog). Three example posts for the new agent's resource,
// each as a Telegram preview, which the owner marks good or bad and can edit; then 2–4 warnings about bad posts
// (a pattern, why it is bad here and a short bad example), each kept or dropped. ActionCard sends the choices
// with Apply; the server stores them in the playbook's examples (the writer's few-shot, the critic's reference).

import { useMemo, useState } from 'react';
import { Icon } from '../ui/Icon';
import { TelegramPreview } from './TelegramPreview';
import {
  previewMessages, savedCount, type ContentExamplesPayload, type ContentExamplesState, type ExampleChoice, type Verdict,
} from '../../lib/content-examples';

const VERDICT_LABEL: Record<Verdict, string> = { good: 'Good', bad: 'Bad' };

function VerdictToggle({ value, onChange, disabled }: { value: Verdict; onChange: (v: Verdict) => void; disabled: boolean }) {
  return (
    <span role="group" aria-label="Verdict" className="verdict">
      {(['good', 'bad'] as const).map((v) => (
        <button key={v} type="button" disabled={disabled} aria-pressed={value === v} onClick={() => onChange(v)}
          className={`chip-toggle${v === 'bad' ? ' is-bad' : ''}`}>
          <Icon name={v === 'good' ? 'check' : 'x'} size={12} strokeWidth={2.5} /> {VERDICT_LABEL[v]}
        </button>
      ))}
    </span>
  );
}

function ExampleItem({ n, e, choice, onChange, pending, channelTitle, channelKey }: {
  n: number; e: ContentExamplesPayload['examples'][number]; choice: ExampleChoice; onChange: (c: ExampleChoice) => void;
  pending: boolean; channelTitle: string; channelKey: string;
}) {
  const [editing, setEditing] = useState(false);
  const edited = choice.text !== null && choice.text.trim() !== e.text.trim();
  const messages = useMemo(() => previewMessages(e, choice.text), [e, choice.text]);
  return (
    <div className="inset example-item">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="text-caption" style={{ fontWeight: 600, color: 'var(--color-ink)' }}>Example {n}</span>
        <span className="chip">{e.format}</span>
        {edited && <span className="chip">edited</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {pending && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing((x) => !x)} aria-expanded={editing}>
              <Icon name={editing ? 'check' : 'pencil'} size={12} /> {editing ? 'Done' : 'Edit'}
            </button>
          )}
          <VerdictToggle value={choice.verdict} disabled={!pending} onChange={(verdict) => onChange({ ...choice, verdict })} />
        </span>
      </div>
      {editing && pending ? (
        <textarea className="input-field" aria-label={`Text of example ${n}`} rows={6} value={choice.text ?? e.text}
          onChange={(ev) => onChange({ ...choice, text: ev.target.value })}
          style={{ width: '100%', resize: 'vertical', lineHeight: 1.5 }} />
      ) : (
        <TelegramPreview messages={messages} channelTitle={channelTitle} channelKey={channelKey} time="example" />
      )}
      {e.why && <span className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>Why it fits: {e.why}</span>}
      {/* Lint notes describe the text as written; an edit is checked again on Apply. */}
      {!edited && e.notes.map((note, i) => (
        <span key={i} className="text-micro" style={{ color: 'var(--color-warning)', overflowWrap: 'anywhere' }}>⚠ {note}</span>
      ))}
      {pending && choice.verdict === 'bad' && (
        <input className="input-field" aria-label={`Why example ${n} is bad`} placeholder="Why is it bad? (optional, the writer and the critic read it)"
          value={choice.note} maxLength={300} onChange={(ev) => onChange({ ...choice, note: ev.target.value })} style={{ width: '100%' }} />
      )}
    </div>
  );
}

export function ContentExamplesBody({ payload, state, onChange, pending }: {
  payload: ContentExamplesPayload; state: ContentExamplesState; onChange: (s: ContentExamplesState) => void; pending: boolean;
}) {
  const channelKey = payload.resource_ref.replace(/^[a-z]+:/, '') || payload.resource_ref;
  const title = payload.handle ? `@${payload.handle} · ${channelKey}` : channelKey;
  const count = savedCount(state);
  // The card's dialog is the expansion: a decided card shows the same body, read-only.
  return (
    <>
      <div style={{ display: 'grid', gap: 10 }}>
        {payload.examples.map((e, i) => (
          <ExampleItem key={i} n={i + 1} e={e} pending={pending} channelTitle={title} channelKey={channelKey}
            choice={state.examples[i] ?? { verdict: 'good', text: null, note: '' }}
            onChange={(c) => onChange({ ...state, examples: state.examples.map((x, k) => (k === i ? c : x)) })} />
        ))}
      </div>
      {payload.warnings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          <span className="text-caption" style={{ fontWeight: 600, color: 'var(--color-ink)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="warning" size={14} /> Warnings: posts to avoid
          </span>
          {payload.warnings.map((w, i) => {
            const keep = state.keep[i] ?? true;
            return (
              <label key={i} className={`inset example-warning${keep ? '' : ' is-off'}`} style={{ cursor: pending ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={keep} disabled={!pending} aria-label={`Keep warning: ${w.pattern}`}
                  onChange={(ev) => onChange({ ...state, keep: state.keep.map((x, k) => (k === i ? ev.target.checked : x)) })} style={{ marginTop: 3 }} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 600, overflowWrap: 'anywhere' }}>{w.pattern}</span>
                  <span className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>{w.why}</span>
                  <span className="text-body-sm card-quote is-bad" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{w.bad_example}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}
      {pending && (
        <p className="text-micro" style={{ margin: '10px 0 0', color: 'var(--color-ink-dim)' }}>
          Apply saves {count.good} good and {count.bad} bad examples to @{payload.handle || 'the agent'}&apos;s playbook. The writer follows the good ones; the critic checks posts against both.
        </p>
      )}
    </>
  );
}

/** The compact card's line: "3 example posts · 2 warnings to mark" (pending) or what was proposed (decided). */
export function examplesCardLine(payload: ContentExamplesPayload, pending: boolean): string {
  const n = payload.examples.length;
  const w = payload.warnings.length;
  const posts = `${n} example ${n === 1 ? 'post' : 'posts'}`;
  if (!w) return pending ? `${posts} to mark` : posts;
  return `${posts} · ${w} ${w === 1 ? 'warning' : 'warnings'}${pending ? ' to mark' : ''}`;
}
