/**
 * Spec 073 FR-009 / FR-010: the slot's config check.
 *
 * A slot can go wrong in two different ways. Its CONTENT can be bad (the writer wrote a weak post: the ladder retries, the
 * breaker counts), or its CONFIGURATION can be wrong (the slot asks for something the channel cannot do: a series that is gone,
 * a format the series does not have, a source that does not exist). No rewrite fixes the second kind, so it is its own skip
 * class `config`: it never counts toward the dead-series breaker, never runs the fallback ladder and never puts a row aside.
 *
 * This file holds the single list of those codes (`CONFIG_FAILURE_CODES`, `isConfigCode`); the checker that finds them before
 * a paid run (`checkSlotConfig`, `repairSlotConfig`) is added to it by spec 073 T12. It imports nothing that imports
 * `silent/skip-reasons.ts`, so the skip classification can read the list without a cycle.
 */

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
