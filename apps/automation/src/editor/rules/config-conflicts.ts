import type { Playbook } from '../network/playbook';
import { instancesPerDay, parseCadence } from '../network/series';
import type { ResourceStyle } from '../post/style/resource-style';
import { ruleOverlap } from '../agents/mentions';

/**
 * Spec 040 FR-011: `rules-vs-config` — the owner's rules and the resource style against the active playbook and the
 * resource profiles, for the conflicts code can check. On 10-16 both posts broke owner rules the playbook contradicted
 * (hashtags off while the playbook asked for 3–5, «легкий сленг» in the tone of a no-slang channel), and the critic
 * scored them 5/5. Pure: the service reads the data, this decides; the fix is one owner card (`fix_config_conflicts`).
 */

export interface OwnerRule { id: number; text: string }

/** What a resource says about itself (effective style, format_prefs, caps, profile text). */
export interface ResourceConfig {
  ref:           string;
  style?:        Pick<ResourceStyle, 'hashtags'> | null;
  /** format_prefs.slang (absent = off). */
  slang?:        boolean;
  /** Poll + quiz posts a week (null = no cap). */
  pollsPerWeek?: number | null;
  profile?: {
    tone?:         string;
    audience?:     { who: string };
    format_prefs?: { tone?: string; hashtags?: { count: number } };
  } | null;
}

export interface ConflictInput {
  rules:     OwnerRule[];
  playbook:  Playbook | null;
  resources: ResourceConfig[];
}

export type ConflictFix =
  | { target: 'playbook'; op: 'hashtags_off'; ref: string }
  | { target: 'playbook'; op: 'pause_series'; names: string[] }
  | { target: 'playbook'; op: 'tone'; ref: string; tone: string }
  | { target: 'profile'; op: 'hashtags_off'; ref: string }
  | { target: 'profile'; op: 'tone'; ref: string; field: 'tone' | 'format_prefs.tone'; tone: string }
  | { target: 'profile'; op: 'audience'; ref: string; who: string };

export interface ConfigConflict {
  code:     'hashtags_off_playbook' | 'hashtags_off_profile' | 'poll_series_over_cap' | 'slang_in_tone' | 'audience_mismatch';
  ref:      string;
  /** English, for the agent page and the manager digest. */
  detail:   string;
  rule_id?: number;
  fix:      ConflictFix;
}

