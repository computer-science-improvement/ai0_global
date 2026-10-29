// Directives of the MANAGER (spec 021 FR-009, spec 025 FR-019), shared by the @manager "Directives" board and an
// orchestrator's "Inbox" tab. Each directive is a compact card (binding, kind, status, addressee, the first lines of the
// body, whether it needs you); a click opens a dialog with the rest — rationale, expected effect, evidence, the
// executor's change and its verification, resolution, the owner's decision, the evaluated outcome — and the owner's
// Approve / Decline while a structural directive awaits them, Uphold / Accept refusal / Discuss while a contested one
// does. Both lists share a binding + kind filter kept in the URL (?binding=&kind=).
// Spec 078 D3: the look is classes (amg-* in agent-manager.css) — facts in an .inset with overline keys, reason codes as
// mono chips, the owner's decisions as real buttons in the dialog footer. Same data, mutations and links.

import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { EmptyState, type Tone } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { CompactCard } from '../ui/CompactCard';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';
import { SegmentedTabs } from '../SegmentedTabs';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { errorBody } from '../../api/agents';
import {
  DIRECTIVE_KINDS, useContestDecision, useDecideDirective, useDirectives,
  type ContestCheck, type Directive, type DirectiveKind, type DirectiveOutcome, type DirectiveStatus, type OwnerDecision,
} from '../../api/manager';
import {
  BOARD_COLUMNS, CLOSED_STATUSES, OPEN_STATUSES, describeChange, hasFilters, matchesFilters, toggleKind, unscoredReason, verificationChip,
  type DirectiveFilters,
} from '../../lib/directive-view';
import { NetworkError, ResourceChip, errorText } from './NetworkUi';

export const DIRECTIVE_KIND_LABEL: Record<DirectiveKind, string> = {
  advice: 'advice', task: 'task', format_shift: 'format shift', frequency: 'frequency', repost: 'repost', cross_promo: 'cross-promo',
  pause_series: 'pause series', experiment: 'experiment', pause_resource: 'pause resource', strategy: 'strategy',
  voice_fix: 'voice fix', format_mix: 'format mix',
};

export const DIRECTIVE_STATUS_LABEL: Record<DirectiveStatus, string> = {
  awaiting_owner: 'awaiting owner', contested: 'contested', new: 'new', accepted: 'accepted', applied: 'applied', evaluated: 'evaluated',
  rejected: 'rejected', declined: 'declined', failed: 'failed', expired: 'expired', canceled: 'canceled', superseded: 'superseded',
};

export const DIRECTIVE_STATUS_TONE: Record<DirectiveStatus, Tone> = {
  awaiting_owner: 'warning', contested: 'warning', new: 'accent', accepted: 'success', applied: 'success', evaluated: 'neutral',
  rejected: 'danger', declined: 'neutral', failed: 'danger', expired: 'neutral', canceled: 'neutral', superseded: 'neutral',
};

export const OUTCOME_TONE: Record<DirectiveOutcome, Tone> = { worked: 'success', hurt: 'danger', no_effect: 'neutral', inconclusive: 'warning' };
export const OUTCOME_LABEL: Record<DirectiveOutcome, string> = { worked: 'worked', hurt: 'hurt', no_effect: 'no effect', inconclusive: 'inconclusive' };

const OWNER_DECISION: Record<OwnerDecision, { tone: Tone; label: string; title: string }> = {
  approved:        { tone: 'success', label: 'owner approved', title: 'You approved this structural directive' },
  declined:        { tone: 'danger',  label: 'owner declined', title: 'You declined this structural directive' },
  timeout_applied: { tone: 'neutral', label: 'timeout · applied', title: 'No answer in time — the default applied it' },
  timeout_dropped: { tone: 'neutral', label: 'timeout · dropped', title: 'No answer in time — the default dropped it' },
  upheld:           { tone: 'success', label: 'owner upheld', title: 'You upheld this directive over the orchestrator’s refusal' },
  refusal_accepted: { tone: 'neutral', label: 'refusal accepted', title: 'You sided with the orchestrator (48 h cooldown on this kind)' },
};

