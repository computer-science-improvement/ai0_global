import type { Pool } from 'pg';
import { z } from 'zod';
import { channelOf, defineTool, EditorTool, ToolContext } from '../harness/tool';
import type { PendingActionsService, PendingAction } from '../agents/pending-actions';
import { DataStore, DataStoreError } from '../../data/data-store';
import { buildCatalog } from '../../data/data-catalog';
import type { CardSource } from '../card';
import { catalogOverview, ledgerUsage, runwayDays, seriesLibraryUse, TtlCache } from './catalog-context';
import { DataQueryError, filterSchema, kyivMonthDay, MAX_AGENT_LIMIT, ORDERS, queryDataset, readableFields } from '../../data/data-query';
import type { DataSchema } from '../../data/data.types';

/**
 * Agents work from dataset descriptions (spec 032 FR-010):
 *   library_catalog → what each dataset is, its agent-visible fields and the numbers (rows, unposted
 *                     here and network-wide, today's rows, top categories, fill rate);
 *   query_data      → only the fields asked for, filters only on filterable fields, refs data://<key>/<id>;
 *   edit_data_schema → a description fix the owner applies with one click (agents never change structure).
 */

export interface DataToolDeps {
  pool:     Pick<Pool, 'query'>;
  actions?: Pick<PendingActionsService, 'propose'>;
  /** Kyiv-local month/day; injectable for tests. */
  today?:   () => { month: number; day: number };
  /** Spec 023: tells library_catalog which API adapters have their key (presence only). */
  env?:     (key: string) => string | undefined;
}

const READ_ROLES = ['planner', 'executor', 'reviewer', 'composer', 'orchestrator', 'idea_reviewer', 'manager', 'builder'] as const;

/** The resource the agent works on: a platform slot's resource, else the Telegram channel. */
export function currentResource(ctx: ToolContext): string | null {
  const slot = ctx.extras?.platformSlot as { resourceRef?: string } | undefined;
  return slot?.resourceRef ?? channelOf(ctx);
}

async function activeSchema(pool: Pick<Pool, 'query'>, key: string): Promise<DataSchema | { error: string; details: string }> {
  const s = await new DataStore(pool).getSchema(key);
  if (!s) return { error: 'unknown_dataset', details: `no dataset "${key}"; read library_catalog for the list` };
  if (s.status !== 'active') return { error: 'dataset_not_active', details: `dataset "${key}" is ${s.status}` };
  return s;
}

export const QueryDataInput = z.object({
  schema:      z.string().min(2).max(63).describe('Dataset key from library_catalog'),
  fields:      z.array(z.string().min(1).max(63)).min(1).max(30).describe('Only the fields you need (agent-visible ones from the catalog)'),
  filters:     z.array(filterSchema).max(10).default([]).describe('Only on fields the catalog marks filterable'),
  search:      z.string().max(200).optional().describe('Full-text search over the title/body and searchable fields'),
  unposted_on: z.string().max(200).nullable().optional().describe('Resource ref (telegram:@x, instagram:123…) whose used rows to skip. Default: the resource you work on; null = include used rows'),
  order:       z.enum(ORDERS).default('random'),
  limit:       z.number().int().min(1).max(MAX_AGENT_LIMIT).default(5),
  full:        z.boolean().default(false).describe('Return long texts whole instead of cut at 2000 characters'),
});
export type QueryDataArgs = z.infer<typeof QueryDataInput>;

/** Run query_data for an agent (shared with the search_library wrapper). */
export async function runQueryData(d: DataToolDeps, i: QueryDataArgs, ctx: ToolContext) {
  const s = await activeSchema(d.pool, i.schema);
  if ('error' in s) return s;
  const unposted = i.unposted_on === undefined ? currentResource(ctx) : i.unposted_on;
  try {
    const r = await queryDataset(d.pool, s, {
      audience: 'agent', fields: i.fields, filters: i.filters, search: i.search, unpostedOn: unposted,
      order: i.order, limit: i.limit, full: i.full, today: (d.today ?? kyivMonthDay)(),
    });
    return {
      dataset: s.key, rows: r.rows,
      ...(r.truncated.length ? { truncated: r.truncated, note: 'long texts cut at 2000 characters; ask again with full: true and only that field if you need all of it' } : {}),
      ...(r.rows.length === 0 ? { note: unposted ? 'nothing left that is unposted here with these filters; loosen the filters or pick another dataset' : 'no rows match these filters' } : {}),
      ...(s.contains_personal_data ? { personal_data: true } : {}),
    };
  } catch (err) {
    if (err instanceof DataQueryError) return { error: err.code, details: err.message };
    throw err;
  }
}

