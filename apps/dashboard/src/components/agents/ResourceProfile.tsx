// "Resource" section of an orchestrator's Overview tab (spec 018 FR-006): the
// resource's health (bot access, token state) and its profile — topic,
// audience, goals in priority order, tone, taboo, sources, ads policy — that is
// always in the agent's prompt. Edit opens a form with every field; the server
// validates (ResourceProfileSchema) and its issues are shown at the fields.

import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { EmptyState, Field, SectionCard, type Tone } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { describeError, toast } from '../ui/Toast';
import { Modal } from '../Modal';
import { Toggle } from './AgentsUi';
import { GOAL_LABEL, GoalChips } from '../chat/ActionCard';
import { fmtDate, fmtRelative } from '../../lib/format';
import {
  errorBody, KPI_GOALS, usePutResourceProfile, useResourceProfile,
  type HealthState, type KpiGoal, type ResourceHealth, type ResourceProfile,
} from '../../api/agents';

export const HEALTH: Record<HealthState, { tone: Tone; label: string }> = {
  ok:             { tone: 'success', label: 'healthy' },
  no_access:      { tone: 'danger',  label: 'no access' },
  token_expiring: { tone: 'warning', label: 'token expiring' },
  token_invalid:  { tone: 'danger',  label: 'token invalid' },
  rate_limited:   { tone: 'warning', label: 'rate limited' },
  unknown:        { tone: 'neutral', label: 'unknown' },
};

const GOAL_NOTE: Record<KpiGoal, string> = {
  growth: 'subscribers', engagement: 'reach & reactions', transitions: 'clicks across the network', revenue: 'ads & income',
};

const input: CSSProperties = { width: '100%', boxSizing: 'border-box' };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', columnGap: 14 };

export function HealthBadge({ health }: { health: ResourceHealth | null }) {
  if (!health) return <Badge tone="neutral" title="The resource has not been checked yet">not checked</Badge>;
  const h = HEALTH[health.state] ?? HEALTH.unknown;
  return <Badge tone={h.tone} title={`checked ${fmtDate(health.checkedAt)}`}>{h.label}</Badge>;
}

function Meta({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div style={{ minWidth: 0, gridColumn: wide ? '1 / -1' : undefined }}>
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 3 }}>{label}</div>
      <div className="text-body-sm" style={{ color: 'var(--color-ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

function Chips({ items, empty = '—' }: { items: string[]; empty?: string }) {
  if (!items.length) return <span style={{ color: 'var(--color-ink-dim)' }}>{empty}</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {items.map((x, i) => <span key={`${x}-${i}`} className="chip" style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}>{x}</span>)}
    </span>
  );
}

export function ResourceSection({ handle }: { handle: string }) {
  const q = useResourceProfile(handle);
  const [editing, setEditing] = useState(false);
  const d = q.data;

  const edit = (
    <button type="button" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setEditing(true)}>
      <Icon name="pencil" size={14} /> Edit
    </button>
  );

  return (
    <SectionCard title="Resource" icon="globe" delay={20} style={{ marginBottom: 16 }} action={d?.profile ? edit : undefined}>
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!d && !q.error && <div style={{ height: 80, opacity: 0.5 }} className="panel" />}
      {d && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            {d.ref && <code className="chip" style={{ fontSize: 12, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }} title={d.ref}>{d.ref}</code>}
            <HealthBadge health={d.health} />
            {d.health?.detail && <span className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>{d.health.detail}</span>}
            {d.health && (
              <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }} title={fmtDate(d.health.checkedAt)}>· checked {fmtRelative(d.health.checkedAt)}</span>
            )}
          </div>

          {d.profile ? <ProfileView p={d.profile} updatedAt={d.updatedAt} /> : (
            <EmptyState icon="globe" title="The resource is not described yet"
              note={<>The profile tells the agent what the resource is about, who reads it and what counts as success. You can also ask <strong>@ai0</strong> in the chat to draft it — it proposes a card you apply.</>}
              action={
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <button type="button" className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setEditing(true)}>
                    <Icon name="pencil" size={14} /> Describe the resource
                  </button>
                  <Link to="/app/chat" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
                    <Icon name="chat" size={14} /> Ask @ai0 in chat
                  </Link>
                </div>
              } />
          )}
        </>
      )}
      {editing && d && <ProfileModal handle={handle} initial={d.profile} refName={d.ref} onClose={() => setEditing(false)} />}
    </SectionCard>
  );
}

