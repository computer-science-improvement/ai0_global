// Directives of the MANAGER (spec 021 FR-009): the card shared by the
// @manager "Directives" board and an orchestrator's "Inbox" tab — kind,
// structural / shadow flags, addressee, body, rationale, the expected effect,
// evidence, resolution, the owner's decision and the evaluated outcome — plus
// the owner's Approve / Decline while a structural directive awaits them.

import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EmptyState, type Tone } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { RowActions, TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';
import { SegmentedTabs } from '../SegmentedTabs';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { errorBody } from '../../api/agents';
import {
  useDecideDirective, useDirectives, type Directive, type DirectiveKind, type DirectiveOutcome, type DirectiveStatus, type OwnerDecision,
} from '../../api/manager';
import { NetworkError, ResourceChip, errorText } from './NetworkUi';

export const DIRECTIVE_KIND_LABEL: Record<DirectiveKind, string> = {
  advice: 'advice', task: 'task', format_shift: 'format shift', frequency: 'frequency', repost: 'repost', cross_promo: 'cross-promo',
  pause_series: 'pause series', experiment: 'experiment', pause_resource: 'pause resource', strategy: 'strategy',
};

export const DIRECTIVE_STATUS_LABEL: Record<DirectiveStatus, string> = {
  awaiting_owner: 'awaiting owner', new: 'new', accepted: 'accepted', applied: 'applied', evaluated: 'evaluated',
  rejected: 'rejected', expired: 'expired', canceled: 'canceled',
};

export const DIRECTIVE_STATUS_TONE: Record<DirectiveStatus, Tone> = {
  awaiting_owner: 'warning', new: 'accent', accepted: 'success', applied: 'success', evaluated: 'neutral',
  rejected: 'danger', expired: 'neutral', canceled: 'neutral',
};

export const OUTCOME_TONE: Record<DirectiveOutcome, Tone> = { worked: 'success', hurt: 'danger', no_effect: 'neutral', inconclusive: 'warning' };
export const OUTCOME_LABEL: Record<DirectiveOutcome, string> = { worked: 'worked', hurt: 'hurt', no_effect: 'no effect', inconclusive: 'inconclusive' };

const OWNER_DECISION: Record<OwnerDecision, { tone: Tone; label: string; title: string }> = {
  approved:        { tone: 'success', label: 'owner approved', title: 'You approved this structural directive' },
  declined:        { tone: 'danger',  label: 'owner declined', title: 'You declined this structural directive' },
  timeout_applied: { tone: 'neutral', label: 'timeout · applied', title: 'No answer in time — the default applied it' },
  timeout_dropped: { tone: 'neutral', label: 'timeout · dropped', title: 'No answer in time — the default dropped it' },
};

export const METRIC_LABEL: Record<string, string> = {
  views_per_post: 'views/post', engagement_rate: 'engagement', posts: 'posts', followers_growth: 'follower growth',
  transitions: 'transitions', revenue: 'revenue',
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

function KeyValues({ label, value }: { label: string; value: unknown }) {
  const e = entriesOf(value);
  if (!e.length) return null;
  return (
    <div className="text-micro" style={{ display: 'flex', gap: '3px 10px', flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}>
      <span style={{ color: 'var(--color-ink-dim)' }}>{label}</span>
      {e.map(([k, x], i) => (
        <span key={`${k}-${i}`} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', minWidth: 0, maxWidth: '100%' }}>
          {k && <span style={{ color: 'var(--color-ink-dim)', whiteSpace: 'nowrap' }}>{k.replace(/_/g, ' ')}</span>}
          {typeof x === 'string' && REF_RE.test(x)
            ? <ResourceChip refId={x} />
            : <span className="tabular-nums" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>{fmtValue(x)}</span>}
        </span>
      ))}
    </div>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere', minWidth: 0 }}>
      <span style={{ color: 'var(--color-ink-dim)' }}>{label} · </span>{children}
    </div>
  );
}

/** "views/post ↑ ≥ 10% on <resource>". */
export function ExpectedLine({ d }: { d: Directive }) {
  const x = d.expected;
  if (!x) return null;
  const up = x.direction === 'up';
  return (
    <div className="text-micro" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
      <span style={{ color: 'var(--color-ink-dim)' }}>expected</span>
      <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{metricLabel(x.metric)}</span>
      <span style={{ color: up ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 600 }} aria-label={up ? 'up' : 'down'}>{up ? '↑' : '↓'}</span>
      <span className="tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>≥ {x.min_change_pct}%</span>
      {x.resource_ref && <ResourceChip refId={x.resource_ref} />}
      {d.reviewAt && <span style={{ color: 'var(--color-ink-dim)' }} title={fmtDate(d.reviewAt)}>· review {fmtDate(d.reviewAt).replace(/ \d{4},.*$/, '')}</span>}
    </div>
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
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '7px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)' }}>
      <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>outcome</span>
      {(before != null || after != null) && (
        <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>
          {d.expected && <span style={{ color: 'var(--color-ink-dim)' }}>{metricLabel(d.expected.metric)} </span>}
          {fmtValue(before)} → <span style={{ color: 'var(--color-ink)' }}>{fmtValue(after)}</span>
        </span>
      )}
      {ch != null && (
        <span className="text-micro tabular-nums" style={{ fontWeight: 600, color: ch === 0 ? 'var(--color-ink-dim)' : good ? 'var(--color-success)' : 'var(--color-danger)' }}>
          {fmtPct(ch)}
        </span>
      )}
      {o.after?.stale && <Badge tone="neutral" title="The metric had no fresh data at evaluation">stale</Badge>}
      {o.confounders?.length ? (
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }} title="Other changes in the same window">
          confounders: {o.confounders.join(', ')}
        </span>
      ) : null}
    </div>
  );
}