export const EditSchemaInput = z.object({
  dataset:  z.string().min(2).max(63),
  target:   z.enum(['description', 'suitable_for', 'field']).describe('The dataset description, its suitable_for text, or one field\'s description'),
  field:    z.string().max(63).nullish().describe('Field name when target = field'),
  old_text: z.string().max(4000).describe('The current text, exactly as library_catalog shows it'),
  new_text: z.string().min(3).max(2000),
  evidence: z.string().min(20).max(1000).describe('Why: what you saw in the rows or in the results that the current text gets wrong or misses'),
});
export type EditSchemaArgs = z.infer<typeof EditSchemaInput>;

function currentText(s: DataSchema, i: Pick<EditSchemaArgs, 'target' | 'field'>): string | { error: string; details: string } {
  if (i.target === 'description') return s.description ?? '';
  if (i.target === 'suitable_for') return s.suitable_for ?? '';
  if (!i.field) return { error: 'field_required', details: 'name the field when target = field' };
  const f = s.fields.find((x) => x.name === i.field);
  if (!f) return { error: 'unknown_field', details: `dataset "${s.key}" has no field "${i.field}"` };
  return f.description ?? '';
}

/**
 * The owner's Apply of an `edit_data_schema` card: a description-only edit (never a version bump), refused
 * when the text changed since the agent read it.
 */
export async function applyDataSchemaSuggestion(store: DataStore, payload: Record<string, unknown>): Promise<{ dataset: string; version: number }> {
  const p = EditSchemaInput.parse(payload);
  const s = await store.requireSchema(p.dataset);
  const cur = currentText(s, p);
  if (typeof cur !== 'string') throw new DataStoreError('invalid', cur.details);
  if (cur.trim() !== p.old_text.trim()) throw new DataStoreError('conflict', 'stale: the text changed after the agent read it; ask for a fresh suggestion');
  const patch = p.target === 'description' ? { description: p.new_text }
    : p.target === 'suitable_for' ? { suitable_for: p.new_text }
    : { fields: s.fields.map((f) => (f.name === p.field ? { ...f, description: p.new_text } : f)) };
  const r = await store.updateSchema(s.key, patch, { changedBy: 'owner (agent suggestion)', reason: `agent suggestion: ${p.evidence}`.slice(0, 500) });
  if (r.diff.structural) throw new DataStoreError('invalid', 'a suggestion may only change descriptions');
  return { dataset: s.key, version: r.schema.version };
}

/** Last use and runway of one dataset on a resource (spec 023 FR-008). */
async function datasetUsage(pool: Pick<Pool, 'query'>, resource: string, key: string, unposted: number | undefined) {
  const [use, series] = await Promise.all([ledgerUsage(pool, resource), seriesLibraryUse(pool, resource)]);
  const u = use[key];
  return { last_used_here: u?.last ? u.last.toISOString() : null, runway_days: runwayDays(unposted, series[key] ?? 0, u?.used28 ?? 0) };
}

