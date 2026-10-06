// Import wizard (spec 032 FR-006): upload a CSV / JSON / JSONL file, then either map its columns onto an
// existing dataset or describe a new dataset drafted from the file (types inferred from 500 rows). A dry
// run reports counts, the first errors and preview rows; nothing is written until Commit.

import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Modal } from '../Modal';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Field, StatTile } from '../ui/primitives';
import { describeError, toast } from '../ui/Toast';
import { api } from '../../api/client';
import {
  commitImport, createDataset, dryRunImport, inferFile, useDatasets,
  type DatasetRow, type ImportReport, type InferResult, type Roles,
} from '../../api/data';
import {
  draftMapping, draftProblems, fmtInt, FIELD_TYPES, ROLE_LABEL, roleValueLabel, TYPE_LABEL,
  type DraftField, type FieldType, type RoleName,
} from '../../lib/data-store';

type Step = 'pick' | 'draft' | 'report' | 'done';
type Mode = 'existing' | 'new';

interface Draft {
  key: string; title: string; entity: string; description: string; suitable_for: string; language: string;
  fields: DraftField[]; roles: Roles; dedup_key: string[];
}

const ACCEPT = '.csv,.json,.jsonl,.ndjson,.txt,text/csv,application/json';

function keyFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const k = /^[a-z]/.test(base) ? base : `data_${base}`;
  return k.slice(0, 60) || 'new_dataset';
}

function draftFromInfer(inf: InferResult, filename: string): Draft {
  // The server drafts one field per column, in column order.
  const fields: DraftField[] = inf.columns.map((col, i) => ({ ...inf.fields[i], column: col, include: true }));
  const title = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return {
    key: keyFromFilename(filename), title: title ? title[0].toUpperCase() + title.slice(1) : 'New dataset', entity: 'item',
    description: '', suitable_for: '', language: 'uk', fields, roles: inf.roles, dedup_key: inf.dedup_key,
  };
}

