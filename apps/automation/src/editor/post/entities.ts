/**
 * Spec 037 FR-002 (T2): the entities of a post, pure. A story is recognised by what it is about — products, game
 * titles, companies, people, numbers with units, dates, domains — not by its wording: the repeats of the DEV channels
 * (Apple hub ×4, Out of Sight ×3, the same Steam deals) share 0.19–0.58 of their trigrams but most of their names.
 *
 *   • names: runs of Latin words («Mistral Large 4», «Qwen-Image-2.1-Turbo», «Out of Sight», «BURIED STARS»), normalised
 *     to lowercase without versions and edition words (`Qwen-Image-2.1-Turbo` → `qwen-image`, `System Shock 2: 25th
 *     Anniversary Remaster` → `system shock`); a big brand alone is weak, a multi-word product is strong, an acronym is
 *     weak, media outlets and generic tech terms do not count;
 *   • people and places: two or more capitalised Cyrillic words («Марк Гурман», «Південно-Східній Азії»), stemmed so
 *     the cases match;
 *   • numbers with units («1,05 трлн», «49 млрд», «$14,5 млрд», «−90%», «74 грн», «8 кроків»), one canonical form;
 *   • dates («13 жовтня», «13.10»), domains in the text («itch.io», «elementsofai.com»).
 *
 * Besides the entities, `topicStems` keeps the stems of the longer Cyrillic content words: two posts about the same
 * Apple hub share «хаб», «розумн-», «термостат» even when the first one names nothing but Apple and LG.
 */

export type EntityKind = 'name' | 'person' | 'number' | 'date' | 'domain';

export interface Entity {
  /** Normalised key, unique per kind: `name:qwen-image`, `num:49bn`, `date:10-13`. */
  key: string;
  kind: EntityKind;
  /** As written (first occurrence), for messages. */
  text: string;
  /** Weight in the overlap: strong names 3, other names / people 2, numbers / dates / domains 1, weak 0.5–1. */
  weight: number;
}

export interface PostEntities {
  entities: Map<string, Entity>;
  /** Stems of the Cyrillic content words (6 letters, words of 6+ letters). */
  stems: Set<string>;
}

/** Media outlets and aggregators: they name where a story came from, not what it is about. */
const MEDIA = new Set([
  'techcrunch', 'the verge', 'verge', 'bloomberg', 'marktechpost', 'reuters', 'financial times', 'ft', 'engadget', 'wired',
  'android headlines', 'dealabs', 'gamerpower', 'playstation blog', 'playstation.blog', 'ign', 'gamespot', 'polygon', 'kotaku',
  'dev.ua', 'ain', 'dou', 'cnbc', 'cnn', 'bbc', 'the information', 'axios', 'ars technica', 'zdnet', 'the guardian', 'x', 'telegram',
  'telegraph', 'threads', 'youtube', 'reddit', 'github', 'hugging face', 'huggingface', 'arxiv', 'medium', 'substack', 'blog',
]);

/** Generic technical terms written in Latin: they appear in unrelated posts. */
const GENERIC = new Set([
  'ai', 'api', 'apis', 'cli', 'gpu', 'gpus', 'cpu', 'npu', 'llm', 'llms', 'ceo', 'cto', 'ipo', 'oled', 'led', 'lcd', 'hdr', 'usb', 'usb-c',
  'pc', 'mac', 'ios', 'android', 'windows', 'linux', 'macos', 'wi-fi', 'bluetooth', 'gps', 'sdk', 'ui', 'ux', 'app', 'apps', 'beta',
  'mixture of experts', 'moe', 'rag', 'mcp', 'model context protocol', 'open source', 'open-source', 'fine-tuning', 'guardrails',
  'reinforcement learning', 'rl', 'agent', 'agents', 'premium', 'free', 'dlc', 'fps', 'rpg', 'pve', 'pvp', 'sci-fi', 'indie', 'demo',
  'pre-order', 'steam deck', 'game pass', 'ps plus', 'playstation plus', 'reels', 'seo', 'q&a', 'faq', 'vs', 'ok', 'wow', 'tl', 'dr',
]);

