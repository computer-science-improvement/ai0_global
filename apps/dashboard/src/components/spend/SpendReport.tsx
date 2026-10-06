// Report tab of the Spend page (spec 029 FR-010): range, filters, the stacked
// daily chart, group-by tabs, the breakdown table (agents expand to roles, runs
// link to their trace) and the CSV export.

import { Fragment, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { SectionCard, EmptyState, StatTile } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { TableAction } from '../ui/table';
import { describeError, toast } from '../ui/Toast';
import { SegmentedTabs } from '../SegmentedTabs';
import { SpendChart } from './SpendChart';
import { useAgentTree } from '../../api/agents';
import {
  SPEND_PROVIDERS, downloadSpendCsv, useSpendBreakdown, useSpendLedger,
  type SpendGroupBy, type SpendQuery, type SpendRange, type SpendRow,
} from '../../api/spend';
import { customRangeError, fmtTokens, fmtUsd, kyivToday } from '../../lib/spend';
import type { SpendSearch } from '../../lib/spend-search';

type RangeTab = SpendRange | 'custom';

const RANGE_TABS: ReadonlyArray<{ key: RangeTab; label: string }> = [
  { key: 'today', label: 'Today' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' },
  { key: 'mtd', label: 'Month to date' }, { key: 'custom', label: 'Custom' },
];

const GROUP_TABS: ReadonlyArray<{ key: SpendGroupBy; label: string }> = [
  { key: 'day', label: 'Day' }, { key: 'agent', label: 'Agent' }, { key: 'role', label: 'Role' },
  { key: 'resource', label: 'Resource' }, { key: 'provider', label: 'Provider' }, { key: 'model', label: 'Model' },
  { key: 'feature', label: 'Feature' }, { key: 'run', label: 'Run' },
];

const GROUP_HEAD: Record<SpendGroupBy, string> = {
  day: 'Day (Kyiv)', agent: 'Agent', role: 'Role', resource: 'Resource', provider: 'Provider', model: 'Model', feature: 'Feature', run: 'Run',
};

function RowCells({ r }: { r: SpendRow }) {
  return (
    <>
      <td className="num">{r.calls.toLocaleString('en-US')}</td>
      <td className="num" style={{ color: r.errors ? 'var(--color-danger)' : undefined }}>{r.errors ? r.errors.toLocaleString('en-US') : '—'}</td>
      <td className="num" title={r.tokensIn.toLocaleString('en-US')}>{fmtTokens(r.tokensIn)}</td>
      <td className="num" title={r.tokensOut.toLocaleString('en-US')}>{fmtTokens(r.tokensOut)}</td>
      <td className="num" title={r.tokensCached.toLocaleString('en-US')}>{fmtTokens(r.tokensCached)}</td>
      <td className="num" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{fmtUsd(r.costUsd)}</td>
      <td className="num">{r.pct.toFixed(1)}%</td>
      <td className="num">{r.avgLatencyMs == null ? '—' : `${(r.avgLatencyMs / 1000).toFixed(1)}s`}</td>
      <td>
        {r.unpricedCalls > 0
          ? <Badge tone="warning" title={`${r.unpricedCalls} call(s) have no price in the price table`}>unpriced</Badge>
          : r.estimated ? <Badge tone="neutral" title={`${fmtUsd(r.estimatedUsd)} estimated from the price table`}>estimated</Badge> : null}
      </td>
    </>
  );
}

/** The roles of one root agent, rendered as indented rows under it. */
function AgentRoles({ q, agentId }: { q: SpendQuery; agentId: string }) {
  const roles = useSpendBreakdown({ ...q, groupBy: 'role', agent: agentId });
  if (!roles.data) {
    return <tr><td colSpan={11} className="text-micro" style={{ color: 'var(--color-ink-dim)', paddingLeft: 32 }}>{roles.error ? describeError(roles.error) : 'Loading roles…'}</td></tr>;
  }
  return (
    <>
      {roles.data.rows.map((r) => (
        <tr key={`${agentId}:${r.key}`} style={{ background: 'var(--color-surface-1)' }}>
          <td style={{ paddingLeft: 32, color: 'var(--color-ink-muted)' }}>↳ {r.label}</td>
          <RowCells r={r} />
          <td />
        </tr>
      ))}
    </>
  );
}

export function SpendReport({ search, setSearch }: { search: SpendSearch; setSearch: (patch: Partial<SpendSearch>) => void }) {
  const custom = !!(search.from && search.to);
  const groupBy: SpendGroupBy = search.groupBy ?? 'day';
  const q: SpendQuery = {
    range: custom ? undefined : search.range ?? '7d', from: search.from, to: search.to, groupBy, stackBy: search.stackBy ?? 'provider',
    agent: search.agent, feature: search.feature, provider: search.provider, shadow: search.shadow,
  };
  const data = useSpendBreakdown(q);
  const ledger = useSpendLedger();
  const tree = useAgentTree();
  const [rangeTab, setRangeTab] = useState<RangeTab>(custom ? 'custom' : search.range ?? '7d');
  const today = kyivToday();
  const [from, setFrom] = useState(search.from ?? today);
  const [to, setTo] = useState(search.to ?? today);
  const [feature, setFeature] = useState(search.feature ?? '');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setFeature(search.feature ?? ''); }, [search.feature]);
  // A link to another range (e.g. from the Overview card) while the page is open.
  useEffect(() => { if (!custom) setRangeTab(search.range ?? '7d'); }, [search.range, custom]);

  const rangeError = rangeTab === 'custom' ? customRangeError(from, to) : null;
  const pickRange = (k: RangeTab) => {
    setRangeTab(k);
    if (k !== 'custom') setSearch({ range: k, from: undefined, to: undefined });
  };
  const applyFeature = () => {
    const v = feature.trim();
    if (v && !/^[a-z0-9_.-]{1,80}$/.test(v)) { toast.error('A feature prefix uses a–z, 0–9, "_", "-" and "." only, e.g. editor. or strategy.recipes'); return; }
    setSearch({ feature: v || undefined });
  };
  const exportCsv = async (kind: SpendGroupBy | 'raw') => {
    setBusy(kind);
    try { await downloadSpendCsv({ ...q, groupBy: kind }); } catch (err) { toast.error(describeError(err)); } finally { setBusy(null); }
  };
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const roots = (tree.data?.agents ?? []).filter((a) => !a.parentId);
  const d = data.data;
  const t = d?.totals;
  const filtered = !!(search.agent || search.feature || search.provider || search.shadow);

  return (
    <>
      <SectionCard icon="calendar" title="Range and filters" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
            <SegmentedTabs size="sm" value={rangeTab} onChange={pickRange} options={RANGE_TABS} />
          </div>
          {rangeTab === 'custom' && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input type="date" className="input-field" aria-label="From (Kyiv day)" value={from} max={today} onChange={(e) => setFrom(e.target.value)} style={{ width: 150 }} />
              <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>to</span>
              <input type="date" className="input-field" aria-label="To (Kyiv day)" value={to} max={today} onChange={(e) => setTo(e.target.value)} style={{ width: 150 }} />
              <button type="button" className="btn-secondary" disabled={!!rangeError} onClick={() => setSearch({ from, to, range: undefined })}>Apply</button>
              {rangeError && <span className="text-micro" style={{ color: 'var(--color-warning)' }}>{rangeError}</span>}
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 170px), 1fr))', gap: 8, alignItems: 'center' }}>
          <select className="input-field" aria-label="Agent" value={search.agent ?? ''} onChange={(e) => setSearch({ agent: e.target.value || undefined })}>
            <option value="">All agents</option>
            <option value="none">No agent (system features)</option>
            {roots.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
          </select>
          <input className="input-field" aria-label="Feature prefix" placeholder="Feature prefix, e.g. editor." value={feature}
            onChange={(e) => setFeature(e.target.value)} onBlur={applyFeature} onKeyDown={(e) => { if (e.key === 'Enter') applyFeature(); }} />
          <select className="input-field" aria-label="Provider" value={search.provider ?? ''} onChange={(e) => setSearch({ provider: (e.target.value || undefined) as SpendSearch['provider'] })}>
            <option value="">All providers</option>
            {SPEND_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <label className="text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-ink-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!search.shadow} onChange={(e) => setSearch({ shadow: e.target.checked || undefined })} />
            Shadow runs only
          </label>
        </div>
        {filtered && (
          <button type="button" className="btn-tiny" style={{ marginTop: 10 }}
            onClick={() => setSearch({ agent: undefined, feature: undefined, provider: undefined, shadow: undefined })}>
            <Icon name="x" size={11} /> Clear filters
          </button>
        )}
      </SectionCard>

      {data.error && !d && <div className="callout-danger" style={{ marginBottom: 12 }}>{describeError(data.error)}</div>}

      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <StatTile icon="spend" label="Spend" value={t ? fmtUsd(t.costUsd) : '—'} delta={d ? `${d.from} – ${d.to}` : undefined} />
        <StatTile icon="analytics" label="Calls" value={t ? t.calls.toLocaleString('en-US') : '—'}
          delta={t ? `${t.errors.toLocaleString('en-US')} errors` : undefined} deltaTone={t?.errors ? 'danger' : 'neutral'} />
        <StatTile icon="database" label="Tokens in / out" value={t ? `${fmtTokens(t.tokensIn)} / ${fmtTokens(t.tokensOut)}` : '—'}
          delta={t ? `${fmtTokens(t.tokensCached)} cached` : undefined} />
        <StatTile icon="info" label="Estimated" value={t ? fmtUsd(t.estimatedUsd) : '—'}
          delta={t ? `${t.unpricedCalls} unpriced call${t.unpricedCalls === 1 ? '' : 's'}` : undefined} deltaTone={t?.unpricedCalls ? 'warning' : 'neutral'} />
        <StatTile icon="eye" label="Shadow spend" value={t ? fmtUsd(t.shadowUsd) : '—'} delta="included in the total" />
      </div>

      {d && (d.partial || d.truncated || (t?.noUsageCalls ?? 0) > 0) && (
        <div className="callout-warning" style={{ marginBottom: 12 }}>
          {d.partial && <div>Raw rows are kept {d.retentionDays} days; this view reads raw rows, so days before that are missing.</div>}
          {d.truncated && <div>Showing the top 500 rows; export the CSV for all of them.</div>}
          {(t?.noUsageCalls ?? 0) > 0 && <div>{t!.noUsageCalls} call{t!.noUsageCalls === 1 ? '' : 's'} without usage (the provider returned no token counts).</div>}
        </div>
      )}

      <SectionCard icon="analytics" title="Daily spend"
        action={<SegmentedTabs size="sm" value={q.stackBy!} onChange={(v) => setSearch({ stackBy: v === 'provider' ? undefined : v })}
          options={[{ key: 'provider', label: 'By provider' }, { key: 'feature', label: 'By feature' }]} />}
        style={{ marginBottom: 12 }}>
        {!d
          ? <div aria-busy style={{ height: 240, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', opacity: 0.6 }} />
          : d.totals.calls === 0
            ? <EmptyState icon="spend" title="No AI calls in this range" note={filtered ? 'Try clearing the filters.' : 'Calls appear here within 5 minutes of being made.'} />
            : <SpendChart chart={d.chart} />}
      </SectionCard>

      <SectionCard icon="logs" title="Breakdown"
        action={
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button type="button" className="btn-tiny" disabled={!!busy} onClick={() => exportCsv(groupBy)} title="The rows below as CSV (same columns)">
              <Icon name="download" size={12} /> {busy === groupBy ? 'Exporting…' : 'Export CSV'}
            </button>
            <button type="button" className="btn-tiny" disabled={!!busy} onClick={() => exportCsv('raw')} title="Every ledger row in the range (no prompts or outputs)">
              <Icon name="download" size={12} /> {busy === 'raw' ? 'Exporting…' : 'Raw rows'}
            </button>
          </div>
        }>
        <div style={{ maxWidth: '100%', overflowX: 'auto', marginBottom: 10 }}>
          <SegmentedTabs size="sm" value={groupBy} onChange={(v) => { setOpen(new Set()); setSearch({ groupBy: v === 'day' ? undefined : v }); }} options={GROUP_TABS} />
        </div>
        {!d
          ? <div aria-busy style={{ height: 160, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', opacity: 0.6 }} />
          : d.rows.length === 0
            ? <EmptyState icon="logs" title="Nothing to break down" />
            : (
              <div className="table-wrap" style={{ opacity: data.isPlaceholderData ? 0.6 : 1 }}>
                <table className="table">
                  <thead><tr>
                    <th>{GROUP_HEAD[groupBy]}</th>
                    <th className="num">Calls</th><th className="num">Errors</th>
                    <th className="num">Tokens in</th><th className="num">Out</th><th className="num">Cached</th>
                    <th className="num">USD</th><th className="num">% of total</th><th className="num">Avg latency</th>
                    <th>Cost</th><th style={{ width: 44 }} />
                  </tr></thead>
                  <tbody>
                    {d.rows.map((r) => {
                      const expandable = groupBy === 'agent' && !!r.key;
                      const isOpen = open.has(r.key);
                      return (
                        <Fragment key={r.key || '(none)'}>
                          <tr>
                            <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.key || r.label}>
                              {r.runId
                                ? <Link to="/app/editor/run/$id" params={{ id: r.runId }} className="link-accent">{r.runId.slice(0, 8)}</Link>
                                : groupBy === 'agent' && r.label.startsWith('@')
                                  ? <Link to="/app/agents/$handle" params={{ handle: r.label.slice(1) }} className="link-accent">{r.label}</Link>
                                  : <span style={{ color: r.key ? 'var(--color-ink)' : 'var(--color-ink-dim)' }}>{r.label}</span>}
                            </td>
                            <RowCells r={r} />
                            <td style={{ textAlign: 'right' }}>
                              {expandable && (
                                <TableAction icon={isOpen ? 'chevron-up' : 'chevron-down'} title={isOpen ? 'Hide roles' : 'Show roles'} onClick={() => toggle(r.key)} />
                              )}
                            </td>
                          </tr>
                          {expandable && isOpen && <AgentRoles q={q} agentId={r.key} />}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '10px 0 0' }}>
          Days are Europe/Kyiv. {d?.source === 'rollup' ? 'Read from the daily rollup (today is at most 5 minutes behind).' : 'Read from the raw ledger.'}
          {' '}Totals are our own ledger; a provider invoice can differ (e.g. requests that timed out on our side but were billed).
          {ledger.data && ledger.data.callsBeforeLedger > 0 && <> {ledger.data.callsBeforeLedger.toLocaleString('en-US')} older AI calls predate the ledger and carry no tokens or cost.</>}
        </p>
      </SectionCard>
    </>
  );
}
