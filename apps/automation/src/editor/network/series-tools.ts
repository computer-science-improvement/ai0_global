import { z } from 'zod';
import { defineTool, EditorTool, ToolContext } from '../harness/tool';
import type { EditorCard } from '../card';
import type { NetworkCtx } from './network-context';
import { Playbook, Series, SeriesSchema } from './playbook';
import { CadenceSchema, instancesPerDay, parseCadence, SERIES_SOURCE_MODES, seriesSourceLabel, SeriesSourceSchema } from './series';
import { agentDraft, networkMode, normalizePlaybook, submitPlaybookVersion, SubmitDeps } from './series-edit';

/**
 * The orchestrator's series tools (spec 023 FR-003): "building a strategy" becomes small, reviewable tool
 * calls on the playbook instead of a full rewrite. Each builds the next body from the agent's own pending
 * draft (or the active version) and goes through the one submit path (`submitPlaybookVersion`): the
 * playbook checks, the owner lock, the change classification with the resource's mode (spec 031: in
 * `approve` every schedule change is a card; a ≤ 90-min shift applies at once in shadow and live) and the
 * Inbox. `submit_playbook` stays for full rebuilds.
 */

export const MAX_SERIES_CHANGES_PER_RUN = 5;

export type SeriesToolDeps = SubmitDeps;

const SeriesFields = {
  cadence:      CadenceSchema.describe('daily@HH:MM[,HH:MM] або weekly:mon[,thu]@HH:MM[,…] — до 6 часів, час картки ресурсу'),
  resource_ref: z.string().min(3).max(200),
  format:       z.string().min(2).max(30),
  brief:        z.string().min(10).max(600),
  source:       SeriesSourceSchema.optional().describe('Джерело: {kind:"library", table} | {kind:"api", source, params} | {kind:"feed", ref} | {kind:"network_highlights", scope} | {kind:"free"}'),
  source_mode:  z.enum(SERIES_SOURCE_MODES).optional().describe('suggested (типово) або required'),
};

export const DefineSeriesInput = z.object({
  name:      z.string().min(3).max(80),
  ...SeriesFields,
  rationale: z.string().min(20).max(1500).describe('Чому ця серія: дані, бриф, директива'),
});

export const UpdateSeriesInput = z.object({
  name:      z.string().min(3).max(80),
  patch:     z.object({
    cadence: SeriesFields.cadence.optional(), resource_ref: SeriesFields.resource_ref.optional(), format: SeriesFields.format.optional(),
    brief: SeriesFields.brief.optional(), source: SeriesSourceSchema.nullable().optional().describe('null — прибрати джерело'),
    source_mode: z.enum(SERIES_SOURCE_MODES).optional(),
  }).refine((p) => Object.keys(p).length > 0, 'patch порожній'),
  rationale: z.string().min(20).max(1500),
});

function netOf(ctx: ToolContext): NetworkCtx {
  const n = ctx.extras?.network as NetworkCtx | undefined;
  if (!n) throw new Error('series tools need an orchestrator context');
  return n;
}

const seriesView = (s: Series) => ({
  name: s.name, cadence: s.cadence, resource_ref: s.resource_ref, format: s.format, brief: s.brief, active: s.active !== false,
  source: s.source ? seriesSourceLabel(s.source) : null, source_mode: s.source_mode ?? 'suggested',
  origin: s.origin ?? 'agent', locked: !!s.locked, per_day: Number(instancesPerDay(parseCadence(s.cadence) ?? { days: [], times: [] }).toFixed(2)),
  ...(s.migrated_from ? { migrated_from: s.migrated_from } : {}),
});

