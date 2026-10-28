// Spec 049 FR-005: the network's health in one place — connections that stop publishing, sources that do not answer,
// budget headroom today and work that got stuck. Each section is a flush panel of rows, worst first; a clear section
// says so in one line. Rows link to where the problem is fixed (Connections, the agent page, the slot).
// Spec 078 C2: a StatStrip on top, rows with severity pills, a 6px meter per budget line. Styles in health.css.

import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { SectionCard, StatStrip, StatTile } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { SeverityPill } from '../ui/Pills';
import { Icon, type IconName } from '../ui/Icon';
import { describeError } from '../ui/Toast';
import { fmtDate, fmtRelative } from '../../lib/format';
import type { BudgetState } from '../../api/spend';
import {
  useNetworkHealth, type BadConnectionState, type NetworkHealth, type BudgetLine, type ConnectionIssue, type SourceIssue, type StuckGroup, type StuckItem, type StuckKind,
} from '../../api/health';
import './health.css';

type Tone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';
type Sev = 'critical' | 'action' | 'info';

const CONNECTION: Record<BadConnectionState, { label: string; sev: Sev }> = {
  token_invalid:  { label: 'Token invalid', sev: 'critical' },
  no_access:      { label: 'No access', sev: 'critical' },
  rate_limited:   { label: 'Rate limited', sev: 'action' },
  token_expiring: { label: 'Token expiring', sev: 'action' },
};
const SOURCE: Record<string, { label: string; sev: Sev }> = {
  blocked:   { label: 'Blocked', sev: 'critical' },
  failing:   { label: 'Failing', sev: 'critical' },
  exhausted: { label: 'Nothing new', sev: 'action' },
};
const BUDGET: Record<BudgetState, { label: string; tone: Tone; fill: string }> = {
  none:    { label: 'No cap', tone: 'neutral', fill: 'is-none' },
  ok:      { label: 'OK', tone: 'success', fill: 'is-ok' },
  warning: { label: 'Over 70 %', tone: 'warning', fill: 'is-warn' },
  danger:  { label: 'Over 90 %', tone: 'danger', fill: 'is-bad' },
  over:    { label: 'Over (not enforced)', tone: 'warning', fill: 'is-warn' },
  blocked: { label: 'Blocking', tone: 'danger', fill: 'is-bad' },
};
const STUCK_ICON: Record<StuckKind, IconName> = {
  slot_running: 'clock', slot_overdue: 'calendar', slot_failed: 'warning', approval_waiting: 'check',
  action_waiting: 'inbox', playbook_waiting: 'logs', ideas_waiting: 'sparkles',
};
/** The Connections page section that manages each platform. */
const CONNECTION_SECTION: Record<string, 'telegram' | 'meta' | 'tiktok'> = { telegram: 'telegram', instagram: 'meta', facebook: 'meta', threads: 'meta', tiktok: 'tiktok' };
const PLATFORM_ICON: Record<string, IconName> = { telegram: 'telegram', instagram: 'instagram', facebook: 'facebook', threads: 'threads', tiktok: 'tiktok', youtube: 'youtube' };

/** One problem as a row of a flush panel: a 36px glyph, the title with its severity pill and badges, meta and detail lines, links on the right. */
function Row({ icon, title, badges, meta, detail, right }: {
  icon: IconName; title: ReactNode; badges?: ReactNode; meta?: ReactNode; detail?: string | null; right?: ReactNode;
}) {
  return (
    <div className="panel-row hl-row">
      <span className="hl-lead" aria-hidden><Icon name={icon} size={16} /></span>
      <div className="hl-main">
        <div className="hl-title">
          <span className="hl-name clamp" title={typeof title === 'string' ? title : undefined}>{title}</span>
          {badges}
        </div>
        {meta && <div className="hl-meta truncate">{meta}</div>}
        {detail && <div className="hl-detail clamp" title={detail}>{detail}</div>}
      </div>
      {right && <div className="hl-right">{right}</div>}
    </div>
  );
}

/** A section with nothing wrong: a compact row (four stacked empty states would bury the page). */
function Clear({ children }: { children: ReactNode }) {
  return (
    <div className="panel-row hl-clear">
      <span className="hl-ok" aria-hidden><Icon name="check" size={14} /></span>
      <span>{children}</span>
    </div>
  );
}

