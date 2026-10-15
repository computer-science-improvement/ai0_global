// Spec 037 FR-008 (T8): the resource style sheet (format_prefs.style) ⇄ the
// owner's form in Resource → Formatting, the one-line summary and the
// bootstrap proposal (pure; unit-tested).

import type { StyleProposal, StyleSheet, StyleView } from '../api/agents';

export const ADDRESS_LABEL = { vy: 'Formal "vy"', ty: 'Informal "ty"', impersonal: 'Impersonal' } as const;
export const NAMES_LABEL = { uk_translit: 'Ukrainian transliteration', original: 'Original script' } as const;
export const AUDIENCE_LEVEL_LABEL = { beginner: 'Beginner', general: 'General', expert: 'Expert' } as const;
export const STYLE_KIND_LABEL = { news: 'News', games: 'Games', evergreen: 'Evergreen', explainer: 'Explainer', education: 'Education' } as const;

export interface GlossaryPair { insteadOf: string; use: string }

export interface StyleForm {
  address:   '' | keyof typeof ADDRESS_LABEL;
  names:     '' | keyof typeof NAMES_LABEL;
  headlineMax: string;
  decimal:   '' | 'comma' | 'dot';
  units:     '' | 'words' | 'latin';
  audience:  '' | keyof typeof AUDIENCE_LEVEL_LABEL;
  /** '' = the default (off on news and games resources, the vocabulary elsewhere). */
  hashtags:  '' | 'off' | 'vocabulary';
  contentKind: '' | keyof typeof STYLE_KIND_LABEL;
  freshnessHours: string;
  ban:       string[];
  prefer:    GlossaryPair[];
  /**
   * The glossary is saved only when the owner set it before or edits it now; until then the form shows the default
   * glossary and the server keeps applying it (so a later change of the defaults reaches the resource).
   */
  glossaryOwn: boolean;
}

/** `prefer` as pairs, from either stored shape (a map or a list). */
export function glossaryPairs(prefer: NonNullable<StyleSheet['glossary']>['prefer']): GlossaryPair[] {
  if (!prefer) return [];
  if (Array.isArray(prefer)) return prefer.map((p) => ({ insteadOf: p.instead_of, use: p.use }));
  return Object.entries(prefer).map(([insteadOf, use]) => ({ insteadOf, use }));
}

/** The form from the server view (stored + effective); an older server without the view gets the stored prefs. */
export function toStyleForm(view: StyleView | undefined, stored: StyleSheet | undefined): StyleForm {
  const s = view?.stored ?? stored ?? {};
  const g = s.glossary ?? view?.effective.glossary;
  return {
    address: s.address ?? '', names: s.names ?? '', headlineMax: s.headline ? String(s.headline.max_chars) : '',
    decimal: s.numbers?.decimal ?? '', units: s.units ?? '', audience: s.audience?.level ?? '', hashtags: s.hashtags ?? '',
    contentKind: s.content_kind ?? '', freshnessHours: s.freshness_hours != null ? String(s.freshness_hours) : '',
    ban: g?.ban ?? [], prefer: glossaryPairs(g?.prefer), glossaryOwn: !!s.glossary,
  };
}

/** The style to store; undefined when nothing is set (every field then takes the default). */
export function toStyle(f: StyleForm): StyleSheet | undefined {
  const n = (s: string) => (s.trim() === '' ? undefined : Number(s));
  const out: StyleSheet = {
    address: f.address || undefined, names: f.names || undefined, units: f.units || undefined, hashtags: f.hashtags || undefined,
    content_kind: f.contentKind || undefined, freshness_hours: n(f.freshnessHours),
  };
  if (n(f.headlineMax) !== undefined) out.headline = { max_chars: n(f.headlineMax)! };
  if (f.decimal) out.numbers = { decimal: f.decimal };
  if (f.audience) out.audience = { level: f.audience };
  if (f.glossaryOwn) {
    const pairs = f.prefer.map((p) => ({ insteadOf: p.insteadOf.trim(), use: p.use.trim() })).filter((p) => p.insteadOf && p.use);
    out.glossary = {
      ...(pairs.length ? { prefer: Object.fromEntries(pairs.map((p) => [p.insteadOf, p.use])) } : {}),
      ...(f.ban.length ? { ban: f.ban } : {}),
    };
  }
  const clean = JSON.parse(JSON.stringify(out)) as StyleSheet; // drops undefined
  return Object.keys(clean).length ? clean : undefined;
}

/** The effective style in one line for the Formatting row. */
export function styleSummary(s: StyleSheet | undefined): string {
  if (!s) return 'Defaults';
  const g = s.glossary;
  const terms = glossaryPairs(g?.prefer).length + (g?.ban?.length ?? 0);
  return [
    s.address ? ADDRESS_LABEL[s.address] : null,
    s.hashtags === 'off' ? 'no hashtags' : s.hashtags === 'vocabulary' ? 'hashtag vocabulary' : null,
    terms ? `glossary ${terms}` : null,
    s.names ? `names: ${s.names === 'original' ? 'original' : 'transliterated'}` : null,
    s.headline ? `headline ≤ ${s.headline.max_chars}` : null,
    s.numbers ? `decimal ${s.numbers.decimal}` : null,
    s.units === 'words' ? 'units in words' : null,
    s.audience ? `${s.audience.level} readers` : null,
    s.content_kind ? STYLE_KIND_LABEL[s.content_kind] : null,
  ].filter(Boolean).join(' · ') || 'Defaults';
}

/** The form with an accepted proposal (names policy); the vocabulary is saved to the card separately. */
export function acceptProposal(f: StyleForm, p: StyleProposal): StyleForm {
  return p.propose.names ? { ...f, names: p.propose.names } : f;
}

/** The proposal in one sentence ("" = nothing to propose). */
export function proposalSummary(p: StyleProposal): string {
  const parts: string[] = [];
  if (p.propose.names) {
    parts.push(`names in ${p.propose.names === 'original' ? 'the original script' : 'Ukrainian transliteration'} (${p.names.latin} original vs ${p.names.cyrillic} transliterated uses)`);
  }
  if (p.propose.vocabulary?.length) parts.push(`a hashtag vocabulary of ${p.propose.vocabulary.length}`);
  return parts.length ? `From ${p.posts} posts of the last ${p.days} days: ${parts.join('; ')}.` : '';
}