/** Precedence layer an orchestrator cited when contesting (spec 025: 1 owner rules, 2 safety). */
const CONTEST_REASON: Record<ContestCheck['reason_kind'], { label: string; layer: string }> = {
  owner_rule: { label: 'owner rule', layer: 'layer 1 · your rules' },
  safety:     { label: 'safety', layer: 'layer 2 · safety' },
  capability: { label: 'capability', layer: 'layer 2 · safety (platform capability)' },
  health:     { label: 'resource health', layer: 'layer 2 · safety (resource health)' },
};

export const METRIC_LABEL: Record<string, string> = {
  views_per_post: 'views/post', engagement_rate: 'engagement', posts: 'posts', followers_growth: 'follower growth',
  transitions: 'transitions', revenue: 'revenue',
  critic_pass_rate: 'critic pass rate', owner_rejection_rate: 'owner rejections', poll_share: 'poll share',
};
export const metricLabel = (m: string) => METRIC_LABEL[m] ?? m.replace(/_/g, ' ');

const REF_RE = /^(telegram|instagram|facebook|threads|tiktok|youtube):\S+$/;

/** Signed percentage, e.g. "+12.5%" / "−31%". */
export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const r = Math.abs(n) >= 100 ? Math.round(n) : Number(n.toFixed(digits));
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}%`;
}

function fmtValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : String(Number(v.toFixed(2)));
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 79)}…` : v;
  if (Array.isArray(v)) return v.every((x) => x == null || typeof x !== 'object') ? v.map(fmtValue).join(', ') : `[${v.length}]`;
  const flat = Object.entries(v as Record<string, unknown>);
  if (flat.length <= 5 && flat.every(([, x]) => x == null || typeof x !== 'object')) return flat.map(([k, x]) => `${k} ${fmtValue(x)}`).join(' · ');
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

/** A JSON value as compact key/value pairs (one level deep). */
function entriesOf(v: unknown, max = 8): Array<[string, unknown]> {
  if (v == null || v === '') return [];
  if (typeof v !== 'object') return [['', v]];
  const e: Array<[string, unknown]> = Array.isArray(v) ? v.map((x, i) => [String(i + 1), x]) : Object.entries(v as Record<string, unknown>);
  return e.filter(([, x]) => x !== undefined).slice(0, max);
}

/** One fact of a directive: an overline key, then the value. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="amg-line">
      <span className="text-overline amg-key">{label}</span>
      <div className="text-micro amg-val">{children}</div>
    </div>
  );
}

function KeyValues({ label, value }: { label: string; value: unknown }) {
  const e = entriesOf(value);
  if (!e.length) return null;
  return (
    <Fact label={label}>
      <div className="amg-pairs">
        {e.map(([k, x], i) => (
          <span key={`${k}-${i}`} className="amg-pair">
            {k && <span className="amg-dim amg-nowrap">{k.replace(/_/g, ' ')}</span>}
            {typeof x === 'string' && REF_RE.test(x)
              ? <ResourceChip refId={x} />
              : <span className="tabular-nums amg-wrap">{fmtValue(x)}</span>}
          </span>
        ))}
      </div>
    </Fact>
  );
}

/** "views/post ↑ ≥ 10% on <resource>". */
export function ExpectedLine({ d }: { d: Directive }) {
  const x = d.expected;
  if (!x) return null;
  const up = x.direction === 'up';
  return (
    <Fact label="expected">
      <div className="amg-expected">
        <span className="amg-ink amg-metric">{metricLabel(x.metric)}</span>
        <span className={`amg-arrow ${up ? 'is-up' : 'is-down'}`} aria-label={up ? 'up' : 'down'}>{up ? '↑' : '↓'}</span>
        <span className="tabular-nums">≥ {x.min_change_pct}%</span>
        {x.resource_ref && <ResourceChip refId={x.resource_ref} />}
        {d.reviewAt && <span className="amg-dim" title={fmtDate(d.reviewAt)}>· review {fmtDate(d.reviewAt).replace(/ \d{4},.*$/, '')}</span>}
      </div>
    </Fact>
  );
}

