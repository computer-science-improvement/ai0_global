// Editorial card form (spec 006 T010). Creates a card (mode approve, spec 031) or edits an
// existing one. The server validates with the same constraints as the
// editor_channels table and its errors are shown inline.

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Modal } from '../Modal';
import { Field } from '../ui/primitives';
import { TableAction } from '../ui/table';
import { describeError } from '../ui/Toast';
import { useUpsertEditorCard } from '../../api/editor';
import type { EditorCard, EditorCardFields, EditorFormat, EditorSource } from '../../api/types';

const FORMATS: EditorFormat[] = ['text', 'photo', 'album', 'poll', 'quiz', 'video', 'carousel', 'longread'];

const SOURCE_PLACEHOLDER: Record<EditorSource['kind'], string> = {
  rss: 'https://…', url: 'https://…', library: 'table, e.g. facts',
  api: 'nasa_apod | spaceflight_news | tmdb_trending | epic_free_games | steam_deals | gamerpower_giveaways | on_this_day',
};

const DEFAULTS: Omit<EditorCardFields, 'mode'> = {
  title: null, language: 'uk', timezone: 'Europe/Kyiv', postsPerDayMin: 2, postsPerDayMax: 6,
  quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60, planHour: 6, brief: '', formats: { text: 1, photo: 1 },
  hashtags: [], hashtagMin: 1, hashtagMax: 3, footer: null, linkStyle: 'inline', emojiPolicy: 'sparse', skills: [],
  sources: [], toolsAllow: null, exploreRatio: 0.2, dailyBudgetUsd: null, models: {}, bannedTerms: [], crosspost: true,
};

const list = (s: string) => s.split(',').map((x) => x.trim().replace(/^#/, '')).filter(Boolean);
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 };
const inputStyle: CSSProperties = { width: '100%', boxSizing: 'border-box' };

interface FormState {
  key: string; title: string; brief: string; timezone: string; language: string;
  postsPerDayMin: string; postsPerDayMax: string; minGapMinutes: string; planHour: string;
  quietStartHour: string; quietEndHour: string;
  formats: Partial<Record<EditorFormat, string>>;
  hashtags: string; hashtagMin: string; hashtagMax: string;
  footer: string; linkStyle: EditorCardFields['linkStyle']; emojiPolicy: EditorCardFields['emojiPolicy'];
  sources: EditorSource[]; skills: string; bannedTerms: string; toolsAllow: string;
  exploreRatio: string; dailyBudgetUsd: string; models: { planner: string; executor: string; reviewer: string };
  crosspost: boolean;
}

function toForm(key: string, c: Omit<EditorCardFields, 'mode'>): FormState {
  return {
    key, title: c.title ?? '', brief: c.brief, timezone: c.timezone, language: c.language,
    postsPerDayMin: String(c.postsPerDayMin), postsPerDayMax: String(c.postsPerDayMax),
    minGapMinutes: String(c.minGapMinutes), planHour: String(c.planHour),
    quietStartHour: String(c.quietStartHour), quietEndHour: String(c.quietEndHour),
    formats: Object.fromEntries(Object.entries(c.formats).map(([f, w]) => [f, String(w)])),
    hashtags: c.hashtags.join(', '), hashtagMin: String(c.hashtagMin), hashtagMax: String(c.hashtagMax),
    footer: c.footer ?? '', linkStyle: c.linkStyle, emojiPolicy: c.emojiPolicy,
    sources: c.sources.map((s) => ({ ...s })), skills: c.skills.join(', '), bannedTerms: c.bannedTerms.join(', '),
    toolsAllow: (c.toolsAllow ?? []).join(', '), exploreRatio: String(c.exploreRatio),
    dailyBudgetUsd: c.dailyBudgetUsd == null ? '' : String(c.dailyBudgetUsd),
    models: { planner: c.models.planner ?? '', executor: c.models.executor ?? '', reviewer: c.models.reviewer ?? '' },
    crosspost: c.crosspost !== false,
  };
}

function toPatch(f: FormState): Partial<EditorCardFields> {
  const n = (s: string) => Number(s);
  const models: EditorCardFields['models'] = {};
  for (const r of ['planner', 'executor', 'reviewer'] as const) if (f.models[r].trim()) models[r] = f.models[r].trim();
  return {
    title: f.title.trim() || null, brief: f.brief, timezone: f.timezone.trim(), language: f.language.trim(),
    postsPerDayMin: n(f.postsPerDayMin), postsPerDayMax: n(f.postsPerDayMax), minGapMinutes: n(f.minGapMinutes),
    planHour: n(f.planHour), quietStartHour: n(f.quietStartHour), quietEndHour: n(f.quietEndHour),
    formats: Object.fromEntries(Object.entries(f.formats).filter(([, w]) => w !== undefined && w !== '').map(([k, w]) => [k, n(w!)])),
    hashtags: list(f.hashtags), hashtagMin: n(f.hashtagMin), hashtagMax: n(f.hashtagMax),
    footer: f.footer.trim() || null, linkStyle: f.linkStyle, emojiPolicy: f.emojiPolicy,
    sources: f.sources.map((s) => ({ id: s.id.trim(), kind: s.kind, ref: s.ref.trim(), ...(s.note?.trim() ? { note: s.note.trim() } : {}) })),
    skills: list(f.skills), bannedTerms: list(f.bannedTerms),
    toolsAllow: list(f.toolsAllow).length ? list(f.toolsAllow) : null,
    exploreRatio: n(f.exploreRatio), dailyBudgetUsd: f.dailyBudgetUsd.trim() === '' ? null : n(f.dailyBudgetUsd),
    models, crosspost: f.crosspost,
  };
}

function Num({ value, onChange, step = 1, min, max }: { value: string; onChange: (v: string) => void; step?: number; min?: number; max?: number }) {
  return <input className="input-field" style={inputStyle} type="number" step={step} min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ borderTop: '1px solid var(--color-hairline-soft)', paddingTop: 14, marginTop: 4 }}>
      <div className="text-eyebrow" style={{ marginBottom: 10, color: 'var(--color-ink-muted)' }}>{title}</div>
      {children}
    </div>
  );
}

