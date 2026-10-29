// Loadout tab of /app/agents/$handle (spec 054 FR-004): the tools the agent is offered (a toggle per optional tool,
// core and terminal tools locked), a read-only skills summary and the channel's rules the agent follows.
//
// Spec 078 D1.3: the look is agent-plan.css (prefix apl-). The suggestions, the tools (grouped by kind) and the rules are
// rows in flush panels; the skills summary is a padded panel.

import { Fragment } from 'react';
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
  if (!q.data) return <div className="panel apl-skeleton compose-rise" style={{ height: 120 }} aria-hidden />;

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
        <p className="text-micro apl-confirm-note">
          @{handle} will be offered a custom set of tools: {applySummary(suggestions)}. You can switch any tool back on, or reset to the role default, at any time.
        </p>
        <ul className="text-micro apl-confirm-list">
          {suggestions.map((s) => <li key={s.id}><span className="mono">{suggestionName(s)}</span>: {s.reason}</li>)}
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
      details: <p className="text-micro apl-confirm-note">
        @{handle} is offered every tool of its role again, including the ones you switched off. Your choices here are removed.
      </p>,
    });
    if (ok) reset.mutate(undefined, { onSuccess: () => toast.success('Back to the role default'), onError: (e) => toast.error(describeError(e)) });
  };

  return (
    <div className="apl-stack">
      {suggestions.length > 0 && (
        <SectionCard title={`Suggestions (${suggestions.length})`} icon="sparkles" flush delay={0}>
          <p className="text-micro apl-intro">
            Counted from the last 30 days of @{handle}'s runs — no model is involved. Nothing changes until you apply it.
          </p>
          {suggestions.map((s) => <SuggestionRow key={s.id} s={s} busy={busy} onApply={() => applyList([s])} />)}
        </SectionCard>
      )}

      <SectionCard title="Tools" icon="wrench" flush delay={30}
        action={
          <div className="apl-head-actions">
            <button type="button" className="btn-primary btn-sm"
              disabled={busy || suggestions.length === 0}
              title={suggestions.length ? `Apply: ${applySummary(suggestions)}` : 'Nothing to recommend yet — suggestions come from the last 30 days of runs'}
              onClick={applyRecommended}>
              <Icon name="sparkles" size={14} /> Use recommended
            </button>
            <button type="button" className="btn-secondary btn-sm"
              disabled={busy || l.mode === 'role'} title={l.mode === 'role' ? 'Already on the role default' : 'Offer every tool of the role again'} onClick={resetToRole}>
              <Icon name="reset" size={14} /> Reset to role default
            </button>
          </div>
        }>
        <div className="apl-tools-sum">
          <Badge tone={l.mode === 'custom' ? 'accent' : 'neutral'}
            title={l.mode === 'custom' ? 'Only the tools enabled below are offered' : 'Every tool of the role is offered'}>{MODE_LABEL[l.mode]}</Badge>
          <span className="text-body-sm tabular-nums apl-ink">{tokensLine(l.tokens)}</span>
          {saved > 0 && <Badge tone="success" title="Smaller than the role default, on every step of every run">−{saved}%</Badge>}
          <span className="text-micro apl-dim">{l.runs30d} {l.runs30d === 1 ? 'run' : 'runs'} in 30 days</span>
        </div>
        <p className="text-micro apl-intro">
          Every tool offered is re-sent to the model on every step, so each one costs tokens whether it is called or not. Switch off what @{handle} never uses;
          the list is fixed for a whole run. Core and finishing tools stay on.
        </p>

        {groups.map((g) => (
          <Fragment key={g.kind}>
            <div className="apl-group">
              <h3 className="text-overline apl-group-title">{g.label}</h3>
              <span className="text-micro apl-dim">
                {g.enabled} of {g.tools.length} on · ~{fmtTokens(g.tokens)} tokens · {g.note}
              </span>
            </div>
            {g.tools.map((t) => <ToolRow key={t.name} tool={t} busy={busy} onToggle={(on) => toggle(t, on)} />)}
          </Fragment>
        ))}
      </SectionCard>

      <SkillsSummary handle={handle} skills={l.skills} />
      <RulesSummary handle={handle} rules={l.rules} />
    </div>
  );
}

function SuggestionRow({ s, busy, onApply }: { s: LoadoutSuggestion; busy: boolean; onApply: () => void }) {
  const label = SUGGESTION_LABEL[s.kind];
  return (
    <div className="panel-row apl-sugg">
      <div className="apl-sugg-main">
        <div className="apl-sugg-head">
          <Badge tone={label.tone}>{label.label}</Badge>
          <span className="mono apl-tool-name">{suggestionName(s)}</span>
        </div>
        <div className="text-body-sm clamp apl-sugg-reason" title={s.reason}>{s.reason}</div>
        <div className="text-micro apl-dim">{evidenceLine(s)}</div>
      </div>
      <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={onApply}>{label.verb}</button>
    </div>
  );
}