function OutcomeBlock({ d }: { d: Directive }) {
  const o = d.outcomeDetail;
  if (!o || (o.before?.value == null && o.after?.value == null && o.changePct == null)) return null;
  const before = o?.before?.value;
  const after = o?.after?.value;
  const ch = o?.changePct;
  const good = d.expected ? (d.expected.direction === 'up' ? (ch ?? 0) > 0 : (ch ?? 0) < 0) : (ch ?? 0) > 0;
  return (
    <div className="inset amg-outcome">
      <span className="text-overline">outcome</span>
      {(before != null || after != null) && (
        <span className="text-micro tabular-nums amg-muted">
          {d.expected && <span className="amg-dim">{metricLabel(d.expected.metric)} </span>}
          {fmtValue(before)} → <span className="amg-ink">{fmtValue(after)}</span>
        </span>
      )}
      {ch != null && (
        <span className={`text-micro mono tabular-nums amg-change ${ch === 0 ? 'is-flat' : good ? 'is-good' : 'is-bad'}`}>
          {fmtPct(ch)}
        </span>
      )}
      {o.after?.stale && <Badge tone="neutral" title="The metric had no fresh data at evaluation">stale</Badge>}
      {o.confounders?.length ? (
        <span className="text-micro amg-dim amg-wrap" title="Other changes in the same window">
          confounders: {o.confounders.join(', ')}
        </span>
      ) : null}
    </div>
  );
}

/** The orchestrator's refusal of a contested directive: reason, precedence layer and the code's check of it. */
function ContestBlock({ d }: { d: Directive }) {
  const c = d.verification?.contest;
  if (!c && d.status !== 'contested') return null;
  const reason = c ? CONTEST_REASON[c.reason_kind] : undefined;
  const check = !c ? null
    : c.verified === true ? { tone: 'success' as Tone, label: 'check passed' }
    : c.verified === 'unverified' ? { tone: 'warning' as Tone, label: 'not checked by code' }
    : { tone: 'danger' as Tone, label: 'check failed' };
  return (
    <div className="inset amg-contest">
      <div className="text-micro amg-contest-head">
        <span className="amg-warn amg-icon"><Icon name="warning" size={12} /></span>
        <span className="amg-ink amg-contest-who">{d.to ? `@${d.to}` : 'The orchestrator'} contests</span>
        {reason && <span className="chip mono" title={reason.layer}>{reason.label}</span>}
        {reason && <span className="amg-dim">{reason.layer}</span>}
        {d.contestedAt && <span className="mono amg-dim amg-push" title={fmtDate(d.contestedAt)}>{fmtRelative(d.contestedAt)}</span>}
      </div>
      {d.resolution && <div className="text-micro amg-muted amg-wrap amg-pre">{d.resolution}</div>}
      {c && check && (
        <div className="text-micro amg-contest-check">
          <Badge tone={check.tone}>{check.label}</Badge>
          <span className="amg-muted amg-wrap">{c.detail}</span>
          {c.rule_ids?.length ? <span className="amg-dim mono">rules {c.rule_ids.map((r) => `#${r}`).join(', ')}</span> : null}
          {c.resource_ref && <ResourceChip refId={c.resource_ref} />}
        </div>
      )}
    </div>
  );
}

/** Uphold / Accept refusal / Discuss on a contested directive (spec 025 FR-008). */
function ContestActions({ d, onDone }: { d: Directive; onDone?: () => void }) {
  const confirm = useConfirm();
  const decide = useContestDecision();
  const who = d.to ? `@${d.to}` : 'the orchestrator';
  const kind = DIRECTIVE_KIND_LABEL[d.kind] ?? d.kind;
  const run = async (decision: 'uphold' | 'accept-refusal') => {
    const ok = decision === 'uphold'
      ? await confirm(`uphold the ${kind} directive to ${who}`, {
          danger: false, confirmLabel: 'Uphold',
          details: <div className="callout-warning amg-callout-col">
            <strong>The executor applies it now, over {who}’s refusal.</strong>
            <span className="text-micro">Your rules are not checked again (you decide), but health and capability guards still are: if the change cannot apply now, nothing happens and the directive stays contested.</span>
          </div>,
        })
      : await confirm(`accept ${who}’s refusal`, {
          danger: false, confirmLabel: 'Accept refusal',
          details: <span className="text-micro">The directive is rejected and @manager may not file another {kind} directive to {who} for 48 hours.</span>,
        });
    if (!ok) return;
    decide.mutate({ id: d.id, decision }, {
      onSuccess: () => { toast.success(decision === 'uphold' ? 'Directive upheld — the executor is applying it' : 'Refusal accepted — the directive is rejected'); onDone?.(); },
      onError: (e) => {
        const b = errorBody(e);
        if (b?.error === 'not_executable') toast.error(`It cannot be applied now: ${typeof b.details === 'string' ? b.details : 'a health or capability guard refused it'}. It stays contested.`);
        else if (b?.error === 'not_contested') toast.error('This directive is no longer contested — refreshed');
        else toast.error(errorText(e));
      },
    });
  };
  const discuss = `@manager about your ${kind} directive to ${who} that it contests (${d.id.slice(0, 8)}): `;
  return (
    <div className="amg-actions-split">
      <Link to="/app/chat" search={{ q: discuss }} className="btn-ghost" title="Open the chat with @manager about this directive">
        <Icon name="chat" size={14} /> Discuss
      </Link>
      <div className="amg-actions">
        <button type="button" className="btn-secondary" title="Accept the orchestrator’s refusal" disabled={decide.isPending} onClick={() => run('accept-refusal')}>
          <Icon name="x" size={14} /> Accept refusal
        </button>
        <button type="button" className="btn-primary" title="Uphold the directive — the executor applies it" disabled={decide.isPending} onClick={() => run('uphold')}>
          <Icon name="check" size={14} /> Uphold
        </button>
      </div>
    </div>
  );
}