export function buildDataTools(d: DataToolDeps): EditorTool[] {
  const today = d.today ?? kyivMonthDay;
  const cache = new TtlCache<Awaited<ReturnType<typeof catalogOverview>>>();

  const libraryCatalog = defineTool({
    name: 'library_catalog',
    description: 'The content library. Without arguments: every dataset with what it holds, who it suits, its field names and numbers (rows, unposted here and network-wide, rows for today, top categories). With dataset: that dataset in full — every agent-visible field with type, description, filterable/searchable, allowed values and fill %, license and reuse rule. Read this first, choose a dataset by its description and numbers, then fetch only the fields you need with query_data.',
    kind: 'read', roles: [...READ_ROLES],
    input: z.object({ dataset: z.string().min(2).max(63).optional().describe('Full field details of this dataset') }),
    execute: async ({ dataset }, ctx) => {
      const resource = currentResource(ctx);
      if (dataset) {
        const entries = await buildCatalog(d.pool, { dataset, resource, today: today() });
        if (!entries.length) return { error: 'unknown_dataset', details: `no active dataset "${dataset}"` };
        const extra = resource ? await datasetUsage(d.pool, resource, entries[0].dataset, entries[0].unposted_here) : {};
        return { dataset: { ...entries[0], ...extra }, refs: 'rows come back with ref = data://<dataset>/<id>; put it into library_ref when you post from a row' };
      }
      // Spec 023 FR-008: plus the APIs (configured or not, never key values), the card's feeds, last use and runway here; cached 10 min.
      const card = ctx.extras?.card as { sources?: CardSource[] } | undefined;
      const c = await cache.get(`${resource ?? '-'}|${(card?.sources ?? []).map((s) => s.id).join(',')}`,
        () => catalogOverview(d.pool, { resource, env: d.env, feeds: card?.sources ?? null, today: today() }));
      return {
        datasets: c.datasets, apis: c.apis, feeds: c.feeds,
        next: 'call library_catalog({dataset}) for field descriptions, then query_data with only the fields you need; fetch_api / fetch_feed / get_network_highlights for the other sources',
      };
    },
  });

  const queryData = defineTool({
    name: 'query_data',
    description: 'Fetch rows of one dataset: only the fields you list (agent-visible ones), filters only on filterable fields (op: eq, in, ilike, gte, lte, between, is_null, today), rows already used on your resource skipped by default, ≤ 20 rows, long text cut at 2000 characters unless full: true. Each row has ref = data://<dataset>/<id> for library_ref.',
    kind: 'read', roles: [...READ_ROLES],
    input: QueryDataInput,
    execute: async (i, ctx) => runQueryData(d, i, ctx),
  });

  const editSchema = defineTool({
    name: 'edit_data_schema',
    description: 'Suggest a better description for a dataset, its suitable_for text or one field, when the rows show the current text is wrong or missing something. The owner applies it with one click; you never change fields, types or roles.',
    kind: 'act', roles: ['planner', 'executor', 'reviewer', 'composer', 'orchestrator', 'manager', 'builder'],
    input: EditSchemaInput,
    execute: async (i, ctx) => {
      if (!d.actions) return { error: 'not_available', details: 'suggestions are not wired in this context' };
      const s = await activeSchema(d.pool, i.dataset);
      if ('error' in s) return s;
      const cur = currentText(s, i);
      if (typeof cur !== 'string') return cur;
      if (i.target === 'field' && !readableFields(s, 'agent').some((f) => f.name === i.field)) {
        return { error: 'field_not_visible', details: `field "${i.field}" is not visible to agents` };
      }
      if (cur.trim() !== i.old_text.trim()) return { error: 'stale_text', details: `the current text is: ${cur.slice(0, 600)}` };
      if (cur.trim() === i.new_text.trim()) return { error: 'no_change', details: 'the new text equals the current one' };
      const { rows } = await d.pool.query(
        `SELECT 1 FROM pending_actions WHERE kind = 'edit_data_schema' AND status = 'pending'
            AND payload->>'dataset' = $1 AND payload->>'target' = $2 AND COALESCE(payload->>'field', '') = $3 LIMIT 1`,
        [i.dataset, i.target, i.field ?? '']);
      if (rows.length) return { error: 'already_suggested', details: 'a suggestion for this text already waits for the owner' };
      const x = ctx.extras as { chat?: { chatId?: string | null }; agent?: { id?: string }; onAction?: (a: PendingAction) => void } | undefined;
      const what = i.target === 'field' ? `${i.dataset}.${i.field}` : `${i.dataset} ${i.target === 'description' ? 'description' : 'suitable for'}`;
      const action = await d.actions.propose({
        chatId: x?.chat?.chatId ?? null, agentId: x?.agent?.id ?? null, kind: 'edit_data_schema',
        payload: { ...i, field: i.field ?? null },
        summary: `Edit ${what}: “${i.old_text.slice(0, 200) || '(empty)'}” → “${i.new_text.slice(0, 400)}”. Why: ${i.evidence.slice(0, 300)}`,
      });
      try { x?.onAction?.(action); } catch { /* UI stream only */ }
      return { ok: true, pending_action: action.id, note: 'The owner sees the suggestion on the dataset page (and in the chat) and applies or discards it.' };
    },
  });

  return [libraryCatalog, queryData, editSchema];
}