/** Big brands: alone they say little about the story (Google posts are many stories). */
const BIG_BRANDS = new Set([
  'google', 'apple', 'microsoft', 'meta', 'amazon', 'openai', 'anthropic', 'nvidia', 'amd', 'intel', 'samsung', 'sony', 'xbox',
  'playstation', 'nintendo', 'steam', 'epic', 'epic games', 'epic games store', 'valve', 'alibaba', 'tencent', 'baidu', 'facebook',
  'instagram', 'whatsapp', 'netflix', 'spotify', 'tesla', 'spacex', 'nasa', 'ibm', 'oracle', 'qualcomm', 'huawei', 'xiaomi', 'lg',
  'deepmind', 'google cloud', 'azure', 'aws', 'chatgpt', 'gemini', 'claude', 'copilot', 'siri', 'iphone', 'ipad', 'gog', 'ubisoft',
  'ea', 'activision', 'blizzard', 'rockstar', 'bethesda', 'cd projekt', 'mistral', 'qwen', 'llama', 'gpt',
]);

/** Words that mark an edition or a variant, not another product: dropped from a name. */
const EDITION = new Set([
  'turbo', 'pro', 'max', 'ultra', 'plus', 'mini', 'lite', 'preview', 'beta', 'edition', 'remaster', 'remastered', 'anniversary',
  'goty', 'deluxe', 'definitive', 'complete', 'full', 'release', 'update', 'version', 'v', 'gen', 'generation', 'the',
]);

/** Lowercase words allowed inside a Latin name («Out of Sight», «Sons Of The Forest»), never at its edges. */
const CONNECTORS = new Set(['of', 'the', 'and', 'for', 'in', 'on', 'to', 'a', 'an', 'at', 'by', 'de', 'la', 'le', 'du', 'with', 'from', '&']);

const LATIN_TOKEN = String.raw`[A-Za-z][A-Za-z0-9+]*(?:[.'’][A-Za-z0-9]+)*`;
const VERSION_TOKEN = String.raw`\d+(?:[.,]\d+)*[A-Za-z]{0,3}`;
/** A run of Latin tokens and versions joined by spaces, hyphens or a colon («System Shock 2: 25th Anniversary Remaster»). */
const NAME_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])${LATIN_TOKEN}(?:(?:[  ]|-|:\s)(?:${LATIN_TOKEN}|${VERSION_TOKEN}))*`, 'gu');

const CYR_CAP = String.raw`[А-ЯІЇЄҐ][а-яіїєґʼ'’]+(?:-[А-ЯІЇЄҐ][а-яіїєґʼ'’]+)*`;
/** Two or more capitalised Cyrillic words in a row (a name or a place), not the first word of a sentence alone. */
const PERSON_RE = new RegExp(String.raw`(?<![\p{L}])${CYR_CAP}(?:[  ]${CYR_CAP})+`, 'gu');

const DOMAIN_RE = /(?<![\p{L}\p{N}@./])((?:[a-z0-9-]+\.)+(?:com|io|ai|org|net|dev|app|co|ua|gg|tv|me|so|xyz))(?:\/[^\s)»"]*)?/giu;

const UNIT_RE = String.raw`(трлн|трильйон\p{L}*|млрд|мільярд\p{L}*|млн|мільйон\p{L}*|тис\.?|тисяч\p{L}*|trillion|billion|million|thousand|%|відсот\p{L}*|грн|гривен\p{L}*|гривн\p{L}*|юан\p{L}*|дол\p{L}*|євро|ГБ|ТБ|МБ|Гб|Мп|Гц|мАг|Вт|ніт|мс|кроків|кроки|крок|токенів|токени|параметрів|разів|рази|раза|GB|TB|MB|B|M|K|T|W|Hz|ms|px|fps|K\b)`;
/** A number with a unit or a currency sign: «1,05 трлн», «$14,5 млрд», «−90%», «74 грн», «¥5699», «49B». */
const NUM_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,])([$€¥£]?)\s?[−–-]?(\d{1,3}(?:[   ]\d{3})+|\d+(?:[.,]\d+)?)(?:\s?${UNIT_RE})?(?![\p{L}\p{N}])`,
  'gu',
);

