// Schema editor (spec 032 FR-002/FR-003/FR-007): the dataset's plain-English texts, the field table
// (description, type, flags, example, add field, deprecate) and the roles mapping. Fields are never removed
// or renamed: they are deprecated. A structural edit shows its version bump and the rows that keep the
// old version before it is saved.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Field, SectionCard } from '../ui/primitives';
import { ActionsTh, RowActions, TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import {
  changeLabel, FIELD_TYPES, MAX_ORDER_BY, newField, orderableFields, previewSummary, REUSE_CHOICES, reuseChoice, reuseFromChoice,
  ROLE_LABEL, ROLE_NAMES, ROUNDS_HINT, schemaPatch, setOrderBy, TYPE_LABEL,
  type FieldDef, type FieldType, type ReuseChoice,
} from '../../lib/data-store';
import { previewDatasetEdit, useUpdateDataset, type DataSchema, type EditPreview, type ReusePolicy, type SchemaPatch } from '../../api/data';
import { Check, RoleSelect } from './ImportWizard';
import './data.css';

type Editable = Pick<DataSchema, 'title' | 'description' | 'entity' | 'fields' | 'roles' | 'language' | 'default_license'
  | 'reuse_policy' | 'suitable_for' | 'contains_personal_data' | 'status'>;

const pick = (s: DataSchema): Editable => ({
  title: s.title, description: s.description, entity: s.entity, fields: s.fields, roles: s.roles, language: s.language,
  default_license: s.default_license, reuse_policy: s.reuse_policy, suitable_for: s.suitable_for,
  contains_personal_data: s.contains_personal_data, status: s.status,
});

export function SchemaEditor({ schema, children }: { schema: DataSchema; children?: ReactNode }) {
  const saved = useMemo(() => pick(schema), [schema]);
  const [draft, setDraft] = useState<Editable>(saved);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<EditPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const update = useUpdateDataset(schema.key);
  const confirm = useConfirm();

  // A fresh copy after every save (or when another tab saved).
  useEffect(() => { setDraft(saved); setPreview(null); }, [saved]);

  const patch = schemaPatch(saved, draft) as SchemaPatch;
  const dirty = Object.keys(patch).length > 0;
  const set = (p: Partial<Editable>) => { setDraft({ ...draft, ...p }); setPreview(null); };
  const setField = (name: string, p: Partial<FieldDef>) => set({ fields: draft.fields.map((f) => (f.name === name ? { ...f, ...p } : f)) });
  const savedNames = new Set(saved.fields.map((f) => f.name));
  const liveFields = draft.fields.filter((f) => !f.deprecated).map((f) => f.name);

  async function check(): Promise<EditPreview | null> {
    setChecking(true);
    try {
      const p = await previewDatasetEdit(schema.key, patch);
      setPreview(p);
      return p;
    } catch (e) {
      toast.error(describeError(e));
      return null;
    } finally {
      setChecking(false);
    }
  }

  async function save() {
    const p = await check();
    if (!p) return;
    if (p.errors.length) { toast.error(p.errors[0]); return; }
    if (p.structural) {
      const ok = await confirm(`save version ${p.nextVersion} of ${schema.title}`, {
        danger: false, confirmLabel: `Save as version ${p.nextVersion}`,
        details: <PreviewBox p={p} version={schema.version} />,
      });
      if (!ok) return;
    }
    update.mutate({ patch, reason: reason.trim() || undefined }, {
      onSuccess: (r) => { toast.success(r.diff.structural ? `Saved as version ${r.schema.version}` : 'Saved'); setReason(''); },
      onError: (e) => toast.error(describeError(e)),
    });
  }

  return (
    <div className="dx-stack" style={{ paddingBottom: dirty ? 96 : 0 }}>
      {children}

      <SectionCard title="Dataset" delay={0}>
        <div className="dx-grid">
          <Field label="Title"><input className="input-field dx-fill" value={draft.title} onChange={(e) => set({ title: e.target.value })} /></Field>
          <Field label="Entity" hint="one row is a…"><input className="input-field dx-fill" value={draft.entity} onChange={(e) => set({ entity: e.target.value })} /></Field>
          <Field label="Language"><input className="input-field dx-fill" value={draft.language ?? ''} onChange={(e) => set({ language: e.target.value.trim() || null })} /></Field>
          <Field label="Default license"><input className="input-field dx-fill" value={draft.default_license} onChange={(e) => set({ default_license: e.target.value })} /></Field>
          <Field label="Reuse" hint="when a row may be posted again on the same resource">
            <ReuseInput value={draft.reuse_policy} fields={draft.fields} onChange={(v) => set({ reuse_policy: v })} />
          </Field>
          <Field label="Status">
            <select className="input-field dx-fill" value={draft.status} onChange={(e) => set({ status: e.target.value as Editable['status'] })}>
              <option value="active">Active — agents see it</option>
              <option value="draft">Draft — hidden from agents</option>
              <option value="archived">Archived — no imports</option>
            </select>
          </Field>
        </div>
        <Field label="Description" hint="what the data is, for whom, how to use it — agents read this first">
          <textarea className="input-field dx-resize" rows={3} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label="Suitable for" hint="topics and resources it fits">
          <textarea className="input-field dx-resize" rows={2} value={draft.suitable_for} onChange={(e) => set({ suitable_for: e.target.value })} />
        </Field>
        <div className="dx-row">
          <Check label="contains personal data (agents are told)" checked={draft.contains_personal_data} onChange={(v) => set({ contains_personal_data: v })} />
          <span className="text-micro dx-dim">
            Dedup key: <span className="mono">{schema.dedup_key.length ? schema.dedup_key.join(' + ') : 'none'}</span> (fixed once the dataset has rows)
          </span>
        </div>
      </SectionCard>

      <SectionCard title={`Fields · version ${schema.version}`} delay={60}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Field</th><th>Type</th><th>Description for agents</th><th>Flags</th><th>Example</th><ActionsTh /></tr></thead>
            <tbody>
              {draft.fields.map((f) => (
                <tr key={f.name} style={{ opacity: f.deprecated ? 0.55 : 1 }}>
                  <td>
                    <span className="mono dx-field-name">{f.name}</span>
                    <div className="dx-badges">
                      {f.required && <Badge>required</Badge>}
                      {f.deprecated && <Badge tone="warning">deprecated</Badge>}
                      {!savedNames.has(f.name) && <Badge tone="accent">new</Badge>}
                      {f.since_version && f.since_version > 1 && <Badge>since v{f.since_version}</Badge>}
                    </div>
                  </td>
                  <td>
                    <div className="text-body-sm">{TYPE_LABEL[f.type]}</div>
                    {f.enum && <div className="meta" style={{ maxWidth: 180, overflowWrap: 'anywhere' }}>{f.enum.slice(0, 12).join(', ')}{f.enum.length > 12 ? '…' : ''}</div>}
                  </td>
                  <td style={{ minWidth: 220 }}>
                    <textarea className="input-field dx-resize" rows={2} value={f.description} aria-label={`Description of ${f.name}`}
                      placeholder="What this field holds and how to use it" onChange={(e) => setField(f.name, { description: e.target.value })} />
                  </td>
                  <td>
                    <div className="dx-flags">
                      <Check label="agents see" checked={f.agent_visible !== false} onChange={(v) => setField(f.name, { agent_visible: v })} />
                      <Check label="searchable" checked={!!f.searchable} onChange={(v) => setField(f.name, { searchable: v })} />
                      <Check label="filterable" checked={!!f.filterable} onChange={(v) => setField(f.name, { filterable: v })} />
                    </div>
                  </td>
                  <td style={{ minWidth: 140 }}>
                    <input className="input-field dx-fill" aria-label={`Example of ${f.name}`} value={f.example === undefined || f.example === null ? '' : String(f.example)}
                      onChange={(e) => setField(f.name, { example: e.target.value === '' ? undefined : e.target.value })} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <RowActions danger={!savedNames.has(f.name)
                      ? <TableAction action="delete" title="Remove the unsaved field" onClick={() => set({ fields: draft.fields.filter((x) => x.name !== f.name) })} />
                      : f.deprecated
                        ? <TableAction icon="refresh" title="Restore" onClick={() => setField(f.name, { deprecated: undefined })} />
                        : <TableAction icon="ban" danger title="Deprecate (rows keep the value; agents stop seeing it)" onClick={() => setField(f.name, { deprecated: true })} />}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <AddField existing={draft.fields} onAdd={(f) => set({ fields: [...draft.fields, f] })} />
      </SectionCard>

      <SectionCard title="Roles" delay={120}>
        <p className="dx-note" style={{ marginBottom: 16 }}>
          Roles give every dataset the same shape: lists, search, previews and "today" filters use them. Changing a role is a structural edit.
        </p>
        <div className="dx-grid is-narrow">
          {ROLE_NAMES.map((role) => (
            <Field key={role} label={ROLE_LABEL[role]}>
              <RoleSelect value={draft.roles[role]} fields={liveFields}
                onChange={(v) => { const roles = { ...draft.roles }; if (v === undefined) delete roles[role]; else roles[role] = v; set({ roles }); }} />
            </Field>
          ))}
        </div>
      </SectionCard>

      {dirty && (
        <div className="dx-savebar" role="region" aria-label="Unsaved schema changes">
          {preview && <PreviewBox p={preview} version={schema.version} />}
          <div className="dx-savebar-row">
            <input className="input-field" placeholder="Why (optional, kept in the version history)" aria-label="Reason for the change" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            <button type="button" className="btn-secondary" onClick={() => { setDraft(saved); setPreview(null); }}>Discard</button>
            <button type="button" className="btn-secondary" disabled={checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Preview'}</button>
            <button type="button" className="btn-primary" disabled={checking || update.isPending} onClick={() => void save()}>
              <Icon name="check" size={14} /> Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewBox({ p, version }: { p: EditPreview; version: number }) {
  return (
    <div className={p.errors.length ? 'callout-danger' : p.structural ? 'callout-warning' : 'inset'}>
      <div>
        <div className="text-body-sm" style={{ fontWeight: 600 }}>{previewSummary(p, version)}</div>
        {p.changes.length > 0 && (
          <ul className="text-micro dx-muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {p.changes.map((c, i) => <li key={i}>{changeLabel(c)}</li>)}
          </ul>
        )}
        {p.errors.length > 1 && (
          <ul className="text-micro" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{p.errors.slice(1).map((e) => <li key={e}>{e}</li>)}</ul>
        )}
      </div>
    </div>
  );
}

/** The Reuse setting (spec 071): never, after N days, or in rounds (every row once per channel, then a new round). */
function ReuseInput({ value, fields, onChange }: { value: ReusePolicy; fields: FieldDef[]; onChange: (v: ReusePolicy) => void }) {
  const inOrder = value.kind === 'cycle' && value.order === 'sequential';
  return (
    <div className="dx-col">
      <div style={{ display: 'flex', gap: 6 }}>
        <select className="input-field" style={{ flex: 1, minWidth: 0 }} aria-label="Reuse" value={reuseChoice(value)}
          onChange={(e) => onChange(reuseFromChoice(e.target.value as ReuseChoice, value))}>
          {REUSE_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        {value.kind === 'after_days' && (
          <input className="input-field" style={{ width: 80 }} inputMode="numeric" aria-label="Days" value={value.days}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n <= 3650) onChange({ kind: 'after_days', days: n }); }} />
        )}
      </div>
      {value.kind === 'cycle' && <span className="text-micro dx-dim">{ROUNDS_HINT}</span>}
      {value.kind === 'cycle' && inOrder && <OrderBy value={value} fields={fields} onChange={onChange} />}
    </div>
  );
}

/** Up to three ordered selects: "Order by", then "Then by" twice. "Import order" (the default) sends no field. */
function OrderBy({ value, fields, onChange }: { value: Extract<ReusePolicy, { kind: 'cycle' }>; fields: FieldDef[]; onChange: (v: ReusePolicy) => void }) {
  const chosen = value.order_by ?? [];
  const options = orderableFields(fields);
  return (
    <div className="dx-col" style={{ gap: 6 }}>
      {Array.from({ length: MAX_ORDER_BY }, (_, i) => i).filter((i) => i <= chosen.length).map((i) => {
        const label = i === 0 ? 'Order by' : 'Then by';
        const here = chosen[i] ?? '';
        // A field already used by another select is not offered again; a saved name that is no longer orderable stays visible.
        const list = [...new Set([...options, ...(here ? [here] : [])])].filter((n) => n === here || !chosen.includes(n));
        return (
          <label key={i} className="dx-order">
            <span>{label}</span>
            <select className="input-field" aria-label={label} value={here}
              onChange={(e) => onChange(setOrderBy(value, i, e.target.value))}>
              <option value="">{i === 0 ? 'Import order' : 'Then import order'}</option>
              {list.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        );
      })}
    </div>
  );
}

function AddField({ existing, onAdd }: { existing: FieldDef[]; onAdd: (f: FieldDef) => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [description, setDescription] = useState('');
  const [enumText, setEnumText] = useState('');
  function add(e: React.FormEvent) {
    e.preventDefault();
    const r = newField(existing, { name, type, description, enumText });
    if ('error' in r) { toast.error(r.error); return; }
    onAdd(r);
    setName(''); setDescription(''); setEnumText('');
  }
  return (
    <form onSubmit={add} className="dx-add-field">
      <Field label="New field" style={{ marginBottom: 0 }}>
        <input className="input-field is-w160" placeholder="snake_case_name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Type" style={{ marginBottom: 0 }}>
        <select className="input-field" value={type} onChange={(e) => setType(e.target.value as FieldType)}>
          {FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </Field>
      {type === 'enum' && (
        <Field label="Values" style={{ marginBottom: 0 }}>
          <input className="input-field is-w180" placeholder="a, b, c" value={enumText} onChange={(e) => setEnumText(e.target.value)} />
        </Field>
      )}
      <Field label="Description" style={{ marginBottom: 0, flex: '1 1 200px' }}>
        <input className="input-field dx-fill" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <button type="submit" className="btn-secondary"><Icon name="plus" size={13} /> Add field</button>
    </form>
  );
}
