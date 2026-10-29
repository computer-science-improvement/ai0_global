import { originWithSource, sourceInSkill } from '../../agents/skill-warnings';
import { seriesSourceLabel } from '../../network/series';
import type { Finding } from '../../sysadmin/audit.types';
import { agentHandleOf, mkFinding } from '../finding';
import type { ChannelFacts, SkillFact } from '../facts.types';
import { seriesSourceContradictions, SOURCE_SERIES_KINDS, type Candidate, type FeedUrlOf } from '../source-contradiction';
import type { DoctorCheck } from './index';

/**
 * Spec 072 FR-003.1: the texts that steer the writer against the source the channel is bound to. A skill, an owner rule or a
 * steering line that sends the writer elsewhere (`series_source_contradicted`), a skill that tells it to mark library or feed
 * material as its own (`origin_original_with_source`) and a skill that names a source of its own (`skill_prescribes_source`).
 */

/** A card source id or address -> the address; any other ref stays as it is. */
export const feedUrlOf = (f: Pick<ChannelFacts, 'card'>): FeedUrlOf => (ref) => f.card.sources.find((c) => c.id === ref || c.ref === ref)?.ref ?? ref;

/** Skills the owner or the agents wrote. A built-in skill is shipped with the code and a safety skill is never switched off. */
const isCandidateSkill = (s: SkillFact) => s.scope !== 'builtin' && !s.safety;

export function candidatesOf(f: ChannelFacts): Candidate[] {
  return [
    ...f.skills.filter(isCandidateSkill).map((s): Candidate => ({ kind: 'skill', id: s.id, name: s.name, description: s.description, body: s.body })),
    ...f.rules.map((r): Candidate => ({ kind: 'rule', id: String(r.id), name: '', body: r.text })),
    ...f.steering.map((r): Candidate => ({ kind: 'steering', id: r.id, name: '', body: r.text })),
  ];
}

const hasSourceSeries = (f: ChannelFacts, kinds: readonly string[]) =>
  f.series.some((s) => s.active !== false && s.source && kinds.includes(s.source.kind));

export const sourceCheck: DoctorCheck = {
  code: 'series_source_contradicted',
  run(f: ChannelFacts): Finding[] {
    const out: Finding[] = [];
    const agent = agentHandleOf(f);
    const feedUrl = feedUrlOf(f);
    const contradictions = seriesSourceContradictions(f.series, candidatesOf(f), { feedUrl });
    const contradictedSkills = new Set(contradictions.filter((x) => x.candidate.kind === 'skill').map((x) => x.candidate.id));

    for (const x of contradictions) {
      const { series, candidate: c } = x;
      const label = seriesSourceLabel(series.source!);
      const what = c.kind === 'skill' ? `skill «${c.name}»` : c.kind === 'rule' ? `owner rule #${c.id}` : `steering rule ${c.id}`;
      out.push(mkFinding(f, {
        code: 'series_source_contradicted',
        severity: series.source_mode === 'required' ? 'error' : 'warn',
        subject: { type: c.kind, id: `${series.name}|${c.kind}:${c.id}`, label: `${series.name}: ${c.kind === 'skill' ? c.name : what}` },
        detail: `Series «${series.name}» ${series.source_mode === 'required' ? 'must' : 'is meant to'} take its material from ${label}, but ${what}: ${x.reason}.${x.sentence ? ` It says: «${x.sentence}»` : ''}`,
        evidence: { series: series.name, source: label, source_mode: series.source_mode, [c.kind]: { id: c.id, name: c.name || undefined }, path: x.path, kind: x.kind, tokens: x.tokens, ...(x.sentence ? { sentence: x.sentence } : {}) },
        ...(c.kind === 'skill' && agent ? { fix: { kind: 'skill_disable' as const, agent, skill: c.name } } : {}),
        ...(c.kind === 'skill' ? {} : { link: '/app/agents/:agent?tab=memory' }),
        values: { series: series.name },
      }));
    }

    const strictSource = hasSourceSeries(f, ['library', 'feed']);
    for (const s of f.skills) {
      const origin = originWithSource(s.body);
      if (origin) {
        out.push(mkFinding(f, {
          code: 'origin_original_with_source',
          severity: strictSource ? 'error' : 'warn',
          subject: { type: 'skill', id: s.id, label: s.name },
          detail: `Skill «${s.name}» tells the writer to mark material it read from a source as original. The post is then refused as origin_mismatch. It says: «${origin.sentence}»`,
          evidence: { skill: { id: s.id, name: s.name }, sentence: origin.sentence, library_or_feed_series: strictSource },
          ...(agent ? { fix: { kind: 'skill_disable' as const, agent, skill: s.name } } : {}),
        }));
      }
      if (!isCandidateSkill(s) || contradictedSkills.has(s.id)) continue;
      const hit = sourceInSkill(s.body);
      if (!hit) continue;
      out.push(mkFinding(f, {
        code: 'skill_prescribes_source',
        severity: 'warn',
        subject: { type: 'skill', id: s.id, label: s.name },
        detail: `Skill «${s.name}» names a source of its own, which no series of the channel contradicts. It says: «${hit.sentence}»`,
        evidence: { skill: { id: s.id, name: s.name }, kind: hit.kind, sentence: hit.sentence, source_series: hasSourceSeries(f, SOURCE_SERIES_KINDS) },
      }));
    }
    return out;
  },
};
