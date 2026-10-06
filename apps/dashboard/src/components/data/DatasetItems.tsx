// Items browser (spec 032 FR-007): full-text search, filters built from the dataset's filterable fields,
// a card per row rendered through the roles (title, body, image, category, date), and hide / unhide.

import { useState } from 'react';
import { SegmentedTabs } from '../SegmentedTabs';
import { Pagination } from '../Pagination';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/primitives';
import { TableAction } from '../ui/table';
import { describeError, toast } from '../ui/Toast';
import { fmtDate } from '../../lib/format';
import {
  buildFilter, cellText, filterLabel, fmtInt, OP_LABEL, opsForField, VALUELESS,
  type DataFilter, type FilterOp,
} from '../../lib/data-store';
import { useDataItems, useSetItemStatus, type DataItem, type DataSchema } from '../../api/data';

const PAGE_SIZE = 24;
type StatusTab = 'active' | 'hidden' | 'all';

export function DatasetItems({ schema }: { schema: DataSchema }) {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusTab>('active');
  const [filters, setFilters] = useState<DataFilter[]>([]);
  const [page, setPage] = useState(1);
  const items = useDataItems(schema.key, { q, filters, status, page, pageSize: PAGE_SIZE });
  const setItem = useSetItemStatus(schema.key);

  const apply = (f: DataFilter[]) => { setFilters(f); setPage(1); };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <form onSubmit={(e) => { e.preventDefault(); setQ(search); setPage(1); }} style={{ display: 'flex', gap: 6, flex: '1 1 240px', minWidth: 0 }}>
          <input className="input-field" style={{ flex: 1, minWidth: 0 }} placeholder="Search titles and texts" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="submit" className="btn-secondary" aria-label="Search"><Icon name="discovery" size={14} /></button>
        </form>
        <SegmentedTabs<StatusTab> size="sm" value={status} onChange={(s) => { setStatus(s); setPage(1); }}
          options={[{ key: 'active', label: 'Active' }, { key: 'hidden', label: 'Hidden' }, { key: 'all', label: 'All' }]} />
      </div>

      <FilterBar schema={schema} filters={filters} onChange={apply} />

      {items.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{describeError(items.error)}</p>}
      {items.isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading rows…</p>}
      {items.data && items.data.items.length === 0 && (
        <EmptyState icon="database" title={q || filters.length ? 'No rows match' : status === 'hidden' ? 'No hidden rows' : 'No rows yet'}
          note={q || filters.length ? 'Try fewer filters or another search.' : 'Import a file to add rows.'} />
      )}
      {items.data && items.data.items.length > 0 && (
        <>
          <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '0 0 8px' }}>{fmtInt(items.data.total)} rows</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 10, opacity: items.isFetching ? 0.7 : 1 }}>
            {items.data.items.map((it, i) => (
              <ItemCard key={it.id} item={it} index={i} schema={schema} busy={setItem.isPending}
                onToggle={() => setItem.mutate({ id: it.id, status: it.status === 'active' ? 'hidden' : 'active' }, {
                  onSuccess: (r) => toast.success(r.status === 'hidden' ? 'Hidden from agents and strategies' : 'Visible again'),
                  onError: (e) => toast.error(describeError(e)),
                })} />
            ))}
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={items.data.total} onPage={setPage} />
        </>
      )}
    </div>
  );
}

