// Data store (spec 032): datasets (schemas), their rows, CSV/JSON imports with dry run, commit and undo,
// and the description edits agents suggest. Backend: apps/automation/src/data/data.controller.ts.

import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api, ApiError, unauthorized } from './client';
import { API_BASE } from '../lib/env';
import type { DataFilter, FieldDef, FieldType, RoleName } from '../lib/data-store';

export type { DataFilter, FieldDef, FieldType, RoleName };

export type Roles = Partial<Record<RoleName, string | string[]>>;
export type ReusePolicy = { kind: 'never' } | { kind: 'after_days'; days: number };
export type DatasetStatus = 'draft' | 'active' | 'archived';

export interface DataSchema {
  id:                     string;
  key:                    string;
  title:                  string;
  description:            string;
  entity:                 string;
  version:                number;
  fields:                 FieldDef[];
  roles:                  Roles;
  dedup_key:              string[];
  language:               string | null;
  default_license:        string;
  reuse_policy:           ReusePolicy;
  suitable_for:           string;
  contains_personal_data: boolean;
  legacy:                 { table: string } | null;
  status:                 DatasetStatus;
  created_by:             string | null;
  created_at:             string;
  updated_at:             string;
}

export interface DatasetRow extends DataSchema {
  rows:             number;
  rows_active:      number;
  last_import_at:   string | null;
  unposted_network: number | null;
  today_items:      number | null;
  stats_at:         string | null;
}

/** Everything the owner may send when creating a dataset. */
export type SchemaInput = Pick<DataSchema, 'key' | 'title' | 'description' | 'entity' | 'fields' | 'roles' | 'dedup_key' | 'language'
  | 'default_license' | 'reuse_policy' | 'suitable_for' | 'contains_personal_data' | 'status'>;
export type SchemaPatch = Partial<Omit<SchemaInput, 'key'>>;

export interface SchemaChange {
  kind: 'field_added' | 'field_deprecated' | 'field_restored' | 'field_changed' | 'field_described' | 'roles' | 'dedup_key' | 'dataset_text';
  field?: string;
  detail?: string;
}

export interface EditPreview {
  structural:            boolean;
  nextVersion:           number;
  changes:               SchemaChange[];
  errors:                string[];
  rows:                  number;
  rows_on_older_version: number;
}

export interface DataItem {
  id:           string;
  ref:          string;
  legacy_ref:   string | null;
  status:       'active' | 'hidden';
  title:        string | null;
  body:         string | null;
  image_url:    string | null;
  url:          string | null;
  category:     string | null;
  event_date:   string | null;
  event_month:  number | null;
  event_day:    number | null;
  created_at:   string;
  updated_at:   string;
  import_id:    string | null;
  posted_count: number;
  data:         Record<string, unknown>;
}

export interface ItemsPage { items: DataItem[]; total: number; page: number; page_size: number }

export interface ImportIssue { row: number; line?: number; field: string | null; error: string }
export interface PreviewRow {
  row: number; title: string | null; body: string | null; image_url: string | null; url: string | null;
  category: string | null; date: string | null; data: Record<string, unknown>;
}

export interface ImportReport {
  import_id:      string;
  status:         string;
  schema:         string;
  schema_version: number;
  source:         string;
  filename:       string | null;
  delimiter?:     string;
  columns:        string[];
  mapping:        Record<string, string | null>;
  rows_total:     number;
  valid:          number;
  invalid:        number;
  new:            number;
  updated:        number;
  duplicates:     number;
  inserted?:      number;
  skipped?:       number;
  errors:         ImportIssue[];
  preview:        PreviewRow[];
}

export interface InferResult {
  fields:       FieldDef[];
  roles:        Roles;
  dedup_key:    string[];
  mapping:      Record<string, string>;
  format:       'csv' | 'json' | 'jsonl';
  columns:      string[];
  rows_sampled: number;
  delimiter?:   string;
  errors:       ImportIssue[];
}

export type ImportStatus = 'dry_run' | 'running' | 'committed' | 'failed' | 'undone' | 'expired';

export interface ImportRecord {
  id:             string;
  schema:         string;
  schema_version: number;
  source:         'csv' | 'json' | 'jsonl' | 'pipeline' | 'api';
  filename:       string | null;
  rows_total:     number;
  inserted:       number;
  updated:        number;
  skipped:        number;
  invalid:        number;
  duplicates:     number;
  status:         ImportStatus;
  created_by:     string | null;
  created_at:     string;
  finished_at:    string | null;
  undone_at:      string | null;
  undo_report:    { deleted?: number; hidden?: number; restored?: number } | null;
}

export interface UndoResult { import_id: string; deleted: number; hidden: number; restored: number }

const enc = encodeURIComponent;

// ─── datasets ────────────────────────────────────────────────────────────────

export function useDatasets() {
  return useQuery({ queryKey: ['data', 'schemas'], queryFn: () => api<DatasetRow[]>('/api/data/schemas') });
}

