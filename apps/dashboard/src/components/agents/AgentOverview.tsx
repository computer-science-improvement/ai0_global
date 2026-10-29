// Overview tab of /app/agents/$handle: stat tiles, mode, an orchestrator's
// resource (health + profile, spec 018), the profile summary — its form (name,
// handle, emoji, description, model, effort, budget, schedule) opens in a dialog
// from Edit — and the role children of an orchestrator.
//
// Spec 034 FR-013 (schedule settings tell the truth): only @manager's run times
// are editable here — they drive its runs. An orchestrator and its role agents run
// at the channel card's plan hour (approval mode: the next day at 20:00 the evening
// before); the form shows that read-only, with a link to the card.

import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { SectionCard, StatStrip, StatTile, Field } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { describeError, toast } from '../ui/Toast';
import { Modal } from '../Modal';
import { fmtUsd } from '../editor/EditorUi';
import { fmtDate, fmtRelative } from '../../lib/format';
import { AgentGlyph, KIND_LABEL, LastRun, ScopeChip, runsLabel } from './AgentsUi';
import { errorBody, useAgentConfigConflicts, usePatchAgent, type AgentDetail, type AgentPatch, type GrammaticalGender, type ReasoningEffort } from '../../api/agents';
import { useModelCatalog, type Workspace } from '../../api/models';
import { ownModelIn, WORKSPACE_LABEL } from '../../lib/models';
import { useEditorChannel } from '../../api/editor';
import { planScheduleNote } from '../../lib/slot-plan';
import { ModelSelect } from '../models/ModelSelect';
import { useActiveSteering } from '../../api/steering';
import { useArtifacts } from '../../api/artifacts';
import { statusLabel } from '../../lib/artifacts';
import { alignPrompt } from '../../lib/align';
import { useDirectives } from '../../api/manager';
import { adviceCounts, planAtLine } from '../../lib/agent-overview';
import { zoneLabel } from '../../lib/zoned-time';
import { TodaySteps } from './TodaySteps';
import { ChannelSummary, FormattingSummary } from './AgentSummaries';

const HANDLE_RE = /^[a-z][a-z0-9_]{2,31}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const input: CSSProperties = { width: '100%', boxSizing: 'border-box' };
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', columnGap: 14 };

interface Form {
  name: string; handle: string; emoji: string; description: string; model: string;
  effort: '' | ReasoningEffort; voice: GrammaticalGender; budget: string; times: string[];
}