function ProfileView({ p, updatedAt }: { p: ResourceProfile; updatedAt: string | null }) {
  const aud = [p.audience.who, p.audience.age, p.audience.region].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '14px 18px' }}>
      <Meta label="Topic" wide>{p.topic}</Meta>
      <Meta label="Audience">{aud || '—'}</Meta>
      <Meta label="Language"><span className="chip">{p.language}</span></Meta>
      <Meta label="Goals (by priority)"><GoalChips goals={p.goals} /></Meta>
      <Meta label="Tone">{p.tone || <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}</Meta>
      <Meta label="Frequency">{p.frequency_hint || <span style={{ color: 'var(--color-ink-dim)' }}>—</span>}</Meta>
      <Meta label="Ads">
        {p.ads_allowed.allowed
          ? <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}><Badge tone="success">allowed</Badge><Chips items={p.ads_allowed.categories} empty="any category" /></span>
          : <Badge tone="neutral">not allowed</Badge>}
      </Meta>
      <Meta label="Taboo" wide><Chips items={p.taboo} empty="none" /></Meta>
      <Meta label="Sources" wide><Chips items={p.sources} empty="none" /></Meta>
      <Meta label="Examples" wide><Chips items={p.examples} empty="none" /></Meta>
      {p.notes && <Meta label="Notes" wide><span style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</span></Meta>}
      {updatedAt && <div className="text-micro" style={{ gridColumn: '1 / -1', color: 'var(--color-ink-dim)' }} title={fmtDate(updatedAt)}>updated {fmtRelative(updatedAt)}</div>}
    </div>
  );
}

// ── form ─────────────────────────────────────────────────────────────────────

interface Form {
  topic: string; who: string; age: string; region: string; language: string; goals: KpiGoal[];
  tone: string; taboo: string[]; sources: string[]; frequency: string; adsAllowed: boolean; adCategories: string[];
  examples: string[]; notes: string;
}

/** Form keys, matched against server issue paths (`audience.who`, `taboo.3`, `ads_allowed.categories.0`…). */
const PATH_KEY: Array<[string, keyof Form]> = [
  ['audience.who', 'who'], ['audience.age', 'age'], ['audience.region', 'region'], ['audience', 'who'],
  ['ads_allowed.categories', 'adCategories'], ['ads_allowed', 'adsAllowed'], ['frequency_hint', 'frequency'],
  ['topic', 'topic'], ['language', 'language'], ['goals', 'goals'], ['tone', 'tone'], ['taboo', 'taboo'],
  ['sources', 'sources'], ['examples', 'examples'], ['notes', 'notes'],
];

function toForm(p: ResourceProfile | null): Form {
  return {
    topic: p?.topic ?? '', who: p?.audience.who ?? '', age: p?.audience.age ?? '', region: p?.audience.region ?? '',
    language: p?.language ?? 'uk', goals: p?.goals ?? [], tone: p?.tone ?? '', taboo: p?.taboo ?? [], sources: p?.sources ?? [],
    frequency: p?.frequency_hint ?? '', adsAllowed: p?.ads_allowed.allowed ?? true, adCategories: p?.ads_allowed.categories ?? [],
    examples: p?.examples ?? [], notes: p?.notes ?? '',
  };
}

