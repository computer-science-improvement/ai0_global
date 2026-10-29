// Items browser (spec 032 FR-007): full-text search, filters built from the dataset's filterable fields,
// a compact card per row rendered through the roles (title, body, image, category, date) that opens all the
// fields, and hide / unhide.

import { useState } from 'react';
import { SegmentedTabs } from '../SegmentedTabs';
import { Pagination } from '../Pagination';
import { SkeletonRows } from '../SkeletonRows';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { EmptyState, SectionCard } from '../ui/primitives';
import { CompactCard } from '../ui/CompactCard';
import { describeError, toast } from '../ui/Toast';
import { fmtDate } from '../../lib/format';
import {
  buildFilter, cellText, filterLabel, fmtInt, OP_LABEL, opsForField, VALUELESS,
  type DataFilter, type FilterOp,
} from '../../lib/data-store';
import { useDataItems, useSetItemStatus, type DataItem, type DataSchema } from '../../api/data';
import './data.css';

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
    <SectionCard title="Rows" delay={60}
      action={items.data ? <span className="mono text-micro dx-dim">{fmtInt(items.data.total)} rows</span> : undefined}>
      <div className="dx-toolbar">
        <form className="dx-search" onSubmit={(e) => { e.preventDefault(); setQ(search); setPage(1); }}>
          <input className="input-field" placeholder="Search titles and texts" aria-label="Search rows" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="submit" className="btn-secondary" aria-label="Search"><Icon name="discovery" size={14} /></button>
        </form>
        <SegmentedTabs<StatusTab> size="sm" ariaLabel="Row status" value={status} onChange={(s) => { setStatus(s); setPage(1); }}
          options={[{ key: 'active', label: 'Active' }, { key: 'hidden', label: 'Hidden' }, { key: 'all', label: 'All' }]} />
      </div>

      <FilterBar schema={schema} filters={filters} onChange={apply} />

      {items.error && <div className="callout-danger" role="alert">{describeError(items.error)}</div>}
      {items.isLoading && <SkeletonRows rows={3} height={84} label="Loading rows" />}
      {items.data && items.data.items.length === 0 && (
        <EmptyState icon="database" title={q || filters.length ? 'No rows match' : status === 'hidden' ? 'No hidden rows' : 'No rows yet'}
          note={q || filters.length ? 'Try fewer filters or another search.' : 'Import a file to add rows.'} />
      )}
      {items.data && items.data.items.length > 0 && (
        <>
          <div className={`compact-grid${items.isFetching ? ' dx-fetching' : ''}`}>
            {items.data.items.map((it, i) => (
              <ItemCard key={it.id} item={it} index={i} schema={schema} busy={setItem.isPending}
                onToggle={(done) => setItem.mutate({ id: it.id, status: it.status === 'active' ? 'hidden' : 'active' }, {
                  onSuccess: (r) => { toast.success(r.status === 'hidden' ? 'Hidden from agents and strategies' : 'Visible again'); done(); },
                  onError: (e) => toast.error(describeError(e)),
                })} />
            ))}
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={items.data.total} onPage={setPage} />
        </>
      )}
    </SectionCard>
  );
}

/**
 * A row as a compact card: a small thumbnail, the status / posted / category badges, the date, the title
 * and two lines of the body. A click opens every field, the ref and the full body with Hide / Unhide.
 */
