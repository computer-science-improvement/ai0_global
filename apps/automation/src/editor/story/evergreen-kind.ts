/**
 * Spec 041 FR-004 (T4): code decides that a post is evergreen — an explainer, a how-to, a glossary entry or a listicle —
 * whatever the writer declared. Review 2 found three explainers on one topic in 9 days, none declared evergreen, so
 * the 30-day evergreen window never applied. A post is evergreen when its title or lead reads like one («що таке»,
 * «як …», «N способів / порад / технік / помилок», «пояснюємо», «X — це …»), or when it has no external source at all
 * (nothing to date it).
 */

export type EvergreenKind = 'explainer' | 'howto' | 'glossary' | 'listicle';

const KIND_RES: Array<[EvergreenKind, RegExp]> = [
  ['glossary', /(?<![\p{L}])(?:що\s+таке|що\s+означає|словник|глосарій|термін\s+дня)(?![\p{L}])/iu],
  ['listicle', /(?<![\p{L}\p{N}])\d{1,2}\s+(?:способ|порад|технік|помил|правил|кроків|крок|причин|інструмент|ідей|лайфхак|прийом|фактів|міфів)\p{L}*/iu],
  ['howto', /(?:^|[.!?:]\s+|«)\s*як\s+\p{L}{3,}/iu],
  ['explainer', /(?<![\p{L}])(?:пояснюємо|пояснення|розбираємо|розбираємось|розбір|простими\s+словами|чому\s+\p{L}+\s+\p{L}+|навіщо)(?![\p{L}])/iu],
  // «Токенізація — це …», «RAG – це …»: a definition.
  ['glossary', /^[^.!?\n]{2,60}\s[—–-]\s+це\s/iu],
];

export interface EvergreenInput {
  title?: string | null;
  lead?:  string | null;
  /** An external source: a source line, a link, a URL button or a page the run read. */
  hasSource: boolean;
  /** The kind the writer declared (`story.kind`). */
  declared?: string | null;
}

/** The evergreen kind of a post, or null for a dated (news) post. */
export function evergreenKind(i: EvergreenInput): EvergreenKind | null {
  const head = [i.title, i.lead].filter(Boolean).join('\n').trim();
  for (const [kind, re] of KIND_RES) if (head && re.test(head)) return kind;
  if (i.declared === 'evergreen' || !i.hasSource) return 'explainer';
  return null;
}
