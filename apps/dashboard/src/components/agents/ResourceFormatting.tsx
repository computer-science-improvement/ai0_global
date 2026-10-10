// "Formatting" section of an orchestrator's Overview tab (spec 024 FR-013):
// how posts are presented on each resource of the agent's network —
// format_prefs the agents evolve themselves (update_resource_format, at most 3
// changes per resource a day). The owner edits the same fields and locks any of
// them (a locked field is read-only to agents); every change is a version with
// who, when, why and the diff. Platform hard limits stay in code.

import { useState, type CSSProperties, type ReactNode } from 'react';
import { EmptyState, Field, SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { describeError, toast } from '../ui/Toast';
import { Modal } from '../Modal';
import { ChipInput } from './ResourceProfile';
import { PlatformIcon } from './NetworkUi';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useResourceLabels } from '../../api/network';
import {
  errorBody, FORMAT_PREF_FIELDS, usePutResourceFormatting, useResourceFormatting,
  type FormatPrefField, type FormatResource, type FormatVersion,
} from '../../api/agents';
import { audienceSummary, CONTENT_KIND_LABEL, FORMAT_LABEL, formatValue, toForm, toPrefs, voiceSummary, type FormatForm as Form } from '../../lib/format-prefs';

/** Spec 034 FR-005: the audience caps are shown in one chip of their own (unset = the defaults). */
const AUDIENCE_FIELDS: readonly FormatPrefField[] = ['content_kind', 'polls_per_week', 'questions_to_readers_per_day'];

const input: CSSProperties = { width: '100%', boxSizing: 'border-box' };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))', columnGap: 14 };