const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const DATE_TEXT_RE = new RegExp(String.raw`(?<![\p{L}\p{N}])(\d{1,2})\s+(${MONTHS.join('|')})(?![\p{L}])`, 'giu');
const DATE_NUM_RE = /(?<![\p{L}\p{N}.,-])(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![\p{L}\p{N}-]|[.,]\d)/gu;

/** Cyrillic words that are not about the story (frequent in every post). */
const STOP_STEMS = new Set([
  'компан', 'користу', 'продаж', 'сервіс', 'новина', 'новини', 'джерел', 'детальн', 'наприк', 'приблиз', 'останн', 'першог',
  'тепер', 'сьогод', 'завтра', 'жовтня', 'вересня', 'листоп', 'працює', 'працюв', 'можуть', 'можна', 'потріб', 'доступ',
  'отрима', 'зробит', 'робить', 'більше', 'менше', 'кількі', 'головн', 'основн', 'новий', 'нового', 'нової', 'нових', 'перший',
  'перша', 'першої', 'першим', 'другий', 'третій', 'кожний', 'кожного', 'кожен', 'своєму', 'своїх', 'своєї', 'власни',
  'власно', 'тільки', 'просто', 'справж', 'реально', 'можлив', 'готуют', 'готує', 'показа', 'показу', 'розпов', 'повідо',
  'заявил', 'заявив', 'каже', 'кажуть', 'пише', 'пишуть', 'даними', 'даних', 'інформ', 'вийде', 'вийшла', 'вийшов', 'виходи',
  'запуст', 'випуст', 'анонсу', 'анонс', 'представ', 'обіцяє', 'обіцян', 'варто', 'зараз', 'досить', 'дуже', 'також',
  'зокрем', 'наприклад', 'результ', 'однак', 'проте', 'поки', 'вперше', 'всього', 'усього', 'людей', 'людина', 'користув',
]);

const STEM_LEN = 6;

