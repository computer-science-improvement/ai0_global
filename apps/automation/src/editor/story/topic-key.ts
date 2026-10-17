import { STOP_STEMS } from '../post/entities';

/**
 * Spec 041 FR-004 (T4): the topic of a post as a set of stems of its title and lead — 6-letter stems of Cyrillic words
 * (5+ letters), lowercase Latin words of 3+ letters — without stop words and the evergreen wording itself («що таке»,
 * «5 порад»). The story match (story-match.ts) needs shared entities; an explainer often has none («Що таке
 * токенізація»), so topics are compared by these stems: overlap / min ≥ 0.6 with at least 2 shared stems — or the one
 * stem of a one-word Cyrillic topic («Що таке токенізація»: a concept, never a lone brand).
 */

export const TOPIC_MATCH = { share: 0.6, shared: 2 } as const;

/** Evergreen wording and generic words that say nothing about the topic. */
const TOPIC_STOP = new Set([
  'пояснюємо', 'поясню', 'поясне', 'розбир', 'простим', 'словам', 'способ', 'спосіб', 'порад', 'порада', 'технік', 'помилк',
  'помило', 'правил', 'кроків', 'причин', 'інстру', 'лайфха', 'прийом', 'фактів', 'фактів', 'означає', 'потрібн', 'навіщо',
  'працюю', 'робота', 'роботи', 'всього', 'знати', 'краще', 'кращих', 'найкра', 'головн', 'важлив', 'цікав', 'цікаві',
  'the', 'and', 'for', 'with', 'how', 'what', 'why', 'you', 'your', 'from', 'this', 'that', 'are',
]);

const stem = (w: string) => w.toLowerCase().replace(/[ʼ'’]/g, '').slice(0, 6);

export function topicKey(o: { title?: string | null; lead?: string | null; topic?: string | null }): string[] {
  const text = [o.title, o.lead, o.topic].filter(Boolean).join('\n').replace(/https?:\/\/\S+/g, ' ');
  const out = new Set<string>();
  for (const m of text.matchAll(/[\p{Script=Cyrillic}ʼ'’]{5,}/gu)) {
    const s = stem(m[0]);
    if (TOPIC_STOP.has(s) || STOP_STEMS.has(s) || [...STOP_STEMS].some((x) => s.startsWith(x))) continue;
    out.add(s);
  }
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])[A-Za-z][A-Za-z0-9+#.-]{2,}(?![\p{L}])/gu)) {
    const w = m[0].toLowerCase().replace(/[.-]+$/, '');
    if (w.length >= 3 && !TOPIC_STOP.has(w)) out.add(w);
  }
  return [...out].sort();
}

/** Shared stems of two topic keys, when they are the same topic (else null). */
export function sameTopic(a: readonly string[], b: readonly string[]): string[] | null {
  if (!a.length || !b.length) return null;
  const set = new Set(b);
  const shared = a.filter((s) => set.has(s));
  const min = Math.min(a.length, b.length);
  const enough = shared.length >= TOPIC_MATCH.shared || (min === 1 && shared.length === 1 && /^\p{Script=Cyrillic}/u.test(shared[0]));
  return enough && shared.length / min >= TOPIC_MATCH.share ? shared : null;
}