export function DirectiveCard({ d, delay = 0, focused = false, show = 'to', showStatus = false }: {
  d: Directive; delay?: number; focused?: boolean; show?: 'to' | 'from'; showStatus?: boolean;
}) {
  const confirm = useConfirm();
  const decide = useDecideDirective();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focused]);

  const who = show === 'to' ? d.to : d.from;
  const act = async (decision: 'approve' | 'decline') => {
    const target = `${DIRECTIVE_KIND_LABEL[d.kind]} directive${d.to ? ` to @${d.to}` : ''}`;
    const ok = decision === 'approve'
      ? await confirm(`approve the ${target}`, {
          danger: false, confirmLabel: 'Approve',
          details: <div className="callout-warning" style={{ flexDirection: 'column', gap: 4 }}>
            <strong>It is delivered to {d.to ? `@${d.to}` : 'the orchestrator'} on its next run.</strong>
            <span className="text-micro">Structural changes (cross-promo, pausing, strategy) act on real resources{d.shadow ? ' — this one is in shadow mode' : ''}.</span>
          </div>,
        })
      : await confirm(`decline the ${target}`, { confirmLabel: 'Decline' });
    if (!ok) return;
    decide.mutate({ id: d.id, decision }, {
      onSuccess: () => toast.success(decision === 'approve' ? 'Directive approved' : 'Directive declined'),
      onError: (e) => toast.error(errorBody(e)?.error === 'not_awaiting_owner' ? 'This directive no longer awaits you — refreshed' : errorText(e)),
    });
  };

  return (
    <div ref={ref} id={`directive-${d.id}`} className="card row-lift compose-rise"
      style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, animationDelay: `${delay}ms`,
        boxShadow: focused ? 'inset 0 0 0 1px var(--color-accent)' : d.status === 'awaiting_owner' ? 'inset 0 0 0 1px var(--color-warning-soft)' : undefined }}>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="chip" style={{ fontSize: 11 }}>{DIRECTIVE_KIND_LABEL[d.kind] ?? d.kind}</span>
        {showStatus && <Badge tone={DIRECTIVE_STATUS_TONE[d.status]}>{DIRECTIVE_STATUS_LABEL[d.status]}</Badge>}
        {d.structural && <Badge tone="warning" title="Structural: needs the owner's approval">structural</Badge>}
        {d.shadow && <Badge tone="neutral" title="Filed while the manager was in shadow mode">shadow</Badge>}
        {d.outcome && <Badge tone={OUTCOME_TONE[d.outcome]}>{OUTCOME_LABEL[d.outcome]}</Badge>}
        <span className="text-micro" style={{ marginLeft: 'auto', color: 'var(--color-ink-dim)', whiteSpace: 'nowrap' }} title={fmtDate(d.createdAt)}>
          {fmtRelative(d.createdAt)}
        </span>
      </div>
      {who && (
        <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
          {show === 'to' ? 'to ' : 'from '}
          <Link to="/app/agents/$handle" params={{ handle: who }} className="link-accent">@{who}</Link>
        </div>
      )}
      <div className="text-body-sm" style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{d.body}</div>
      {d.rationale && <Line label="why">{d.rationale}</Line>}
      <ExpectedLine d={d} />
      <KeyValues label="params" value={d.params && Object.keys(d.params).length ? d.params : null} />
      <KeyValues label="evidence" value={d.evidence} />
      {(d.resolution || d.reasonKind || d.ownerDecision) && (
        <div className="text-micro" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', color: 'var(--color-ink-muted)', minWidth: 0 }}>
          {d.ownerDecision && <Badge tone={OWNER_DECISION[d.ownerDecision].tone} title={OWNER_DECISION[d.ownerDecision].title}>{OWNER_DECISION[d.ownerDecision].label}</Badge>}
          {d.reasonKind && <span className="chip" style={{ fontSize: 10 }}>{d.reasonKind.replace(/_/g, ' ')}</span>}
          {d.resolution && !(d.ownerDecision === 'declined' && d.resolution === 'owner declined') && <span style={{ overflowWrap: 'anywhere' }}>{d.resolution}</span>}
        </div>
      )}
      <OutcomeBlock d={d} />
      {d.status === 'awaiting_owner' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <RowActions danger={<TableAction icon="x" danger label="Decline" title="Decline" disabled={decide.isPending} onClick={() => act('decline')} />}>
            <TableAction icon="check" label="Approve" title="Approve" disabled={decide.isPending} onClick={() => act('approve')} />
          </RowActions>
        </div>
      )}
    </div>
  );
}