const AgentLink = ({ handle, tab }: { handle: string | null | undefined; tab?: 'overview' | 'ideas' | 'playbook' }) => handle
  ? <Link to="/app/agents/$handle" params={{ handle }} search={tab && tab !== 'overview' ? { tab } : {}} className="link-accent text-micro">@{handle}</Link>
  : null;

function Count({ n, what }: { n: number; what: string }) {
  return <span className={`hl-count${n ? ' is-warn' : ''}`}>{n ? `${n} ${what}` : 'clear'}</span>;
}

function ConnectionsSection({ rows, delay }: { rows: ConnectionIssue[]; delay: number }) {
  return (
    <SectionCard title="Connections" icon="connections" flush delay={delay} style={{ marginBottom: 16 }}
      action={<Count n={rows.length} what={rows.length === 1 ? 'problem' : 'problems'} />}>
      {!rows.length ? <Clear>Every connected resource can publish.</Clear> : rows.map((c) => {
        const st = CONNECTION[c.state];
        const platform = c.ref.split(':')[0];
        return (
          <Row key={c.ref} icon={PLATFORM_ICON[platform] ?? 'globe'} title={c.title ?? c.ref}
            badges={<>
              <SeverityPill severity={st.sev} label={st.label} />
              {c.muted && <Badge tone="neutral" title="You muted the daily reminders for this state">reminders muted</Badge>}
            </>}
            meta={<>{c.title ? `${c.ref} · ` : ''}{c.since ? `since ${fmtRelative(c.since)}` : c.checkedAt ? `checked ${fmtRelative(c.checkedAt)}` : 'not checked'}{c.expiresAt ? ` · expires ${fmtDate(c.expiresAt)}` : ''}</>}
            detail={c.detail}
            right={<>
              <Link to="/app/connections" search={{ section: CONNECTION_SECTION[platform] ?? 'telegram' }} className="link-accent text-micro">Fix in Connections</Link>
              <AgentLink handle={c.agent} />
            </>} />
        );
      })}
    </SectionCard>
  );
}

function SourcesSection({ rows, delay }: { rows: SourceIssue[]; delay: number }) {
  return (
    <SectionCard title="Sources" icon="radar" flush delay={delay} style={{ marginBottom: 16 }}
      action={<Count n={rows.length} what="not working" />}>
      {!rows.length ? <Clear>Every channel's sources answered in the last 14 days.</Clear> : (
        <>
          {rows.map((s) => {
            const st = SOURCE[s.state] ?? { label: s.state, sev: 'info' as Sev };
            return (
              <Row key={`${s.channelKey}/${s.id}`} icon="radar" title={<>{s.channelKey} · {s.id}</>}
                badges={<>
                  <SeverityPill severity={st.sev} label={st.label} />
                  {s.slotsLost > 0 && <Badge tone="warning">{s.slotsLost} slot{s.slotsLost === 1 ? '' : 's'} lost</Badge>}
                </>}
                meta={<span title={s.ref}>{s.kind} · {s.ref}</span>}
                detail={s.detail}
                right={<>
                  <span className="hl-rate">{s.successRate === null ? '—' : `${Math.round(s.successRate * 100)}%`}</span>
                  <span className="hl-sub">{s.calls ? `${s.ok}/${s.calls} reads` : 'no reads'}</span>
                  <AgentLink handle={s.agent} />
                </>} />
            );
          })}
          <div className="panel-foot hl-note">
            The channel agent looks for a replacement of a source that keeps failing; its proposal waits in "Waiting for you" with Apply / Discard.
          </div>
        </>
      )}
    </SectionCard>
  );
}