/** Approve / Decline while a structural directive awaits the owner (spec 025). */
function OwnerActions({ d, onDone }: { d: Directive; onDone?: () => void }) {
  const confirm = useConfirm();
  const decide = useDecideDirective();
  const act = async (decision: 'approve' | 'decline') => {
    const target = `${DIRECTIVE_KIND_LABEL[d.kind]} ${d.binding === 'advice' ? 'advice' : 'directive'}${d.to ? ` to @${d.to}` : ''}`;
    const ok = decision === 'approve'
      ? await confirm(`approve the ${target}`, {
          danger: false, confirmLabel: 'Approve',
          details: <div className="callout-warning amg-callout-col">
            <strong>It is delivered to {d.to ? `@${d.to}` : 'the orchestrator'} on its next run.</strong>
            <span className="text-micro">Structural changes (cross-promo, pausing, strategy) act on real resources{d.shadow ? ' — this one is in shadow mode' : ''}.</span>
          </div>,
        })
      : await confirm(`decline the ${target}`, { confirmLabel: 'Decline' });
    if (!ok) return;
    decide.mutate({ id: d.id, decision }, {
      onSuccess: () => { toast.success(decision === 'approve' ? 'Directive approved' : 'Directive declined'); onDone?.(); },
      onError: (e) => toast.error(errorBody(e)?.error === 'not_awaiting_owner' ? 'This directive no longer awaits you — refreshed' : errorText(e)),
    });
  };
  return (
    <div className="amg-actions">
      <button type="button" className="btn-secondary" title="Decline this directive" disabled={decide.isPending} onClick={() => act('decline')}>
        <Icon name="x" size={14} /> Decline
      </button>
      <button type="button" className="btn-primary" title="Approve: it is delivered to the orchestrator on its next run" disabled={decide.isPending} onClick={() => act('approve')}>
        <Icon name="check" size={14} /> Approve
      </button>
    </div>
  );
}

/** "Format shift directive" / "Advice". */
function directiveTitle(d: Directive): string {
  const kind = DIRECTIVE_KIND_LABEL[d.kind] ?? d.kind;
  if (d.binding === 'advice') return d.kind === 'advice' ? 'Advice' : `${kind[0].toUpperCase()}${kind.slice(1)} advice`;
  return `${kind[0].toUpperCase()}${kind.slice(1)} directive`;
}