function ItemCard({ item, index, schema, onToggle, busy }: { item: DataItem; index: number; schema: DataSchema; onToggle: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const date = item.event_date ?? (item.event_month && item.event_day ? `${String(item.event_day).padStart(2, '0')}.${String(item.event_month).padStart(2, '0')}` : null);
  return (
    <div className="card compose-rise" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, animationDelay: `${Math.min(index, 12) * 25}ms`, opacity: item.status === 'hidden' ? 0.6 : 1 }}>
      {item.image_url && (
        <img src={item.image_url} alt="" loading="lazy" style={{ width: '100%', height: 140, objectFit: 'cover', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-3)' }} />
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {item.status === 'hidden' && <Badge tone="warning">Hidden</Badge>}
        {item.posted_count > 0 && <Badge tone="success" title="Posted markers from strategies">Posted {item.posted_count}×</Badge>}
        {item.category && <span className="chip">{item.category}</span>}
        {date && <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{date}</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <TableAction icon="info" title={open ? 'Hide fields' : 'Show all fields'} onClick={() => setOpen(!open)} />
          <TableAction icon={item.status === 'active' ? 'ban' : 'eye'} title={item.status === 'active' ? 'Hide' : 'Unhide'} disabled={busy} onClick={onToggle} />
        </span>
      </div>
      <div className="text-body-sm" style={{ fontWeight: 600, color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>
        {item.title ?? <em style={{ color: 'var(--color-ink-dim)' }}>no title</em>}
      </div>
      {item.body && <div className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>{item.body}</div>}
      {item.url && <a href={item.url} target="_blank" rel="noreferrer noopener" className="link-accent text-micro" style={{ overflowWrap: 'anywhere' }}>{item.url}</a>}
      {open && (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'minmax(80px, 120px) 1fr', gap: '4px 10px', borderTop: '1px solid var(--color-hairline-soft)', paddingTop: 8 }}>
          {schema.fields.map((f) => (
            <FieldRow key={f.name} name={f.name} value={item.data[f.name]} muted={f.deprecated || f.agent_visible === false} />
          ))}
          <FieldRow name="ref" value={item.ref} />
          {item.legacy_ref && <FieldRow name="legacy ref" value={item.legacy_ref} />}
          <FieldRow name="added" value={fmtDate(item.created_at)} />
        </dl>
      )}
    </div>
  );
}

function FieldRow({ name, value, muted }: { name: string; value: unknown; muted?: boolean }) {
  return (
    <>
      <dt className="text-micro" style={{ color: muted ? 'var(--color-ink-dim)' : 'var(--color-ink-muted)', fontFamily: 'var(--font-mono, monospace)', overflowWrap: 'anywhere' }}>{name}</dt>
      <dd className="text-micro" style={{ margin: 0, color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{cellText(value, 400)}</dd>
    </>
  );
}

function FilterBar({ schema, filters, onChange }: { schema: DataSchema; filters: DataFilter[]; onChange: (f: DataFilter[]) => void }) {
  const filterable = schema.fields.filter((f) => f.filterable && !f.deprecated);
  const [fieldName, setFieldName] = useState('');
  const field = filterable.find((f) => f.name === fieldName) ?? filterable[0];
  const ops = field ? opsForField(field, schema.roles) : [];
  const [op, setOp] = useState<FilterOp>('eq');
  const curOp: FilterOp = ops.includes(op) ? op : ops[0] ?? 'eq';
  const [v1, setV1] = useState('');
  const [v2, setV2] = useState('');

  if (!filterable.length) {
    return <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '0 0 12px' }}>No filterable fields — mark fields as filterable on the Schema tab.</p>;
  }

  function add() {
    if (!field) return;
    const r = buildFilter(field, curOp, v1, v2);
    if ('error' in r) { toast.error(r.error); return; }
    onChange([...filters, r]);
    setV1(''); setV2('');
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <form onSubmit={(e) => { e.preventDefault(); add(); }} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="input-field" aria-label="Filter field" value={field?.name ?? ''} onChange={(e) => setFieldName(e.target.value)}>
          {filterable.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
        </select>
        <select className="input-field" aria-label="Filter operator" value={curOp} onChange={(e) => setOp(e.target.value as FilterOp)}>
          {ops.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
        </select>
        {curOp === 'is_null' && (
          <select className="input-field" aria-label="Empty or not" value={v1 === 'false' ? 'false' : 'true'} onChange={(e) => setV1(e.target.value)}>
            <option value="true">yes</option>
            <option value="false">no (has a value)</option>
          </select>
        )}
        {!VALUELESS.includes(curOp) && field?.type === 'enum' && curOp === 'eq' ? (
          <select className="input-field" aria-label="Filter value" value={v1} onChange={(e) => setV1(e.target.value)}>
            <option value="">— value —</option>
            {(field.enum ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        ) : !VALUELESS.includes(curOp) && (
          <input className="input-field" aria-label="Filter value" style={{ width: 160 }} value={v1} onChange={(e) => setV1(e.target.value)}
            placeholder={curOp === 'in' ? 'a, b, c' : field?.type === 'date' ? 'YYYY-MM-DD' : field?.type === 'month_day' ? 'MM-DD' : curOp === 'between' ? 'from' : 'value'} />
        )}
        {curOp === 'between' && (
          <input className="input-field" aria-label="Filter value to" style={{ width: 120 }} value={v2} onChange={(e) => setV2(e.target.value)} placeholder="to" />
        )}
        <button type="submit" className="btn-secondary"><Icon name="plus" size={13} /> Add filter</button>
      </form>
      {filters.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {filters.map((f, i) => (
            <span key={i} className="chip" style={{ gap: 6 }}>
              {filterLabel(f)}
              <button type="button" className="btn-icon" aria-label={`Remove filter ${filterLabel(f)}`} style={{ width: 18, height: 18 }}
                onClick={() => onChange(filters.filter((_, j) => j !== i))}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          <button type="button" className="btn-ghost text-micro" onClick={() => onChange([])}>Clear</button>
        </div>
      )}
    </div>
  );
}
