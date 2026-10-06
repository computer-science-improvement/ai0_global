// Budgets tab of the Spend page (spec 029 FR-008/FR-010): every llm_budgets cap
// with today's spend and state, what is blocking right now, per-agent caps, and
// add/edit/delete with a confirm dialog. Edits apply without a restart.

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { SectionCard, EmptyState, Field } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { ActionsTh, RowActions, TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { Modal } from '../Modal';
import {
  SPEND_PROVIDERS, useBudgets, useDeleteBudget, useSaveBudget,
  type BudgetInput, type BudgetScopeKind, type BudgetStatus,
} from '../../api/spend';
import { barPct, budgetBadge, budgetBarColor, fmtUsd, parseUsd } from '../../lib/spend';

const KINDS: Array<{ key: BudgetScopeKind; label: string; hint: string }> = [
  { key: 'global',         label: 'Total (all AI calls)', hint: 'one per deployment' },
  { key: 'feature_prefix', label: 'Feature prefix',       hint: 'e.g. editor. or strategy.recipes' },
  { key: 'provider',       label: 'Provider',             hint: SPEND_PROVIDERS.join(', ') },
  { key: 'resource',       label: 'Resource',             hint: '* = each resource, or telegram:@channel' },
];

interface Draft { id?: number; scopeKind: BudgetScopeKind; scopeKey: string; daily: string; monthly: string; alertPct: string; enforce: boolean; builtIn: boolean }

const fromRow = (b: BudgetStatus): Draft => ({
  id: b.id, scopeKind: b.scopeKind, scopeKey: b.scopeKey, daily: b.dailyUsd == null ? '' : String(b.dailyUsd),
  monthly: b.monthlyUsd == null ? '' : String(b.monthlyUsd), alertPct: String(b.alertPct), enforce: b.enforce, builtIn: !!b.seededFrom,
});
const EMPTY: Draft = { scopeKind: 'feature_prefix', scopeKey: '', daily: '', monthly: '', alertPct: '80', enforce: true, builtIn: false };

function toInput(d: Draft): BudgetInput | string {
  const daily = parseUsd(d.daily);
  const monthly = parseUsd(d.monthly);
  const alertPct = Number(d.alertPct);
  if ((daily != null && Number.isNaN(daily)) || (monthly != null && Number.isNaN(monthly))) return 'Caps are non-negative numbers';
  if (daily == null && monthly == null) return 'Set a daily or a monthly cap';
  if (!Number.isInteger(alertPct) || alertPct < 1 || alertPct > 100) return 'Alert at is a whole percent from 1 to 100';
  const scopeKey = d.scopeKind === 'global' ? '' : d.scopeKey.trim();
  if (d.scopeKind !== 'global' && !scopeKey) return 'Enter the scope';
  return { ...(d.id != null ? { id: d.id } : {}), scopeKind: d.scopeKind, scopeKey, dailyUsd: daily, monthlyUsd: monthly, alertPct, enforce: d.enforce };
}

function Bar({ b }: { b: BudgetStatus }) {
  return (
    <div role="meter" aria-label={`${b.label} today`} aria-valuemin={0} aria-valuemax={b.dailyUsd ?? 0} aria-valuenow={b.spentTodayUsd}
      style={{ height: 6, borderRadius: 3, background: 'var(--color-surface-3)', overflow: 'hidden', minWidth: 80 }}>
      <div style={{ height: '100%', width: `${barPct(b.spentTodayUsd, b.dailyUsd)}%`, background: budgetBarColor(b.state), borderRadius: 3 }} />
    </div>
  );
}

function BudgetModal({ initial, before, onClose }: { initial: Draft; before: BudgetStatus | null; onClose: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const save = useSaveBudget();
  const confirm = useConfirm();
  const kind = KINDS.find((k) => k.key === d.scopeKind)!;
  const submit = async () => {
    const body = toInput(d);
    if (typeof body === 'string') { toast.error(body); return; }
    const money = (v: number | null | undefined) => (v == null ? 'none' : fmtUsd(v));
    const ok = await confirm(before ? `change the cap "${before.label}"` : 'add this cap', {
      danger: false, confirmLabel: 'Save cap',
      details: (
        <div className="text-micro" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.7 }}>
          {before && <div>Before: daily {money(before.dailyUsd)} · monthly {money(before.monthlyUsd)} · alert at {before.alertPct}% · {before.enforce ? 'blocks calls' : 'alert only'}</div>}
          <div style={{ color: 'var(--color-ink)' }}>After: daily {money(body.dailyUsd)} · monthly {money(body.monthlyUsd)} · alert at {body.alertPct}% · {body.enforce ? 'blocks calls' : 'alert only'}</div>
          <div style={{ marginTop: 6 }}>Takes effect within seconds, no restart. {body.enforce ? 'Calls over the daily cap are refused until Kyiv midnight.' : 'Over the cap you only get an alert.'}</div>
        </div>
      ),
    });
    if (!ok) return;
    save.mutate(body, { onSuccess: () => { toast.success('Cap saved'); onClose(); } });
  };
  return (
    <Modal open onClose={onClose} title={before ? 'Edit cap' : 'Add cap'} subtitle="Daily caps block calls unless set to alert only" icon="spend">
      <Field label="Scope" hint={d.builtIn ? 'built-in cap: the scope is fixed' : kind.hint}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="input-field" value={d.scopeKind} disabled={d.builtIn} onChange={(e) => setD((x) => ({ ...x, scopeKind: e.target.value as BudgetScopeKind }))} style={{ flex: '1 1 160px' }}>
            {KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
          {d.scopeKind !== 'global' && (
            d.scopeKind === 'provider'
              ? <select className="input-field" value={d.scopeKey} disabled={d.builtIn} onChange={(e) => setD((x) => ({ ...x, scopeKey: e.target.value }))} style={{ flex: '1 1 160px' }}>
                  <option value="">Pick a provider</option>
                  {SPEND_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              : <input className="input-field" value={d.scopeKey} disabled={d.builtIn} onChange={(e) => setD((x) => ({ ...x, scopeKey: e.target.value }))}
                  placeholder={d.scopeKind === 'resource' ? 'telegram:@channel or *' : 'strategy.'} style={{ flex: '1 1 160px' }} />
          )}
        </div>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: '0 12px' }}>
        <Field label="Daily cap, USD"><input className="input-field" inputMode="decimal" value={d.daily} onChange={(e) => setD((x) => ({ ...x, daily: e.target.value }))} style={{ width: '100%' }} /></Field>
        <Field label="Monthly cap, USD" hint="tracked, not blocking"><input className="input-field" inputMode="decimal" value={d.monthly} onChange={(e) => setD((x) => ({ ...x, monthly: e.target.value }))} style={{ width: '100%' }} /></Field>
        <Field label="Alert at, %"><input className="input-field" inputMode="numeric" value={d.alertPct} onChange={(e) => setD((x) => ({ ...x, alertPct: e.target.value }))} style={{ width: '100%' }} /></Field>
      </div>
      <label className="text-body-sm" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer' }}>
        <input type="checkbox" checked={d.enforce} onChange={(e) => setD((x) => ({ ...x, enforce: e.target.checked }))} />
        Block calls over the daily cap (off = alert only)
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

export function BudgetsTab() {
  const q = useBudgets();
  const del = useDeleteBudget();
  const save = useSaveBudget();
  const confirm = useConfirm();
  const [modal, setModal] = useState<{ initial: Draft; before: BudgetStatus | null } | null>(null);

  const remove = async (b: BudgetStatus) => {
    if (!(await confirm(`delete the cap "${b.label}"`))) return;
    del.mutate(b.id, { onSuccess: () => toast.success('Cap deleted') });
  };
  const toggleEnforce = async (b: BudgetStatus) => {
    const next = !b.enforce;
    const ok = await confirm(next ? `make "${b.label}" block calls over the cap` : `make "${b.label}" alert only`, {
      danger: !next, confirmLabel: next ? 'Block over cap' : 'Alert only',
    });
    if (!ok) return;
    save.mutate({ id: b.id, scopeKind: b.scopeKind, scopeKey: b.scopeKey, dailyUsd: b.dailyUsd, monthlyUsd: b.monthlyUsd, alertPct: b.alertPct, enforce: next },
      { onSuccess: () => toast.success(next ? 'The cap now blocks calls' : 'The cap is alert only') });
  };

  const d = q.data;
  return (
    <>
      {d && d.blocking.length > 0 && (
        <div className="callout-danger" style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, marginBottom: 6 }}>
            <Icon name="ban" size={14} /> Blocking AI calls now (until Kyiv midnight or a higher cap)
          </div>
          {d.blocking.map((b) => (
            <div key={`${b.kind}:${b.id}`} className="text-micro tabular-nums">
              {b.label}: {fmtUsd(b.spentUsd)} of {fmtUsd(b.capUsd)}
            </div>
          ))}
        </div>
      )}

      <SectionCard icon="spend" title="Caps"
        action={<button type="button" className="btn-primary" onClick={() => setModal({ initial: EMPTY, before: null })}><Icon name="plus" size={13} /> Add cap</button>}
        style={{ marginBottom: 12 }}>
        {q.error && !d && <div className="callout-danger">{describeError(q.error)}</div>}
        {!d && !q.error && <div aria-busy style={{ height: 160, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', opacity: 0.6 }} />}
        {d && d.rows.length === 0 && <EmptyState icon="spend" title="No caps" note="The built-in caps are created when the automation service starts." />}
        {d && d.rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th>Scope</th><th className="num">Spent today</th><th className="num">Daily cap</th><th style={{ minWidth: 100 }}>Today</th>
                <th className="num">This month</th><th className="num">Monthly cap</th><th className="num">Alert at</th><th>State</th><ActionsTh />
              </tr></thead>
              <tbody>
                {d.rows.map((b) => {
                  const badge = budgetBadge(b.state, b.enforce);
                  return (
                    <tr key={b.id}>
                      <td>
                        <div style={{ color: 'var(--color-ink)' }}>{b.label}</div>
                        <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                          {b.scopeKind}{b.scopeKey ? ` · ${b.scopeKey}` : ''}{b.seededFrom ? ` · built-in (${b.seededFrom})` : ''}
                        </div>
                        {b.resources && b.resources.length > 0 && (
                          <div className="text-micro" style={{ color: 'var(--color-danger)', marginTop: 2 }}>
                            {b.resources.map((r) => `${r.ref} ${fmtUsd(r.spentUsd)}`).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td className="num" title={b.scopeKind === 'resource' && b.scopeKey === '*' ? 'The resource that spent most today' : undefined}>{fmtUsd(b.spentTodayUsd)}</td>
                      <td className="num">{b.dailyUsd == null ? '—' : fmtUsd(b.dailyUsd)}</td>
                      <td><Bar b={b} /></td>
                      <td className="num">{b.scopeKind === 'resource' && b.scopeKey === '*' ? '—' : fmtUsd(b.spentMonthUsd)}</td>
                      <td className="num">{b.monthlyUsd == null ? '—' : fmtUsd(b.monthlyUsd)}</td>
                      <td className="num">{b.alertPct}%</td>
                      <td>{badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : <Badge tone="success">OK</Badge>}</td>
                      <td style={{ textAlign: 'right' }}>
                        <RowActions danger={b.seededFrom ? undefined : <TableAction action="delete" onClick={() => remove(b)} />}>
                          <TableAction action="edit" onClick={() => setModal({ initial: fromRow(b), before: b })} />
                          <TableAction icon={b.enforce ? 'unlock' : 'lock'} title={b.enforce ? 'Make alert only' : 'Block over cap'} onClick={() => toggleEnforce(b)} />
                        </RowActions>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '10px 0 0' }}>
          Daily caps reset at Kyiv midnight. Monthly caps are tracked here but do not block calls. Built-in caps can be edited or made alert only, not deleted.
        </p>
      </SectionCard>

      {d && d.agentCaps.length > 0 && (
        <SectionCard icon="agents" title="Per-agent caps">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Agent</th><th className="num">Spent today</th><th className="num">Daily cap</th><th style={{ minWidth: 100 }}>Today</th><th>State</th></tr></thead>
              <tbody>
                {d.agentCaps.map((a) => {
                  const badge = budgetBadge(a.state, true);
                  return (
                    <tr key={a.agentId}>
                      <td><Link to="/app/agents/$handle" params={{ handle: a.handle }} className="link-accent">@{a.handle}</Link></td>
                      <td className="num">{fmtUsd(a.spentUsd)}</td>
                      <td className="num">{fmtUsd(a.capUsd)}</td>
                      <td>
                        <div style={{ height: 6, borderRadius: 3, background: 'var(--color-surface-3)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${barPct(a.spentUsd, a.capUsd)}%`, background: budgetBarColor(a.state), borderRadius: 3 }} />
                        </div>
                      </td>
                      <td>{badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : <Badge tone="success">OK</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '10px 0 0' }}>Per-agent caps always block; change them on the agent's page.</p>
        </SectionCard>
      )}

      {modal && <BudgetModal initial={modal.initial} before={modal.before} onClose={() => setModal(null)} />}
    </>
  );
}
