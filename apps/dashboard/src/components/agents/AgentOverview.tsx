// Overview tab of /app/agents/$handle: stat tiles, mode, an orchestrator's
// resource (health + profile, spec 018), the profile form (name, handle, emoji,
// description, model, effort, budget, schedule) and the role children of an
// orchestrator.

import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { SectionCard, StatTile, Field } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { describeError, toast } from '../ui/Toast';
import { fmtUsd } from '../editor/EditorUi';
import { fmtDate, fmtRelative } from '../../lib/format';
import { AgentGlyph, AgentModeSwitch, KIND_LABEL, LastRun, ScopeChip, runsLabel } from './AgentsUi';
import { ResourceSection } from './ResourceProfile';
import { errorBody, usePatchAgent, type AgentDetail, type AgentPatch, type ReasoningEffort } from '../../api/agents';

const HANDLE_RE = /^[a-z][a-z0-9_]{2,31}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const input: CSSProperties = { width: '100%', boxSizing: 'border-box' };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', columnGap: 14 };

interface Form {
  name: string; handle: string; emoji: string; description: string; model: string;
  effort: '' | ReasoningEffort; budget: string; times: string[];
}

function toForm(a: AgentDetail['agent']): Form {
  return {
    name: a.name, handle: a.handle, emoji: a.emoji ?? '', description: a.description ?? '', model: a.model ?? '',
    effort: a.reasoningEffort ?? '', budget: a.dailyBudgetUsd == null ? '' : String(a.dailyBudgetUsd),
    times: [...(a.schedule.times ?? [])].sort(),
  };
}

function validate(f: Form): Partial<Record<keyof Form, string>> {
  const e: Partial<Record<keyof Form, string>> = {};
  if (!f.name.trim() || f.name.trim().length > 60) e.name = '1–60 characters';
  const h = f.handle.trim().replace(/^@/, '').toLowerCase();
  if (!HANDLE_RE.test(h)) e.handle = '3–32 chars: a–z, 0–9, _; starts with a letter';
  if ([...f.emoji.trim()].length > 8) e.emoji = 'one emoji';
  if (f.description.length > 500) e.description = 'up to 500 characters';
  if (f.model.trim() && (f.model.trim().length < 3 || f.model.trim().length > 100)) e.model = '3–100 characters, or blank for the default';
  if (f.budget.trim() !== '') {
    const n = Number(f.budget);
    if (!Number.isFinite(n) || n < 0 || n > 50) e.budget = '0–50 USD, or blank for the default';
  }
  return e;
}

function diff(a: AgentDetail['agent'], f: Form): AgentPatch {
  const p: AgentPatch = {};
  const h = f.handle.trim().replace(/^@/, '').toLowerCase();
  if (f.name.trim() !== a.name) p.name = f.name.trim();
  if (h !== a.handle) p.handle = h;
  if ((f.emoji.trim() || null) !== a.emoji) p.emoji = f.emoji.trim() || null;
  if ((f.description.trim() || null) !== (a.description ?? null)) p.description = f.description.trim() || null;
  if ((f.model.trim() || null) !== a.model) p.model = f.model.trim() || null;
  if ((f.effort || null) !== a.reasoningEffort) p.reasoning_effort = f.effort || null;
  const budget = f.budget.trim() === '' ? null : Number(f.budget);
  if (budget !== a.dailyBudgetUsd) p.daily_budget_usd = budget;
  const before = [...(a.schedule.times ?? [])].sort().join(',');
  if (f.times.join(',') !== before) p.schedule = { times: f.times };
  return p;
}