export function FormattingSection({ handle }: { handle: string }) {
  const q = useResourceFormatting(handle);
  const label = useResourceLabels();
  const [editing, setEditing] = useState<FormatResource | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const d = q.data;

  return (
    <SectionCard title="Formatting" icon="wrench" delay={30} style={{ marginBottom: 16 }}>
      <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: '0 0 12px' }}>
        How posts look on each resource. The agent adjusts these itself from results (at most {d?.changesPerDay ?? 3} changes per resource a day);
        lock a field to keep it yours. Platform limits are always enforced by code.
      </p>
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!d && !q.error && <div style={{ height: 80, opacity: 0.5 }} className="panel" />}
      {d && !d.resources.length && <EmptyState icon="wrench" title="No resources to format" note="This agent has no resource of its own." />}
      {d && d.resources.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {d.resources.map((r) => {
            const l = label(r.ref);
            // Humour and slang are always shown in one chip (unset = off, spec 034).
            const set = FORMAT_PREF_FIELDS.filter((k) => k !== 'humor' && k !== 'slang' && !AUDIENCE_FIELDS.includes(k) && r.formatPrefs[k] !== undefined);
            const voiceLocked = r.locks.includes('humor') || r.locks.includes('slang');
            const audienceLocked = AUDIENCE_FIELDS.some((k) => r.locks.includes(k));
            return (
              <div key={r.ref} className="card row-lift" style={{ padding: '10px 12px', display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                    <PlatformIcon platform={l.platform} />
                    <strong className="text-body-sm" title={l.title} style={{ overflowWrap: 'anywhere' }}>{r.title ?? l.label}</strong>
                    <Badge tone={r.changesToday >= d.changesPerDay ? 'warning' : 'neutral'} title="Agent changes today (resource time zone)">
                      {r.changesToday}/{d.changesPerDay} today
                    </Badge>
                    {r.locks.length > 0 && <Badge tone="accent">{r.locks.length} locked</Badge>}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: set.length ? 6 : 4 }}>
                    <span className="chip" style={{ gap: 4, maxWidth: '100%', overflowWrap: 'anywhere' }}
                      title="Humour and slang are off unless you allow them; agents cannot turn them on">
                      {voiceLocked && <Icon name="lock" size={11} />}
                      <span style={{ color: 'var(--color-ink-dim)' }}>Voice:</span> {voiceSummary(r.formatPrefs)}
                    </span>
                    <span className="chip" style={{ gap: 4, maxWidth: '100%', overflowWrap: 'anywhere' }}
                      title="Polls and questions to readers are capped; plans and posts over the cap are refused. Agents can only lower the caps">
                      {audienceLocked && <Icon name="lock" size={11} />}
                      <span style={{ color: 'var(--color-ink-dim)' }}>Audience asks:</span> {audienceSummary(r.formatPrefs, r.audience)}
                    </span>
                  </div>
                  {set.length ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {set.map((k) => (
                        <span key={k} className="chip" style={{ gap: 4, maxWidth: '100%', overflowWrap: 'anywhere' }} title={r.locks.includes(k) ? 'Locked by you' : 'Set by the agent or you'}>
                          {r.locks.includes(k) && <Icon name="lock" size={11} />}
                          <span style={{ color: 'var(--color-ink-dim)' }}>{FORMAT_LABEL[k]}:</span> {formatValue(k, r.formatPrefs[k])}
                        </span>
                      ))}
                    </div>
                  ) : <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Not set — the agent's judgement</span>}
                </div>
                <button type="button" className="btn-act" aria-label={`Edit formatting of ${l.label}`} title="Edit" onClick={() => setEditing(r)}>
                  <Icon name="pencil" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {d && (
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn-ghost" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="history" size={14} /> Change history ({d.history.length})
            <Icon name={showHistory ? 'chevron-up' : 'chevron-down'} size={14} />
          </button>
          {showHistory && <History items={d.history} label={(ref) => label(ref).label} />}
        </div>
      )}
      {editing && <FormatModal handle={handle} resource={editing} title={label(editing.ref).label} onClose={() => setEditing(null)} />}
    </SectionCard>
  );
}

function who(v: FormatVersion): string {
  if (v.changedBy === 'agent') return v.agentHandle ? `@${v.agentHandle}` : 'agent';
  return v.changedBy === 'owner' ? 'you' : v.changedBy;
}

function History({ items, label }: { items: FormatVersion[]; label: (ref: string) => string }) {
  if (!items.length) return <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 8 }}>No changes yet.</div>;
  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {items.map((v) => (
        <li key={v.id} className="panel" style={{ padding: '8px 10px' }}>
          <div className="text-micro" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', color: 'var(--color-ink-muted)' }}>
            <Badge tone={v.changedBy === 'agent' ? 'accent' : 'neutral'}>{who(v)}</Badge>
            <span style={{ overflowWrap: 'anywhere' }}>{label(v.resourceRef)}</span>
            <span title={fmtDate(v.createdAt)}>· {fmtRelative(v.createdAt)}</span>
            <span>· v{v.version}</span>
          </div>
          {v.reason && <div className="text-body-sm" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>{v.reason}</div>}
          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {Object.entries(v.diff).map(([k, x]) => (
              <li key={k} className="text-micro" style={{ overflowWrap: 'anywhere' }}>{diffLine(k, x.from, x.to)}</li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function diffLine(key: string, from: unknown, to: unknown): ReactNode {
  const k = key.replace(/^format_prefs\./, '') as FormatPrefField | 'format_locks';
  if (k === 'format_locks') return <>Locks: {(from as string[] | null)?.join(', ') || 'none'} → {(to as string[] | null)?.join(', ') || 'none'}</>;
  if (!(FORMAT_PREF_FIELDS as readonly string[]).includes(k)) return <>{key} changed</>;
  return <><strong>{FORMAT_LABEL[k as FormatPrefField]}</strong>: {formatValue(k as FormatPrefField, from)} → {formatValue(k as FormatPrefField, to)}</>;
}

// ── edit form ────────────────────────────────────────────────────────────────

function LockToggle({ field, locked, onChange }: { field: FormatPrefField; locked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="btn-act" aria-pressed={locked} onClick={() => onChange(!locked)}
      aria-label={`${locked ? 'Unlock' : 'Lock'} ${FORMAT_LABEL[field]}`} title={locked ? 'Locked: the agent cannot change it' : 'Unlocked: the agent may change it'}
      style={{ flexShrink: 0, color: locked ? 'var(--color-accent)' : 'var(--color-ink-dim)' }}>
      <Icon name={locked ? 'lock' : 'unlock'} size={14} />
    </button>
  );
}

function Row({ field, locked, onLock, children }: { field: FormatPrefField; locked: boolean; onLock: (v: boolean) => void; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      <div style={{ paddingTop: 24 }}><LockToggle field={field} locked={locked} onChange={onLock} /></div>
    </div>
  );
}

function FormatModal({ handle, resource, title, onClose }: { handle: string; resource: FormatResource; title: string; onClose: () => void }) {
  const put = usePutResourceFormatting(handle);
  const [f, setF] = useState<Form>(() => toForm(resource.formatPrefs));
  const [locks, setLocks] = useState<FormatPrefField[]>(resource.locks);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setF((s) => ({ ...s, [k]: v })); if (put.error) put.reset(); };
  const lock = (k: FormatPrefField) => (v: boolean) => setLocks((s) => (v ? [...new Set([...s, k])] : s.filter((x) => x !== k)));
  const is = (k: FormatPrefField) => locks.includes(k);

  const body = errorBody(put.error);
  const issues = (body?.issues ?? []).map((i) => `${String(i.path ?? '').replace(/^format_prefs\./, '') || 'form'}: ${i.message}`);
  const save = async () => {
    try {
      await put.mutateAsync({ ref: resource.ref, format_prefs: toPrefs(f), format_locks: locks });
      toast.success('Formatting saved');
      onClose();
    } catch { /* shown inline */ }
  };

  return (
    <Modal open onClose={onClose} size="lg" icon="wrench" title="Edit formatting" subtitle={`${title} · empty = the agent's judgement · lock = the agent cannot change it`}>
      <Row field="tone" locked={is('tone')} onLock={lock('tone')}>
        <Field label="Tone"><input className="input-field" style={input} value={f.tone} maxLength={200} placeholder="Friendly, to the point" onChange={(e) => set('tone', e.target.value)} /></Field>
      </Row>
      <Row field="length" locked={is('length')} onLock={lock('length')}>
        <div style={grid}>
          <Field label="Length target" hint="characters"><input className="input-field" style={input} type="number" min={10} value={f.lengthTarget} onChange={(e) => set('lengthTarget', e.target.value)} /></Field>
          <Field label="Length max" hint="characters"><input className="input-field" style={input} type="number" min={10} value={f.lengthMax} onChange={(e) => set('lengthMax', e.target.value)} /></Field>
        </div>
      </Row>
      <div style={grid}>
        <Row field="emoji" locked={is('emoji')} onLock={lock('emoji')}>
          <Field label="Emoji">
            <select className="input-field" style={input} value={f.emoji} onChange={(e) => set('emoji', e.target.value as Form['emoji'])}>
              <option value="">Agent's choice</option><option value="none">None</option><option value="light">Light</option><option value="rich">Rich</option>
            </select>
          </Field>
        </Row>
        <Row field="links" locked={is('links')} onLock={lock('links')}>
          <Field label="Links">
            <select className="input-field" style={input} value={f.links} onChange={(e) => set('links', e.target.value as Form['links'])}>
              <option value="">Agent's choice</option><option value="inline">In the text</option><option value="bio">Link in bio</option>
              <option value="first_comment">First comment</option><option value="button">Button</option>
            </select>
          </Field>
        </Row>
      </div>
      {resource.platform === 'telegram' && (
        <Row field="rich" locked={is('rich')} onLock={lock('rich')}>
          <Field label="Rich messages" hint="Telegram headings, tables, numbered lists, formulas">
            <select className="input-field" style={input} value={f.rich} onChange={(e) => set('rich', e.target.value as Form['rich'])}>
              <option value="">Agent's choice</option><option value="auto">Auto: when the post uses them</option>
              <option value="prefer">Prefer for every text post</option><option value="never">Never (plain HTML)</option>
            </select>
          </Field>
        </Row>
      )}
      <div style={grid}>
        <Row field="humor" locked={is('humor')} onLock={lock('humor')}>
          <Field label="Humour" hint="only you can turn it on">
            <select className="input-field" style={input} value={f.humor} onChange={(e) => set('humor', e.target.value as Form['humor'])}>
              <option value="">Off: no jokes or memes</option><option value="light">Light humour</option>
            </select>
          </Field>
        </Row>
        <Row field="slang" locked={is('slang')} onLock={lock('slang')}>
          <Field label="Slang" hint="only you can turn it on">
            <select className="input-field" style={input} value={f.slang} onChange={(e) => set('slang', e.target.value as Form['slang'])}>
              <option value="">Off: plain language</option><option value="yes">Allowed</option>
            </select>
          </Field>
        </Row>
      </div>
      <Row field="content_kind" locked={is('content_kind')} onLock={lock('content_kind')}>
        <Field label="Resource kind" hint="news: no reader questions · quiz: no poll limit">
          <select className="input-field" style={input} value={f.contentKind} onChange={(e) => set('contentKind', e.target.value as Form['contentKind'])}>
            <option value="">{resource.audience?.kindInferred ? `From the topic: ${CONTENT_KIND_LABEL[resource.audience.kind].toLowerCase()}` : 'From the topic'}</option>
            <option value="general">General</option><option value="news">News</option>
            <option value="education">Education</option><option value="quiz">Quiz</option>
          </select>
        </Field>
      </Row>
      <div style={grid}>
        <Row field="polls_per_week" locked={is('polls_per_week')} onLock={lock('polls_per_week')}>
          <Field label="Polls a week" hint="polls + quizzes, any 7 days">
            <input className="input-field" style={input} type="number" min={0} max={70} value={f.pollsPerWeek}
              placeholder={f.contentKind === 'quiz' ? 'no limit' : '1 (default)'} onChange={(e) => set('pollsPerWeek', e.target.value)} />
          </Field>
        </Row>
        <Row field="questions_to_readers_per_day" locked={is('questions_to_readers_per_day')} onLock={lock('questions_to_readers_per_day')}>
          <Field label="Reader questions" hint="per post">
            <input className="input-field" style={input} type="number" min={0} max={5} value={f.questionsPerPost}
              placeholder={(f.contentKind || resource.audience?.kind) === 'news' ? '0 (default for news)' : '1 (default)'}
              onChange={(e) => set('questionsPerPost', e.target.value)} />
          </Field>
        </Row>
      </div>
      <Row field="hashtags" locked={is('hashtags')} onLock={lock('hashtags')}>
        <div style={grid}>
          <Field label="Hashtags" hint="how many"><input className="input-field" style={input} type="number" min={0} max={30} value={f.hashCount} onChange={(e) => set('hashCount', e.target.value)} /></Field>
          <Field label="Hashtag style" hint="optional"><input className="input-field" style={input} value={f.hashStyle} maxLength={60} placeholder="lowercase, Ukrainian" onChange={(e) => set('hashStyle', e.target.value)} /></Field>
        </div>
        <Field label="Always include" hint="without # · Enter to add"><ChipInput values={f.hashFixed} onChange={(v) => set('hashFixed', v.map((x) => x.replace(/^#/, '')))} max={10} maxLen={40} placeholder="space" label="hashtag" /></Field>
      </Row>
      <div style={grid}>
        <Row field="cta" locked={is('cta')} onLock={lock('cta')}>
          <Field label="Call to action"><input className="input-field" style={input} value={f.cta} maxLength={200} placeholder="Save it for later" onChange={(e) => set('cta', e.target.value)} /></Field>
        </Row>
        <Row field="mentions" locked={is('mentions')} onLock={lock('mentions')}>
          <Field label="Mentions"><input className="input-field" style={input} value={f.mentions} maxLength={200} placeholder="Credit the source account" onChange={(e) => set('mentions', e.target.value)} /></Field>
        </Row>
        <Row field="line_breaks" locked={is('line_breaks')} onLock={lock('line_breaks')}>
          <Field label="Line breaks"><input className="input-field" style={input} value={f.lineBreaks} maxLength={120} placeholder="Short paragraphs" onChange={(e) => set('lineBreaks', e.target.value)} /></Field>
        </Row>
        <Row field="signature" locked={is('signature')} onLock={lock('signature')}>
          <Field label="Signature"><input className="input-field" style={input} value={f.signature} maxLength={200} onChange={(e) => set('signature', e.target.value)} /></Field>
        </Row>
      </div>
      <Row field="preferred_formats" locked={is('preferred_formats')} onLock={lock('preferred_formats')}>
        <Field label="Preferred formats" hint="e.g. ig_carousel · Enter to add"><ChipInput values={f.formats} onChange={(v) => set('formats', v)} max={10} maxLen={30} minLen={2} placeholder="ig_carousel" label="format" /></Field>
      </Row>
      <Row field="media" locked={is('media')} onLock={lock('media')}>
        <div style={grid}>
          <Field label="Aspect" hint="optional"><input className="input-field" style={input} value={f.aspect} maxLength={20} placeholder="4:5" onChange={(e) => set('aspect', e.target.value)} /></Field>
          <Field label="Cover style" hint="optional"><input className="input-field" style={input} value={f.cover} maxLength={120} placeholder="Big headline on the first slide" onChange={(e) => set('cover', e.target.value)} /></Field>
        </div>
      </Row>
      <Row field="notes" locked={is('notes')} onLock={lock('notes')}>
        <Field label="Notes" hint={`${f.notes.trim().length} / 1000`}>
          <textarea className="input-field" style={{ ...input, minHeight: 64, resize: 'vertical', fontFamily: 'inherit' }} value={f.notes} maxLength={1000} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </Row>
      {put.error && (
        <div className="callout-danger" style={{ marginBottom: 8, flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
          {issues.length ? issues.map((x) => <span key={x} className="text-micro">{x}</span>) : <span className="text-micro">{describeError(put.error)}</span>}
        </div>
      )}
      <div className="modal-foot">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={put.isPending} onClick={save}>{put.isPending ? 'Saving…' : 'Save formatting'}</button>
      </div>
    </Modal>
  );
}
