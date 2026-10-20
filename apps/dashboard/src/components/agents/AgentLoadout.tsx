// Loadout tab of /app/agents/$handle (spec 054 FR-004): the tools the agent is offered (a toggle per optional tool,
// core and terminal tools locked), a read-only skills summary and the channel's rules the agent follows.

import { Link } from '@tanstack/react-router';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { Toggle } from './AgentsUi';
import {
  applyBody, applySummary, evidenceLine, fmtChars, fmtTokens, groupTools, loadoutErrorText, lockReason, MODE_LABEL, ruleLines, savedPct,
  skillsSummary, SUGGESTION_LABEL, suggestionName, tokensLine, toolsAfterToggle, usageLine,
} from '../../lib/loadout';
import { errorBody, type AgentDetail } from '../../api/agents';
import {
  useApplyLoadout, useLoadout, usePutLoadoutTools, useResetLoadout,
  type LoadoutRules, type LoadoutSkill, type LoadoutSuggestion, type LoadoutTool,
} from '../../api/loadout';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function AgentLoadout({ data }: { data: AgentDetail }) {
  const handle = data.agent.handle;
  const q = useLoadout(handle);
  const put = usePutLoadoutTools(handle);
  const reset = useResetLoadout(handle);
  const applyMut = useApplyLoadout(handle);
  const confirm = useConfirm();

  if (q.error) {
    const missing = (q.error as { status?: number }).status === 404;
    return missing
      ? <EmptyState icon="wrench" title="No loadout here yet" note="This server does not have the agent loadout (or the agent has no tools to manage)." />
      : <div className="callout-danger">{describeError(q.error)}</div>;
  }
  if (!q.data) return <div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} />;

  const l = q.data;
  const busy = put.isPending || reset.isPending || applyMut.isPending;
  const groups = groupTools(l.tools);
  const saved = savedPct(l.tokens);
  const suggestions = l.suggestions ?? [];

  const applyList = (list: LoadoutSuggestion[]) => applyMut.mutate(applyBody(list), {
    onSuccess: () => toast.success(`Done: ${applySummary(list)}`),
    onError: (e) => toast.error(loadoutErrorText(errorBody(e)?.error, describeError(e))),
  });
  const applyRecommended = async () => {
    const ok = await confirm('apply the recommended loadout', {
      confirmLabel: 'Apply', danger: false,
      details: <>
        <p className="text-micro" style={{ margin: '0 0 8px', color: 'var(--color-ink-muted)' }}>
          @{handle} will be offered a custom set of tools: {applySummary(suggestions)}. You can switch any tool back on, or reset to the role default, at any time.
        </p>
        <ul className="text-micro" style={{ margin: 0, paddingLeft: 18, color: 'var(--color-ink-dim)' }}>
          {suggestions.map((s) => <li key={s.id}><span style={{ fontFamily: mono }}>{suggestionName(s)}</span>: {s.reason}</li>)}
        </ul>
      </>,
    });
    if (ok) applyList(suggestions);
  };

  const toggle = (t: LoadoutTool, on: boolean) => put.mutate(toolsAfterToggle(l.tools, t.name, on), {
    onError: (e) => toast.error(loadoutErrorText(errorBody(e)?.error, describeError(e))),
  });
  const resetToRole = async () => {
    const ok = await confirm('reset to the role default', {
      confirmLabel: 'Reset',
      details: <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
        @{handle} is offered every tool of its role again, including the ones you switched off. Your choices here are removed.
      </p>,
    });
    if (ok) reset.mutate(undefined, { onSuccess: () => toast.success('Back to the role default'), onError: (e) => toast.error(describeError(e)) });
  };

  return (
    <div>
      {suggestions.length > 0 && (
        <SectionCard title={`Suggestions (${suggestions.length})`} icon="sparkles" style={{ marginBottom: 16 }}>
          <p className="text-micro" style={{ margin: '0 0 12px', color: 'var(--color-ink-dim)', maxWidth: 760 }}>
            Counted from the last 30 days of @{handle}'s runs — no model is involved. Nothing changes until you apply it.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {suggestions.map((s, i) => <SuggestionRow key={s.id} s={s} delay={Math.min(i, 12) * 20} busy={busy} onApply={() => applyList([s])} />)}
          </div>
        </SectionCard>
      )}

      <SectionCard title="Tools" icon="wrench" style={{ marginBottom: 16 }}
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              disabled={busy || suggestions.length === 0}
              title={suggestions.length ? `Apply: ${applySummary(suggestions)}` : 'Nothing to recommend yet — suggestions come from the last 30 days of runs'}
              onClick={applyRecommended}>
              <Icon name="sparkles" size={14} /> Use recommended
            </button>
            <button type="button" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              disabled={busy || l.mode === 'role'} title={l.mode === 'role' ? 'Already on the role default' : 'Offer every tool of the role again'} onClick={resetToRole}>
              <Icon name="reset" size={14} /> Reset to role default
            </button>
          </div>
        }>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <Badge tone={l.mode === 'custom' ? 'accent' : 'neutral'}
            title={l.mode === 'custom' ? 'Only the tools enabled below are offered' : 'Every tool of the role is offered'}>{MODE_LABEL[l.mode]}</Badge>
          <span className="text-body-sm tabular-nums" style={{ color: 'var(--color-ink)' }}>{tokensLine(l.tokens)}</span>
          {saved > 0 && <Badge tone="success" title="Smaller than the role default, on every step of every run">−{saved}%</Badge>}
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{l.runs30d} {l.runs30d === 1 ? 'run' : 'runs'} in 30 days</span>
        </div>
        <p className="text-micro" style={{ margin: '0 0 14px', color: 'var(--color-ink-dim)', maxWidth: 760 }}>
          Every tool offered is re-sent to the model on every step, so each one costs tokens whether it is called or not. Switch off what @{handle} never uses;
          the list is fixed for a whole run. Core and finishing tools stay on.
        </p>

        {groups.map((g, gi) => (
          <div key={g.kind} style={{ marginBottom: gi === groups.length - 1 ? 0 : 16 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', margin: '0 0 8px' }}>
              <h3 className="text-heading-md" style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>{g.label}</h3>
              <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                {g.enabled} of {g.tools.length} on · ~{fmtTokens(g.tokens)} tokens · {g.note}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {g.tools.map((t, i) => <ToolRow key={t.name} tool={t} delay={Math.min(i, 12) * 20} busy={busy} onToggle={(on) => toggle(t, on)} />)}
            </div>
          </div>
        ))}
      </SectionCard>

      <SkillsSummary handle={handle} skills={l.skills} />
      <RulesSummary handle={handle} rules={l.rules} />
    </div>
  );
}

