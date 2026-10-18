// Spec 049 FR-005: the network's health in one place — connections that stop publishing, sources that do not answer,
// budget headroom today and work that got stuck. Each section is a list of card-rows, worst first; a clear section
// says so in one line. Rows link to where the problem is fixed (Connections, the agent page, the slot).

import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { describeError } from '../ui/Toast';
import { fmtDate, fmtRelative } from '../../lib/format';
import type { BudgetState } from '../../api/spend';
import {
  useNetworkHealth, type BadConnectionState, type BudgetLine, type ConnectionIssue, type SourceIssue, type StuckGroup, type StuckItem, type StuckKind,
} from '../../api/health';

type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

const CONNECTION: Record<BadConnectionState, { label: string; tone: Tone }> = {
  token_invalid:  { label: 'Token invalid', tone: 'danger' },
  no_access:      { label: 'No access', tone: 'danger' },
  rate_limited:   { label: 'Rate limited', tone: 'warning' },
  token_expiring: { label: 'Token expiring', tone: 'warning' },
};
const SOURCE: Record<string, { label: string; tone: Tone }> = {
  blocked:   { label: 'Blocked', tone: 'danger' },
  failing:   { label: 'Failing', tone: 'danger' },
  exhausted: { label: 'Nothing new', tone: 'warning' },
};
const BUDGET: Record<BudgetState, { label: string; tone: Tone; bar: string }> = {
  none:    { label: 'No cap', tone: 'neutral', bar: 'var(--color-ink-dim)' },
  ok:      { label: 'OK', tone: 'success', bar: 'var(--color-success)' },
  warning: { label: 'Over 70 %', tone: 'warning', bar: 'var(--color-warning)' },
  danger:  { label: 'Over 90 %', tone: 'danger', bar: 'var(--color-danger)' },
  over:    { label: 'Over (not enforced)', tone: 'warning', bar: 'var(--color-warning)' },
  blocked: { label: 'Blocking', tone: 'danger', bar: 'var(--color-danger)' },
};
const STUCK_ICON: Record<StuckKind, IconName> = {
  slot_running: 'clock', slot_overdue: 'calendar', slot_failed: 'warning', approval_waiting: 'check',
  action_waiting: 'inbox', playbook_waiting: 'logs', ideas_waiting: 'sparkles',
};
/** The Connections page section that manages each platform. */
const CONNECTION_SECTION: Record<string, 'telegram' | 'meta' | 'tiktok'> = { telegram: 'telegram', instagram: 'meta', facebook: 'meta', threads: 'meta', tiktok: 'tiktok' };
const PLATFORM_ICON: Record<string, IconName> = { telegram: 'telegram', instagram: 'instagram', facebook: 'facebook', threads: 'threads', tiktok: 'tiktok', youtube: 'youtube' };

