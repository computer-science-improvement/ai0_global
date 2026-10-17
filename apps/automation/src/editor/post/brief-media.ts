/**
 * Spec 041 FR-008 (T8): what the owner's brief says about pictures — «у форматі опитувань із картинкою», «кожен пост —
 * одне фото». Review 2 found a channel whose brief asked for a picture on every poll publishing bare polls: the brief
 * reached the writer as prose and nothing checked it. Each sentence that asks for a picture names the formats it covers
 * (polls, quizzes, news / text posts, longreads) or every post («кожен пост», «усі пости»); a negated one («без
 * картинок») asks for nothing. The lint error is `brief_media_missing`.
 */

export type BriefMediaNeed = 'all' | ReadonlySet<string>;

const PICTURE_RE = /(?:картинк|зображен|ілюстрац|фото|світлин|візуал|обкладинк|picture|image|photo)/iu;
const NEGATED_RE = /(?:без|ні|не\s+(?:додава|став|пиши|використов)\p{L}*)\s+(?:\p{L}+\s+){0,2}?(?:картинк|зображен|ілюстрац|фото|світлин|візуал|picture|image|photo)/iu;
/** «з картинкою», «із фото», «має фото», «додавай картинку», «обовʼязково фото», «кожен пост — фото». */
const ASKS_RE = /(?:(?:з|із|зі|має|мають|додава\p{L}*|додай|став|прикріплю\p{L}*|обов[ʼ'’]?язково|завжди|with|always)\s+(?:\p{L}+\s+){0,2}?(?:картинк|зображен|ілюстрац|фото|світлин|візуал|обкладинк|picture|image|photo))|(?:[—–-]\s*(?:одн[аеуоі]\p{L}*\s+)?(?:картинк|фото|зображен|світлин))/iu;
const EVERY_RE = /(?:кож(?:ен|ний|на|не|ного|ну)\s+(?:пост|публікац|допис)|усі\s+пости|всі\s+пости|every\s+post|all\s+posts)/iu;

const FORMAT_WORDS: Array<[RegExp, string[]]> = [
  [/опитуван|poll/iu, ['poll']],
  [/вікторин|quiz/iu, ['quiz']],
  [/лонгрід|стат(?:т|е)\p{L}*|longread/iu, ['longread']],
  [/новин|текстов|text\s+posts?|news/iu, ['text']],
];

/** The formats whose posts must carry a picture by the brief, or 'all'; null when the brief asks for none. */
export function briefMediaNeed(brief: string | null | undefined): BriefMediaNeed | null {
  if (!brief?.trim()) return null;
  const formats = new Set<string>();
  for (const sentence of brief.split(/(?<=[.!?;\n])\s*/u)) {
    if (!PICTURE_RE.test(sentence) || NEGATED_RE.test(sentence) || !ASKS_RE.test(sentence)) continue;
    if (EVERY_RE.test(sentence)) return 'all';
    for (const [re, fs] of FORMAT_WORDS) if (re.test(sentence)) for (const f of fs) formats.add(f);
  }
  return formats.size ? formats : null;
}

/** Formats that carry no picture by design (a media format already requires its own). */
const NO_PICTURE = new Set(['video', 'photo', 'album', 'carousel', 'audio', 'document']);

/** Does the post carry a picture: a media item, or a carousel slide image. */
export function specHasPicture(spec: { media?: ReadonlyArray<unknown>; slides?: ReadonlyArray<{ image?: string | null }> | null }): boolean {
  return (spec.media?.length ?? 0) > 0 || !!spec.slides?.some((s) => !!s.image);
}

/** The lint message when the brief wants a picture on this format and the post has none (null otherwise). */
export function briefMediaMissing(format: string, hasPicture: boolean, brief: string | null | undefined): string | null {
  if (hasPicture || NO_PICTURE.has(format)) return null;
  const need = briefMediaNeed(brief);
  if (!need || (need !== 'all' && !need.has(format))) return null;
  return `бриф каналу вимагає картинку ${need === 'all' ? 'в кожному пості' : `у форматі ${format}`} — додай media: [{"url": "https://…"}] (зображення з джерела чи бібліотеки)`;
}