function toBody(f: Form): ResourceProfile {
  const opt = (s: string) => (s.trim() ? s.trim() : undefined);
  return {
    topic: f.topic.trim(),
    audience: { who: f.who.trim(), age: opt(f.age), region: opt(f.region) },
    language: f.language.trim() || 'uk',
    goals: f.goals,
    tone: opt(f.tone),
    taboo: f.taboo,
    sources: f.sources,
    frequency_hint: opt(f.frequency),
    ads_allowed: { allowed: f.adsAllowed, categories: f.adsAllowed ? f.adCategories : [] },
    examples: f.examples,
    notes: opt(f.notes),
  };
}

const len = (s: string, min: number, max: number) => { const n = s.trim().length; return n >= min && n <= max; };

function validate(f: Form): Partial<Record<keyof Form, string>> {
  const e: Partial<Record<keyof Form, string>> = {};
  if (!len(f.topic, 3, 300)) e.topic = '3–300 characters';
  if (!len(f.who, 2, 200)) e.who = '2–200 characters';
  if (f.age.trim().length > 40) e.age = 'up to 40 characters';
  if (f.region.trim().length > 80) e.region = 'up to 80 characters';
  if (!len(f.language, 2, 10)) e.language = '2–10 characters, e.g. uk';
  if (f.goals.length < 1) e.goals = 'pick at least one goal';
  if (f.tone.trim().length > 300) e.tone = 'up to 300 characters';
  if (f.frequency.trim().length > 120) e.frequency = 'up to 120 characters';
  if (f.notes.trim().length > 800) e.notes = 'up to 800 characters';
  return e;
}