export function ImportWizard({ open, onClose, initialSchema }: { open: boolean; onClose: () => void; initialSchema?: string }) {
  const qc = useQueryClient();
  const datasets = useDatasets();
  const [step, setStep] = useState<Step>('pick');
  const [mode, setMode] = useState<Mode>('existing');
  const [schemaKey, setSchemaKey] = useState(initialSchema ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [keepExtra, setKeepExtra] = useState(false);
  const [done, setDone] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);

  const writable = (datasets.data ?? []).filter((d) => d.status !== 'archived');
  const target: DatasetRow | undefined = writable.find((d) => d.key === (createdKey ?? schemaKey));

  function reset() {
    setStep('pick'); setFile(null); setDraft(null); setCreatedKey(null); setReport(null); setMapping({}); setKeepExtra(false); setDone(null);
    setSchemaKey(initialSchema ?? ''); setMode('existing');
  }
  function close() { reset(); onClose(); }

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { toast.error(describeError(e)); } finally { setBusy(false); }
  }

  const next = () => guard(async () => {
    if (!file) return;
    if (mode === 'existing') {
      if (!schemaKey) { toast.error('Choose a dataset'); return; }
      const r = await dryRunImport({ schema: schemaKey, file });
      setReport(r); setMapping(r.mapping); setStep('report');
    } else {
      setDraft(draftFromInfer(await inferFile(file), file.name));
      setStep('draft');
    }
  });

  const createAndCheck = () => guard(async () => {
    if (!file || !draft) return;
    const problems = draftProblems(draft);
    if (problems.length) { toast.error(problems[0]); return; }
    let key = createdKey;
    if (!key) {
      const inc = draft.fields.filter((f) => f.include);
      const names = new Set(inc.map((f) => f.name));
      const roles = Object.fromEntries(Object.entries(draft.roles).filter(([, v]) => (Array.isArray(v) ? v : [v]).every((n) => n && names.has(n))));
      const created = await createDataset({
        key: draft.key, title: draft.title.trim(), entity: draft.entity.trim() || 'item', description: draft.description.trim(),
        suitable_for: draft.suitable_for.trim(), language: draft.language.trim() || null, default_license: 'unknown',
        reuse_policy: { kind: 'never' }, contains_personal_data: false, status: 'draft', dedup_key: draft.dedup_key,
        roles, fields: inc.map(({ column: _c, include: _i, ...f }) => f),
      });
      key = created.key;
      setCreatedKey(key);
      void qc.invalidateQueries({ queryKey: ['data', 'schemas'] });
    }
    const m = draftMapping(draft.fields);
    const r = await dryRunImport({ schema: key, file, mapping: m });
    setReport(r); setMapping(r.mapping); setStep('report');
  });

  const recheck = () => guard(async () => {
    if (!file || !report) return;
    const r = await dryRunImport({ schema: report.schema, file, mapping, keepExtra });
    setReport(r); setMapping(r.mapping);
  });

  const commit = () => guard(async () => {
    if (!report) return;
    const r = await commitImport(report.import_id);
    // A dataset created by this wizard starts as a draft; it goes live with its first committed import.
    if (createdKey) await api(`/api/data/schemas/${encodeURIComponent(createdKey)}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
    setDone(r); setStep('done');
    void qc.invalidateQueries({ queryKey: ['data'] });
  });

  const titles: Record<Step, string> = { pick: 'Import a file', draft: 'Describe the new dataset', report: 'Dry run', done: 'Imported' };

  return (
    <Modal open={open} onClose={close} title={titles[step]} subtitle={file ? file.name : 'CSV, JSON or JSONL, up to 20 MB'} icon="database" size="xl">
      {step === 'pick' && (
        <div>
          <Field label="File" hint="UTF-8; comma, semicolon or tab separated CSV, a JSON array of objects, or JSON lines">
            <input type="file" accept={ACCEPT} className="input-field" style={{ width: '100%' }}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Field label="Into">
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <Radio checked={mode === 'existing'} onChange={() => setMode('existing')}>An existing dataset</Radio>
              <Radio checked={mode === 'new'} onChange={() => setMode('new')}>A new dataset from this file</Radio>
            </div>
          </Field>
          {mode === 'existing' && (
            <Field label="Dataset">
              <select className="input-field" style={{ width: '100%' }} value={schemaKey} onChange={(e) => setSchemaKey(e.target.value)}>
                <option value="">— choose —</option>
                {writable.map((d) => <option key={d.key} value={d.key}>{d.title} ({d.key})</option>)}
              </select>
            </Field>
          )}
          {mode === 'new' && (
            <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginTop: 0 }}>
              Column types are guessed from the first 500 rows. You name the fields, describe them for the agents and pick the roles next.
            </p>
          )}
          <div className="modal-foot">
            <button type="button" className="btn-secondary" onClick={close}>Cancel</button>
            <button type="button" className="btn-primary" disabled={!file || busy || (mode === 'existing' && !schemaKey)} onClick={next}>
              {busy ? 'Reading…' : mode === 'existing' ? 'Check file' : 'Draft dataset'}
            </button>
          </div>
        </div>
      )}

      {step === 'draft' && draft && (
        <DraftEditor draft={draft} onChange={setDraft} locked={!!createdKey}>
          <div className="modal-foot">
            <button type="button" className="btn-secondary" onClick={() => setStep('pick')} disabled={!!createdKey}>Back</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={createAndCheck}>
              {busy ? 'Working…' : createdKey ? 'Check file again' : 'Create dataset and check file'}
            </button>
          </div>
        </DraftEditor>
      )}

      {step === 'report' && report && (
        <ReportView report={report} target={target} mapping={mapping} onMapping={setMapping} mappingEditable={!createdKey}
          keepExtra={keepExtra} onKeepExtra={setKeepExtra} onRecheck={recheck} busy={busy}>
          <div className="modal-foot">
            <button type="button" className="btn-secondary" onClick={() => setStep(createdKey ? 'draft' : 'pick')} disabled={busy}>Back</button>
            <button type="button" className="btn-primary" disabled={busy || report.valid === 0} onClick={commit}>
              {busy ? 'Importing…' : `Commit ${fmtInt(report.new + report.updated)} rows`}
            </button>
          </div>
        </ReportView>
      )}

      {step === 'done' && done && (
        <div>
          <div className="stat-grid">
            <StatTile label="Inserted" value={fmtInt(done.inserted ?? 0)} icon="plus" accent />
            <StatTile label="Updated" value={fmtInt(done.updated)} icon="refresh" />
            <StatTile label="Skipped" value={fmtInt(done.skipped ?? 0)} icon="skip-forward" />
            <StatTile label="Invalid" value={fmtInt(done.invalid)} icon="warning" />
          </div>
          <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
            You can undo this import from the dataset's Imports tab.
          </p>
          <div className="modal-foot">
            <Link to="/app/data/$key" params={{ key: done.schema }} search={{}} className="btn-secondary" onClick={close}>Open dataset</Link>
            <button type="button" className="btn-primary" onClick={close}>Done</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Radio({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
      <input type="radio" checked={checked} onChange={onChange} style={{ accentColor: 'var(--color-accent)' }} />
      <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{children}</span>
    </label>
  );
}

export function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label title={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: 'var(--color-accent)' }} />
      <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{label}</span>
    </label>
  );
}

function DraftEditor({ draft, onChange, locked, children }: { draft: Draft; onChange: (d: Draft) => void; locked: boolean; children: ReactNode }) {
  const set = (p: Partial<Draft>) => onChange({ ...draft, ...p });
  const setField = (i: number, p: Partial<DraftField>) => {
    const fields = draft.fields.map((f, j) => (j === i ? { ...f, ...p } : f));
    // Keep roles and the dedup key pointing at the renamed field.
    const old = draft.fields[i].name;
    const renamed = p.name !== undefined && p.name !== old;
    const roles = renamed ? Object.fromEntries(Object.entries(draft.roles).map(([r, v]) => [r, Array.isArray(v) ? v.map((n) => (n === old ? p.name! : n)) : v === old ? p.name : v])) : draft.roles;
    const dedup_key = renamed ? draft.dedup_key.map((n) => (n === old ? p.name! : n)) : draft.dedup_key;
    onChange({ ...draft, fields, roles: roles as Roles, dedup_key });
  };
  const included = draft.fields.filter((f) => f.include);
  const problems = useMemo(() => draftProblems(draft), [draft]);

  return (
    <div>
      {locked && (
        <div className="callout-warning" style={{ marginBottom: 14 }}>
          <Icon name="info" size={16} />
          <span>The dataset <strong>{draft.key}</strong> is created as a draft. Fix the file and check again, or change the dataset later on its Schema tab.</span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 16px' }}>
        <Field label="Key" hint="permanent, snake_case">
          <input className="input-field" style={{ width: '100%' }} value={draft.key} disabled={locked} onChange={(e) => set({ key: e.target.value.trim() })} />
        </Field>
        <Field label="Title">
          <input className="input-field" style={{ width: '100%' }} value={draft.title} disabled={locked} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="Entity" hint="one row is a…">
          <input className="input-field" style={{ width: '100%' }} value={draft.entity} disabled={locked} placeholder="recipe, quote, event…" onChange={(e) => set({ entity: e.target.value })} />
        </Field>
        <Field label="Language">
          <input className="input-field" style={{ width: '100%' }} value={draft.language} disabled={locked} onChange={(e) => set({ language: e.target.value })} />
        </Field>
      </div>
      <Field label="Description" hint="what the data is, for whom, how to use it — agents read this first">
        <textarea className="input-field" rows={2} style={{ width: '100%', resize: 'vertical' }} value={draft.description} disabled={locked} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <Field label="Suitable for" hint="topics and resources it fits">
        <input className="input-field" style={{ width: '100%' }} value={draft.suitable_for} disabled={locked} onChange={(e) => set({ suitable_for: e.target.value })} />
      </Field>

      <div className="text-eyebrow" style={{ margin: '4px 0 8px' }}>Fields</div>
      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table className="table">
          <thead><tr><th>Import</th><th>Column</th><th>Field name</th><th>Type</th><th>Description for agents</th><th>Flags</th></tr></thead>
          <tbody>
            {draft.fields.map((f, i) => (
              <tr key={f.column} style={{ opacity: f.include ? 1 : 0.5 }}>
                <td><input type="checkbox" checked={f.include} disabled={locked} onChange={(e) => setField(i, { include: e.target.checked })} style={{ accentColor: 'var(--color-accent)' }} aria-label={`Import column ${f.column}`} /></td>
                <td className="meta" style={{ maxWidth: 160, overflowWrap: 'anywhere' }}>{f.column}</td>
                <td><input className="input-field" style={{ width: 150, fontFamily: 'var(--font-mono, monospace)' }} value={f.name} disabled={locked || !f.include} onChange={(e) => setField(i, { name: e.target.value.trim() })} /></td>
                <td>
                  <select className="input-field" value={f.type} disabled={locked || !f.include} onChange={(e) => setField(i, { type: e.target.value as FieldType, ...(e.target.value === 'enum' ? {} : { enum: undefined }) })}>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                  </select>
                  {f.type === 'enum' && (
                    <input className="input-field" style={{ width: '100%', marginTop: 6 }} placeholder="values, comma separated" disabled={locked || !f.include}
                      value={(f.enum ?? []).join(', ')} onChange={(e) => setField(i, { enum: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                  )}
                  {f.example !== undefined && <div className="meta" style={{ marginTop: 4, maxWidth: 200, overflowWrap: 'anywhere' }}>e.g. {String(f.example).slice(0, 60)}</div>}
                </td>
                <td><input className="input-field" style={{ width: '100%', minWidth: 180 }} value={f.description} disabled={locked || !f.include} placeholder="What this field holds" onChange={(e) => setField(i, { description: e.target.value })} /></td>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <Check label="agents see" checked={f.agent_visible !== false} disabled={locked || !f.include} onChange={(v) => setField(i, { agent_visible: v })} />
                    <Check label="searchable" checked={!!f.searchable} disabled={locked || !f.include} onChange={(v) => setField(i, { searchable: v })} />
                    <Check label="filterable" checked={!!f.filterable} disabled={locked || !f.include} onChange={(v) => setField(i, { filterable: v })} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0 16px' }}>
        {(['title', 'body', 'image', 'url', 'category', 'date', 'month_day'] as RoleName[]).map((role) => (
          <Field key={role} label={`Role: ${ROLE_LABEL[role]}`}>
            <RoleSelect value={draft.roles[role]} fields={included.map((f) => f.name)} disabled={locked}
              onChange={(v) => set({ roles: { ...draft.roles, [role]: v } })} />
          </Field>
        ))}
        <Field label="Dedup key" hint="the same value = the same row">
          <select className="input-field" style={{ width: '100%' }} value={draft.dedup_key[0] ?? ''} disabled={locked}
            onChange={(e) => set({ dedup_key: e.target.value ? [e.target.value] : [] })}>
            <option value="">— none (every row is new) —</option>
            {included.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
          </select>
        </Field>
      </div>

      {!locked && problems.length > 0 && (
        <div className="callout-warning" style={{ marginTop: 4 }}>
          <Icon name="warning" size={16} />
          <ul style={{ margin: 0, paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {children}
    </div>
  );
}

export function RoleSelect({ value, fields, onChange, disabled }: {
  value: string | string[] | undefined; fields: string[]; onChange: (v: string | string[] | undefined) => void; disabled?: boolean;
}) {
  const multi = Array.isArray(value) && value.length > 1;
  const current = multi ? '__multi' : (Array.isArray(value) ? value[0] : value) ?? '';
  return (
    <select className="input-field" style={{ width: '100%' }} value={current} disabled={disabled}
      onChange={(e) => onChange(e.target.value === '__multi' ? value : e.target.value || undefined)}>
      <option value="">— none —</option>
      {multi && <option value="__multi">{roleValueLabel(value)}</option>}
      {fields.map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  );
}

function ReportView({ report, target, mapping, onMapping, mappingEditable, keepExtra, onKeepExtra, onRecheck, busy, children }: {
  report: ImportReport; target?: DatasetRow; mapping: Record<string, string | null>; onMapping: (m: Record<string, string | null>) => void;
  mappingEditable: boolean; keepExtra: boolean; onKeepExtra: (v: boolean) => void; onRecheck: () => void; busy: boolean; children: ReactNode;
}) {
  const [allErrors, setAllErrors] = useState(false);
  const fields = (target?.fields ?? []).filter((f) => !f.deprecated).map((f) => f.name);
  const errors = allErrors ? report.errors : report.errors.slice(0, 15);
  return (
    <div>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <StatTile label="Rows in file" value={fmtInt(report.rows_total)} icon="database" />
        <StatTile label="Valid" value={fmtInt(report.valid)} icon="check" accent />
        <StatTile label="New" value={fmtInt(report.new)} icon="plus" />
        <StatTile label="Updated" value={fmtInt(report.updated)} icon="refresh" />
        <StatTile label="Invalid" value={fmtInt(report.invalid)} icon="warning" deltaTone="warning" delta={report.invalid ? 'skipped on commit' : undefined} />
        <StatTile label="Duplicates" value={fmtInt(report.duplicates)} icon="ban" delta={report.duplicates ? 'last row wins' : undefined} />
      </div>
      <p className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 0 }}>
        Into <strong>{report.schema}</strong> · validated against version {report.schema_version}{report.delimiter ? ` · delimiter "${report.delimiter === '\t' ? 'tab' : report.delimiter}"` : ''}
      </p>

      {mappingEditable && (
        <details style={{ marginBottom: 16 }} open={Object.values(mapping).some((v) => v === null)}>
          <summary className="text-eyebrow" style={{ cursor: 'pointer', marginBottom: 8 }}>Column mapping</summary>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Column in the file</th><th>Field</th></tr></thead>
              <tbody>
                {report.columns.map((c) => (
                  <tr key={c}>
                    <td style={{ overflowWrap: 'anywhere' }}>{c}</td>
                    <td>
                      <select className="input-field" value={mapping[c] ?? ''} onChange={(e) => onMapping({ ...mapping, [c]: e.target.value || null })}>
                        <option value="">— not imported —</option>
                        {fields.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <Check label="keep unmapped columns under _extra" checked={keepExtra} onChange={onKeepExtra} />
            <button type="button" className="btn-secondary" onClick={onRecheck} disabled={busy}>
              <Icon name="refresh" size={13} /> Check again
            </button>
          </div>
        </details>
      )}

      {report.errors.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="text-eyebrow" style={{ marginBottom: 8 }}>First errors</div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th className="num">Row</th><th className="num">Line</th><th>Field</th><th>Problem</th></tr></thead>
              <tbody>
                {errors.map((e, i) => (
                  <tr key={i}>
                    <td className="num">{e.row + 1}</td>
                    <td className="num">{e.line ?? '—'}</td>
                    <td>{e.field ?? '—'}</td>
                    <td style={{ overflowWrap: 'anywhere' }}>{e.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.errors.length > errors.length && (
            <button type="button" className="btn-ghost" style={{ marginTop: 6 }} onClick={() => setAllErrors(true)}>
              Show all {report.errors.length}{report.invalid > report.errors.length ? ` of the first ${report.errors.length}` : ''}
            </button>
          )}
        </div>
      )}

      {report.preview.length > 0 && (
        <div>
          <div className="text-eyebrow" style={{ marginBottom: 8 }}>Preview through the roles</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {report.preview.map((p) => (
              <div key={p.row} className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                {p.image_url && <img src={p.image_url} alt="" loading="lazy" style={{ width: '100%', height: 110, objectFit: 'cover', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-3)' }} />}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>row {p.row + 1}</span>
                  {p.category && <span className="chip">{p.category}</span>}
                  {p.date && <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{p.date}</span>}
                </div>
                <div className="text-body-sm" style={{ fontWeight: 600, color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{p.title ?? <em style={{ color: 'var(--color-ink-dim)' }}>no title</em>}</div>
                {p.body && <div className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>{p.body}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      {report.valid === 0 && <div style={{ marginTop: 12 }}><Badge tone="danger">No valid rows — nothing to import</Badge></div>}
      {children}
    </div>
  );
}