const NO_HASHTAGS_RE = /(без|ні|не\s+(?:став|додав|пиши|використов)\w*|no|without|don't\s+use)\s+(?:\p{L}+\s+){0,2}?(хештег|хэштег|hashtag|#)/iu;
const NO_SLANG_RE = /(без|не\s+(?:вживай|використов|пиши)\w*|no|without)\s+(?:\p{L}+\s+){0,2}?(сленг|slang)/iu;
const SLANG_RE = /сленг|slang/iu;
const NEGATED_SLANG_RE = /(без|ні|не|no|without|avoid)\s+(?:\p{L}+\s+){0,2}?(сленг|slang)/iu;
const AUDIENCE_RULE_RE = /(аудиторі|читач\w*\s+(?:—|-|це)|пишемо\s+для|пиши\s+для|для\s+(?:новачк|початківц|експерт|розробник|школяр|студент|батьк|геймер|дітей|підлітк)|audience|write\s+for)/iu;
const POLL_FORMATS = new Set(['poll', 'quiz', 'ig_poll', 'threads_poll']);
/** Below this share of the rule's words in `audience.who`, the profile describes someone else. */
const AUDIENCE_OVERLAP_MIN = 0.3;

const ruleMatching = (rules: OwnerRule[], re: RegExp) => rules.find((r) => re.test(r.text));

/** A tone without the parts that ask for slang (a negated mention — «без сленгу» — stays). */
export function toneWithoutSlang(tone: string): string {
  return tone.split(/(?<=[.;,])\s*/).filter((part) => !SLANG_RE.test(part) || NEGATED_SLANG_RE.test(part))
    .join(' ').replace(/[\s,;]+$/, '').trim();
}

const asksForSlang = (tone: string | undefined): tone is string => !!tone && SLANG_RE.test(tone) && toneWithoutSlang(tone) !== tone.trim();

/** Poll / quiz series posts a week on a resource. */
function pollSeriesPerWeek(pb: Playbook, ref: string): Array<{ name: string; perWeek: number }> {
  return pb.series.filter((s) => s.active !== false && s.resource_ref === ref && POLL_FORMATS.has(s.format))
    .map((s) => { const c = parseCadence(s.cadence); return { name: s.name, perWeek: c ? Math.round(instancesPerDay(c) * 7) : 0 }; })
    .filter((s) => s.perWeek > 0);
}

export function configConflicts(i: ConflictInput): ConfigConflict[] {
  const out: ConfigConflict[] = [];
  const noHashtagsRule = ruleMatching(i.rules, NO_HASHTAGS_RE);
  const noSlangRule = ruleMatching(i.rules, NO_SLANG_RE);
  const audienceRule = ruleMatching(i.rules, AUDIENCE_RULE_RE);
  for (const r of i.resources) {
    const section = i.playbook?.platforms.find((p) => p.resource_ref === r.ref) ?? null;
    // Hashtags off (the style sheet or an owner rule) ⇒ the playbook asks for none and format_prefs suggests none.
    const hashtagsOff = r.style?.hashtags === 'off' || !!noHashtagsRule;
    const why = r.style?.hashtags === 'off' ? 'hashtags are off in the resource style' : `owner rule #${noHashtagsRule?.id}`;
    if (hashtagsOff && section && section.hashtag_policy.max > 0) {
      out.push({
        code: 'hashtags_off_playbook', ref: r.ref, rule_id: noHashtagsRule?.id,
        detail: `Playbook asks for ${section.hashtag_policy.min}–${section.hashtag_policy.max} hashtags on ${r.ref}, but ${why}.`,
        fix: { target: 'playbook', op: 'hashtags_off', ref: r.ref },
      });
    }
    if (hashtagsOff && (r.profile?.format_prefs?.hashtags?.count ?? 0) > 0) {
      out.push({
        code: 'hashtags_off_profile', ref: r.ref, rule_id: noHashtagsRule?.id,
        detail: `The profile of ${r.ref} suggests ${r.profile!.format_prefs!.hashtags!.count} hashtags per post, but ${why}.`,
        fix: { target: 'profile', op: 'hashtags_off', ref: r.ref },
      });
    }
    // polls_per_week ⇒ the poll / quiz series fit the cap.
    if (i.playbook && r.pollsPerWeek != null) {
      const series = pollSeriesPerWeek(i.playbook, r.ref);
      const total = series.reduce((a, s) => a + s.perWeek, 0);
      if (total > r.pollsPerWeek) {
        // Pause the busiest series first until the rest fits the cap.
        const names: string[] = [];
        let left = total;
        for (const s of [...series].sort((a, b) => b.perWeek - a.perWeek)) {
          if (left <= r.pollsPerWeek) break;
          names.push(s.name);
          left -= s.perWeek;
        }
        out.push({
          code: 'poll_series_over_cap', ref: r.ref,
          detail: `Poll/quiz series on ${r.ref} plan ${total} posts a week (${series.map((s) => `«${s.name}» ${s.perWeek}`).join(', ')}); the cap is ${r.pollsPerWeek}.`,
          fix: { target: 'playbook', op: 'pause_series', names },
        });
      }
    }
    // Slang off ⇒ no slang asked for in the tones.
    const slangOff = r.slang !== true || !!noSlangRule;
    if (slangOff) {
      const why2 = noSlangRule ? `owner rule #${noSlangRule.id}` : 'slang is off for this resource';
      if (section && asksForSlang(section.tone)) {
        out.push({ code: 'slang_in_tone', ref: r.ref, rule_id: noSlangRule?.id, detail: `Playbook tone of ${r.ref} asks for slang («${section.tone}»), but ${why2}.`, fix: { target: 'playbook', op: 'tone', ref: r.ref, tone: toneWithoutSlang(section.tone) } });
      }
      if (asksForSlang(r.profile?.tone)) {
        out.push({ code: 'slang_in_tone', ref: r.ref, rule_id: noSlangRule?.id, detail: `Profile tone of ${r.ref} asks for slang («${r.profile!.tone}»), but ${why2}.`, fix: { target: 'profile', op: 'tone', ref: r.ref, field: 'tone', tone: toneWithoutSlang(r.profile!.tone!) } });
      }
      if (asksForSlang(r.profile?.format_prefs?.tone)) {
        const t = r.profile!.format_prefs!.tone!;
        out.push({ code: 'slang_in_tone', ref: r.ref, rule_id: noSlangRule?.id, detail: `Format tone of ${r.ref} asks for slang («${t}»), but ${why2}.`, fix: { target: 'profile', op: 'tone', ref: r.ref, field: 'format_prefs.tone', tone: toneWithoutSlang(t) } });
      }
    }
    // An owner rule about the audience ⇒ the profile describes the same readers.
    const who = r.profile?.audience?.who;
    if (audienceRule && who && ruleOverlap(audienceRule.text, who) < AUDIENCE_OVERLAP_MIN && ruleOverlap(who, audienceRule.text) < AUDIENCE_OVERLAP_MIN) {
      out.push({
        code: 'audience_mismatch', ref: r.ref, rule_id: audienceRule.id,
        detail: `Owner rule #${audienceRule.id} («${audienceRule.text.slice(0, 120)}») describes other readers than the profile of ${r.ref} («${who}»).`,
        fix: { target: 'profile', op: 'audience', ref: r.ref, who: audienceRule.text.slice(0, 200) },
      });
    }
  }
  return out;
}

/** The playbook with the playbook-side fixes applied (null when none applies). */
export function patchPlaybook(pb: Playbook, fixes: ConflictFix[]): Playbook | null {
  let changed = false;
  const next: Playbook = JSON.parse(JSON.stringify(pb));
  for (const f of fixes) {
    if (f.target !== 'playbook') continue;
    if (f.op === 'hashtags_off') {
      const s = next.platforms.find((p) => p.resource_ref === f.ref);
      if (s && s.hashtag_policy.max > 0) { s.hashtag_policy = { vocab: [], min: 0, max: 0 }; changed = true; }
    } else if (f.op === 'pause_series') {
      for (const s of next.series) if (f.names.includes(s.name) && s.active !== false) { s.active = false; changed = true; }
    } else if (f.op === 'tone') {
      const s = next.platforms.find((p) => p.resource_ref === f.ref);
      if (s && s.tone !== f.tone) { s.tone = f.tone || undefined; changed = true; }
    }
  }
  return changed ? next : null;
}