function Row({ icon, i, title, badges, meta, detail, right }: {
  icon: IconName; i: number; title: ReactNode; badges?: ReactNode; meta?: ReactNode; detail?: string | null; right?: ReactNode;
}) {
  return (
    <div className="card compose-rise" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 14px', animationDelay: `${Math.min(i, 12) * 30}ms`, flexWrap: 'wrap' }}>
      <span style={{ color: 'var(--color-ink-muted)', paddingTop: 2 }}><Icon name={icon} size={16} /></span>
      <div style={{ flex: '1 1 240px', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="clamp" style={{ color: 'var(--color-ink)', fontWeight: 500, minWidth: 0 }} title={typeof title === 'string' ? title : undefined}>{title}</span>
          {badges}
        </div>
        {meta && <div className="text-micro truncate" style={{ color: 'var(--color-ink-dim)' }}>{meta}</div>}
        {detail && <div className="text-micro clamp" style={{ color: 'var(--color-ink-muted)', marginTop: 4 }} title={detail}>{detail}</div>}
      </div>
      {right && <div style={{ textAlign: 'right', minWidth: 90 }}>{right}</div>}
    </div>
  );
}

function Clear({ children }: { children: ReactNode }) {
  return (
    <div className="text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-ink-muted)' }}>
      <span style={{ color: 'var(--color-success)' }}><Icon name="check" size={13} /></span>{children}
    </div>
  );
}

const List = ({ children }: { children: ReactNode }) => <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>;

const AgentLink = ({ handle, tab }: { handle: string | null | undefined; tab?: 'overview' | 'ideas' | 'playbook' }) => handle
  ? <Link to="/app/agents/$handle" params={{ handle }} search={tab && tab !== 'overview' ? { tab } : {}} className="link-accent text-micro">@{handle}</Link>
  : null;

function Count({ n, what }: { n: number; what: string }) {
  return <span className="text-micro" style={{ color: n ? 'var(--color-warning)' : 'var(--color-ink-dim)' }}>{n ? `${n} ${what}` : 'clear'}</span>;
}

function ConnectionsSection({ rows, delay }: { rows: ConnectionIssue[]; delay: number }) {
  return (
    <SectionCard title="Connections" icon="connections" delay={delay} style={{ marginBottom: 16 }}
      action={<Count n={rows.length} what={rows.length === 1 ? 'problem' : 'problems'} />}>
      {!rows.length ? <Clear>Every connected resource can publish.</Clear> : (
        <List>
          {rows.map((c, i) => {
            const st = CONNECTION[c.state];
            const platform = c.ref.split(':')[0];
            return (
              <Row key={c.ref} i={i} icon={PLATFORM_ICON[platform] ?? 'globe'} title={c.title ?? c.ref}
                badges={<>
                  <Badge tone={st.tone}>{st.label}</Badge>
                  {c.muted && <Badge tone="neutral" title="You muted the daily reminders for this state">reminders muted</Badge>}
                </>}
                meta={<>{c.title ? `${c.ref} · ` : ''}{c.since ? `since ${fmtRelative(c.since)}` : c.checkedAt ? `checked ${fmtRelative(c.checkedAt)}` : 'not checked'}{c.expiresAt ? ` · expires ${fmtDate(c.expiresAt)}` : ''}</>}
                detail={c.detail}
                right={<div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
                  <Link to="/app/connections" search={{ section: CONNECTION_SECTION[platform] ?? 'telegram' }} className="link-accent text-micro">Fix in Connections</Link>
                  <AgentLink handle={c.agent} />
                </div>} />
            );
          })}
        </List>
      )}
    </SectionCard>
  );
}

function SourcesSection({ rows, delay }: { rows: SourceIssue[]; delay: number }) {
  return (
    <SectionCard title="Sources" icon="radar" delay={delay} style={{ marginBottom: 16 }}
      action={<Count n={rows.length} what="not working" />}>
      {!rows.length ? <Clear>Every channel's sources answered in the last 14 days.</Clear> : (
        <>
          <List>
            {rows.map((s, i) => {
              const st = SOURCE[s.state] ?? { label: s.state, tone: 'neutral' as Tone };
              return (
                <Row key={`${s.channelKey}/${s.id}`} i={i} icon="radar" title={<>{s.channelKey} · {s.id}</>}
                  badges={<>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {s.slotsLost > 0 && <Badge tone="warning">{s.slotsLost} slot{s.slotsLost === 1 ? '' : 's'} lost</Badge>}
                  </>}
                  meta={<span title={s.ref}>{s.kind} · {s.ref}</span>}
                  detail={s.detail}
                  right={<div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end' }}>
                    <span className="tabular-nums" style={{ color: 'var(--color-ink)' }}>{s.successRate === null ? '—' : `${Math.round(s.successRate * 100)}%`}</span>
                    <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{s.calls ? `${s.ok}/${s.calls} reads` : 'no reads'}</span>
                    <AgentLink handle={s.agent} />
                  </div>} />
              );
            })}
          </List>
          <div className="text-micro" style={{ marginTop: 10, color: 'var(--color-ink-muted)' }}>
            The channel agent looks for a replacement of a source that keeps failing; its proposal waits in "Waiting for you" with Apply / Discard.
          </div>
        </>
      )}
    </SectionCard>
  );
}

function BudgetRow({ l, i }: { l: BudgetLine; i: number }) {
  const st = BUDGET[l.state];
  const pct = Math.max(0, Math.min(100, l.pct));
  return (
    <div className="card compose-rise" style={{ padding: '10px 14px', animationDelay: `${Math.min(i, 12) * 30}ms` }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{l.label}</span>
        {l.state !== 'ok' && <Badge tone={st.tone}>{st.label}</Badge>}
        {!l.enforce && <Badge tone="neutral" title="This cap only alerts; it does not block calls">alert only</Badge>}
        <span className="tabular-nums text-micro" style={{ marginLeft: 'auto', color: 'var(--color-ink-muted)' }}>
          ${l.spentUsd.toFixed(2)} of ${l.capUsd.toFixed(2)} · {Math.round(l.pct)}%
        </span>
      </div>
      <div role="meter" aria-label={`${l.label} spent today`} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}
        style={{ height: 4, borderRadius: 2, background: 'var(--color-surface-2)', marginTop: 8, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: st.bar }} />
      </div>
    </div>
  );
}

function BudgetSection({ budget, delay }: { budget: { lines: BudgetLine[]; blocking: unknown[]; slotsHit: number }; delay: number }) {
  return (
    <SectionCard title="Budget today" icon="spend" delay={delay} style={{ marginBottom: 16 }}
      action={<Link to="/app/spend" search={{ tab: 'budgets' }} className="link-accent text-micro">Edit caps</Link>}>
      {budget.blocking.length > 0 && (
        <div className="callout-danger" style={{ marginBottom: 10 }}>
          {budget.blocking.length} cap{budget.blocking.length === 1 ? ' blocks' : 's block'} LLM calls right now.
        </div>
      )}
      {!budget.lines.length ? <Clear>No daily caps are set.</Clear> : <List>{budget.lines.map((l, i) => <BudgetRow key={l.label} l={l} i={i} />)}</List>}
      {budget.slotsHit > 0 && (
        <div className="text-micro" style={{ marginTop: 10, color: 'var(--color-warning)' }}>
          {budget.slotsHit} post{budget.slotsHit === 1 ? '' : 's'} waited for or skipped by a cap today.
        </div>
      )}
    </SectionCard>
  );
}

function StuckLink({ kind, item }: { kind: StuckKind; item: StuckItem }) {
  if (kind.startsWith('slot_') || kind === 'approval_waiting') {
    return <Link to="/app/editor/slot/$id" params={{ id: item.id }} className="link-accent text-micro">Open the post</Link>;
  }
  if (kind === 'playbook_waiting') return <AgentLink handle={item.agent} tab="playbook" />;
  if (kind === 'ideas_waiting') return <AgentLink handle={item.agent} tab="ideas" />;
  return <AgentLink handle={item.agent} />;
}

function StuckSection({ groups, delay }: { groups: StuckGroup[]; delay: number }) {
  const total = groups.reduce((s, g) => s + g.count, 0);
  let i = 0;
  return (
    <SectionCard title="Stuck work" icon="clock" delay={delay} style={{ marginBottom: 16 }}
      action={<Count n={total} what={total === 1 ? 'item' : 'items'} />}>
      {!groups.length ? <Clear>Nothing is stuck: posts run on time and nothing waits on you for long.</Clear> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {groups.map((g) => (
            <div key={g.kind}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span className="text-eyebrow">{g.label} · {g.count}</span>
                <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{g.rule}</span>
              </div>
              <List>
                {g.items.map((it) => (
                  <Row key={it.id} i={i++} icon={STUCK_ICON[g.kind]} title={it.title || '—'}
                    meta={<>{[it.channelKey, it.agent && !it.channelKey ? `@${it.agent}` : null].filter(Boolean).join(' · ')}{it.channelKey || it.agent ? ' · ' : ''}<span title={fmtDate(it.at)}>{fmtRelative(it.at)}</span></>}
                    detail={g.kind === 'action_waiting' ? `${it.detail?.replace(/_/g, ' ') ?? 'card'} — open it from "Waiting for you"` : it.detail}
                    right={<StuckLink kind={g.kind} item={it} />} />
                ))}
              </List>
              {g.count > g.items.length && (
                <div className="text-micro" style={{ marginTop: 6, color: 'var(--color-ink-dim)' }}>and {g.count - g.items.length} more</div>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

export function NetworkHealthView() {
  const q = useNetworkHealth();
  if (q.error) return <div className="callout-danger">{describeError(q.error)}</div>;
  if (!q.data) return <div style={{ height: 240, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', opacity: 0.6 }} />;
  const h = q.data;
  return (
    <div>
      <div className="text-micro" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, color: h.problems ? 'var(--color-warning)' : 'var(--color-ink-muted)' }}>
        <Icon name={h.problems ? 'warning' : 'check'} size={13} />
        {h.problems ? `${h.problems} thing${h.problems === 1 ? '' : 's'} need${h.problems === 1 ? 's' : ''} attention` : 'All clear'}
        <span style={{ color: 'var(--color-ink-dim)' }} title={fmtDate(h.generatedAt)}>· updated {fmtRelative(h.generatedAt)}</span>
      </div>
      <ConnectionsSection rows={h.connections} delay={0} />
      <SourcesSection rows={h.sources} delay={60} />
      <BudgetSection budget={h.budget} delay={120} />
      <StuckSection groups={h.stuck} delay={180} />
    </div>
  );
}