/** Everything about one directive: the dialog body. */
function DirectiveDetails({ d, show }: { d: Directive; show: 'to' | 'from' }) {
  const contested = d.status === 'contested';
  const vchip = verificationChip(d);
  const change = describeChange(d.change);
  const unscored = d.status === 'evaluated' ? unscoredReason(d) : null;
  const who = show === 'to' ? d.to : d.from;
  const params = d.params && Object.keys(d.params).length ? d.params : null;
  const execFailed = !!d.execError && (d.status === 'accepted' || d.status === 'failed');
  const hasFacts = !!(d.rationale || d.expected || params || entriesOf(d.evidence).length || change || execFailed);
  return (
    <div className="amg-stack">
      <div className="amg-badges">
        {d.binding === 'advice'
          ? <Badge tone="neutral" title="Advice: the orchestrator may follow or decline it">advice</Badge>
          : <Badge tone="warning" title="Binding directive: the orchestrator carries it out, or contests it to you citing your rules or safety">directive</Badge>}
        <Badge tone={DIRECTIVE_STATUS_TONE[d.status] ?? 'neutral'}>{DIRECTIVE_STATUS_LABEL[d.status] ?? d.status}</Badge>
        {d.structural && <Badge tone="warning" title="Structural: needs the owner's approval">structural</Badge>}
        {d.shadow && <Badge tone="neutral" title="Filed while the manager was in shadow mode">shadow</Badge>}
        {vchip && <Badge tone={vchip.tone} title={vchip.title}>{vchip.label}</Badge>}
        {d.outcome && <Badge tone={OUTCOME_TONE[d.outcome]}>{OUTCOME_LABEL[d.outcome]}</Badge>}
        {who && (
          <span className="text-micro mono amg-dim amg-push">
            {show === 'to' ? 'to ' : 'from '}
            <Link to="/app/agents/$handle" params={{ handle: who }} className="link-accent">@{who}</Link>
          </span>
        )}
      </div>
      <div className="text-body-sm amg-ink amg-wrap amg-pre">{d.body}</div>
      {hasFacts && (
        <div className="inset amg-facts">
          {d.rationale && <Fact label="why">{d.rationale}</Fact>}
          <ExpectedLine d={d} />
          <KeyValues label="params" value={params} />
          <KeyValues label="evidence" value={d.evidence} />
          {change && <Fact label="change">{change}</Fact>}
          {execFailed && (
            <Fact label="executor">
              <span className="amg-danger">{d.execError}</span>
              {d.execAttempts ? <span className="amg-dim"> · {d.execAttempts} attempt{d.execAttempts === 1 ? '' : 's'}</span> : null}
            </Fact>
          )}
        </div>
      )}
      <ContestBlock d={d} />
      {(d.reasonKind || d.ownerDecision || (d.resolution && !d.verification?.contest && !contested)) && (
        <div className="text-micro amg-resolution">
          {d.ownerDecision && OWNER_DECISION[d.ownerDecision] && <Badge tone={OWNER_DECISION[d.ownerDecision].tone} title={OWNER_DECISION[d.ownerDecision].title}>{OWNER_DECISION[d.ownerDecision].label}</Badge>}
          {d.reasonKind && !d.verification?.contest && <span className="chip mono">{d.reasonKind.replace(/_/g, ' ')}</span>}
          {d.resolution && !d.verification?.contest && !(d.ownerDecision === 'declined' && d.resolution === 'owner declined') && <span className="amg-wrap">{d.resolution}</span>}
        </div>
      )}
      <OutcomeBlock d={d} />
      {unscored && (
        <div className="text-micro amg-muted amg-note">
          <Icon name="info" size={12} /><span>{unscored}</span>
        </div>
      )}
      <div className="text-micro mono tabular-nums amg-dim amg-meta">
        <span>filed {fmtDate(d.createdAt)}</span>
        {d.reviewAt && <span>review {fmtDate(d.reviewAt)}</span>}
        <span title={d.id}>id {d.id.slice(0, 8)}</span>
      </div>
    </div>
  );
}

/**
 * One directive as a compact card: binding, kind, status, who, the first lines of the body and whether it needs you.
 * A click opens the dialog with everything else and the owner's actions.
 */
export function DirectiveCard({ d, delay = 0, focused = false, show = 'to', showStatus = false }: {
  d: Directive; delay?: number; focused?: boolean; show?: 'to' | 'from'; showStatus?: boolean;
}) {
  const contested = d.status === 'contested';
  const needsYou = d.status === 'awaiting_owner' || contested;
  const statusBadge = showStatus || contested || CLOSED_STATUSES.includes(d.status);
  const who = show === 'to' ? d.to : d.from;

  return (
    <CompactCard id={`directive-${d.id}`} delay={delay} focused={focused} attention={needsYou} hint="Open the directive"
      top={<>
        {d.binding === 'advice' ? <Badge tone="neutral">advice</Badge> : <Badge tone="warning">directive</Badge>}
        {d.kind !== 'advice' && <span className="chip mono amg-nowrap">{DIRECTIVE_KIND_LABEL[d.kind] ?? d.kind}</span>}
        {statusBadge && <Badge tone={DIRECTIVE_STATUS_TONE[d.status] ?? 'neutral'}>{DIRECTIVE_STATUS_LABEL[d.status] ?? d.status}</Badge>}
        {d.outcome && <Badge tone={OUTCOME_TONE[d.outcome]}>{OUTCOME_LABEL[d.outcome]}</Badge>}
      </>}
      meta={<span title={fmtDate(d.createdAt)}>{fmtRelative(d.createdAt)}</span>}
      body={<>
        {who && <span className="amg-dim"><span className="mono">{show === 'to' ? '→ ' : '← '}@{who}</span> · </span>}
        {d.body}
      </>}
      note={needsYou ? (contested ? `${who ? `@${who}` : 'The orchestrator'} contests it — your call` : 'Needs your approval') : undefined}
      dialog={{
        size: 'lg', icon: 'agents', title: directiveTitle(d),
        subtitle: `${who ? `${show === 'to' ? 'to' : 'from'} @${who} · ` : ''}${fmtRelative(d.createdAt)}`,
        body: () => <DirectiveDetails d={d} show={show} />,
        actions: needsYou ? (close) => d.status === 'awaiting_owner'
          ? <OwnerActions d={d} onDone={close} />
          : <ContestActions d={d} onDone={close} /> : undefined,
      }} />
  );
}

