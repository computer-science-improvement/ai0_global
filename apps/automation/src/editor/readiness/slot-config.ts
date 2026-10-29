/**
 * Spec 073 FR-009 / FR-010: the slot's config check.
 *
 * A slot can go wrong in two different ways. Its CONTENT can be bad (the writer wrote a weak post: the ladder retries, the
 * breaker counts), or its CONFIGURATION can be wrong (the slot asks for something the channel cannot do: a series that is gone,
 * a format the series does not have, a source that does not exist). No rewrite fixes the second kind, so it is its own skip
 * class `config`: it never counts toward the dead-series breaker, never runs the fallback ladder and never puts a row aside.
 *
 * This file holds the single list of those codes (`CONFIG_FAILURE_CODES`, `isConfigCode`) and the pure checker that finds them
 * before a paid run (`checkSlotConfig`) with the pure repair of the two that code can fix (`repairSlotConfig`, `isRepairable`).
 * It imports nothing that imports `silent/skip-reasons.ts`, so the skip classification can read the list without a cycle.
 * The 072 doctor, the 074 repair and the 077 bring-up call the same functions; the context they need comes from
 * `ScheduleService.slotConfigContext`, which reads and never writes.
 */
import type { Series } from '../network/playbook';
import { datasetFormat, type SeriesSourceCatalog } from '../network/series';
import { sourceHints } from '../schedule/series-guard';
import { API_SOURCE_NAMES } from '../tools/api-adapters/names';

/** The slot errors that are a config problem: the checker's codes, the publish-time guards, and the skeleton check's instance codes. */
export const CONFIG_FAILURE_CODES = [
  'config_series_gone', 'config_format_mismatch', 'config_source_mismatch', 'config_source_missing', 'config_tools_missing',
  'series_format_mismatch', 'series_source_mismatch', 'preflight_format_unavailable',
  'series_format_unavailable', 'series_in_quiet_hours',
] as const;
export type ConfigFailureCode = typeof CONFIG_FAILURE_CODES[number];

const CONFIG = new Set<string>(CONFIG_FAILURE_CODES);

/** The single source for 072, 074 and 076: is this code a config failure? */
export const isConfigCode = (code: string | null | undefined): boolean => !!code && CONFIG.has(code);

/** The two problems the runner fixes in place at $0 (the format and the source hints); every other one skips the slot. */
const REPAIRABLE = new Set<string>(['config_format_mismatch', 'config_source_mismatch']);

/** True only for `config_format_mismatch` and `config_source_mismatch` (I5). At the 072 merge the lead also exposes it as `AUTO_SAFE_RUN_REPAIRS`. */
export const isRepairable = (code: string | null | undefined): boolean => !!code && REPAIRABLE.has(code);

/**
 * One problem of a slot or a plan. `detail` is ONE English line (A53); the owner's Ukrainian text comes from the catalogue.
 * `series` names the series the problem is about and `at` (ISO) the instance, for the problems that are per instance.
 */
export type ConfigProblem = { code: string; detail: string; series?: string; at?: string };

/** The slot fields the check reads (an `EditorSlot` fits, with `seriesName` from `slotSeriesOf`: the column, else the `series:` hint). */
export interface SlotConfigSlot {
  channelKey:      string;
  resourceRef:     string | null;
  format:          string;
  seriesName:      string | null;
  sourceHints:     readonly string[];
  scheduleRuleId?: string | null;
}

/** Everything the check needs besides the slot; `null` for a field means "unknown", and that check is skipped. */
export interface SlotConfigCtx {
  /** The playbook's full series list, INACTIVE ones included; null = unknown (no orchestrator, no playbook). */
  series:    ReadonlyArray<Pick<Series, 'name' | 'resource_ref' | 'format' | 'active' | 'source' | 'source_mode'>> | null;
  /** The library datasets and card feeds a source may name, as `seriesSourceErrors` reads them. */
  catalog:   SeriesSourceCatalog | null;
  /** The executor's tool names after the loadout and the card's allow list; null = unknown, `config_tools_missing` is skipped. */
  tools:     ReadonlySet<string> | null;
  /** Spec 071: the next row of a required library source that goes in order. */
  nextRow?:  string | null;
  /** The required source's unposted count: `empty` when nothing is left, `ok` when something is, null when unknown or not a required library source. */
  material?: 'ok' | 'empty' | null;
}

/** I13: the read tools each source kind needs (any one of them is enough); `config_tools_missing` and 072 / 077 read this one map. */
export const SOURCE_READ_TOOLS: Readonly<Record<'library' | 'feed' | 'api' | 'network_highlights', readonly string[]>> = {
  library:            ['query_data', 'search_library'],
  feed:               ['fetch_feed', 'web_fetch'],
  api:                ['fetch_api'],
  network_highlights: ['get_network_highlights'],
};

type CtxSeries = NonNullable<SlotConfigCtx['series']>[number];

/** The series a slot is an instance of: by name and resource first, then by name alone (the same order as `seriesForSlot`). */
export function resolveSeries(slot: Pick<SlotConfigSlot, 'channelKey' | 'resourceRef' | 'seriesName'>, ctx: Pick<SlotConfigCtx, 'series'>): CtxSeries | null {
  if (!slot.seriesName || !ctx.series) return null;
  const ref = slot.resourceRef ?? `telegram:${slot.channelKey}`;
  return ctx.series.find((s) => s.name === slot.seriesName && s.resource_ref === ref) ?? ctx.series.find((s) => s.name === slot.seriesName) ?? null;
}