export function AgentOverview({ data }: { data: AgentDetail }) {
  const a = data.agent;
  const act = a.activity;
  // An orchestrator's day includes its role agents (same roll-up as the list page).
  const kids = data.children;
  const spend = (act?.spentTodayUsd ?? 0) + kids.reduce((s, c) => s + (c.activity?.spentTodayUsd ?? 0), 0);
  const runs = (act?.runsToday ?? 0) + kids.reduce((s, c) => s + (c.activity?.runsToday ?? 0), 0);
  const withRoles = kids.length > 0 ? ' · incl. roles' : '';
  return (
    <div>
      <div className="stat-grid compose-rise" style={{ marginBottom: 18 }}>
        <div className="stat-tile">
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Mode</div>
          <AgentModeSwitch agent={a} />
          {a.shadowUntil && a.mode === 'shadow' && (
            <div className="text-micro" style={{ marginTop: 8, color: 'var(--color-ink-muted)' }}>shadow until {fmtDate(a.shadowUntil)}</div>
          )}
        </div>
        <StatTile label="Spend today" value={fmtUsd(spend)} icon="analytics"
          delta={`cap ${a.dailyBudgetUsd == null ? 'default' : fmtUsd(a.dailyBudgetUsd)}${withRoles}`} />
        <StatTile label="Runs today" value={runs} icon="logs" delta={withRoles ? 'incl. roles' : undefined} />
        <div className="stat-tile">
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Last run</div>
          <LastRun activity={act} />
          {act?.lastRunAt && <div className="text-micro tabular-nums" style={{ marginTop: 8, color: 'var(--color-ink-dim)' }}>{fmtDate(act.lastRunAt)}</div>}
        </div>
      </div>

      {a.kind === 'orchestrator' && a.scopeId && <ResourceSection handle={a.handle} />}

      <ProfileForm key={`${a.id}:${a.updatedAt}`} data={data} />

      {data.children.length > 0 && (
        <SectionCard title="Roles" icon="agents" delay={90} style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.children.map((c, i) => (
              <Link key={c.id} to="/app/agents/$handle" params={{ handle: c.handle }} className="card row-lift compose-rise"
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', textDecoration: 'none', color: 'inherit', flexWrap: 'wrap', animationDelay: `${i * 30}ms` }}>
                <AgentGlyph agent={c} size={30} />
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{KIND_LABEL[c.kind]}</span>
                    <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>@{c.handle}</span>
                    {c.status === 'paused' && <Badge tone="danger">paused</Badge>}
                  </div>
                  {c.model && <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{c.model}</div>}
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
                  <LastRun activity={c.activity} />
                  <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)', minWidth: 96, textAlign: 'right' }}>
                    {fmtUsd(c.activity?.spentTodayUsd ?? 0)} · {runsLabel(c.activity?.runsToday ?? 0)}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 3 }}>{label}</div>
      <div className="text-body-sm" style={{ color: 'var(--color-ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

function ProfileForm({ data }: { data: AgentDetail }) {
  const a = data.agent;
  const navigate = useNavigate();
  const patch = usePatchAgent(a.handle);
  const [f, setF] = useState<Form>(() => toForm(a));
  const [time, setTime] = useState('09:00');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));

  const errors = validate(f);
  const changes = diff(a, f);
  const dirty = Object.keys(changes).length > 0;
  const valid = Object.keys(errors).length === 0;
  const serverErr = errorBody(patch.error);
  const handleErr = errors.handle
    ?? (serverErr?.error === 'handle_taken' ? 'this handle is taken' : serverErr?.error === 'invalid_handle' ? String(serverErr.details ?? 'invalid handle') : undefined);

  const addTime = () => {
    if (!TIME_RE.test(time) || f.times.includes(time) || f.times.length >= 8) return;
    set('times', [...f.times, time].sort());
  };

  // mutateAsync, not mutate callbacks: the refetch after saving remounts this
  // form (its key includes updatedAt), which would drop mutate-level callbacks.
  const save = async () => {
    if (!dirty || !valid) return;
    try {
      const r = await patch.mutateAsync(changes);
      if (changes.handle && r.agent.handle !== a.handle) {
        toast.success(`@${a.handle} is now @${r.agent.handle} — the old handle keeps working for 30 days`);
        navigate({ to: '/app/agents/$handle', params: { handle: r.agent.handle }, replace: true });
      } else {
        toast.success('Profile saved');
      }
    } catch { /* shown inline */ }
  };

  const err = (k: keyof Form) => errors[k] && <div className="text-micro" style={{ color: 'var(--color-danger)', marginTop: 4 }}>{errors[k]}</div>;

  return (
    <SectionCard title="Profile" icon="pencil" delay={40}
      action={dirty ? <Badge tone="warning">unsaved</Badge> : undefined}>
      <div id="agent-profile" style={grid}>
        <Field label="Name">
          <input id="agent-name" className="input-field" style={input} value={f.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
          {err('name')}
        </Field>
        <Field label="Handle" hint={f.handle.trim().replace(/^@/, '').toLowerCase() !== a.handle ? 'old handle stays an alias for 30 days' : undefined}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-ink-dim)' }}>@</span>
            <input className="input-field" style={{ ...input, paddingLeft: 28 }} value={f.handle} maxLength={33} autoCapitalize="none" spellCheck={false}
              onChange={(e) => { set('handle', e.target.value.toLowerCase()); if (patch.error) patch.reset(); }} />
          </div>
          {handleErr && <div className="text-micro" style={{ color: 'var(--color-danger)', marginTop: 4 }}>{handleErr}</div>}
        </Field>
        <Field label="Emoji">
          <input className="input-field" style={input} value={f.emoji} maxLength={8} placeholder="🚀" onChange={(e) => set('emoji', e.target.value)} />
          {err('emoji')}
        </Field>
      </div>
      <Field label="Description" hint={`${f.description.length} / 500`}>
        <textarea className="input-field" style={{ ...input, minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }} value={f.description} maxLength={500}
          onChange={(e) => set('description', e.target.value)} />
        {err('description')}
      </Field>
      <div style={grid}>
        <Field label="Model" hint="blank = role default">
          <input className="input-field" style={input} value={f.model} placeholder="default" spellCheck={false} onChange={(e) => set('model', e.target.value)} />
          {err('model')}
        </Field>
        <Field label="Reasoning effort">
          <select className="input-field" style={input} value={f.effort} onChange={(e) => set('effort', e.target.value as Form['effort'])}>
            <option value="">default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
        </Field>
        <Field label="Daily budget, USD" hint="blank = default cap">
          <input className="input-field" style={input} type="number" min={0} max={50} step={0.05} value={f.budget} placeholder="default" onChange={(e) => set('budget', e.target.value)} />
          {err('budget')}
        </Field>
      </div>
      <Field label="Schedule" hint="Kyiv time · up to 8 runs a day">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {f.times.length === 0 && <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>role default</span>}
          {f.times.map((t) => (
            <span key={t} className="chip tabular-nums" style={{ gap: 4, paddingRight: 4 }}>
              {t}
              <button type="button" aria-label={`Remove ${t}`} title="Remove" onClick={() => set('times', f.times.filter((x) => x !== t))}
                style={{ background: 'none', border: 0, color: 'var(--color-ink-dim)', cursor: 'pointer', display: 'inline-flex', padding: 2 }}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="time" className="input-field" style={{ width: 120, padding: '6px 10px', fontSize: 13, colorScheme: 'dark' }} value={time} onChange={(e) => setTime(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTime(); }} />
            <button type="button" className="btn-tiny" disabled={!TIME_RE.test(time) || f.times.includes(time) || f.times.length >= 8} onClick={addTime}>
              <Icon name="plus" size={12} /> Add
            </button>
          </span>
        </div>
      </Field>

      <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', rowGap: 12, padding: '12px 0', borderTop: '1px solid var(--color-hairline-soft)' }}>
        <Meta label="Kind">{KIND_LABEL[a.kind]}</Meta>
        <Meta label="Scope"><ScopeChip agent={a} /></Meta>
        <Meta label="Created">{fmtDate(a.createdAt)} · {a.createdBy}</Meta>
        <Meta label="Updated">{fmtRelative(a.updatedAt)}</Meta>
      </div>

      {patch.error && !handleErr && <div className="callout-danger" style={{ marginTop: 8 }}>{describeError(patch.error)}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn-secondary" disabled={!dirty || patch.isPending} onClick={() => { setF(toForm(a)); patch.reset(); }}>Reset</button>
        <button type="button" className="btn-primary" disabled={!dirty || !valid || patch.isPending} onClick={save}>
          {patch.isPending ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </SectionCard>
  );
}
