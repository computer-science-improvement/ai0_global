import { extractEntities } from './entities';
import { formatLocalStamp, parseDateMentions } from './dates';
import { bodyText, excerptOf, type AuditPost, type Finding } from './integrity/types';

/**
 * Spec 037 FR-004 (T4): `fact_conflict` — the same fact told differently by an earlier post of the resource. Pure.
 *
 * Facts compared (each tied to its subject, a game or product name):
 *   • a price: «Red Dead Redemption 2 — 539 грн замість 1799, знижка 70%» (new and old price, the discount);
 *   • a character: «граєте за сліпого хлопчика» vs «граєте за сліпу дівчинку Софі» (the role noun, the name);
 *   • a deadline: «до 15 жовтня» of a giveaway / deal.
 * A mismatch is a warning with both values and the earlier post's date: the critic checks the source, and a real
 * change is said in the post («ціна зросла з 539 до 649 грн»). The earlier posts are the story registry's history
 * (14 days, the story guard of publish_post) or, in the export audit, the channel's timeline.
 */

export const FACT_WINDOW_DAYS = 14;

const NUM = String.raw`\d{1,3}(?:[   ]\d{3})+|\d+`;
const CUR = String.raw`(?:грн|₴|\$|€|USD|UAH)?`;
const PRICE_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])[$€]?(${NUM})\s*${CUR}\s*(?:замість|замiсть|instead of|вместо)\s*[$€]?(${NUM})\s*${CUR}`, 'u');
const DISCOUNT_RE = /(?:знижк\p{L}*\s*|[−–-]\s?)(\d{1,2})\s*%/u;
const CHAR_RE = /(?:граєте|граєш|граємо|граєтe|керуєте|керуєш|(?:у|в)\s+ролі)\s+(?:за\s+)?([^.,;:!?\n()«»]+)/iu;
/** Role nouns of a character (stems at a word start); two posts with different ones tell different characters. */
const ROLES = ['хлопч', 'хлопц', 'дівчин', 'дівчат', 'чоловік', 'жінк', 'юнак', 'дідус', 'бабус', 'брат', 'сестр', 'доньк', 'дочк',
  'батьк', 'кішк', 'собак', 'робот', 'лицар', 'солдат', 'детектив', 'принцес', 'королев', 'boy', 'girl', 'woman'];

interface Fact { kind: 'price' | 'character' | 'deadline'; subject: Set<string>; text: string; value: string }

const num = (s: string) => Number(s.replace(/\D/g, ''));
const strip = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Strong names (games, products, people) of a piece of text: big brands and stores alone are not a subject. */
function subjectOf(text: string): Set<string> {
  const e = extractEntities(text);
  return new Set([...e.entities.values()].filter((x) => (x.kind === 'name' && x.weight >= 2) || x.kind === 'person').map((x) => x.key));
}

function sentences(text: string): string[] {
  return text.split('\n').flatMap((l) => l.split(/(?<=[.!?])\s+(?=[\p{Lu}•\d])/u)).map((s) => s.trim()).filter(Boolean);
}

function priceFacts(text: string): Fact[] {
  const out: Fact[] = [];
  for (const s of sentences(text)) {
    const m = PRICE_RE.exec(s);
    if (!m) continue;
    const before = s.slice(0, m.index).replace(/^[•·\-–\s]+/, '').replace(/[\s—–:,-]+$/, '');
    const subject = subjectOf(before);
    if (!subject.size) continue;
    const d = DISCOUNT_RE.exec(s.slice(m.index));
    const value = `${num(m[1])}/${num(m[2])}${d ? `/${d[1]}` : ''}`;
    out.push({ kind: 'price', subject, value, text: strip(`${m[0]}${d ? ` (−${d[1]}%)` : ''}`) });
  }
  return out;
}

function characterFacts(text: string): Fact[] {
  const out: Fact[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const m = CHAR_RE.exec(para);
    if (!m) continue;
    const subject = subjectOf(para);
    if (!subject.size) continue;
    const phrase = strip(m[1]).split(/\s+(?:який|яка|яке|які|що|and|who)\s/u)[0];
    const words = phrase.split(/\s+/);
    const role = words.map((w) => w.toLowerCase()).map((w) => ROLES.find((r) => w.startsWith(r))).find(Boolean) ?? '';
    const name = words.filter((w, i) => i > 0 && /^\p{Lu}\p{Ll}+/u.test(w)).join(' ');
    if (!role && !name) continue;
    out.push({ kind: 'character', subject, value: `${role}|${name}`, text: phrase });
  }
  return out;
}

function deadlineFacts(post: AuditPost, text: string): Fact[] {
  const days = new Set<string>();
  let shown = '';
  for (const m of parseDateMentions(text, { publishedAt: post.publishedAt, timezone: post.timezone || 'Europe/Kyiv' })) {
    if (m.preposition !== 'until' || !m.date || m.historical || m.kind === 'weekday' || m.kind === 'time') continue;
    days.add(m.date);
    shown ||= m.text;
  }
  if (days.size !== 1) return [];
  const subject = subjectOf(text);
  return subject.size ? [{ kind: 'deadline', subject, value: [...days][0], text: `до ${strip(shown)}` }] : [];
}

/** The comparable facts of a post. */
export function factsOfPost(post: AuditPost): Fact[] {
  const text = bodyText(post);
  if (!text.trim()) return [];
  return [...priceFacts(text), ...characterFacts(text), ...deadlineFacts(post, text)];
}

const shares = (a: Set<string>, b: Set<string>) => [...a].some((k) => b.has(k));

function differs(a: Fact, b: Fact): boolean {
  if (a.kind === 'character') {
    const [ra, na] = a.value.split('|');
    const [rb, nb] = b.value.split('|');
    return (!!ra && !!rb && ra !== rb) || (!!na && !!nb && na !== nb);
  }
  if (a.kind === 'price') {
    // Same new / old price; a discount compares only when both posts give it.
    const [na, oa, da] = a.value.split('/');
    const [nb, ob, db] = b.value.split('/');
    return na !== nb || oa !== ob || (!!da && !!db && da !== db);
  }
  return a.value !== b.value;
}

const KIND_UK: Record<Fact['kind'], string> = { price: 'ціна', character: 'персонаж', deadline: 'дедлайн' };
const HOW: Record<Fact['kind'], string> = {
  price: 'перевір ціну на сторінці магазину; якщо вона змінилась — скажи це прямо («ціна зросла з … до …»)',
  character: 'перевір у джерелі, кого грає гравець, і виправ один із варіантів',
  deadline: 'перевір дату на сторінці роздачі; якщо її продовжили — скажи це прямо',
};

const stamp = (p: AuditPost) => formatLocalStamp(p.publishedAt, p.timezone || 'Europe/Kyiv').replace(/^[^,]+,\s*/, '').replace(/\s*\([^)]*\)$/, '');

/**
 * `fact_conflict` findings of a post against earlier posts (any order; those of the last 14 days before it count).
 * One finding per fact kind, naming both values and the earlier post's date.
 */
export function factConflicts(post: AuditPost, previous: readonly AuditPost[]): Finding[] {
  const mine = factsOfPost(post);
  if (!mine.length) return [];
  const at = Date.parse(post.publishedAt);
  const earlier = previous
    .filter((p) => p.id !== post.id && Date.parse(p.publishedAt) < at && at - Date.parse(p.publishedAt) <= FACT_WINDOW_DAYS * 86_400_000)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const conflicts = new Map<Fact['kind'], string[]>();
  for (const f of mine) {
    for (const p of earlier) {
      const other = factsOfPost(p).find((g) => g.kind === f.kind && shares(f.subject, g.subject));
      if (!other) continue;
      if (differs(f, other)) {
        const list = conflicts.get(f.kind) ?? [];
        list.push(`тут «${excerptOf(f.text, 70)}», а в пості ${stamp(p)} — «${excerptOf(other.text, 70)}»`);
        conflicts.set(f.kind, list);
      }
      break; // the newest earlier post with this fact is the one to agree with
    }
  }
  return [...conflicts.entries()].map(([kind, list]) => ({
    code: 'fact_conflict', level: 'warning' as const, excerpt: excerptOf(list[0], 120),
    message: `${KIND_UK[kind]} розходиться з попереднім постом: ${list.slice(0, 3).join('; ')} — ${HOW[kind]}`,
  }));
}