const URL_HINT = /^https?:\/\//i;
const DATA_HINT = /^data:\/\/([a-z][a-z0-9_]{1,62})\//i;
const TABLE_HINT = /^library:(?!\/\/)([^/\s]+)/i;

/** The hints of a slot that point somewhere else than the required dataset: a URL, a row of another dataset, `library:<other>`. */
function strayHints(hints: readonly string[], table: string): string[] {
  return hints.map((h) => h.trim()).filter((h) => {
    if (URL_HINT.test(h)) return true;
    const ds = DATA_HINT.exec(h)?.[1] ?? TABLE_HINT.exec(h)?.[1] ?? null;
    return ds !== null && ds !== table;
  });
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What is wrong with a series' source, in one English line (null = fine): the same rules `seriesSourceErrors` applies at save
 * time (a test keeps the two in step), worded for the slot's error text.
 */
function sourceProblem(s: CtxSeries, cat: SeriesSourceCatalog | null): string | null {
  const src = s.source;
  if (!src) return null;
  if (src.kind === 'api' && !(API_SOURCE_NAMES as readonly string[]).includes(src.source)) return `API ${src.source} does not exist`;
  if (!cat) return null;
  if (src.kind === 'library') {
    if (!cat.tables.includes(src.table)) return `dataset ${src.table} does not exist in the library`;
    const entity = cat.entities?.[src.table];
    const need = datasetFormat(entity);
    if (need && need !== s.format) return `dataset ${src.table} (${entity}) is posted as ${need}, not ${s.format}`;
  }
  if (src.kind === 'feed' && !cat.feeds.includes(src.ref)) return `feed ${src.ref} is not in the channel card`;
  return null;
}

/**
 * Spec 073 FR-009: what is wrong with a slot's CONFIGURATION, in this order. A slot that names no series (an improvised slot, a
 * pin without a series) has nothing to check, and so has a slot whose series list is unknown (`ctx.series === null`).
 *   1. `config_series_gone`: the series is missing from the playbook or switched off. Nothing else is checked then.
 *   2. `config_format_mismatch`: the slot's format is not the series' format. Repairable.
 *   3. `config_source_mismatch`: a `required` library series whose hints name a URL or another dataset. Repairable.
 *   4. `config_source_missing`: the source does not exist, or its dataset is posted in another format than the series.
 *   5. `config_tools_missing`: the executor has none of the tools the source kind reads with (`SOURCE_READ_TOOLS`).
 *   6. `preflight_no_material`: the required library source has nothing left. It stays in the material class (L4): the dead-series
 *      breaker counts it, so this module only reports it.
 * A breaker pause is not a problem here: it lives in `series_pauses` and skips planned slots on its own path (A4).
 */
export function checkSlotConfig(slot: SlotConfigSlot, ctx: SlotConfigCtx): ConfigProblem[] {
  if (!slot.seriesName || ctx.series === null) return [];
  const s = resolveSeries(slot, ctx);
  const name = slot.seriesName;
  if (!s || s.active === false) {
    return [{ code: 'config_series_gone', detail: `series "${name}" is ${s ? 'switched off' : 'not in the playbook'}`, series: name }];
  }
  const out: ConfigProblem[] = [];
  const add = (code: string, detail: string) => out.push({ code, detail, series: name });
  if (slot.format !== s.format) add('config_format_mismatch', `slot format ${slot.format} differs from series "${name}" format ${s.format}`);
  const src = s.source;
  if (s.source_mode === 'required' && src?.kind === 'library') {
    const stray = strayHints(slot.sourceHints, src.table);
    if (stray.length) add('config_source_mismatch', `series "${name}" requires library:${src.table}; the slot hints name ${clip(stray.slice(0, 2).join(', '), 120)}`);
  }
  const bad = sourceProblem(s, ctx.catalog);
  if (bad) add('config_source_missing', `series "${name}": ${bad}`);
  if (ctx.tools && src && src.kind !== 'free') {
    const need = SOURCE_READ_TOOLS[src.kind];
    if (!need.some((t) => ctx.tools!.has(t))) add('config_tools_missing', `series "${name}" reads ${src.kind}; the executor has none of ${need.join(', ')}`);
  }
  if (ctx.material === 'empty' && s.source_mode === 'required' && src?.kind === 'library') {
    add('preflight_no_material', `series "${name}": required source library:${src.table} has nothing left on ${slot.resourceRef ?? `telegram:${slot.channelKey}`}`);
  }
  return out;
}

/**
 * The fix for the repairable problems among `problems` (A7): the series' format, and the hints `series:<name>` plus the next
 * row (else `library:<table>`, as the series itself writes it). `{ note: '' }` means nothing to repair. `note` is one English
 * line that starts with the codes.
 */
export function repairSlotConfig(slot: SlotConfigSlot, problems: readonly ConfigProblem[], ctx: SlotConfigCtx): { format?: string; sourceHints?: string[]; note: string } {
  const s = resolveSeries(slot, ctx);
  if (!s) return { note: '' };
  let format: string | undefined;
  let hints: string[] | undefined;
  const notes: string[] = [];
  for (const p of problems) {
    if (p.code === 'config_format_mismatch' && slot.format !== s.format) {
      format = s.format;
      notes.push(`config_format_mismatch: ${slot.format} → ${s.format}`);
    } else if (p.code === 'config_source_mismatch' && s.source?.kind === 'library') {
      hints = [`series:${s.name}`, ...(ctx.nextRow ? [ctx.nextRow] : sourceHints(s.source))];
      notes.push(`config_source_mismatch: hints → ${hints.join(', ')}`);
    }
  }
  return { ...(format ? { format } : {}), ...(hints ? { sourceHints: hints } : {}), note: notes.join('; ') };
}
