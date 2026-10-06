// Prices tab of the Spend page (spec 029 FR-005/FR-010): the llm_prices table,
// add/edit/delete with a confirm dialog, models billed as unpriced, and the owner
// action "Reprice estimates for the last N days".

import { useState } from 'react';
import { SectionCard, EmptyState, Field } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { ActionsTh, RowActions, TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { Modal } from '../Modal';
import {
  useDeletePrice, usePrices, useReprice, useSavePrice, type PriceInput, type PriceRow, type SpendProvider,
} from '../../api/spend';
import { fmtUsd, kyivToday, parseUsd } from '../../lib/spend';

const PRICED: SpendProvider[] = ['openrouter', 'anthropic', 'openai', 'perplexity', 'xai', 'agent_sdk'];

interface Draft {
  provider: SpendProvider; model: string; inPerM: string; outPerM: string; cachedReadPerM: string; cachedWritePerM: string;
  perRequestUsd: string; effectiveFrom: string; note: string;
}

const s = (n: number | null | undefined) => (n == null ? '' : String(n));
const perM = (n: number | null) => (n == null ? '—' : `$${n}`);

function toDraft(p: Partial<PriceRow> & { provider?: string; model?: string }, today: string): Draft {
  return {
    provider: (PRICED as string[]).includes(p.provider ?? '') ? (p.provider as SpendProvider) : 'openrouter', model: p.model ?? '',
    inPerM: s(p.inPerM), outPerM: s(p.outPerM), cachedReadPerM: s(p.cachedReadPerM), cachedWritePerM: s(p.cachedWritePerM),
    perRequestUsd: s(p.perRequestUsd), effectiveFrom: p.effectiveFrom ?? today, note: p.note ?? '',
  };
}

/** Draft → API body, or an error message. */
function toInput(d: Draft): PriceInput | string {
  const req = { inPerM: parseUsd(d.inPerM), outPerM: parseUsd(d.outPerM) };
  const opt = { cachedReadPerM: parseUsd(d.cachedReadPerM), cachedWritePerM: parseUsd(d.cachedWritePerM), perRequestUsd: parseUsd(d.perRequestUsd) };
  if (!d.model.trim()) return 'Enter the model id';
  if (req.inPerM == null || req.outPerM == null) return 'Input and output prices are required';
  if ([...Object.values(req), ...Object.values(opt)].some((v) => v != null && Number.isNaN(v))) return 'Prices are non-negative numbers';
  return { provider: d.provider, model: d.model.trim(), inPerM: req.inPerM, outPerM: req.outPerM, ...opt, effectiveFrom: d.effectiveFrom, note: d.note.trim() || null };
}

function PriceModal({ initial, editing, onClose }: { initial: Draft; editing: PriceRow | null; onClose: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const save = useSavePrice();
  const confirm = useConfirm();
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  const submit = async () => {
    const body = toInput(d);
    if (typeof body === 'string') { toast.error(body); return; }
    const sameRow = editing && editing.provider === body.provider && editing.model === body.model && editing.effectiveFrom === body.effectiveFrom;
    const ok = await confirm(sameRow ? `overwrite the price of ${body.model} from ${body.effectiveFrom}` : `add a price for ${body.model} from ${body.effectiveFrom}`, {
      danger: false, confirmLabel: 'Save price',
      details: (
        <div className="text-micro" style={{ color: 'var(--color-ink-muted)', lineHeight: 1.7 }}>
          {editing && <div>Before: in {perM(editing.inPerM)} · out {perM(editing.outPerM)} · cache read {perM(editing.cachedReadPerM)} · cache write {perM(editing.cachedWritePerM)} per 1M</div>}
          <div style={{ color: 'var(--color-ink)' }}>After: in ${body.inPerM} · out ${body.outPerM} · cache read {perM(body.cachedReadPerM ?? null)} · cache write {perM(body.cachedWritePerM ?? null)} per 1M{body.perRequestUsd ? ` · $${body.perRequestUsd} per request` : ''}</div>
          <div style={{ marginTop: 6 }}>New calls use it at once. Past rows keep their cost until you run "Reprice estimates".</div>
        </div>
      ),
    });
    if (!ok) return;
    save.mutate(body, { onSuccess: () => { toast.success(`Price saved for ${body.model}`); onClose(); } });
  };
  return (
    <Modal open onClose={onClose} title={editing ? 'Edit price' : 'Add price'} subtitle="USD per 1M tokens; a new start day keeps the old price for earlier calls" icon="spend" size="lg">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '0 12px' }}>
        <Field label="Provider">
          <select className="input-field" value={d.provider} onChange={set('provider')} style={{ width: '100%' }}>
            {PRICED.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="Model" hint="date suffixes are ignored">
          <input className="input-field" value={d.model} onChange={set('model')} placeholder="claude-haiku-4-5" style={{ width: '100%' }} />
        </Field>
        <Field label="Input / 1M"><input className="input-field" inputMode="decimal" value={d.inPerM} onChange={set('inPerM')} style={{ width: '100%' }} /></Field>
        <Field label="Output / 1M"><input className="input-field" inputMode="decimal" value={d.outPerM} onChange={set('outPerM')} style={{ width: '100%' }} /></Field>
        <Field label="Cache read / 1M" hint="empty = input price"><input className="input-field" inputMode="decimal" value={d.cachedReadPerM} onChange={set('cachedReadPerM')} style={{ width: '100%' }} /></Field>
        <Field label="Cache write / 1M" hint="empty = input price"><input className="input-field" inputMode="decimal" value={d.cachedWritePerM} onChange={set('cachedWritePerM')} style={{ width: '100%' }} /></Field>
        <Field label="Per request" hint="e.g. Perplexity"><input className="input-field" inputMode="decimal" value={d.perRequestUsd} onChange={set('perRequestUsd')} style={{ width: '100%' }} /></Field>
        <Field label="Effective from" hint="Kyiv day"><input type="date" className="input-field" value={d.effectiveFrom} onChange={set('effectiveFrom')} style={{ width: '100%' }} /></Field>
      </div>
      <Field label="Note"><input className="input-field" value={d.note} onChange={set('note')} maxLength={200} placeholder="Source of the price" style={{ width: '100%' }} /></Field>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

function RepricePanel({ maxDays }: { maxDays: number }) {
  const [days, setDays] = useState('7');
  const reprice = useReprice();
  const confirm = useConfirm();
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= maxDays;
  const run = async () => {
    const ok = await confirm(`reprice estimated and unpriced calls of the last ${n} day${n === 1 ? '' : 's'}`, {
      danger: false, confirmLabel: 'Reprice',
      details: <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>Only rows costed from the price table (estimate) or without a price (unpriced) change. Provider-billed and backfilled rows keep their cost. The daily rollup of those days is rebuilt.</p>,
    });
    if (!ok) return;
    reprice.mutate(n, {
      onSuccess: (r) => toast.success(`Repriced ${r.repriced} of ${r.scanned} rows (${r.deltaUsd >= 0 ? '+' : '−'}${fmtUsd(Math.abs(r.deltaUsd))})${r.stillUnpriced ? `; ${r.stillUnpriced} still unpriced` : ''}`),
    });
  };
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>Reprice estimates for the last</span>
      <input className="input-field" inputMode="numeric" aria-label="Days" value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 64 }} />
      <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>days (max {maxDays})</span>
      <button type="button" className="btn-secondary" disabled={!valid || reprice.isPending} onClick={run}>
        <Icon name="refresh" size={13} /> {reprice.isPending ? 'Repricing…' : 'Reprice'}
      </button>
    </div>
  );
}