export function ProfileModal({ handle, initial, refName, onClose }: {
  handle: string; initial: ResourceProfile | null; refName: string | null; onClose: () => void;
}) {
  const put = usePutResourceProfile(handle);
  const [f, setF] = useState<Form>(() => toForm(initial));
  const [tried, setTried] = useState(false);
  const [jump, setJump] = useState(0);
  const formRef = useRef<HTMLDivElement | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((s) => ({ ...s, [k]: v }));
    if (put.error) put.reset(); // the server's issues refer to the old values
  };

  const local = validate(f);
  const body = errorBody(put.error);
  const server: Partial<Record<keyof Form, string>> = {};
  const unmatched: string[] = [];
  for (const i of body?.issues ?? []) {
    const path = String(Array.isArray(i.path) ? i.path.join('.') : i.path ?? '');
    const hit = PATH_KEY.find(([pre]) => path === pre || path.startsWith(`${pre}.`));
    if (hit && !server[hit[1]]) server[hit[1]] = i.message;
    else if (!hit) unmatched.push(`${path || 'body'}: ${i.message}`);
  }
  const errs = { ...(tried ? local : {}), ...server };
  const err = (k: keyof Form) => errs[k] && <div className="text-micro" role="alert" style={{ color: 'var(--color-danger)', marginTop: 4 }}>{errs[k]}</div>;

  const toggleGoal = (g: KpiGoal) => set('goals', f.goals.includes(g) ? f.goals.filter((x) => x !== g) : [...f.goals, g]);

  // After a failed save, bring the first invalid field into view (the form is taller than the modal).
  useEffect(() => {
    if (!jump) return;
    formRef.current?.querySelector('[role=alert]')?.closest('.field, label, div')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [jump]);

  const save = async () => {
    setTried(true);
    if (Object.keys(local).length) { setJump((n) => n + 1); return; }
    try {
      await put.mutateAsync(toBody(f));
      toast.success('Resource profile saved');
      onClose();
    } catch { setJump((n) => n + 1); /* issues are shown inline */ }
  };

  return (
    <Modal open onClose={onClose} size="lg" icon="globe" title={initial ? 'Edit resource profile' : 'Describe the resource'}
      subtitle={refName ? `${refName} · always in the agent's prompt` : "Always in the agent's prompt"}>
      <div ref={formRef}>
      <Field label="Topic" hint={`${f.topic.trim().length} / 300 · what the resource is about`}>
        <textarea className="input-field" style={{ ...input, minHeight: 64, resize: 'vertical', fontFamily: 'inherit' }} value={f.topic} maxLength={300}
          placeholder="What the resource is about: topics, format, what sets it apart…" onChange={(e) => set('topic', e.target.value)} />
        {err('topic')}
      </Field>

      <div style={grid}>
        <Field label="Audience">
          <input className="input-field" style={input} value={f.who} maxLength={200} placeholder="Who reads it" onChange={(e) => set('who', e.target.value)} />
          {err('who')}
        </Field>
        <Field label="Age" hint="optional">
          <input className="input-field" style={input} value={f.age} maxLength={40} placeholder="18–35" onChange={(e) => set('age', e.target.value)} />
          {err('age')}
        </Field>
        <Field label="Region" hint="optional">
          <input className="input-field" style={input} value={f.region} maxLength={80} placeholder="Ukraine" onChange={(e) => set('region', e.target.value)} />
          {err('region')}
        </Field>
      </div>

      <Field label="Goals" hint="click in priority order · 1–4">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Goals">
          {KPI_GOALS.map((g) => {
            const n = f.goals.indexOf(g);
            const on = n >= 0;
            return (
              <button key={g} type="button" aria-pressed={on} onClick={() => toggleGoal(g)} className={`chip${on ? ' is-active' : ''}`}
                aria-label={`${GOAL_LABEL[g]} — ${GOAL_NOTE[g]}${on ? ` (priority ${n + 1})` : ''}`} style={{ gap: 6, cursor: 'pointer', border: 0, padding: '5px 10px', fontSize: 12.5 }}>
                <span className="tabular-nums" style={{
                  display: 'inline-grid', placeItems: 'center', width: 16, height: 16, borderRadius: 'var(--radius-pill)', fontSize: 10, fontWeight: 700,
                  background: on ? 'var(--color-accent)' : 'var(--color-surface-2)', color: on ? 'var(--color-on-accent)' : 'var(--color-ink-dim)',
                }}>{on ? n + 1 : '+'}</span>
                {GOAL_LABEL[g]}
                <span style={{ color: 'var(--color-ink-dim)', fontWeight: 400 }}>· {GOAL_NOTE[g]}</span>
              </button>
            );
          })}
        </div>
        {err('goals')}
      </Field>

      <div style={grid}>
        <Field label="Language" hint="code, e.g. uk">
          <input className="input-field" style={input} value={f.language} maxLength={10} spellCheck={false} onChange={(e) => set('language', e.target.value)} />
          {err('language')}
        </Field>
        <Field label="Frequency" hint="optional">
          <input className="input-field" style={input} value={f.frequency} maxLength={120} placeholder="3–5 posts a day" onChange={(e) => set('frequency', e.target.value)} />
          {err('frequency')}
        </Field>
      </div>

      <Field label="Tone" hint="optional">
        <input className="input-field" style={input} value={f.tone} maxLength={300} placeholder="Friendly, to the point, no bureaucratese" onChange={(e) => set('tone', e.target.value)} />
        {err('tone')}
      </Field>

      <Field label="Taboo" hint="topics to avoid · Enter to add">
        <ChipInput values={f.taboo} onChange={(v) => set('taboo', v)} max={30} maxLen={80} placeholder="politics" label="taboo" />
        {err('taboo')}
      </Field>
      <Field label="Sources" hint="sites / feeds / channels · Enter to add">
        <ChipInput values={f.sources} onChange={(v) => set('sources', v)} max={30} maxLen={300} minLen={3} placeholder="site.com or @channel" label="source" />
        {err('sources')}
      </Field>
      <Field label="Examples" hint="resources to look up to · Enter to add">
        <ChipInput values={f.examples} onChange={(v) => set('examples', v)} max={10} maxLen={200} minLen={2} placeholder="@channel" label="example" />
        {err('examples')}
      </Field>

      <Field label="Ads">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Toggle checked={f.adsAllowed} onChange={(v) => set('adsAllowed', v)} label={f.adsAllowed ? 'Ads allowed' : 'No ads'} />
          {f.adsAllowed && (
            <ChipInput values={f.adCategories} onChange={(v) => set('adCategories', v)} max={20} maxLen={60} placeholder="education (empty = any category)" label="category" />
          )}
        </div>
        {err('adCategories') ?? err('adsAllowed')}
      </Field>

      <Field label="Notes" hint={`optional · ${f.notes.trim().length} / 800`}>
        <textarea className="input-field" style={{ ...input, minHeight: 64, resize: 'vertical', fontFamily: 'inherit' }} value={f.notes} maxLength={800}
          onChange={(e) => set('notes', e.target.value)} />
        {err('notes')}
      </Field>

      {(unmatched.length > 0 || (put.error && !body?.issues?.length)) && (
        <div className="callout-danger" style={{ marginBottom: 8, flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
          {unmatched.length ? unmatched.map((u) => <span key={u} className="text-micro">{u}</span>) : <span className="text-micro">{describeError(put.error)}</span>}
        </div>
      )}
      {tried && Object.keys(errs).length > 0 && (
        <div className="text-micro" style={{ color: 'var(--color-danger)', marginBottom: 4 }}>Fix the highlighted fields.</div>
      )}
      </div>

      <div className="modal-foot">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={put.isPending} onClick={save}>{put.isPending ? 'Saving…' : 'Save resource'}</button>
      </div>
    </Modal>
  );
}

/** Tags with ×; Enter or comma adds, Backspace on empty removes the last; typed text is added on blur. */
function ChipInput({ values, onChange, max, maxLen, minLen = 1, placeholder, label }: {
  values: string[]; onChange: (v: string[]) => void; max: number; maxLen: number; minLen?: number; placeholder?: string; label: string;
}) {
  const [text, setText] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const add = (raw: string) => {
    const parts = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return true;
    const next = [...values];
    for (const p of parts) {
      if (p.length < minLen || p.length > maxLen) { setHint(`each ${label}: ${minLen}–${maxLen} characters`); return false; }
      if (next.length >= max) { setHint(`up to ${max}`); return false; }
      if (!next.includes(p)) next.push(p);
    }
    onChange(next);
    setText('');
    setHint(null);
    return true;
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && !text && values.length) {
      onChange(values.slice(0, -1));
    }
  };
  return (
    <div>
      <div className="input-field" style={{ ...input, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '6px 8px', minHeight: 40 }}>
        {values.map((v) => (
          <span key={v} className="chip" style={{ gap: 4, paddingRight: 4, maxWidth: '100%', overflowWrap: 'anywhere' }}>
            {v}
            <button type="button" aria-label={`Remove ${v}`} title="Remove" onClick={() => onChange(values.filter((x) => x !== v))}
              style={{ background: 'none', border: 0, color: 'var(--color-ink-dim)', cursor: 'pointer', display: 'inline-flex', padding: 2 }}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input value={text} onChange={(e) => { setText(e.target.value); if (hint) setHint(null); }} onKeyDown={onKey}
          onBlur={() => { if (text.trim()) add(text); }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text');
            if (/[\n,]/.test(t)) { e.preventDefault(); add(text + t); }
          }}
          disabled={values.length >= max} aria-label={`Add ${label}`}
          placeholder={values.length ? '' : placeholder}
          style={{ flex: '1 1 120px', minWidth: 80, border: 0, outline: 'none', background: 'transparent', color: 'var(--color-ink)', font: 'inherit', fontSize: 13, padding: '2px 0' }} />
      </div>
      {hint && <div className="text-micro" style={{ color: 'var(--color-warning)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}