function toForm(a: AgentDetail['agent'], ws: Workspace): Form {
  return {
    name: a.name, handle: a.handle, emoji: a.emoji ?? '', description: a.description ?? '', model: ownModelIn(a, ws) ?? '',
    effort: a.reasoningEffort ?? '', voice: a.grammaticalGender ?? 'masculine', budget: a.dailyBudgetUsd == null ? '' : String(a.dailyBudgetUsd),
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

/** Only @manager's schedule drives its runs (spec 034 FR-013); every other agent follows its channel's plan hour. */
function scheduleEditable(a: Pick<AgentDetail['agent'], 'kind'>): boolean {
  return a.kind === 'manager';
}

/** `model` is the agent's model in the active workspace (spec 038): the server stores it in that workspace's column. */
function diff(a: AgentDetail['agent'], f: Form, ws: Workspace): AgentPatch {
  const p: AgentPatch = {};
  const h = f.handle.trim().replace(/^@/, '').toLowerCase();
  if (f.name.trim() !== a.name) p.name = f.name.trim();
  if (h !== a.handle) p.handle = h;
  if ((f.emoji.trim() || null) !== a.emoji) p.emoji = f.emoji.trim() || null;
  if ((f.description.trim() || null) !== (a.description ?? null)) p.description = f.description.trim() || null;
  if ((f.model.trim() || null) !== ownModelIn(a, ws)) p.model = f.model.trim() || null;
  if ((f.effort || null) !== a.reasoningEffort) p.reasoning_effort = f.effort || null;
  if (f.voice !== (a.grammaticalGender ?? 'masculine')) p.grammatical_gender = f.voice;
  const budget = f.budget.trim() === '' ? null : Number(f.budget);
  if (budget !== a.dailyBudgetUsd) p.daily_budget_usd = budget;
  const before = [...(a.schedule.times ?? [])].sort().join(',');
  if (scheduleEditable(a) && f.times.join(',') !== before) p.schedule = { times: f.times };
  return p;
}

/** Spec 047 FR-005: "N conflicts" — what keeps the channel from the owner's rules, and the way to resolve it in one card. */
function ConflictsLine({ handle }: { handle: string }) {
  const q = useAgentConfigConflicts(handle);
  const n = q.data?.items?.length ?? q.data?.conflicts.length ?? 0;
  if (!n) return null;
  return (
    <div className="callout-warning" role="status" style={{ flexWrap: 'wrap', gap: 10 }}>
      <Icon name="warning" size={16} />
      <span style={{ flex: '1 1 240px', minWidth: 0 }}>
        <strong>{n} conflict{n === 1 ? '' : 's'}</strong> with your rules — the agent cannot follow the rules and its config at once.
      </span>
      <Link to="/app/agents/$handle" params={{ handle }} search={{ tab: 'memory' } as any} className="btn-tiny">See them</Link>
      <Link to="/app/chat" search={{ q: alignPrompt(handle) } as any} className="btn-tiny">Resolve in one card</Link>
    </div>
  );
}

/** "MANAGER advice · 30 d": how much of @manager's advice the agent followed and declined (orchestrators only). */
function AdviceTile({ handle }: { handle: string }) {
  const q = useDirectives({ agent: handle, binding: 'advice' });
  const { followed, declined } = adviceCounts(q.data?.directives ?? []);
  const none = !q.data || followed + declined === 0;
  return (
    <StatTile label="MANAGER advice · 30 d" value={none ? '—' : `${followed} / ${declined}`}
      delta={q.data ? (none ? 'no advice yet' : 'followed / declined') : undefined} deltaTone={declined > followed ? 'warning' : 'neutral'} />
  );
}

/** The four numbers of the Overview: spend, runs, the daily plan and (orchestrators) the advice record. */
function OverviewKpis({ data }: { data: AgentDetail }) {
  const a = data.agent;
  const act = a.activity;
  // An orchestrator's day includes its role agents (same roll-up as the list page).
  const kids = data.children;
  const spend = (act?.spentTodayUsd ?? 0) + kids.reduce((s, c) => s + (c.activity?.spentTodayUsd ?? 0), 0);
  const runs = (act?.runsToday ?? 0) + kids.reduce((s, c) => s + (c.activity?.runsToday ?? 0), 0);
  const withRoles = kids.length > 0 ? ' · incl. roles' : '';
  const card = useEditorChannel(data.channelKey ?? '').data;
  const lastBad = act?.lastStatus === 'error' || act?.lastStatus === 'budget_exceeded';
  return (
    <StatStrip label="Key numbers">
      <StatTile label="Spend today" value={fmtUsd(spend)}
        delta={`cap ${a.dailyBudgetUsd == null ? 'default' : fmtUsd(a.dailyBudgetUsd)}${withRoles}`} />
      <StatTile label="Runs today" value={runs} deltaTone={lastBad ? 'danger' : 'neutral'}
        delta={`${act?.lastRunAt ? `last ${lastBad ? 'failed ' : ''}${fmtRelative(act.lastRunAt)}` : 'no runs yet'}${withRoles}`} />
      {card && (
        <StatTile label="Daily plan" value={card.postsPerDayMin === card.postsPerDayMax ? card.postsPerDayMin : `${card.postsPerDayMin}–${card.postsPerDayMax}`}
          delta={planAtLine({ planHour: card.planHour, approval: card.mode === 'approve', zone: zoneLabel(card.timezone) })} />
      )}
      {a.kind === 'orchestrator' && a.scopeId && <AdviceTile handle={a.handle} />}
    </StatStrip>
  );
}

export function AgentOverview({ data }: { data: AgentDetail }) {
  const a = data.agent;
  // Spec 038: the agent's model shown and edited is the one of the active workspace.
  const ws: Workspace = useModelCatalog().data?.workspace ?? 'openrouter';
  const resource = a.kind === 'orchestrator' && !!a.scopeId;
  return (
    <div className="agent-overview">
      {/* The mode (and a role agent's "follows") moved to the page header; paused series to the banners under it. */}
      <OverviewKpis data={data} />

      {resource && <ConflictsLine handle={a.handle} />}
      {data.channelKey && <TodaySteps data={data} delay={30} />}

      {resource && (
        <div className="agent-summaries">
          <ChannelSummary handle={a.handle} delay={60} />
          <FormattingSummary handle={a.handle} scopeRef={a.scopeId} channelKey={data.channelKey} delay={90} />
        </div>
      )}
      {resource && <ArtifactsLine handle={a.handle} targetRef={a.scopeId!} />}

      {data.children.length > 0 && (
        <SectionCard title="Roles" icon="agents" flush delay={120}>
          {data.children.map((c) => (
            <Link key={c.id} to="/app/agents/$handle" params={{ handle: c.handle }} className="panel-row agent-role">
              <AgentGlyph agent={c} size={30} />
              <div className="agent-role-main">
                <div className="agent-role-name">
                  <span className="agent-role-kind">{KIND_LABEL[c.kind]}</span>
                  <span className="mono agent-dim">@{c.handle}</span>
                  {c.status === 'paused' && <Badge tone="danger">paused</Badge>}
                </div>
                {ownModelIn(c, ws) && <div className="text-micro mono agent-dim">{ownModelIn(c, ws)}</div>}
              </div>
              <LastRun activity={c.activity} />
              <span className="text-micro mono agent-muted agent-role-spend">
                {fmtUsd(c.activity?.spentTodayUsd ?? 0)} · {runsLabel(c.activity?.runsToday ?? 0)}
              </span>
            </Link>
          ))}
        </SectionCard>
      )}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="text-micro ink-dim" style={{ marginBottom: 3 }}>{label}</div>
      <div className="text-body-sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

/** The profile, read-only: the key settings at a glance and Edit, which opens the form in a dialog (Settings tab). */
export function AgentProfileCard({ data }: { data: AgentDetail }) {
  const a = data.agent;
  const ws: Workspace = useModelCatalog().data?.workspace ?? 'openrouter';
  const [editing, setEditing] = useState(false);
  const defaultModel = useModelCatalog().data?.defaultModel;
  const model = ownModelIn(a, ws);
  const times = [...(a.schedule.times ?? [])].sort();
  const dim = (t: string) => <span className="ink-dim">{t}</span>;
  return (
    <SectionCard title="Profile" icon="pencil" delay={40}
      action={
        <button type="button" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setEditing(true)}>
          <Icon name="pencil" size={14} /> Edit
        </button>
      }>
      <div style={{ ...grid, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))', rowGap: 12 }}>
        <Meta label="Name">{a.emoji ? `${a.emoji} ` : ''}{a.name}</Meta>
        <Meta label="Handle">@{a.handle}</Meta>
        <Meta label={`Model · ${WORKSPACE_LABEL[ws]}`}>
          {model ?? dim(data.parent ? `inherit from @${data.parent.handle}` : `default (${defaultModel ?? 'global default'})`)}
        </Meta>
        <Meta label="Reasoning effort">{a.reasoningEffort ?? dim('default')}</Meta>
        <Meta label="Voice">{a.grammaticalGender === 'feminine' ? 'Feminine' : 'Masculine'}</Meta>
        <Meta label="Daily budget">{a.dailyBudgetUsd == null ? dim('default cap') : fmtUsd(a.dailyBudgetUsd)}</Meta>
        <Meta label="Schedule">
          {scheduleEditable(a)
            ? (times.length ? <span className="tabular-nums">{times.join(', ')} (Kyiv)</span> : dim('role default'))
            : <PlanTimesNote channelKey={data.channelKey} />}
        </Meta>
        <Meta label="Kind">{KIND_LABEL[a.kind]}</Meta>
        <Meta label="Scope"><ScopeChip agent={a} /></Meta>
        <Meta label="Created">{fmtDate(a.createdAt)} · {a.createdBy}</Meta>
        <Meta label="Updated">{fmtRelative(a.updatedAt)}</Meta>
      </div>
      {a.description && (
        <div style={{ marginTop: 12 }}>
          <div className="text-micro ink-dim" style={{ marginBottom: 3 }}>Description</div>
          <div className="text-body-sm clamp ink-muted" style={{ ['--clamp' as string]: 2 } as CSSProperties} title={a.description}>{a.description}</div>
        </div>
      )}
      <AgentEditDialog data={data} open={editing} onClose={() => setEditing(false)} />
    </SectionCard>
  );
}

/** The agent's profile form in a dialog (the Overview's Profile "Edit" and the page header's "Edit"). */
export function AgentEditDialog({ data, open, onClose }: { data: AgentDetail; open: boolean; onClose: () => void }) {
  const ws: Workspace = useModelCatalog().data?.workspace ?? 'openrouter';
  const a = data.agent;
  return (
    <Modal open={open} onClose={onClose} size="lg" icon="pencil" title="Edit profile" subtitle={`@${a.handle} · ${KIND_LABEL[a.kind]}`}>
      {open && <ProfileForm key={`${a.id}:${a.updatedAt}:${ws}`} data={data} ws={ws} onClose={onClose} />}
    </Modal>
  );
}

function ProfileForm({ data, ws, onClose }: { data: AgentDetail; ws: Workspace; onClose: () => void }) {
  const a = data.agent;
  const navigate = useNavigate();
  const patch = usePatchAgent(a.handle);
  const defaultModel = useModelCatalog().data?.defaultModel;
  const [f, setF] = useState<Form>(() => toForm(a, ws));
  const [time, setTime] = useState('09:00');
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));

  const errors = validate(f);
  const changes = diff(a, f, ws);
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
      onClose();
    } catch { /* shown inline */ }
  };

  const err = (k: keyof Form) => errors[k] && <div className="text-micro ink-danger" style={{ marginTop: 4 }}>{errors[k]}</div>;

  return (
    <>
      <div id="agent-profile" style={grid}>
        <Field label="Name">
          <input id="agent-name" autoFocus className="input-field" style={input} value={f.name} maxLength={60} onChange={(e) => set('name', e.target.value)} />
          {err('name')}
        </Field>
        <Field label="Handle" hint={f.handle.trim().replace(/^@/, '').toLowerCase() !== a.handle ? 'old handle stays an alias for 30 days' : undefined}>
          <div style={{ position: 'relative' }}>
            <span className="ink-dim" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }}>@</span>
            <input className="input-field" style={{ ...input, paddingLeft: 28 }} value={f.handle} maxLength={33} autoCapitalize="none" spellCheck={false}
              onChange={(e) => { set('handle', e.target.value.toLowerCase()); if (patch.error) patch.reset(); }} />
          </div>
          {handleErr && <div className="text-micro ink-danger" style={{ marginTop: 4 }}>{handleErr}</div>}
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
        <Field label="Model" hint={<>{WORKSPACE_LABEL[ws]} workspace · all agents: <Link to="/app/models" className="link-inherit">Models</Link></>}>
          <ModelSelect value={f.model.trim() || null} onChange={(m) => set('model', m ?? '')} ariaLabel="Agent model"
            defaultLabel={data.parent ? `Inherit from @${data.parent.handle}` : `Default (${defaultModel ?? 'global default'})`} />
          {err('model')}
        </Field>
        <Field label="Reasoning effort">
          <select className="input-field" style={input} value={f.effort} onChange={(e) => set('effort', e.target.value as Form['effort'])}>
            <option value="">default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
        </Field>
        <Field label="Voice" hint="grammatical gender in chat replies">
          <select className="input-field" style={input} value={f.voice} onChange={(e) => set('voice', e.target.value as GrammaticalGender)} aria-label="Agent voice">
            <option value="masculine">Masculine</option><option value="feminine">Feminine</option>
          </select>
        </Field>
        <Field label="Daily budget, USD" hint="blank = default cap">
          <input className="input-field" style={input} type="number" min={0} max={50} step={0.05} value={f.budget} placeholder="default" onChange={(e) => set('budget', e.target.value)} />
          {err('budget')}
        </Field>
      </div>
      {!scheduleEditable(a) && <PlanTimes channelKey={data.channelKey} />}
      {scheduleEditable(a) && <Field label="Schedule" hint="Kyiv time · up to 8 runs a day">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {f.times.length === 0 && <span className="text-micro ink-dim">role default</span>}
          {f.times.map((t) => (
            <span key={t} className="chip tabular-nums" style={{ gap: 4, paddingRight: 4 }}>
              {t}
              <button className="time-remove" type="button" aria-label={`Remove ${t}`} title="Remove" onClick={() => set('times', f.times.filter((x) => x !== t))}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input type="time" className="input-field time-input" value={time} onChange={(e) => setTime(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTime(); }} />
            <button type="button" className="btn-tiny" disabled={!TIME_RE.test(time) || f.times.includes(time) || f.times.length >= 8} onClick={addTime}>
              <Icon name="plus" size={12} /> Add
            </button>
          </span>
        </div>
      </Field>}

      {patch.error && !handleErr && <div className="callout-danger" style={{ marginTop: 8 }}>{describeError(patch.error)}</div>}
      <div className="modal-foot">
        {dirty && <span style={{ marginRight: 'auto', alignSelf: 'center' }}><Badge tone="warning">unsaved</Badge></span>}
        <button type="button" className="btn-secondary" disabled={!dirty || patch.isPending} onClick={() => { setF(toForm(a, ws)); patch.reset(); }}>Reset</button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!dirty || !valid || patch.isPending} onClick={save}>
          {patch.isPending ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </>
  );
}

/** When an orchestrator / role agent runs: the channel card's plan hour (read-only here; edited on the card). */
function PlanTimes({ channelKey }: { channelKey: string | null }) {
  return (
    <Field label="Schedule" hint="from the channel card">
      <PlanTimesNote channelKey={channelKey} />
    </Field>
  );
}

function PlanTimesNote({ channelKey }: { channelKey: string | null }) {
  const ch = useEditorChannel(channelKey ?? '');
  const c = ch.data;
  return (
    <div className="text-body-sm ink-muted" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} data-testid="plan-times">
      <Icon name="clock" size={13} />
      {c
        ? <span>{planScheduleNote({ planHour: c.planHour, timezone: c.timezone, approval: c.mode === 'approve', batchHour: 20 })}</span>
        : <span>The orchestrator and the planner run at the channel card's plan hour.</span>}
      {channelKey && <Link to="/app/editor/$channel" params={{ channel: channelKey }} className="link-accent">Change on the card →</Link>}
    </div>
  );
}

/**
 * Spec 048 FR-007 (was the 045 steering line): what shapes this channel at a glance — the latest setup from history,
 * the active steering and the owner rules — linking to the agent's Artifacts tab.
 */
function ArtifactsLine({ handle, targetRef }: { handle: string; targetRef: string }) {
  const q = useArtifacts({ agent: handle, limit: 200 });
  const steering = useActiveSteering(targetRef.startsWith('telegram:@') ? targetRef : null);
  if (!q.data) return null;
  const rows = q.data.rows;
  const setup = rows.filter((r) => r.type === 'setup').sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0];
  const rules = rows.find((r) => r.type === 'rules');
  const active = steering.data?.active ?? rows.filter((r) => r.type === 'steering' && r.status === 'active').length;
  const parts = [
    setup ? `Setup from history: ${statusLabel(setup.status)} ${new Date(setup.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'No setup from history',
    active ? `Steering: ${active} active${steering.data?.sources.length ? ` from ${steering.data.sources.join(', ')}` : ''}` : 'No steering',
    rules?.live ? `Owner rules: ${rules.summary.replace(/ rules?$/, '')}` : 'No owner rules',
  ];
  return (
    <div className="text-body-sm compose-rise ink-muted" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Icon name="layers" size={14} />
      <span>{parts.join(' · ')}</span>
      <Link to="/app/agents/$handle" params={{ handle }} search={{ tab: 'artifacts' }} className="link-accent">Artifacts →</Link>
    </div>
  );
}
