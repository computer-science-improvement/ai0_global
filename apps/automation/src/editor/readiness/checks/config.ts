import type { Platform } from '../../agents/agent.types';
import { configConflicts, type ConfigConflict } from '../../rules/config-conflicts';
import { findingKey } from '../../sysadmin/audit-text';
import type { AuditSeverity, Finding } from '../../sysadmin/audit.types';
import { doctorReason, resolveLink } from '../codes';
import { mkFinding } from '../finding';
import type { ChannelFacts } from '../facts.types';
import { checkPlanSkeleton, type SkeletonResource } from '../plan-skeleton';
import { checkSlotConfig, isConfigCode, isRepairable, type ConfigProblem } from '../slot-config';
import type { DoctorCheck } from './index';

/**
 * Spec 072 FR-003.4, FR-012, A8, A18, L8, I5: the configuration. Owner rules against the card and the profile
 * (`configConflicts`, this channel's own resource only), the hashtag minimum with nothing to take hashtags from, a card and a
 * playbook section that enable different formats, and the seam where 073's checks of the plan and of the slots plug in.
 */

export type { ConfigProblem };

/**
 * 073's checks of the plan and of the slots, as the doctor reads them (L8, I5, I6). The seam keeps the check testable with a stub;
 * `configSeam` is the real one, wired at the 073 × 072 merge:
 *   - `planSkeleton`: `checkPlanSkeleton` over the channel's series and the resources the loader filled through
 *     `skeletonResourcesOf` (a resource without `formats` is left out; the per-day maximum needs none). 073 owns
 *     `series_format_unavailable`, `series_in_quiet_hours` and `series_rate_over_card_max`: the doctor has no check of its own for them.
 *   - `slotConfig`: `checkSlotConfig` over today's and tomorrow's planned slots, with the read-only context the loader took from
 *     `ScheduleService.slotConfigContext` (no tools: `tools_missing_for_source` is the doctor's). Only config codes come through;
 *     `preflight_no_material` is material, and the material check says it per dataset.
 *   - `isRepairable`: 073's (`AUTO_SAFE_RUN_REPAIRS`): the runner repairs such a slot before the run, so it is only info.
 */
export interface ConfigSeam {
  planSkeleton(f: ChannelFacts): ConfigProblem[];
  slotConfig(f: ChannelFacts): Array<{ slotId: string; problems: ConfigProblem[] }>;
  isRepairable(p: ConfigProblem): boolean;
}

/** The facts' resources as the skeleton check takes them: only those the loader gave producible formats. */
export const skeletonResourcesOfFacts = (f: Pick<ChannelFacts, 'resources'>): SkeletonResource[] =>
  f.resources.flatMap((r) => (r.formats ? [{ ref: r.ref, platform: r.platform as Platform, formats: r.formats, ...(r.tz ? { tz: r.tz } : {}), ...(r.quiet ? { quiet: r.quiet } : {}) }] : []));

export const configSeam: ConfigSeam = {
  planSkeleton: (f) => checkPlanSkeleton(f.card, f.playbook?.body ?? null, f.series, skeletonResourcesOfFacts(f)),
  slotConfig: (f) => f.planned.flatMap((p) => {
    if (!p.configCtx) return [];
    const problems = checkSlotConfig(
      { channelKey: f.channelKey, resourceRef: p.resourceRef, format: p.format, seriesName: p.seriesName, sourceHints: p.sourceHints, scheduleRuleId: p.scheduleRuleId },
      p.configCtx,
    ).filter((x) => isConfigCode(x.code));
    return problems.length ? [{ slotId: p.id, problems }] : [];
  }),
  isRepairable: (p) => isRepairable(p.code),
};

/**
 * How bad a seam problem is when it is not repairable. A gone series is not a miss (the owner removed it; the slot is skipped at $0
 * and nothing is lost), so it is info; a series that posts more often than the card's daily maximum is a warning, because the
 * maximum is raised to the series (spec 073: the series is authoritative). Every other config problem stops a post: an error.
 */
const SEAM_SEVERITY: Readonly<Record<string, AuditSeverity>> = { config_series_gone: 'info', series_rate_over_card_max: 'warn' };