// ── filters (binding + kinds, kept in the URL by the route) ──

const BINDING_OPTIONS = [
  { key: 'all' as const, label: 'All' },
  { key: 'directive' as const, label: 'Directives' },
  { key: 'advice' as const, label: 'Advice' },
];

export function DirectiveFilterBar({ filters, onChange, trailing }: {
  filters: DirectiveFilters; onChange: (f: DirectiveFilters) => void; trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(filters.kinds.length > 0);
  const kindsLabel = filters.kinds.length === 0 ? 'all' : filters.kinds.length === 1 ? DIRECTIVE_KIND_LABEL[filters.kinds[0]] : `${filters.kinds.length} selected`;
  return (
    <div className="amg-filters">
      <div className="amg-toolbar">
        <SegmentedTabs size="sm" ariaLabel="Directive type" value={filters.binding ?? 'all'} options={BINDING_OPTIONS}
          onChange={(v) => onChange({ ...filters, binding: v === 'all' ? undefined : v })} />
        <button type="button" className="btn-secondary btn-sm" aria-expanded={open} aria-controls="directive-kind-filter" onClick={() => setOpen((v) => !v)}>
          Kind · {kindsLabel}
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
        </button>
        {hasFilters(filters) && (
          <button type="button" className="btn-ghost" onClick={() => onChange({ kinds: [] })} title="Show every directive">
            <Icon name="x" size={12} /> Clear
          </button>
        )}
        {trailing}
      </div>
      {open && (
        <div id="directive-kind-filter" role="group" aria-label="Directive kinds" className="amg-kinds">
          {DIRECTIVE_KINDS.map((k) => {
            const on = filters.kinds.includes(k);
            return (
              <button key={k} type="button" aria-pressed={on} className="chip-toggle" onClick={() => onChange(toggleKind(filters, k))}>
                {on && <Icon name="check" size={12} />}
                {DIRECTIVE_KIND_LABEL[k]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── @manager: the board ──

const byNewest = (a: Directive, b: Directive) => b.createdAt.localeCompare(a.createdAt);

export function ManagerDirectives({ focus, filters, onFilters }: { focus?: string; filters: DirectiveFilters; onFilters: (f: DirectiveFilters) => void }) {
  const q = useDirectives({ binding: filters.binding, kinds: filters.kinds });
  const wide = useMediaQuery('(min-width: 1100px)');
  const [showClosed, setShowClosed] = useState(false);
  const all = useMemo(() => (q.data?.directives ?? []).filter((d) => matchesFilters(d, filters)).sort(byNewest), [q.data, filters]);
  const groups = useMemo(() => BOARD_COLUMNS.map((c) => ({ ...c, items: all.filter((d) => c.statuses.includes(d.status)) })), [all]);
  useEffect(() => {
    if (focus && all.find((d) => d.id === focus && CLOSED_STATUSES.includes(d.status))) setShowClosed(true);
  }, [focus, all]);

  const bar = <DirectiveFilterBar filters={filters} onChange={onFilters}
    trailing={q.data ? <span className="amg-count amg-push">{all.length} shown</span> : undefined} />;

  if (q.error) return <NetworkError error={q.error} />;
  if (!q.data) return <div className="amg-skeleton" aria-hidden />;
  if (!all.length) {
    return (
      <div>
        {hasFilters(filters) && bar}
        {hasFilters(filters)
          ? <EmptyState icon="agents" title="Nothing matches these filters" note="Clear the filters to see every directive and advice." />
          : <EmptyState icon="agents" title="No directives yet"
              note="The manager answers “continue” while the network is healthy; it files advice (optional) or directives (binding) to orchestrators when a KPI drifts or an opportunity shows up." />}
      </div>
    );
  }

  if (wide) {
    return (
      <div>
        {bar}
        <div className="amg-board-scroll">
          <div className="amg-board">
            {groups.map((g) => (
              <section key={g.key} aria-label={g.label} className={`amg-col${g.items.length ? '' : ' is-empty'}`}>
                <ColumnHead label={g.label} n={g.items.length} note={g.note} warn={g.key === 'awaiting' && g.items.length > 0} />
                {g.items.length === 0
                  ? <div className="text-micro amg-dim amg-col-empty">—</div>
                  : g.items.map((d, i) => <DirectiveCard key={d.id} d={d} delay={Math.min(i, 8) * 25} focused={d.id === focus} />)}
              </section>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {bar}
      <div className="amg-groups">
        {groups.filter((g) => g.items.length > 0).map((g) => {
          const closed = g.key === 'closed';
          return (
            <section key={g.key} aria-label={g.label} className="amg-group">
              <ColumnHead label={g.label} n={g.items.length} note={g.note} warn={g.key === 'awaiting'}
                action={closed ? <button type="button" className="btn-ghost" aria-expanded={showClosed} onClick={() => setShowClosed((v) => !v)}>{showClosed ? 'Hide' : 'Show'}</button> : undefined} />
              {(!closed || showClosed) && g.items.map((d, i) => <DirectiveCard key={d.id} d={d} delay={Math.min(i, 8) * 25} focused={d.id === focus} />)}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ColumnHead({ label, n, note, warn, action }: { label: string; n: number; note: string; warn?: boolean; action?: ReactNode }) {
  return (
    <div className="amg-colhead" title={note}>
      {warn && <span className="amg-warn amg-icon"><Icon name="warning" size={13} /></span>}
      <span className={`text-overline${warn ? ' is-warn' : ''}`}>{label}</span>
      <span className="amg-count">{n}</span>
      {action && <span className="amg-push">{action}</span>}
    </div>
  );
}

// ── orchestrator: the inbox ──

const RANK: Partial<Record<DirectiveStatus, number>> = { contested: 0, awaiting_owner: 0, new: 1, accepted: 2, applied: 3 };

export function AgentInbox({ handle, filters, onFilters }: { handle: string; filters: DirectiveFilters; onFilters: (f: DirectiveFilters) => void }) {
  const q = useDirectives({ agent: handle, binding: filters.binding, kinds: filters.kinds });
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const all = useMemo(() => (q.data?.directives ?? []).filter((d) => matchesFilters(d, filters))
    .sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || byNewest(a, b)), [q.data, filters]);
  const open = all.filter((d) => OPEN_STATUSES.includes(d.status));
  const shown = filter === 'open' ? open : all;

  if (q.error) return <NetworkError error={q.error} />;
  return (
    <div>
      <div className="amg-toolbar is-spaced">
        <SegmentedTabs size="sm" ariaLabel="Directives shown" value={filter} onChange={setFilter}
          options={[{ key: 'open', label: 'Open', count: q.data ? open.length : undefined }, { key: 'all', label: 'All', count: q.data ? all.length : undefined }]} />
        <Link to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives' }} className="link-accent text-caption">
          All directives on @manager →
        </Link>
      </div>
      <DirectiveFilterBar filters={filters} onChange={onFilters} />
      {!q.data && <div className="amg-skeleton is-short" aria-hidden />}
      {q.data && shown.length === 0 && (
        <EmptyState icon="inbox" title={hasFilters(filters) ? 'Nothing matches these filters' : filter === 'open' ? 'No open directives' : 'No directives yet'}
          note="Directives (binding) and advice (optional) from @manager land here: the orchestrator accepts a directive or contests it to you; it follows advice or declines it. Structural ones wait for you first." />
      )}
      <div className="compact-grid">
        {shown.map((d, i) => <DirectiveCard key={d.id} d={d} delay={Math.min(i, 12) * 25} show="from" showStatus />)}
      </div>
    </div>
  );
}
