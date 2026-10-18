import type { Playbook } from '../network/playbook';
import { instancesPerDay, parseCadence } from '../network/series';
import type { ResourceStyle } from '../post/style/resource-style';
import { ruleOverlap } from '../agents/mentions';
import { NO_HASHTAGS_RE, NO_SLANG_RE, SIMPLER_RE } from './owner-style-overlay';

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
  /** Spec 041 FR-003, Telegram only: the card's hashtag vocabulary and its stored minimum. */
  vocabulary?:   readonly string[] | null;
  hashtagMin?:   number | null;
  /** Telegram only: the channel card's language — `uk` turns on the Ukrainian check (lint `not_ukrainian`). */
  language?:     string | null;
  profile?: {
    tone?:         string;
    audience?:     { who: string };
    format_prefs?: { tone?: string; hashtags?: { count: number }; slang?: boolean; style?: Partial<ResourceStyle> | null };
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
  | { target: 'profile'; op: 'audience'; ref: string; who: string }
  /** Spec 041 FR-003: the owner rule written into format_prefs (`style` replaces the stored style sheet). */
  | { target: 'profile'; op: 'style'; ref: string; style: ResourceStyle; slang?: false }
  | { target: 'card'; op: 'hashtag_min_zero'; channelKey: string }
  /** An owner rule that turns the Ukrainian check off ⇒ the card's language (`en` for an English channel, else `mixed`). */
  | { target: 'card'; op: 'language'; channelKey: string; language: string };

export interface ConfigConflict {
  code:     'hashtags_off_playbook' | 'hashtags_off_profile' | 'poll_series_over_cap' | 'slang_in_tone' | 'audience_mismatch'
    | 'hashtag_min_without_vocabulary' | 'rule_not_in_profile' | 'language_check_rule';
  ref:      string;
  /** English, for the agent page and the manager digest. */
  detail:   string;
  rule_id?: number;
  fix:      ConflictFix;
}

const SLANG_RE = /сленг|slang/iu;
const NEGATED_SLANG_RE = /(без|ні|не|no|without|avoid)\s+(?:\p{L}+\s+){0,2}?(сленг|slang)/iu;
const AUDIENCE_RULE_RE = /(аудиторі|читач\w*\s+(?:—|-|це)|пишемо\s+для|пиши\s+для|для\s+(?:новачк|початківц|експерт|розробник|школяр|студент|батьк|геймер|дітей|підлітк)|audience|write\s+for)/iu;
const POLL_FORMATS = new Set(['poll', 'quiz', 'ig_poll', 'threads_poll']);
/** Below this share of the rule's words in `audience.who`, the profile describes someone else. */
const AUDIENCE_OVERLAP_MIN = 0.3;

/**
 * An owner rule that turns the Ukrainian check off. Review 10-18 (@ai0_prompts_dev): rule #23 «вимкнути перевірку мови»
 * was stored, but the check is the card's language, so every post kept failing `not_ukrainian`.
 */
export const LANGUAGE_CHECK_OFF_RE = /(?:(?:вимкн|вимик|відключ|прибер|прибира|ігнор|disable|turn\s+off|switch\s+off|ignore|skip|drop)\p{L}*|без|не\s+перевіря\p{L}*)\s+(?:\p{L}+\s+){0,3}?(?:перевірк\p{L}*\s+(?:\p{L}+\s+)?мов|мовн\p{L}*\s+(?:перевірк|правил)|not_ukrainian|кирилиц|language\s+(?:check|rule)|правил\p{L}*\s+(?:про\s+)?(?:українськ\p{L}*\s+)?мов|українськ\p{L}*\s+мов)/iu;
/** An owner rule that the channel writes in English. */
export const ENGLISH_CHANNEL_RE = /(?:пиш\p{L}*|пост\p{L}*|контент|канал\p{L}*|мова\p{L}*|тексти?|write|posts?|language)\s+(?:\p{L}+\s+){0,3}?(?:англійськ|english)/iu;

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
  const simplerRule = ruleMatching(i.rules, SIMPLER_RE);
  const languageRule = ruleMatching(i.rules, LANGUAGE_CHECK_OFF_RE) ?? ruleMatching(i.rules, ENGLISH_CHANNEL_RE);
  for (const r of i.resources) {
    // An owner rule that turns the Ukrainian check off ⇒ the card's language is not `uk` (the check reads only that).
    if (languageRule && r.ref.startsWith('telegram:') && r.language === 'uk') {
      const language = ENGLISH_CHANNEL_RE.test(languageRule.text) ? 'en' : 'mixed';
      out.push({
        code: 'language_check_rule', ref: r.ref, rule_id: languageRule.id,
        detail: `Owner rule #${languageRule.id} («${languageRule.text.slice(0, 80)}») turns the Ukrainian check off, but the card of ${r.ref} still says language "uk", so the check keeps failing posts; the fix sets it to "${language}".`,
        fix: { target: 'card', op: 'language', channelKey: r.ref.slice('telegram:'.length), language },
      });
    }
    const section = i.playbook?.platforms.find((p) => p.resource_ref === r.ref) ?? null;
    // Hashtags off (the style sheet or an owner rule) ⇒ the playbook asks for none and format_prefs suggests none.
    const hashtagsOff = r.style?.hashtags === 'off' || !!noHashtagsRule;
    const why = noHashtagsRule ? `owner rule #${noHashtagsRule.id}`
      : r.style?.hashtags === 'off' && r.vocabulary && !r.vocabulary.length && !r.profile?.format_prefs?.style?.hashtags
        ? 'the card has no hashtag vocabulary' : 'hashtags are off in the resource style';
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
    // Spec 041 FR-003: a minimum with nothing to take the hashtags from.
    if (r.ref.startsWith('telegram:') && r.vocabulary && !r.vocabulary.length && (r.hashtagMin ?? 0) > 0) {
      out.push({
        code: 'hashtag_min_without_vocabulary', ref: r.ref,
        detail: `The card of ${r.ref} asks for at least ${r.hashtagMin} hashtags but has no hashtag vocabulary.`,
        fix: { target: 'card', op: 'hashtag_min_zero', channelKey: r.ref.slice('telegram:'.length) },
      });
    }
    // Spec 041 FR-003: an owner rule the stored style sheet says the opposite of ⇒ write the rule into format_prefs.
    const stored = r.profile?.format_prefs?.style ?? {};
    const against: Array<{ id: number; what: string }> = [];
    const next: ResourceStyle = { ...stored } as ResourceStyle;
    let slangFix = false;
    if (noHashtagsRule && stored.hashtags === 'vocabulary') { against.push({ id: noHashtagsRule.id, what: 'hashtags: vocabulary' }); next.hashtags = 'off'; }
    if (noSlangRule && r.profile?.format_prefs?.slang === true) { against.push({ id: noSlangRule.id, what: 'slang: on' }); slangFix = true; }
    if (simplerRule && stored.audience?.level && stored.audience.level !== 'beginner') {
      against.push({ id: simplerRule.id, what: `audience: ${stored.audience.level}` });
      next.audience = { level: 'beginner' };
    }
    if (against.length) {
      out.push({
        code: 'rule_not_in_profile', ref: r.ref, rule_id: against[0].id,
        detail: `Owner rules ${against.map((a) => `#${a.id}`).join(', ')} say otherwise than the stored style of ${r.ref} (${against.map((a) => a.what).join(', ')}); the rule wins.`,
        fix: { target: 'profile', op: 'style', ref: r.ref, style: next, ...(slangFix ? { slang: false as const } : {}) },
      });
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