function BudgetRow({ l }: { l: BudgetLine }) {
  const st = BUDGET[l.state];
  const pct = Math.max(0, Math.min(100, l.pct));
  return (
    <div className="panel-row hl-budget">
      <div className="hl-budget-top">
        <span className="hl-name">{l.label}</span>
        {l.state !== 'ok' && <Badge tone={st.tone}>{st.label}</Badge>}
        {!l.enforce && <Badge tone="neutral" title="This cap only alerts; it does not block calls">alert only</Badge>}
        <span className="hl-amount">${l.spentUsd.toFixed(2)} of ${l.capUsd.toFixed(2)} · {Math.round(l.pct)}%</span>
      </div>
      <div className="hl-meter" role="meter" aria-label={`${l.label} spent today`} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`hl-meter-fill anim-grow-x ${st.fill}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function BudgetSection({ budget, delay }: { budget: { lines: BudgetLine[]; blocking: unknown[]; slotsHit: number }; delay: number }) {
  return (
    <SectionCard title="Budget today" icon="spend" flush delay={delay} style={{ marginBottom: 16 }}
      action={<Link to="/app/spend" search={{ tab: 'budgets' }} className="panel-link">Edit caps →</Link>}>
      {budget.blocking.length > 0 && (
        <div className="hl-pad">
          <div className="callout-danger" role="alert">
            {budget.blocking.length} cap{budget.blocking.length === 1 ? ' blocks' : 's block'} LLM calls right now.
          </div>
        </div>
      )}
      {!budget.lines.length ? <Clear>No daily caps are set.</Clear> : budget.lines.map((l) => <BudgetRow key={l.label} l={l} />)}
      {budget.slotsHit > 0 && (
        <div className="panel-foot hl-warn">
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
  return (
    <SectionCard title="Stuck work" icon="clock" flush delay={delay} style={{ marginBottom: 16 }}
      action={<Count n={total} what={total === 1 ? 'item' : 'items'} />}>
      {!groups.length ? <Clear>Nothing is stuck: posts run on time and nothing waits on you for long.</Clear> : groups.map((g) => (
        <div key={g.kind}>
          <div className="hl-group">
            <span className="text-overline">{g.label} · {g.count}</span>
            <span className="hl-sub">{g.rule}</span>
          </div>
          {g.items.map((it) => (
            <Row key={it.id} icon={STUCK_ICON[g.kind]} title={it.title || '—'}
              meta={<>{[it.channelKey, it.agent && !it.channelKey ? `@${it.agent}` : null].filter(Boolean).join(' · ')}{it.channelKey || it.agent ? ' · ' : ''}<span title={fmtDate(it.at)}>{fmtRelative(it.at)}</span></>}
              detail={g.kind === 'action_waiting' ? `${it.detail?.replace(/_/g, ' ') ?? 'card'} — open it from "Waiting for you"` : it.detail}
              right={<StuckLink kind={g.kind} item={it} />} />
          ))}
          {g.count > g.items.length && <div className="hl-more">and {g.count - g.items.length} more</div>}
        </div>
      ))}
    </SectionCard>
  );
}

/** The four numbers on top: what needs fixing in each section, and how close the busiest cap is. */
function Glance({ h }: { h: NetworkHealth }) {
  const stuck = h.stuck.reduce((s, g) => s + g.count, 0);
  // The line that matters most: one that blocks calls, else the fullest.
  const rank = (l: BudgetLine) => (l.state === 'blocked' ? 1000 : 0) + l.pct;
  const worst = h.budget.lines.reduce<BudgetLine | null>((m, l) => (m == null || rank(l) > rank(m) ? l : m), null);
  const worstTone: Tone = h.budget.blocking.length ? 'danger' : worst ? BUDGET[worst.state].tone : 'neutral';
  return (
    <StatStrip label="Network health at a glance" style={{ marginBottom: 16 }}>
      <StatTile label="Connections" value={h.connections.length}
        delta={h.connections.length ? 'need fixing' : 'all can publish'} deltaTone={h.connections.length ? 'warning' : 'success'} />
      <StatTile label="Sources" value={h.sources.length}
        delta={h.sources.length ? 'not working' : 'all answering'} deltaTone={h.sources.length ? 'warning' : 'success'} />
      <StatTile label="Budget today" value={worst ? `${Math.round(worst.pct)}%` : '—'}
        delta={worst ? `${worst.label} · $${worst.spentUsd.toFixed(2)} of $${worst.capUsd.toFixed(2)}` : 'no caps set'} deltaTone={worstTone} />
      <StatTile label="Stuck work" value={stuck}
        delta={stuck ? (stuck === 1 ? 'item waiting' : 'items waiting') : 'nothing stuck'} deltaTone={stuck ? 'warning' : 'success'} />
    </StatStrip>
  );
}

export function NetworkHealthView() {
  const q = useNetworkHealth();
  if (q.error) return <div className="callout-danger" role="alert">{describeError(q.error)}</div>;
  if (!q.data) return <div className="hl-skeleton" aria-busy="true" />;
  const h = q.data;
  return (
    <div>
      <Glance h={h} />
      <ConnectionsSection rows={h.connections} delay={0} />
      <SourcesSection rows={h.sources} delay={60} />
      <BudgetSection budget={h.budget} delay={120} />
      <StuckSection groups={h.stuck} delay={180} />
    </div>
  );
}