function normName(raw: string): string {
  const parts = raw
    .replace(/[’']/g, '')
    .split(/[\s :-]+/)
    .map((p) => p.toLowerCase())
    .filter(Boolean);
  const kept = parts.filter((p, i) => {
    if (/^\d/.test(p)) return false; // versions, ordinals (2.1, 4, 25th, 7b)
    if (/^[a-z]?\d+[a-z]{0,2}$/.test(p)) return false; // g4, m6, a18
    if (EDITION.has(p) && i > 0) return false;
    return true;
  });
  while (kept.length && CONNECTORS.has(kept[kept.length - 1])) kept.pop();
  while (kept.length && CONNECTORS.has(kept[0])) kept.shift();
  return kept.join(parts.length > 1 && /-/.test(raw) && !/\s/.test(raw) ? '-' : ' ');
}

function nameWeight(key: string, raw: string): number {
  if (MEDIA.has(key) || GENERIC.has(key)) return 0;
  if (BIG_BRANDS.has(key)) return 1;
  const words = key.split(/[ -]/).filter(Boolean);
  // «Gemini Agent», «Apple TV»: a big brand's product is a name of its own, but weaker than «Out of Sight».
  if (words.length >= 2) return words.every((w) => BIG_BRANDS.has(w) || GENERIC.has(w) || EDITION.has(w)) ? 2 : 3;
  if (/^[A-Z]{2,4}$/.test(raw.trim())) return 0.5; // an acronym (LG, MCP, TMLR)
  if (key.length <= 2) return 0;
  return 2;
}

const UNIT_CANON: Array<[RegExp, string]> = [
  [/^(трлн|трильйон|trillion|T$)/iu, 'tn'], [/^(млрд|мільярд|billion|B$)/iu, 'bn'], [/^(млн|мільйон|million|M$)/iu, 'm'], [/^(тис|тисяч|thousand|K$)/iu, 'k'],
  [/^(%|відсот)/iu, '%'], [/^(грн|гривен|гривн)/iu, 'uah'], [/^юан/iu, 'cny'], [/^дол/iu, 'usd'], [/^євро/iu, 'eur'],
  [/^(ГБ|Гб|GB)$/u, 'gb'], [/^(ТБ|TB)$/u, 'tb'], [/^(МБ|MB)$/u, 'mb'], [/^Мп$/u, 'mp'], [/^(Гц|Hz)$/u, 'hz'], [/^мАг$/u, 'mah'],
  [/^(Вт|W)$/u, 'w'], [/^ніт$/u, 'nit'], [/^(мс|ms)$/u, 'ms'], [/^крок/iu, 'steps'], [/^токен/iu, 'tokens'], [/^параметр/iu, 'params'],
  [/^(раз)/iu, 'x'], [/^(px|fps)$/iu, ''],
];
const CURRENCY: Record<string, string> = { $: 'usd', '€': 'eur', '¥': 'cny', '£': 'gbp' };

function unitOf(u: string | undefined): string | null {
  if (!u) return null;
  for (const [re, c] of UNIT_CANON) if (re.test(u)) return c;
  return null;
}

/** «1,05» → 1.05, «2 599» → 2599; null when not a number. */
export function numberValue(s: string): number | null {
  const v = Number(s.replace(/[   ]/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

const SCALE: Record<string, number> = { tn: 1e12, bn: 1e9, m: 1e6, k: 1e3 };

function numberEntities(text: string, out: Map<string, Entity>): void {
  for (const m of text.matchAll(NUM_RE)) {
    const cur = m[1] ? CURRENCY[m[1]] : undefined;
    const unit = unitOf(m[3]);
    if (!cur && unit === null) continue; // a bare number: years, list numbering, versions
    if (unit === '') continue;
    const v = numberValue(m[2]);
    if (v === null) continue;
    // One canonical form: «1,05 трлн» = «1.05T» = 1 050 млрд; the money unit after the scale.
    const scale = unit && SCALE[unit] ? unit : null;
    const value = scale ? Number((v * SCALE[scale]).toPrecision(6)) : v;
    const money = cur ?? (unit === 'uah' || unit === 'usd' || unit === 'eur' || unit === 'cny' ? unit : null);
    const tail = scale ? '' : unit && !money ? unit : '';
    const key = `num:${money ? `${money}:` : ''}${value}${tail}`;
    if (!out.has(key)) out.set(key, { key, kind: 'number', text: m[0].trim(), weight: 1 });
  }
}

function dateEntities(text: string, out: Map<string, Entity>): void {
  for (const m of text.matchAll(DATE_TEXT_RE)) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    const d = Number(m[1]);
    if (!mo || d < 1 || d > 31) continue;
    const key = `date:${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!out.has(key)) out.set(key, { key, kind: 'date', text: m[0], weight: 1 });
  }
  for (const m of text.matchAll(DATE_NUM_RE)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    const key = `date:${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!out.has(key)) out.set(key, { key, kind: 'date', text: m[0], weight: 1 });
  }
}

function stemOf(w: string): string {
  return w.toLowerCase().replace(/[ʼ'’]/g, '').slice(0, STEM_LEN);
}

/** The entities and topic stems of a plain text (the reader text of a post, without the trailer lines). */
export function extractEntities(text: string): PostEntities {
  const entities = new Map<string, Entity>();
  const src = (text ?? '').replace(/https?:\/\/\S+/g, ' ');

  for (const m of (text ?? '').matchAll(DOMAIN_RE)) {
    const host = m[1].toLowerCase().replace(/^www\./, '');
    if (MEDIA.has(host) || MEDIA.has(host.replace(/\.[a-z]+$/, ''))) continue;
    const key = `dom:${host}`;
    if (!entities.has(key)) entities.set(key, { key, kind: 'domain', text: m[0], weight: 1 });
  }
  const noDomains = src.replace(DOMAIN_RE, ' ');

  for (const m of noDomains.matchAll(NAME_RE)) {
    const raw = m[0].replace(/[:\s-]+$/, '');
    const key = normName(raw);
    if (!key || key.length < 2) continue;
    const weight = nameWeight(key, raw);
    if (!weight) continue;
    const k = `name:${key}`;
    const prev = entities.get(k);
    if (!prev) entities.set(k, { key: k, kind: 'name', text: raw, weight });
    // The brand of a product name counts too: «Gemini Agent» and «Gemini на агента» share Gemini.
    const head = key.split(/[ -]/)[0];
    if (head !== key && BIG_BRANDS.has(head) && !entities.has(`name:${head}`)) {
      entities.set(`name:${head}`, { key: `name:${head}`, kind: 'name', text: head, weight: 1 });
    }
  }

  for (const m of noDomains.matchAll(PERSON_RE)) {
    const words = m[0].split(/[  ]+/);
    // «Що відомо», sentence starts: a capitalised word after a sentence end only counts with another capital after it.
    const key = `person:${words.map(stemOf).map((w) => w.slice(0, 5)).join(' ')}`;
    if (!entities.has(key)) entities.set(key, { key, kind: 'person', text: m[0], weight: 2 });
  }

  numberEntities(noDomains, entities);
  dateEntities(noDomains, entities);

  const stems = new Set<string>();
  for (const m of noDomains.matchAll(/[\p{Script=Cyrillic}ʼ'’]{6,}/gu)) {
    const s = stemOf(m[0]);
    if (!STOP_STEMS.has(s) && ![...STOP_STEMS].some((x) => s.startsWith(x))) stems.add(s);
  }
  return { entities, stems };
}

/** Σ weights of a set of entity keys. */
function weightOf(keys: Iterable<string>, ...maps: Array<Map<string, Entity>>): number {
  let w = 0;
  for (const k of keys) w += Math.max(...maps.map((m) => m.get(k)?.weight ?? 0));
  return w;
}

export interface Overlap {
  /** Weighted containment of the smaller side: shared weight / min(weight of a, weight of b). */
  score: number;
  /** Shared entity weight. */
  shared: number;
  /** Shared entities (keys), heaviest first. */
  keys: string[];
  /** Share of the smaller stem set found in the other one. */
  stems: number;
}

/**
 * Overlap of two posts' entities as containment: the weight of what they share over the weight of the poorer one,
 * so a short post fully contained in a long one scores 1 (the overlap coefficient, weighted).
 */
export function entityOverlap(a: PostEntities, b: PostEntities): Overlap {
  const keys = [...a.entities.keys()].filter((k) => b.entities.has(k) && (a.entities.get(k)!.weight > 0));
  keys.sort((x, y) => b.entities.get(y)!.weight - b.entities.get(x)!.weight);
  const shared = weightOf(keys, a.entities, b.entities);
  const wa = weightOf(a.entities.keys(), a.entities);
  const wb = weightOf(b.entities.keys(), b.entities);
  const score = Math.min(wa, wb) > 0 ? shared / Math.min(wa, wb) : 0;
  let common = 0;
  for (const s of a.stems) if (b.stems.has(s)) common++;
  const stems = Math.min(a.stems.size, b.stems.size) ? common / Math.min(a.stems.size, b.stems.size) : 0;
  return { score: Math.round(score * 1000) / 1000, shared, keys, stems: Math.round(stems * 1000) / 1000 };
}

/** Keys of `a` that `b` does not have (new entities), heaviest first; weightless keys left out. */
export function newEntities(a: PostEntities, b: PostEntities): Entity[] {
  return [...a.entities.values()].filter((e) => e.weight > 0 && !b.entities.has(e.key)).sort((x, y) => y.weight - x.weight);
}

/** Union of several posts' entities (a story's earlier posts). */
export function mergeEntities(list: PostEntities[]): PostEntities {
  const entities = new Map<string, Entity>();
  const stems = new Set<string>();
  for (const p of list) {
    for (const [k, e] of p.entities) if (!entities.has(k) || entities.get(k)!.weight < e.weight) entities.set(k, e);
    for (const s of p.stems) stems.add(s);
  }
  return { entities, stems };
}