function ToolRow({ tool: t, busy, onToggle }: { tool: LoadoutTool; busy: boolean; onToggle: (on: boolean) => void }) {
  const lock = lockReason(t);
  return (
    <div className={`panel-row apl-tool${t.enabled ? '' : ' is-off'}`}>
      <div className="apl-tool-main">
        <div className="apl-tool-head">
          <span className="mono apl-tool-name">{t.name}</span>
          {t.core && <Badge tone="accent" title="Every agent of this role needs it">core</Badge>}
          {!t.available && <Badge tone="neutral" title="Runs of this role always drop this tool">not used in runs</Badge>}
          {t.errors30d > 0 && <Badge tone="warning" title="Calls that returned an error in the last 30 days">{t.errors30d} {t.errors30d === 1 ? 'error' : 'errors'}</Badge>}
        </div>
        <div className="text-body-sm clamp apl-tool-desc" title={t.description}>{t.description}</div>
        <div className="text-micro apl-tool-meta">
          <span>{usageLine(t)}</span>
          <span>·</span>
          <span className="tabular-nums" title="Size of the tool's schema">~{fmtTokens(t.tokens)} tokens</span>
        </div>
      </div>
      <div className="apl-tool-side">
        {lock && <span className="apl-tool-lock" title={lock}><Icon name="lock" size={13} /></span>}
        <Toggle label={t.enabled ? 'On' : 'Off'} checked={t.enabled} disabled={busy || !!lock}
          title={lock ?? (t.enabled ? 'Offered to the agent — switch off to drop it' : 'Not offered — switch on to offer it')}
          onChange={onToggle} />
      </div>
    </div>
  );
}

function SkillsSummary({ handle, skills }: { handle: string; skills: LoadoutSkill[] }) {
  const s = skillsSummary(skills);
  const never = s.neverLoaded;
  return (
    <SectionCard title="Skills" icon="book" delay={60}
      action={
        <Link to="/app/agents/$handle" params={{ handle }} search={{ tab: 'skills' }} className="panel-link">
          Manage on the Skills tab
        </Link>
      }>
      {s.total === 0
        ? <p className="text-body-sm apl-muted apl-flat">No skills apply to this role.</p>
        : <>
            <div className="text-body-sm apl-stats">
              <span><strong className="tabular-nums">{s.enabled}</strong> of {s.total} enabled</span>
              <span><strong className="tabular-nums">{s.inline}</strong> always in context{s.inline ? ` (${fmtChars(s.inlineChars)})` : ''}</span>
              <span><strong className="tabular-nums">{never.length}</strong> never loaded in 30 days</span>
            </div>
            <p className="text-micro apl-section-hint apl-hint-top">
              A skill on demand costs one line (its description) until the agent loads it; one that is always in context costs its whole text on every step.
            </p>
            {never.length > 0 && (
              <div className="apl-chips apl-chips-top">
                {never.map((n) => <span key={n} className="chip mono">{n}</span>)}
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
      case 'ownerRules':    return <Link to="/app/artifacts" search={{ type: 'rules', agent: handle }} className="panel-link">Edit in Rules</Link>;
      case 'memory':        return <Link to="/app/artifacts" search={{ type: 'memory', agent: handle }} className="panel-link">Edit in Memory</Link>;
      case 'steeringSets':  return <Link to="/app/artifacts" search={{ type: 'steering', agent: handle }} className="panel-link">Edit in Steering</Link>;
      case 'playbookRules': return <Link to="/app/artifacts" search={{ type: 'playbook', agent: handle }} className="panel-link">Edit in Playbook</Link>;
    }
  };
  return (
    <SectionCard title="Rules" icon="logs" flush delay={90}>
      <p className="text-micro apl-intro">
        Rules belong to the channel and bind every agent on it.{rules.chars > 0 ? ` Together they weigh ${fmtChars(rules.chars)} of every prompt.` : ''}
      </p>
      {lines.map((r) => (
        <div key={r.key} className="panel-row apl-rule">
          <span className="text-body-sm apl-rule-label">{r.label}</span>
          <span className="text-body-sm tabular-nums apl-muted">{r.count} {r.unit}</span>
          <span className="apl-rule-link">{link(r.key)}</span>
        </div>
      ))}
    </SectionCard>
  );
}