// ── @manager: the board ──

const COLUMNS: Array<{ key: string; label: string; statuses: DirectiveStatus[]; note: string }> = [
  { key: 'awaiting_owner', label: 'Awaiting you', statuses: ['awaiting_owner'], note: 'Structural directives wait for your approval.' },
  { key: 'new', label: 'New', statuses: ['new'], note: 'Delivered to the orchestrator on its next run.' },
  { key: 'accepted', label: 'Accepted', statuses: ['accepted'], note: 'The orchestrator agreed and is applying it.' },
  { key: 'applied', label: 'Applied', statuses: ['applied'], note: 'Applied; the effect is evaluated at review time.' },
  { key: 'evaluated', label: 'Evaluated', statuses: ['evaluated'], note: 'Outcome measured against the baseline.' },
  { key: 'closed', label: 'Rejected · expired', statuses: ['rejected', 'expired', 'canceled'], note: 'Declined, rejected by the orchestrator, or timed out.' },
];

const byNewest = (a: Directive, b: Directive) => b.createdAt.localeCompare(a.createdAt);

export function ManagerDirectives({ focus }: { focus?: string }) {
  const q = useDirectives();
  const wide = useMediaQuery('(min-width: 1100px)');
  const [showClosed, setShowClosed] = useState(false);
  const all = useMemo(() => [...(q.data?.directives ?? [])].sort(byNewest), [q.data]);
  const groups = useMemo(() => COLUMNS.map((c) => ({ ...c, items: all.filter((d) => c.statuses.includes(d.status)) })), [all]);
  useEffect(() => {
    if (focus && all.find((d) => d.id === focus && ['rejected', 'expired', 'canceled'].includes(d.status))) setShowClosed(true);
  }, [focus, all]);

  if (q.error) return <NetworkError error={q.error} />;
  if (!q.data) return <div className="panel compose-rise" style={{ height: 160, opacity: 0.55 }} />;
  if (!all.length) {
    return <EmptyState icon="agents" title="No directives yet"
      note="The manager answers “continue” while the network is healthy; it files directives to orchestrators when a KPI drifts or an opportunity shows up." />;
  }

  if (wide) {
    return (
      <div style={{ overflowX: 'auto', maxWidth: '100%', paddingBottom: 6 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', minWidth: 'min-content' }}>
          {groups.map((g) => (
            <section key={g.key} aria-label={g.label}
              style={{ flex: g.items.length ? '1 0 280px' : '0 0 150px', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 8, padding: 8, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline)' }}>
              <ColumnHead label={g.label} n={g.items.length} note={g.note} warn={g.key === 'awaiting_owner' && g.items.length > 0} />
              {g.items.length === 0
                ? <div className="text-micro" style={{ color: 'var(--color-ink-dim)', padding: '10px 4px' }}>—</div>
                : g.items.map((d, i) => <DirectiveCard key={d.id} d={d} delay={Math.min(i, 8) * 25} focused={d.id === focus} />)}
            </section>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {groups.filter((g) => g.items.length > 0).map((g) => {
        const closed = g.key === 'closed';
        return (
          <section key={g.key} aria-label={g.label} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ColumnHead label={g.label} n={g.items.length} note={g.note} warn={g.key === 'awaiting_owner'}
              action={closed ? <button type="button" className="btn-tiny" onClick={() => setShowClosed((v) => !v)}>{showClosed ? 'Hide' : 'Show'}</button> : undefined} />
            {(!closed || showClosed) && g.items.map((d, i) => <DirectiveCard key={d.id} d={d} delay={Math.min(i, 8) * 25} focused={d.id === focus} />)}
          </section>
        );
      })}
    </div>
  );
}

function ColumnHead({ label, n, note, warn, action }: { label: string; n: number; note: string; warn?: boolean; action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px' }} title={note}>
      {warn && <span style={{ color: 'var(--color-warning)', display: 'inline-flex' }}><Icon name="warning" size={13} /></span>}
      <span className="text-eyebrow" style={{ color: warn ? 'var(--color-warning)' : undefined }}>{label}</span>
      <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>{n}</span>
      {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
    </div>
  );
}

// ── orchestrator: the inbox ──

const OPEN: DirectiveStatus[] = ['awaiting_owner', 'new', 'accepted', 'applied'];
const RANK: Partial<Record<DirectiveStatus, number>> = { awaiting_owner: 0, new: 1, accepted: 2, applied: 3 };

export function AgentInbox({ handle }: { handle: string }) {
  const q = useDirectives({ agent: handle });
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const all = useMemo(() => [...(q.data?.directives ?? [])].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || byNewest(a, b)), [q.data]);
  const open = all.filter((d) => OPEN.includes(d.status));
  const shown = filter === 'open' ? open : all;

  if (q.error) return <NetworkError error={q.error} />;
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <SegmentedTabs size="sm" value={filter} onChange={setFilter}
          options={[{ key: 'open', label: q.data ? `Open · ${open.length}` : 'Open' }, { key: 'all', label: q.data ? `All · ${all.length}` : 'All' }]} />
        <Link to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives' }} className="link-accent text-micro">
          All directives on @manager →
        </Link>
      </div>
      {!q.data && <div className="panel compose-rise" style={{ height: 140, opacity: 0.55 }} />}
      {q.data && shown.length === 0 && (
        <EmptyState icon="inbox" title={filter === 'open' ? 'No open directives' : 'No directives yet'}
          note="Directives from @manager land here: the orchestrator accepts or rejects them on its next run; structural ones wait for you first." />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 380px), 1fr))', gap: 10, alignItems: 'start' }}>
        {shown.map((d, i) => <DirectiveCard key={d.id} d={d} delay={Math.min(i, 12) * 25} show="from" showStatus />)}
      </div>
    </div>
  );
}