export function PricesTab() {
  const q = usePrices();
  const del = useDeletePrice();
  const confirm = useConfirm();
  const today = kyivToday();
  const [modal, setModal] = useState<{ initial: Draft; editing: PriceRow | null } | null>(null);

  const remove = async (p: PriceRow) => {
    if (!(await confirm(`delete the price of ${p.provider}/${p.model} from ${p.effectiveFrom}`))) return;
    del.mutate(p, { onSuccess: () => toast.success('Price deleted') });
  };

  return (
    <>
      {q.data && q.data.unpriced.length > 0 && (
        <div className="callout-warning" style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 6 }}>These models were called without a price in the last 30 days, so their cost is unknown:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {q.data.unpriced.map((u) => (
              <button key={`${u.provider}/${u.model}`} type="button" className="btn-tiny" title={`${u.calls} calls · add a price`}
                onClick={() => setModal({ initial: toDraft({ provider: u.provider as SpendProvider, model: u.model }, today), editing: null })}>
                <Icon name="plus" size={11} /> {u.provider}/{u.model} · {u.calls}
              </button>
            ))}
          </div>
        </div>
      )}

      <SectionCard icon="spend" title="Price table"
        action={<button type="button" className="btn-primary" onClick={() => setModal({ initial: toDraft({}, today), editing: null })}><Icon name="plus" size={13} /> Add price</button>}
        style={{ marginBottom: 12 }}>
        {q.error && !q.data && <div className="callout-danger">{describeError(q.error)}</div>}
        {!q.data && !q.error && <div aria-busy style={{ height: 160, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', opacity: 0.6 }} />}
        {q.data && q.data.rows.length === 0 && <EmptyState icon="spend" title="No prices yet" note="Without a price, calls are recorded as unpriced (tokens are still counted)." />}
        {q.data && q.data.rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th>Provider</th><th>Model</th>
                <th className="num">In / 1M</th><th className="num">Out / 1M</th><th className="num">Cache read</th><th className="num">Cache write</th>
                <th className="num">Per request</th><th>From</th><th>Status</th><th>Note</th><ActionsTh />
              </tr></thead>
              <tbody>
                {q.data.rows.map((p) => (
                  <tr key={`${p.provider}/${p.model}/${p.effectiveFrom}`} style={{ opacity: p.current || p.scheduled ? 1 : 0.6 }}>
                    <td>{p.provider}</td>
                    <td style={{ color: 'var(--color-ink)' }}>{p.model}</td>
                    <td className="num">${p.inPerM}</td>
                    <td className="num">${p.outPerM}</td>
                    <td className="num">{perM(p.cachedReadPerM)}</td>
                    <td className="num">{perM(p.cachedWritePerM)}</td>
                    <td className="num">{p.perRequestUsd == null ? '—' : `$${p.perRequestUsd}`}</td>
                    <td className="tabular-nums">{p.effectiveFrom}</td>
                    <td>{p.current ? <Badge tone="success">Current</Badge> : p.scheduled ? <Badge tone="warning">Scheduled</Badge> : <Badge tone="neutral">Superseded</Badge>}</td>
                    <td className="text-micro" style={{ color: 'var(--color-ink-dim)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.note ?? ''}>{p.note ?? ''}</td>
                    <td style={{ textAlign: 'right' }}>
                      <RowActions danger={<TableAction action="delete" onClick={() => remove(p)} />}>
                        <TableAction action="edit" onClick={() => setModal({ initial: toDraft(p, today), editing: p })} />
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '10px 0 0' }}>
          Seed prices were not fetched from the providers — check them against the provider pricing pages.
        </p>
      </SectionCard>

      <SectionCard icon="refresh" title="Reprice estimates">
        <p className="text-micro" style={{ color: 'var(--color-ink-muted)', margin: '0 0 10px' }}>
          Historical rows are never repriced on their own. After fixing a price, re-cost the calls that were estimated or unpriced.
        </p>
        <RepricePanel maxDays={q.data?.repriceMaxDays ?? 88} />
      </SectionCard>

      {modal && <PriceModal initial={modal.initial} editing={modal.editing} onClose={() => setModal(null)} />}
    </>
  );
}