export function useDataset(key: string) {
  return useQuery({ queryKey: ['data', 'schema', key], queryFn: () => api<DataSchema>(`/api/data/schemas/${enc(key)}`) });
}

export function createDataset(input: SchemaInput): Promise<DataSchema> {
  return api<DataSchema>('/api/data/schemas', { method: 'POST', body: JSON.stringify(input) });
}

export function previewDatasetEdit(key: string, patch: SchemaPatch): Promise<EditPreview> {
  return api<EditPreview>(`/api/data/schemas/${enc(key)}/preview`, { method: 'POST', body: JSON.stringify(patch) });
}

export function useUpdateDataset(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { patch: SchemaPatch; reason?: string }) =>
      api<{ schema: DataSchema; diff: EditPreview }>(`/api/data/schemas/${enc(key)}`, {
        method: 'PATCH', body: JSON.stringify({ ...v.patch, ...(v.reason ? { reason: v.reason } : {}) }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['data'] }),
  });
}

export function useRefreshStats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (schema?: string) => api<{ refreshed: number }>('/api/data/stats/refresh', { method: 'POST', body: JSON.stringify(schema ? { schema } : {}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['data', 'schemas'] }),
  });
}

// ─── items ───────────────────────────────────────────────────────────────────

export interface ItemsQuery {
  q?:        string;
  filters?:  DataFilter[];
  status?:   'active' | 'hidden' | 'all';
  order?:    'newest' | 'oldest' | 'random';
  page?:     number;
  pageSize?: number;
}

export function itemsPath(key: string, p: ItemsQuery): string {
  const qs = new URLSearchParams();
  if (p.q?.trim()) qs.set('q', p.q.trim());
  if (p.filters?.length) qs.set('filters', JSON.stringify(p.filters));
  if (p.status && p.status !== 'active') qs.set('status', p.status);
  if (p.order && p.order !== 'newest') qs.set('order', p.order);
  if (p.page && p.page > 1) qs.set('page', String(p.page));
  if (p.pageSize) qs.set('page_size', String(p.pageSize));
  const s = qs.toString();
  return `/api/data/${enc(key)}/items${s ? `?${s}` : ''}`;
}

export function useDataItems(key: string, p: ItemsQuery) {
  return useQuery({
    queryKey: ['data', 'items', key, p],
    queryFn: () => api<ItemsPage>(itemsPath(key, p)),
    placeholderData: keepPreviousData,
  });
}

export function useSetItemStatus(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: 'active' | 'hidden' }) =>
      api<{ id: string; status: string }>(`/api/data/${enc(key)}/items/${enc(v.id)}`, { method: 'PATCH', body: JSON.stringify({ status: v.status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['data'] }),
  });
}

// ─── agent suggestions (pending action edit_data_schema) ─────────────────────

export interface DataSuggestion {
  id:         string;
  dataset:    string;
  target:     'description' | 'suitable_for' | 'field';
  field:      string | null;
  old_text:   string;
  new_text:   string;
  evidence:   string;
  summary:    string;
  agent:      string | null;
  created_at: string;
}

export function useDataSuggestions(schema?: string) {
  return useQuery({
    queryKey: ['data', 'suggestions', schema ?? null],
    queryFn: () => api<DataSuggestion[]>(`/api/data/suggestions${schema ? `?schema=${enc(schema)}` : ''}`),
  });
}

/** Apply or discard through the shared pending-actions endpoint; the server re-checks the text is not stale. */
export function useDecideSuggestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; decision: 'apply' | 'discard' }) =>
      api<{ action: { status: string; error: string | null } }>(`/api/agents/actions/${enc(v.id)}/${v.decision}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['data'] }),
  });
}

// ─── imports ─────────────────────────────────────────────────────────────────

/** Multipart upload: `api()` always sends JSON, so files go through fetch directly (same cookie, same 401 handling). */
async function upload<T>(path: string, file: File, fields: Record<string, string | undefined>): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v);
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', credentials: 'include', body: form });
  if (res.status === 401) throw await unauthorized(res);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<T>;
}

export function inferFile(file: File): Promise<InferResult> {
  return upload<InferResult>('/api/data/imports/infer', file, {});
}

export function dryRunImport(v: { schema: string; file: File; mapping?: Record<string, string | null>; keepExtra?: boolean }): Promise<ImportReport> {
  return upload<ImportReport>('/api/data/imports', v.file, {
    schema: v.schema,
    mapping: v.mapping ? JSON.stringify(v.mapping) : undefined,
    extra: v.keepExtra ? 'keep' : undefined,
  });
}

export function commitImport(id: string): Promise<ImportReport> {
  return api<ImportReport>(`/api/data/imports/${enc(id)}/commit`, { method: 'POST' });
}

export function useImports(schema?: string) {
  return useQuery({
    queryKey: ['data', 'imports', schema ?? null],
    queryFn: () => api<ImportRecord[]>(`/api/data/imports${schema ? `?schema=${enc(schema)}` : ''}`),
  });
}

export function useUndoImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<UndoResult>(`/api/data/imports/${enc(id)}/undo`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['data'] }),
  });
}
