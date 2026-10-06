// "AI spend" card on the Overview (spec 029 FR-009): USD and tokens for today,
// 7 and 30 days with Δ against the previous period, the budget bars (total cap,
// agents' cap and the 3 most-used other caps) with a Blocked state, the top 5
// agents and features by 7-day cost, and a note when estimates dominate.
// The Network health card links here (#ai-spend).

import { Link } from '@tanstack/react-router';
import type { CSSProperties } from 'react';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { describeError } from '../ui/Toast';
import { useSpendSummary, type BudgetStatus, type SpendPeriod, type SpendRange, type SpendSummary } from '../../api/spend';
import {
  barPct, budgetBadge, budgetBarColor, cardView, deltaTone, estimatedNote, fmtDelta, fmtTokens, fmtUsd, spendIsEmpty,
} from '../../lib/spend';

const TONE_VAR = { success: 'var(--color-success)', warning: 'var(--color-warning)', danger: 'var(--color-danger)', accent: 'var(--color-accent)', neutral: 'var(--color-ink-dim)' } as const;
const eyebrow: CSSProperties = { color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em' };

function PeriodTile({ label, range, p }: { label: string; range: SpendRange; p: SpendPeriod }) {
  const tokens = p.tokensIn + p.tokensOut;
  return (
    <Link to="/app/spend" search={{ range }} className="row-lift" title={`${p.from} – ${p.to} (Kyiv days) · previous period ${fmtUsd(p.prev.usd)}`}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, padding: '10px 12px', borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline)', textDecoration: 'none', color: 'inherit' }}>
      <span className="text-micro" style={eyebrow}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span className="tabular-nums" style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--color-ink)' }}>{fmtUsd(p.usd)}</span>
        <span className="text-micro tabular-nums" style={{ color: TONE_VAR[deltaTone(p.deltaPct)], fontWeight: 500 }}>{fmtDelta(p.deltaPct, p.prev.usd, p.usd)}</span>
      </span>
      <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)' }} title={`in ${p.tokensIn.toLocaleString('en-US')} · out ${p.tokensOut.toLocaleString('en-US')} · cached ${p.tokensCached.toLocaleString('en-US')}`}>
        {fmtTokens(tokens)} tokens · {fmtTokens(p.tokensCached)} cached
      </span>
    </Link>
  );
}

export function BudgetBar({ b }: { b: BudgetStatus }) {
  const badge = budgetBadge(b.state, b.enforce);
  const pct = barPct(b.spentTodayUsd, b.dailyUsd);
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, minWidth: 0 }}>
        <span className="text-micro" style={{ color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={b.label}>{b.label}</span>
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        <span className="text-micro tabular-nums" style={{ marginLeft: 'auto', color: 'var(--color-ink)', whiteSpace: 'nowrap' }}>
          {fmtUsd(b.spentTodayUsd)} <span style={{ color: 'var(--color-ink-dim)' }}>/ {b.dailyUsd == null ? 'no daily cap' : fmtUsd(b.dailyUsd)}</span>
        </span>
      </div>
      <div role="meter" aria-label={`${b.label} today`} aria-valuemin={0} aria-valuemax={b.dailyUsd ?? 0} aria-valuenow={b.spentTodayUsd}
        style={{ height: 6, borderRadius: 3, background: 'var(--color-surface-3)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: budgetBarColor(b.state), borderRadius: 3 }} />
      </div>
    </div>
  );
}

function TopList({ title, rows }: { title: string; rows: Array<{ key: string; label: string; usd: number; tokens: number; to?: { handle: string } }> }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="text-micro" style={{ ...eyebrow, marginBottom: 6 }}>{title}</div>
      {rows.length === 0
        ? <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: 0 }}>Nothing in the last 7 days.</p>
        : rows.map((r) => (
          <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderTop: '1px solid var(--color-hairline-soft)', minWidth: 0 }}>
            {r.to
              ? <Link to="/app/agents/$handle" params={{ handle: r.to.handle }} className="link-accent text-micro" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{r.label}</Link>
              : <span className="text-micro" style={{ color: 'var(--color-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={r.label}>{r.label}</span>}
            <span className="text-micro tabular-nums" style={{ marginLeft: 'auto', color: 'var(--color-ink-dim)', whiteSpace: 'nowrap' }}>{fmtTokens(r.tokens)} tok</span>
            <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink)', minWidth: 56, textAlign: 'right' }}>{fmtUsd(r.usd)}</span>
          </div>
        ))}
    </div>
  );
}

function Body({ s }: { s: SpendSummary }) {
  const note = estimatedNote(s.estimated);
  return (
    <>
      {s.blocking.length > 0 && (
        <div className="callout-danger" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <Icon name="ban" size={14} />
          <span>
            {s.blocking.length === 1 ? `${s.blocking[0].label} is blocking AI calls` : `${s.blocking.length} caps are blocking AI calls`}
            {' '}until Kyiv midnight or until the cap is raised.
          </span>
          <Link to="/app/spend" search={{ tab: 'budgets' }} className="link-accent" style={{ marginLeft: 'auto' }}>Raise a cap</Link>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))', gap: 8, marginBottom: 14 }}>
        <PeriodTile label="Today" range="today" p={s.periods.today} />
        <PeriodTile label="7 days" range="7d" p={s.periods['7d']} />
        <PeriodTile label="30 days" range="30d" p={s.periods['30d']} />
      </div>

      {s.budgets.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '10px 16px', marginBottom: 14 }}>
          {s.budgets.map((b) => <BudgetBar key={b.id} b={b} />)}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 16 }}>
        <TopList title="Top agents · 7 days" rows={s.topAgents.map((a) => ({
          key: a.rootAgentId, label: a.handle ? `@${a.handle}` : 'Deleted agent', usd: a.usd, tokens: a.tokens,
          ...(a.handle ? { to: { handle: a.handle } } : {}),
        }))} />
        <TopList title="Top features · 7 days" rows={s.topFeatures.map((f) => ({ key: f.feature, label: f.feature, usd: f.usd, tokens: f.tokens }))} />
      </div>

      {(note || s.shadowUsd > 0) && (
        <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '12px 0 0', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <Icon name="info" size={12} />
          <span>
            {note && <>{note}. </>}
            {s.shadowUsd > 0 && <>Shadow runs cost {fmtUsd(s.shadowUsd)} in the last 7 days (included in the totals).</>}
          </span>
        </p>
      )}
    </>
  );
}

export function AiSpendCard({ delay }: { delay?: number }) {
  const q = useSpendSummary('7d');
  const view = cardView(q, spendIsEmpty);
  return (
    <div id="ai-spend" style={{ scrollMarginTop: 16 }}>
      <SectionCard delay={delay} icon="spend" title="AI spend"
        action={<Link to="/app/spend" className="link-accent text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Spend details <Icon name="chevron-right" size={11} /></Link>}>
        {view === 'error' && <div className="callout-danger">{describeError(q.error)}</div>}
        {view === 'loading' && <div aria-busy style={{ height: 220, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', opacity: 0.6 }} />}
        {view === 'empty' && (
          <EmptyState icon="spend" title="No AI calls recorded yet"
            note="Every LLM call (agents, strategies, DM triage, ROI, dedup) lands in the spend ledger; totals appear here within 5 minutes." />
        )}
        {view === 'data' && q.data && <Body s={q.data} />}
      </SectionCard>
    </div>
  );
}