const humanise = (code: string) => { const s = code.replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

/**
 * A finding for a problem of 073's. Its code is 073's: the title and the link come from the one catalogue (a code with no entry
 * gets its own words as the title and the Schedule tab).
 */
function seamFinding(f: ChannelFacts, p: ConfigProblem, seam: ConfigSeam, slotId?: string): Finding {
  const repairable = seam.isRepairable(p);
  const severity: AuditSeverity = repairable ? 'info' : SEAM_SEVERITY[p.code] ?? 'error';
  const subject = {
    type: 'channel' as const, id: `${p.code}:${slotId ?? p.series ?? ''}:${p.at ?? ''}`, label: p.series ?? humanise(p.code),
    ...(f.agent ? { agent: f.agent.handle } : {}), channel: f.channelKey,
  };
  const link = resolveLink(doctorReason(p.code)?.link ?? '/app/agents/:agent?tab=schedule', { channel: f.channelKey, agent: f.agent?.handle, series: p.series });
  const repair = repairable ? ' It will be repaired before the run.' : p.code === 'config_series_gone' ? ' The slot is skipped at no cost.' : '';
  return {
    key: findingKey('channel', p.code, subject), area: 'channel', check: p.code, severity, subject,
    title: doctorReason(p.code)?.en ?? humanise(p.code), detail: `${p.detail}${repair}`,
    evidence: { problem: p.code, ...(p.series ? { series: p.series } : {}), ...(p.at ? { at: p.at } : {}), ...(slotId ? { slot: slotId } : {}) },
    ...(link ? { link } : {}),
  };
}

/** `hashtag_min_without_vocabulary` is the doctor's own check and keeps its own code. */
const OWN_CODE = 'hashtag_min_without_vocabulary';

/** The conflicts of this channel's resource; a sibling resource of the group shows on its own panel (A18). */
const ownConflicts = (f: ChannelFacts): ConfigConflict[] => configConflicts(f.conflictInput).filter((c) => c.ref === f.resourceRef);

export function makeConfigCheck(seam: ConfigSeam = configSeam): DoctorCheck {
  return {
    code: 'config_conflict',
    run(f: ChannelFacts): Finding[] {
      const out: Finding[] = [];
      const conflicts = ownConflicts(f);

      // hashtag_min_without_vocabulary: the minimum cannot be met.
      const hashtag = conflicts.find((c) => c.code === OWN_CODE);
      if (hashtag) {
        out.push(mkFinding(f, {
          code: 'hashtag_min_without_vocabulary', severity: 'error', subject: { type: 'channel', id: f.channelKey, label: 'Hashtag minimum' },
          detail: hashtag.detail,
          evidence: { hashtag_min: f.card.hashtagMin, hashtags: f.card.hashtags.length },
          fix: { kind: 'hashtag_min_zero', channel: f.channelKey },
        }));
      }

      // config_conflict: one finding per (code, rule); the same code twice for one rule (three tones) is one finding.
      const groups = new Map<string, ConfigConflict[]>();
      for (const c of conflicts) {
        if (c.code === OWN_CODE) continue;
        const id = `${c.code}:${c.ref}:${c.rule_id ?? ''}`;
        groups.set(id, [...(groups.get(id) ?? []), c]);
      }
      for (const [id, list] of groups) {
        const first = list[0];
        out.push(mkFinding(f, {
          code: 'config_conflict', severity: 'warn',
          subject: { type: first.rule_id !== undefined ? 'rule' : 'channel', id, label: `${humanise(first.code)}${first.rule_id !== undefined ? ` (rule #${first.rule_id})` : ''}` },
          detail: list.map((c) => c.detail).join(' '),
          evidence: { conflict: first.code, ref: first.ref, ...(first.rule_id !== undefined ? { rule_id: first.rule_id } : {}), details: list.map((c) => c.detail), fixes: list.map((c) => c.fix) },
          ...(f.agent ? { fix: { kind: 'conflicts_resolve' as const, agent: f.agent.handle, codes: [first.code], channel: f.channelKey } } : {}),
        }));
      }

      // formats_diverge: in an independent group the card and the playbook section are two lists nothing keeps equal.
      const section = f.playbook?.body.platforms.find((p) => p.resource_ref === f.resourceRef);
      if (f.group?.mode === 'independent' && section) {
        const names = [...new Set([...Object.keys(f.card.formats), ...Object.keys(section.formats)])].sort();
        for (const name of names) {
          const card = f.card.formats[name] ?? 0;
          const book = section.formats[name] ?? 0;
          if ((card > 0) === (book > 0)) continue;
          out.push(mkFinding(f, {
            code: 'formats_diverge', severity: 'warn', subject: { type: 'playbook', id: name, label: name },
            detail: card > 0
              ? `The card enables the format ${name} (weight ${card}), but the playbook section of ${f.resourceRef} does not list it.`
              : `The playbook section of ${f.resourceRef} enables the format ${name} (weight ${book}), but the card does not.`,
            evidence: { format: name, card_weight: card, playbook_weight: book, group: f.group.name },
          }));
        }
      }

      // 073's checks of the plan and of the slots (L8, I5): info when the problem is repaired before the run (`SEAM_SEVERITY`).
      for (const p of seam.planSkeleton(f)) out.push(seamFinding(f, p, seam));
      for (const { slotId, problems } of seam.slotConfig(f)) {
        for (const p of problems) out.push(seamFinding(f, p, seam, slotId));
      }
      return out;
    },
  };
}

export const configCheck: DoctorCheck = makeConfigCheck();
