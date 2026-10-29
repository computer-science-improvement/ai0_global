import { configConflicts, type ConfigConflict } from '../../rules/config-conflicts';
import { findingKey } from '../../sysadmin/audit-text';
import type { AuditSeverity, Finding } from '../../sysadmin/audit.types';
import { doctorReason, resolveLink } from '../codes';
import { mkFinding } from '../finding';
import type { ChannelFacts } from '../facts.types';
import type { DoctorCheck } from './index';

/**
 * Spec 072 FR-003.4, FR-012, A8, A18, L8, I5: the configuration. Owner rules against the card and the profile
 * (`configConflicts`, this channel's own resource only), the hashtag minimum with nothing to take hashtags from, a card and a
 * playbook section that enable different formats, and the seam where 073's checks of the plan and of the slots plug in.
 */

/** Copy of 073's `ConfigProblem` (the lead swaps it for the import at merge) with the two fields that tell problems apart (L8). */
export type ConfigProblem = { code: string; detail: string; series?: string; at?: string };

/**
 * 073's seam. In W1 every function returns the empty answer. At merge the lead points `planSkeleton` at
 * `checkPlanSkeleton(f.card, f.playbook?.body ?? null, f.series, f.resources)`, `slotConfig` at `checkSlotConfig(slot, ctx)` over
 * `f.planned`, and `isRepairable` at 073's `isRepairable` (I5): a repairable problem is fixed before the run, so it is only info.
 */
export interface ConfigSeam {
  planSkeleton(f: ChannelFacts): ConfigProblem[];
  slotConfig(f: ChannelFacts): Array<{ slotId: string; problems: ConfigProblem[] }>;
  isRepairable(p: ConfigProblem): boolean;
}

export const configSeam: ConfigSeam = {
  planSkeleton: () => [],
  slotConfig: () => [],
  isRepairable: () => false,
};

const humanise = (code: string) => { const s = code.replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

/** A finding for a problem of 073's: its code is 073's, not in the doctor's catalogue, so the title falls back to the code. */
function seamFinding(f: ChannelFacts, p: ConfigProblem, severity: AuditSeverity, slotId?: string): Finding {
  const subject = {
    type: 'channel' as const, id: `${p.code}:${slotId ?? p.series ?? ''}:${p.at ?? ''}`, label: p.series ?? humanise(p.code),
    ...(f.agent ? { agent: f.agent.handle } : {}), channel: f.channelKey,
  };
  const link = resolveLink('/app/agents/:agent?tab=schedule', { channel: f.channelKey, agent: f.agent?.handle });
  const repair = severity === 'info' ? ' It will be repaired before the run.' : '';
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
          ...(f.agent && first.code !== 'poll_series_over_cap'
            ? { fix: { kind: 'conflicts_resolve' as const, agent: f.agent.handle, codes: [first.code], channel: f.channelKey } } : {}),
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

      // 073's checks of the plan and of the slots (L8, I5): an error, or info when the problem is repaired before the run.
      for (const p of seam.planSkeleton(f)) out.push(seamFinding(f, p, seam.isRepairable(p) ? 'info' : 'error'));
      for (const { slotId, problems } of seam.slotConfig(f)) {
        for (const p of problems) out.push(seamFinding(f, p, seam.isRepairable(p) ? 'info' : 'error', slotId));
      }
      return out;
    },
  };
}

export const configCheck: DoctorCheck = makeConfigCheck();