function ItemCard({ item, index, schema, onToggle, busy }: { item: DataItem; index: number; schema: DataSchema; onToggle: (done: () => void) => void; busy: boolean }) {
  const date = item.event_date ?? (item.event_month && item.event_day ? `${String(item.event_day).padStart(2, '0')}.${String(item.event_month).padStart(2, '0')}` : null);
  const hidden = item.status === 'hidden';
  const badges = (
    <>
      {hidden && <Badge tone="warning">Hidden</Badge>}
      {item.posted_count > 0 && <Badge tone="success" title="Resources this row was published on (content ledger)">Posted {item.posted_count}×</Badge>}
      {item.category && <span className="chip">{item.category}</span>}
      {date && <span className="mono text-micro dx-dim">{date}</span>}
    </>
  );
  return (
    <CompactCard delay={Math.min(index, 12) * 25} hint="Open the row" style={{ opacity: hidden ? 0.6 : 1 }}
      top={<>
        {item.image_url && <img src={item.image_url} alt="" loading="lazy" className="dx-thumb" />}
        <span className="dx-card-top">{badges}</span>
      </>}
      title={item.title ?? <em className="dx-dim" style={{ fontWeight: 400 }}>no title</em>}
      body={item.body || undefined}
      dialog={{
        size: 'lg', icon: 'database', title: item.title ?? 'Untitled row', subtitle: item.ref,
        body: () => (
          <div className="dx-col" style={{ gap: 12 }}>
            {item.image_url && <img src={item.image_url} alt="" loading="lazy" className="dx-hero-img" />}
            <div className="dx-meta" style={{ marginTop: 0 }}>{badges}</div>
            {item.body && <div className="dx-text" style={{ whiteSpace: 'pre-line' }}>{item.body}</div>}
            {item.url && <a href={item.url} target="_blank" rel="noreferrer noopener" className="link-accent text-micro" style={{ overflowWrap: 'anywhere' }}>{item.url}</a>}
            <dl className="dx-facts inset">
              {schema.fields.map((f) => (
                <FieldRow key={f.name} name={f.name} value={item.data[f.name]} muted={f.deprecated || f.agent_visible === false} />
              ))}
              <FieldRow name="ref" value={item.ref} />
              {item.legacy_ref && <FieldRow name="legacy ref" value={item.legacy_ref} />}
              <FieldRow name="added" value={fmtDate(item.created_at)} />
            </dl>
          </div>
        ),
        actions: (close) => (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => onToggle(close)}
            style={{ marginLeft: 'auto' }}>
            <Icon name={hidden ? 'eye' : 'ban'} size={14} /> {hidden ? 'Unhide' : 'Hide'}
          </button>
        ),
      }} />
  );
}

function FieldRow({ name, value, muted }: { name: string; value: unknown; muted?: boolean }) {
  return (
    <>
      <dt className={`mono${muted ? ' dx-dim' : ''}`}>{name}</dt>
      <dd>{cellText(value, 400)}</dd>
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
    return <p className="dx-note is-sm" style={{ marginBottom: 12 }}>No filterable fields — mark fields as filterable on the Schema tab.</p>;
  }

  function add() {
    if (!field) return;
    const r = buildFilter(field, curOp, v1, v2);
    if ('error' in r) { toast.error(r.error); return; }
    onChange([...filters, r]);
    setV1(''); setV2('');
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <form className="dx-filter-form" onSubmit={(e) => { e.preventDefault(); add(); }}>
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
          <input className="input-field is-w160" aria-label="Filter value" value={v1} onChange={(e) => setV1(e.target.value)}
            placeholder={curOp === 'in' ? 'a, b, c' : field?.type === 'date' ? 'YYYY-MM-DD' : field?.type === 'month_day' ? 'MM-DD' : curOp === 'between' ? 'from' : 'value'} />
        )}
        {curOp === 'between' && (
          <input className="input-field is-w120" aria-label="Filter value to" value={v2} onChange={(e) => setV2(e.target.value)} placeholder="to" />
        )}
        <button type="submit" className="btn-secondary"><Icon name="plus" size={13} /> Add filter</button>
      </form>
      {filters.length > 0 && (
        <div className="dx-filters">
          {filters.map((f, i) => (
            <span key={i} className="dx-filter">
              {filterLabel(f)}
              <button type="button" className="dx-filter-x" aria-label={`Remove filter ${filterLabel(f)}`}
                onClick={() => onChange(filters.filter((_, j) => j !== i))}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          <button type="button" className="btn-ghost" onClick={() => onChange([])}>Clear</button>
        </div>
      )}
    </div>
  );
}
