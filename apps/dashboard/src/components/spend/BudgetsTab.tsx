// Budgets tab of the Spend page (spec 029 FR-008/FR-010): every llm_budgets cap
// with today's spend and state, what is blocking right now, per-agent caps, and
// add/edit/delete with a confirm dialog. Edits apply without a restart.

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { SectionCard, EmptyState, Field } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { RowActions, TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { Modal } from '../Modal';
import {
  SPEND_PROVIDERS, useBudgets, useDeleteBudget, useSaveBudget,
  type BudgetInput, type BudgetScopeKind, type BudgetStatus,
} from '../../api/spend';
import { barPct, budgetBadge, budgetBarColor, fmtUsd, parseUsd, type BudgetStateLike } from '../../lib/spend';

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

/** Today's spend against the daily cap: "$1.20 / $3.00" over a 6px meter coloured by the cap's state. */
function Meter({ label, spent, cap, state, title }: { label: string; spent: number; cap: number | null; state: BudgetStateLike; title?: string }) {
  return (
    <div className="spend-today" title={title}>
      <div className="spend-today-line">
        <span className="mono tabular-nums" style={{ color: 'var(--color-ink)' }}>{fmtUsd(spent)}</span>
        <span className="mono tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>/ {cap == null ? 'no daily cap' : fmtUsd(cap)}</span>
      </div>
      <div className="spend-bar" role="meter" aria-label={`${label} today`} aria-valuemin={0} aria-valuemax={cap ?? 0} aria-valuenow={spent}>
        <span className="anim-grow-x" style={{ width: `${barPct(spent, cap)}%`, ['--bar' as string]: budgetBarColor(state) }} />
      </div>
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
      <div className="modal-foot">
        <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
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
        <div className="callout-danger" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
          <span style={{ display: 'inline-flex', paddingTop: 2 }}><Icon name="ban" size={16} /></span>
          <div style={{ minWidth: 0 }}>
            <div className="text-heading-md" style={{ marginBottom: 6 }}>Blocking AI calls now (until Kyiv midnight or a higher cap)</div>
            {d.blocking.map((b) => (
              <div key={`${b.kind}:${b.id}`} className="text-micro mono tabular-nums">
                {b.label}: {fmtUsd(b.spentUsd)} of {fmtUsd(b.capUsd)}
              </div>
            ))}
          </div>
        </div>
      )}

      <SectionCard title="Caps" flush delay={0}
        action={<button type="button" className="btn-primary btn-sm" onClick={() => setModal({ initial: EMPTY, before: null })}><Icon name="plus" size={13} /> Add cap</button>}
        style={{ marginBottom: 12 }}>
        {q.error && !d && (
          <div className="spend-pad">
            <div className="callout-danger">
              <Icon name="warning" size={16} />
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{describeError(q.error)}</span>
            </div>
          </div>
        )}
        {!d && !q.error && <div className="spend-pad"><div className="inset" aria-busy style={{ height: 120, opacity: 0.6 }} /></div>}
        {d && d.rows.length === 0 && <EmptyState icon="spend" title="No caps" note="The built-in caps are created when the automation service starts." />}
        {d && d.rows.map((b) => {
          const badge = budgetBadge(b.state, b.enforce);
          const everyResource = b.scopeKind === 'resource' && b.scopeKey === '*';
          return (
            <div key={b.id} className="panel-row">
              <div className="spend-id">
                <div className="text-body-sm" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{b.label}</div>
                <div className="mono text-micro" style={{ color: 'var(--color-ink-dim)', overflowWrap: 'anywhere' }}>
                  {b.scopeKind}{b.scopeKey ? ` · ${b.scopeKey}` : ''}{b.seededFrom ? ` · built-in (${b.seededFrom})` : ''}
                </div>
                {b.resources && b.resources.length > 0 && (
                  <div className="text-micro" style={{ color: 'var(--color-danger)', marginTop: 2, overflowWrap: 'anywhere' }}>
                    {b.resources.map((r) => `${r.ref} ${fmtUsd(r.spentUsd)}`).join(' · ')}
                  </div>
                )}
              </div>
              <Meter label={b.label} spent={b.spentTodayUsd} cap={b.dailyUsd} state={b.state}
                title={everyResource ? 'The resource that spent most today' : undefined} />
              <div className="spend-fact">
                <span className="text-overline">This month</span>
                <span className="mono tabular-nums">
                  {everyResource ? '—' : fmtUsd(b.spentMonthUsd)}
                  {b.monthlyUsd != null && <span style={{ color: 'var(--color-ink-dim)' }}> / {fmtUsd(b.monthlyUsd)}</span>}
                </span>
              </div>
              <div className="spend-fact is-narrow">
                <span className="text-overline">Alert at</span>
                <span className="mono tabular-nums">{b.alertPct}%</span>
              </div>
              <span className="spend-state">{badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : <Badge tone="success">OK</Badge>}</span>
              <RowActions danger={b.seededFrom ? undefined : <TableAction action="delete" onClick={() => remove(b)} />}>
                <TableAction action="edit" onClick={() => setModal({ initial: fromRow(b), before: b })} />
                <TableAction icon={b.enforce ? 'unlock' : 'lock'} title={b.enforce ? 'Make alert only' : 'Block over cap'} onClick={() => toggleEnforce(b)} />
              </RowActions>
            </div>
          );
        })}
        <div className="panel-foot">
          <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
            Daily caps reset at Kyiv midnight. Monthly caps are tracked here but do not block calls. Built-in caps can be edited or made alert only, not deleted.
          </span>
        </div>
      </SectionCard>

      {d && d.agentCaps.length > 0 && (
        <SectionCard title="Per-agent caps" flush delay={40}>
          {d.agentCaps.map((a) => {
            const badge = budgetBadge(a.state, true);
            return (
              <div key={a.agentId} className="panel-row">
                <div className="spend-id">
                  <Link to="/app/agents/$handle" params={{ handle: a.handle }} className="link-accent mono">@{a.handle}</Link>
                </div>
                <Meter label={`@${a.handle}`} spent={a.spentUsd} cap={a.capUsd} state={a.state} />
                <span className="spend-state">{badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : <Badge tone="success">OK</Badge>}</span>
              </div>
            );
          })}
          <div className="panel-foot">
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Per-agent caps always block; change them on the agent's page.</span>
          </div>
        </SectionCard>
      )}

      {modal && <BudgetModal initial={modal.initial} before={modal.before} onClose={() => setModal(null)} />}
    </>
  );
}