export function CardEditorModal({ open, onClose, card }: { open: boolean; onClose: () => void; card: EditorCard | null }) {
  const isNew = !card;
  const [f, setF] = useState<FormState>(() => toForm(card?.channelKey ?? '', card ?? DEFAULTS));
  const upsert = useUpsertEditorCard();
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const setSource = (i: number, patch: Partial<EditorSource>) =>
    setF((s) => ({ ...s, sources: s.sources.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));

  const submit = async () => {
    const key = f.key.trim();
    if (!key) return;
    try {
      await upsert.mutateAsync({ key, card: toPatch(f) });
      onClose();
    } catch { /* shown inline below */ }
  };

  return (
    <Modal open={open} onClose={onClose} size="lg" icon="sparkles"
      title={isNew ? 'New channel card' : `Edit card · ${card.channelKey}`}
      subtitle={isNew ? 'Created in approval mode: the agent writes posts, but each one waits for your approval.' : 'What the editor agents know about this channel.'}>
      {isNew && (
        <Field label="Channel key" hint="tracked_channels.channel_key, e.g. @my_channel">
          <input className="input-field" style={inputStyle} value={f.key} onChange={(e) => set('key', e.target.value)} placeholder="@my_channel" />
        </Field>
      )}
      <Field label="Title">
        <input className="input-field" style={inputStyle} value={f.title} onChange={(e) => set('title', e.target.value)} />
      </Field>
      <Field label="Brief" hint="what the channel is about, audience, no-go topics">
        <textarea className="input-field" style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} rows={4} value={f.brief} onChange={(e) => set('brief', e.target.value)} />
      </Field>

      <Group title="Formats and weights">
        <div style={grid}>
          {FORMATS.map((fmt) => {
            const on = f.formats[fmt] !== undefined;
            return (
              <label key={fmt} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="text-caption" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={on} onChange={(e) => set('formats', { ...f.formats, [fmt]: e.target.checked ? '0.5' : undefined })} />
                  {fmt}
                </span>
                <input className="input-field" style={inputStyle} type="number" step={0.05} min={0.01} max={1} disabled={!on}
                  value={f.formats[fmt] ?? ''} onChange={(e) => set('formats', { ...f.formats, [fmt]: e.target.value })} />
              </label>
            );
          })}
        </div>
      </Group>

      <Group title="Limits">
        <div style={grid}>
          <Field label="Posts/day min"><Num value={f.postsPerDayMin} onChange={(v) => set('postsPerDayMin', v)} min={0} max={48} /></Field>
          <Field label="Posts/day max"><Num value={f.postsPerDayMax} onChange={(v) => set('postsPerDayMax', v)} min={1} max={48} /></Field>
          <Field label="Min gap, min"><Num value={f.minGapMinutes} onChange={(v) => set('minGapMinutes', v)} min={0} /></Field>
          <Field label="Plan hour"><Num value={f.planHour} onChange={(v) => set('planHour', v)} min={0} max={23} /></Field>
          <Field label="Quiet from"><Num value={f.quietStartHour} onChange={(v) => set('quietStartHour', v)} min={0} max={23} /></Field>
          <Field label="Quiet until"><Num value={f.quietEndHour} onChange={(v) => set('quietEndHour', v)} min={0} max={23} /></Field>
        </div>
        <div style={grid}>
          <Field label="Time zone"><input className="input-field" style={inputStyle} value={f.timezone} onChange={(e) => set('timezone', e.target.value)} /></Field>
          <Field label="Language"><input className="input-field" style={inputStyle} value={f.language} onChange={(e) => set('language', e.target.value)} /></Field>
          <Field label="Explore ratio"><Num value={f.exploreRatio} onChange={(v) => set('exploreRatio', v)} step={0.05} min={0} max={1} /></Field>
          <Field label="Budget $/day" hint="blank = env"><Num value={f.dailyBudgetUsd} onChange={(v) => set('dailyBudgetUsd', v)} step={0.05} min={0} /></Field>
        </div>
      </Group>

      <Group title="Style">
        <Field label="Hashtag vocabulary" hint="comma-separated, without #">
          <input className="input-field" style={inputStyle} value={f.hashtags} onChange={(e) => set('hashtags', e.target.value)} />
        </Field>
        <div style={grid}>
          <Field label="Hashtags min"><Num value={f.hashtagMin} onChange={(v) => set('hashtagMin', v)} min={0} max={10} /></Field>
          <Field label="Hashtags max"><Num value={f.hashtagMax} onChange={(v) => set('hashtagMax', v)} min={0} max={10} /></Field>
          <Field label="Links">
            <select className="input-field" style={inputStyle} value={f.linkStyle} onChange={(e) => set('linkStyle', e.target.value as FormState['linkStyle'])}>
              <option value="inline">inline</option><option value="footer">footer</option><option value="button">button</option>
            </select>
          </Field>
          <Field label="Emoji">
            <select className="input-field" style={inputStyle} value={f.emojiPolicy} onChange={(e) => set('emojiPolicy', e.target.value as FormState['emojiPolicy'])}>
              <option value="none">none</option><option value="sparse">sparse</option><option value="free">free</option>
            </select>
          </Field>
        </div>
        <Field label="Footer" hint="signature line, plain text">
          <input className="input-field" style={inputStyle} value={f.footer} onChange={(e) => set('footer', e.target.value)} />
        </Field>
        <Field label="Banned terms" hint="comma-separated">
          <input className="input-field" style={inputStyle} value={f.bannedTerms} onChange={(e) => set('bannedTerms', e.target.value)} />
        </Field>
        <label className="text-caption" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <input type="checkbox" checked={f.crosspost} onChange={(e) => set('crosspost', e.target.checked)} />
          Cross-post live posts to the channel's Meta targets (Instagram / Facebook / Threads)
        </label>
      </Group>

      <Group title="Sources">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          {f.sources.map((s, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '110px 100px 1fr 32px', gap: 8, alignItems: 'center' }}>
              <input className="input-field" style={inputStyle} placeholder="id" value={s.id} onChange={(e) => setSource(i, { id: e.target.value })} />
              <select className="input-field" style={inputStyle} value={s.kind} onChange={(e) => setSource(i, { kind: e.target.value as EditorSource['kind'] })}>
                <option value="rss">rss</option><option value="url">url</option><option value="library">library</option><option value="api">api</option>
              </select>
              <input className="input-field" style={inputStyle} placeholder={SOURCE_PLACEHOLDER[s.kind]} value={s.ref} onChange={(e) => setSource(i, { ref: e.target.value })} />
              <TableAction action="delete" title="Remove source" onClick={() => set('sources', f.sources.filter((_, j) => j !== i))} />
            </div>
          ))}
        </div>
        <button type="button" className="btn-tiny" onClick={() => set('sources', [...f.sources, { id: `src${f.sources.length + 1}`, kind: 'rss', ref: '' }])}>
          + Add source
        </button>
      </Group>

      <Group title="Agents">
        <Field label="Skills" hint="editor-skills loaded on every run, comma-separated">
          <input className="input-field" style={inputStyle} value={f.skills} onChange={(e) => set('skills', e.target.value)} />
        </Field>
        <Field label="Tools allowlist" hint="blank = role defaults">
          <input className="input-field" style={inputStyle} value={f.toolsAllow} onChange={(e) => set('toolsAllow', e.target.value)} />
        </Field>
        <div style={grid}>
          {(['planner', 'executor', 'reviewer'] as const).map((r) => (
            <Field key={r} label={`Model · ${r}`} hint="blank = default">
              <input className="input-field" style={inputStyle} value={f.models[r]} onChange={(e) => set('models', { ...f.models, [r]: e.target.value })} />
            </Field>
          ))}
        </div>
      </Group>

      {upsert.error && <div className="callout-danger" style={{ marginTop: 8 }}>{describeError(upsert.error)}</div>}
      <div className="modal-foot">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={upsert.isPending || !f.key.trim()} onClick={submit}>
          {upsert.isPending ? 'Saving…' : isNew ? 'Create card' : 'Save card'}
        </button>
      </div>
    </Modal>
  );
}