export function buildSeriesTools(d: SeriesToolDeps): EditorTool[] {
  const changes = new Map<string, number>();

  /** The body the change builds on: the agent's own pending draft, else the active version. */
  async function base(net: NetworkCtx): Promise<{ body: Playbook; fromDraft: boolean } | { error: string; details: string }> {
    const draft = await agentDraft(d, net);
    if ('error' in draft) return draft;
    if (draft.draft) return { body: normalizePlaybook(draft.draft.body), fromDraft: true };
    if (!net.playbook) return { error: 'no_playbook', details: 'плейбука ще немає — спершу submit_playbook' };
    return { body: normalizePlaybook(net.playbook), fromDraft: false };
  }

  /** Count a mutating call; refuse the sixth in one run. */
  function budget(ctx: ToolContext): { error: string; details: string } | null {
    const n = (changes.get(ctx.runId) ?? 0) + 1;
    changes.set(ctx.runId, n);
    if (changes.size > 500) changes.delete(changes.keys().next().value!);
    return n > MAX_SERIES_CHANGES_PER_RUN ? { error: 'too_many_series_changes', details: `не більше ${MAX_SERIES_CHANGES_PER_RUN} змін серій за прогін` } : null;
  }

  const lockedError = (name: string) => ({
    error: 'series_locked',
    details: `серію «${name}» заблокував власник — не змінюй її; якщо зміна потрібна, поясни це в підсумку прогону (finish_orchestration)`,
  });

  /** Change one series in the base body and submit it. */
  async function mutate(ctx: ToolContext, name: string, rationale: string, fn: (series: Series[], net: NetworkCtx) => Series[] | { error: string; details: string }) {
    const over = budget(ctx);
    if (over) return over;
    const net = netOf(ctx);
    const active = net.playbook ? normalizePlaybook(net.playbook) : null;
    if (active?.series.find((s) => s.name === name)?.locked) return lockedError(name);
    const b = await base(net);
    if ('error' in b) return b;
    const next = fn(b.body.series.map((s) => ({ ...s })), net);
    if (!Array.isArray(next)) return next;
    const res = await submitPlaybookVersion(d, net, ctx, { ...b.body, series: next }, rationale);
    if ('error' in res) return res;
    return {
      ok: true, version: res.version, status: res.status, applied: res.status === 'active', changes: res.changes,
      note: res.status === 'active' ? 'застосовано одразу' : 'структурна зміна (або режим апруву) — чекає рішення власника',
      ...(b.fromDraft ? { based_on: 'твоя чернетка, що чекає власника' } : {}),
    };
  }

  const listSeries = defineTool({
    name: 'list_series',
    description: 'Серії мережі: розклад, ресурс, формат, джерело, хто створив (agent | owner | migration) і чи заблоковані власником; та чернетка, що чекає власника. Заблоковані (locked) серії змінювати не можна.',
    kind: 'read', roles: ['orchestrator', 'planner', 'manager'],
    input: z.object({}),
    execute: async (_i, ctx) => {
      const net = netOf(ctx);
      const card = (ctx.extras?.card as EditorCard | undefined) ?? null;
      const draft = await agentDraft(d, net);
      const active = net.playbook ? normalizePlaybook(net.playbook) : null;
      return {
        mode: networkMode(net, card), timezone: card?.timezone ?? 'Europe/Kyiv',
        active_version: net.playbookVersion, series: (active?.series ?? []).map(seriesView),
        pending: 'error' in draft ? { blocked: draft.error }
          : draft.draft ? { version: draft.draft.version, series: normalizePlaybook(draft.draft.body).series.map(seriesView) } : null,
        rules: `Зміна часу ≤ 90 хв у ті самі дні й нове джерело того ж типу застосовуються одразу (у режимі апруву — через власника). Нова/прибрана серія, інші дні, кількість часів, ресурс, формат, тип джерела — на затвердження. Не більше ${MAX_SERIES_CHANGES_PER_RUN} змін за прогін.`,
      };
    },
  });

  const defineSeries = defineTool({
    name: 'define_series',
    description: 'Створити нову серію (рубрику) у плейбуку: розклад, ресурс, формат, бриф і (необовʼязково) джерело. Нова серія — структурна зміна: піде власнику на затвердження.',
    kind: 'act', roles: ['orchestrator'],
    input: DefineSeriesInput,
    execute: async (i, ctx) => mutate(ctx, i.name, i.rationale, (series) => {
      if (series.some((s) => s.name === i.name)) return { error: 'series_exists', details: `серія «${i.name}» вже є — update_series` };
      const s = SeriesSchema.parse({
        name: i.name, cadence: i.cadence, resource_ref: i.resource_ref, format: i.format, brief: i.brief,
        ...(i.source ? { source: i.source } : {}), source_mode: i.source_mode ?? 'suggested', active: true,
      });
      return [...series, s];
    }),
  });

  const updateSeries = defineTool({
    name: 'update_series',
    description: 'Змінити серію: розклад, ресурс, формат, бриф, джерело або режим джерела. Зсув часу ≤ 90 хв у ті самі дні й нове джерело того ж типу — одразу (у режимі апруву — через власника); інше — на затвердження.',
    kind: 'act', roles: ['orchestrator'],
    input: UpdateSeriesInput,
    execute: async (i, ctx) => mutate(ctx, i.name, i.rationale, (series) => {
      const idx = series.findIndex((s) => s.name === i.name);
      if (idx < 0) return { error: 'series_not_found', details: `серії «${i.name}» немає — list_series` };
      const { source, ...rest } = i.patch;
      const next: Series = { ...series[idx], ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) } as Series;
      if (source === null) delete (next as Partial<Series>).source;
      else if (source !== undefined) next.source = source;
      series[idx] = next;
      return series;
    }),
  });

  const setSeriesActive = defineTool({
    name: 'set_series_active',
    description: 'Поставити серію на паузу (active: false) або відновити. Так виконується директива менеджера pause_series. У режимі апруву — через власника.',
    kind: 'act', roles: ['orchestrator'],
    input: z.object({ name: z.string().min(3).max(80), active: z.boolean(), reason: z.string().min(10).max(800) }),
    execute: async (i, ctx) => mutate(ctx, i.name, i.reason.length >= 20 ? i.reason : `${i.active ? 'Відновлення' : 'Пауза'} серії: ${i.reason}`, (series) => {
      const idx = series.findIndex((s) => s.name === i.name);
      if (idx < 0) return { error: 'series_not_found', details: `серії «${i.name}» немає — list_series` };
      if ((series[idx].active !== false) === i.active) return { error: 'no_change', details: `серія вже ${i.active ? 'активна' : 'на паузі'}` };
      series[idx] = { ...series[idx], active: i.active };
      return series;
    }),
  });

  const retireSeries = defineTool({
    name: 'retire_series',
    description: 'Прибрати серію з плейбука (структурна зміна — власнику на затвердження). Для тимчасової зупинки краще set_series_active.',
    kind: 'act', roles: ['orchestrator'],
    input: z.object({ name: z.string().min(3).max(80), reason: z.string().min(20).max(800) }),
    execute: async (i, ctx) => mutate(ctx, i.name, i.reason, (series) => {
      if (!series.some((s) => s.name === i.name)) return { error: 'series_not_found', details: `серії «${i.name}» немає — list_series` };
      return series.filter((s) => s.name !== i.name);
    }),
  });

  return [listSeries, defineSeries, updateSeries, setSeriesActive, retireSeries];
}