function SuggestionRow({ s, delay, busy, onApply }: { s: LoadoutSuggestion; delay: number; busy: boolean; onApply: () => void }) {
  const label = SUGGESTION_LABEL[s.kind];
  return (
    <div className="card row-lift compose-rise" style={{ padding: '10px 14px', animationDelay: `${delay}ms` }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
            <Badge tone={label.tone}>{label.label}</Badge>
            <span style={{ fontFamily: mono, fontSize: 13, color: 'var(--color-ink)', fontWeight: 600, overflowWrap: 'anywhere' }}>{suggestionName(s)}</span>
          </div>
          <div className="text-body-sm clamp" title={s.reason} style={{ ['--clamp' as string]: 2, color: 'var(--color-ink-muted)', marginBottom: 2 }}>{s.reason}</div>
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{evidenceLine(s)}</div>
        </div>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onApply}>{label.verb}</button>
      </div>
    </div>
  );
}

function ToolRow({ tool: t, delay, busy, onToggle }: { tool: LoadoutTool; delay: number; busy: boolean; onToggle: (on: boolean) => void }) {
  const lock = lockReason(t);
  return (
    <div className="card row-lift compose-rise" style={{ padding: '10px 14px', animationDelay: `${delay}ms`, opacity: t.enabled ? 1 : 0.62 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
            <span style={{ fontFamily: mono, fontSize: 13, color: 'var(--color-ink)', fontWeight: 600, overflowWrap: 'anywhere' }}>{t.name}</span>
            {t.core && <Badge tone="accent" title="Every agent of this role needs it">core</Badge>}
            {!t.available && <Badge tone="neutral" title="Runs of this role always drop this tool">not used in runs</Badge>}
            {t.errors30d > 0 && <Badge tone="warning" title="Calls that returned an error in the last 30 days">{t.errors30d} {t.errors30d === 1 ? 'error' : 'errors'}</Badge>}
          </div>
          <div className="text-body-sm clamp" title={t.description} style={{ ['--clamp' as string]: 1, color: 'var(--color-ink-muted)', marginBottom: 4 }}>{t.description}</div>
          <div className="text-micro" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', color: 'var(--color-ink-dim)' }}>
            <span>{usageLine(t)}</span>
            <span>·</span>
            <span className="tabular-nums" title="Size of the tool's schema">~{fmtTokens(t.tokens)} tokens</span>
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {lock && <span style={{ display: 'inline-flex', color: 'var(--color-ink-dim)' }} title={lock}><Icon name="lock" size={13} /></span>}
          <Toggle label={t.enabled ? 'On' : 'Off'} checked={t.enabled} disabled={busy || !!lock}
            title={lock ?? (t.enabled ? 'Offered to the agent — switch off to drop it' : 'Not offered — switch on to offer it')}
            onChange={onToggle} />
        </div>
      </div>
    </div>
  );
}

function SkillsSummary({ handle, skills }: { handle: string; skills: LoadoutSkill[] }) {
  const s = skillsSummary(skills);
  const never = s.neverLoaded;
  return (
    <SectionCard title="Skills" icon="book" delay={40} style={{ marginBottom: 16 }}
      action={
        <Link to="/app/agents/$handle" params={{ handle }} search={{ tab: 'skills' }} className="link-accent text-micro">
          Manage on the Skills tab
        </Link>
      }>
      {s.total === 0
        ? <p className="text-body-sm" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>No skills apply to this role.</p>
        : <>
            <div className="text-body-sm" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', color: 'var(--color-ink)' }}>
              <span><strong className="tabular-nums">{s.enabled}</strong> of {s.total} enabled</span>
              <span><strong className="tabular-nums">{s.inline}</strong> always in context{s.inline ? ` (${fmtChars(s.inlineChars)})` : ''}</span>
              <span><strong className="tabular-nums">{never.length}</strong> never loaded in 30 days</span>
            </div>
            <p className="text-micro" style={{ margin: '8px 0 0', color: 'var(--color-ink-dim)' }}>
              A skill on demand costs one line (its description) until the agent loads it; one that is always in context costs its whole text on every step.
            </p>
            {never.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                {never.map((n) => <span key={n} className="chip" style={{ fontSize: 11, fontFamily: mono }}>{n}</span>)}
              </div>
            )}
          </>}
    </SectionCard>
  );
}

function RulesSummary({ handle, rules }: { handle: string; rules: LoadoutRules }) {
  const lines = ruleLines(rules);
  const link = (key: typeof lines[number]['key']) => {
    switch (key) {
      case 'ownerRules':    return <Link to="/app/artifacts" search={{ type: 'rules', agent: handle }} className="link-accent text-micro">Edit in Rules</Link>;
      case 'memory':        return <Link to="/app/artifacts" search={{ type: 'memory', agent: handle }} className="link-accent text-micro">Edit in Memory</Link>;
      case 'steeringSets':  return <Link to="/app/artifacts" search={{ type: 'steering', agent: handle }} className="link-accent text-micro">Edit in Steering</Link>;
      case 'playbookRules': return <Link to="/app/artifacts" search={{ type: 'playbook', agent: handle }} className="link-accent text-micro">Edit in Playbook</Link>;
    }
  };
  return (
    <SectionCard title="Rules" icon="logs" delay={80}>
      <p className="text-micro" style={{ margin: '0 0 12px', color: 'var(--color-ink-dim)' }}>
        Rules belong to the channel and bind every agent on it.{rules.chars > 0 ? ` Together they weigh ${fmtChars(rules.chars)} of every prompt.` : ''}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {lines.map((r) => (
          <div key={r.key} className="card" style={{ padding: '9px 14px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500, minWidth: 130 }}>{r.label}</span>
            <span className="text-body-sm tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>{r.count} {r.unit}</span>
            <span style={{ marginLeft: 'auto' }}>{link(r.key)}</span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
