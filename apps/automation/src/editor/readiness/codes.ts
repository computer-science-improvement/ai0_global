import { reasonFor, type ReasonEntry } from '../reasons/catalogue';

/**
 * Spec 072 FR-001: the reason codes the channel doctor emits. Their texts live in the ONE reason catalogue of spec 073
 * (`reasons/catalogue.ts`, mirrored for the dashboard in `apps/dashboard/src/lib/reasons.ts`); this file names which codes are
 * the doctor's and keeps 072's link helper. Swapped from a local copy at the 073 × 072 merge (lead).
 *
 * `en` is the finding's title in the dashboard, `uk` the owner bot's line; `fix` is one sentence: what to change. The detail
 * line of a finding (which skill, which dataset, which number) is made by its check; the catalogue holds what does not vary.
 * `source_unreachable` is a skip class and a pause cause, never a doctor code, so it is not in `DOCTOR_CODES`.
 */
export type { ReasonEntry };

/** The placeholders a link template may hold. */
export const LINK_PLACEHOLDERS = ['channel', 'agent', 'dataset', 'series'] as const;

/**
 * The codes the doctor's checks emit, and the service's `auto_fixed` (A20). Each has a catalogue entry of kind `doctor`, except
 * `series_paused`, which is the same code as the slot's skip reason (kind `skip`) and shares its entry.
 */
export const DOCTOR_CODES = [
  'series_source_contradicted', 'origin_original_with_source', 'skill_prescribes_source', 'dataset_without_series', 'series_source_not_required',
  'dataset_post_requires_missing', 'dataset_low_fill', 'material_exhausted', 'material_low', 'dataset_order_random',
  'tools_missing_for_source', 'hashtag_min_without_vocabulary', 'config_conflict', 'formats_diverge',
  'series_paused', 'series_paused_by_owner', 'pause_cause_gone', 'playbook_draft_waiting', 'bot_not_admin', 'auto_fixed',
  // 076's source checks (`checks/sources.ts` wraps `sources/source-findings.ts`, lead S8): kind `doctor` in the catalogue too.
  'source_probe_failed', 'source_empty', 'source_untested', 'card_without_sources', 'dataset_resync_manual',
] as const;

/** The catalogue entries of the doctor's codes, in `DOCTOR_CODES` order (a code without an entry throws at load: a test pins it). */
export const DOCTOR_REASONS: ReasonEntry[] = DOCTOR_CODES.map((code) => {
  const e = reasonFor(code);
  if (!e) throw new Error(`doctor code ${code} has no entry in reasons/catalogue.ts`);
  return e;
});

/**
 * The catalogue entry of a code a finding carries: the doctor's own codes and the codes that reach it from the other specs (073's
 * config problems through the config seam, 076's source codes). Undefined = not in the catalogue.
 */
export const doctorReason = (code: string): ReasonEntry | undefined => reasonFor(code);

/** Values for the placeholders of a link template. */
export type LinkValues = Partial<Record<typeof LINK_PLACEHOLDERS[number], string | null | undefined>>;

/**
 * A link template with its placeholders filled; each value is URL-encoded. A placeholder with no value makes the link
 * unusable, so the result is null (a finding without a link shows no Open button).
 */
export function resolveLink(template: string | undefined | null, values: LinkValues): string | null {
  if (!template) return null;
  let missing = false;
  const out = template.replace(/:(channel|agent|dataset|series)\b/g, (_m, name: typeof LINK_PLACEHOLDERS[number]) => {
    const v = values[name];
    if (v == null || v === '') { missing = true; return ''; }
    return encodeURIComponent(v);
  });
  return missing ? null : out;
}
