import type { EditorCard } from '../card';
import { MAX_BLOCKS, PostSpec, SUPPORTED_FORMATS } from './post-spec';
import { inlineToPlain, visibleLength } from './inline-markup';
import { blockWords, countBlocks, usesRichBlocks } from './blocks';
import { CAPTION_LIMIT, RICH_FORMATS, TEXT_LIMIT, normalizeHashtag, renderTelegram, type RenderCard, type TgMessage } from './render-telegram';
import { RICH_MAX_BLOCKS, RICH_MAX_CHARS, RICH_MAX_DEPTH, richStats } from './render-rich';
/** Spec 034 FR-003: signature AI phrasings (the anti-slop list, normalised) live in slop-phrases.ts. */
import { bannedTermContext, findBannedTerms, findSlopPhrases, normalizeSlop } from './slop-phrases';
import { slopWarnings } from './slop-lint';

export interface LintIssue { code: string; message: string }
/**
 * `warnings` never fail a post. Spec 034: the slop counters arrive here as `slop_*` codes
 * (see SLOP_WARNING_CODES / isSlopWarning in slop-lint.ts) for the pre-publish critic.
 */
export interface LintResult { ok: boolean; errors: LintIssue[]; warnings: LintIssue[] }

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

const blocksPlain = (blocks: PostSpec['body']): string =>
  blocks.map((b) => blockWords(b, inlineToPlain)).join('\n');

function bodyPlain(spec: PostSpec): string {
  return blocksPlain(spec.body);
}

/** Everything the reader sees as text: post body plus carousel slides and the longread article. */
function readerPlain(spec: PostSpec): string {
  const parts = [bodyPlain(spec)];
  if (spec.format === 'carousel') for (const s of spec.slides ?? []) parts.push(s.title, s.text);
  if (spec.format === 'longread' && spec.longread) parts.push(spec.longread.title, blocksPlain(spec.longread.blocks));
  return parts.filter(Boolean).join('\n');
}

/** Spec 033 FR-005: a table in a post shorter than this is a lint warning. */
export const RICH_SHORT_TABLE = 400;
/** Spec 033 FR-005: more than 2 headings in a post shorter than this is a lint warning. */
export const RICH_SHORT_HEADINGS = 1200;

/** Longread teaser limit: the post is a hook for the Telegraph article, not the article. */
export const TEASER_LIMIT = 600;

/** A Bot API sendVideo needs a direct file: an explicit kind 'video' or a .mp4 path. */
export function isDirectVideo(m: { url: string; kind?: 'image' | 'video' }): boolean {
  if (m.kind === 'video') return true;
  try { return /\.mp4$/i.test(new URL(m.url).pathname); } catch { return false; }
}

function cyrillicShare(text: string): number {
  const letters = text.replace(/https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return 1; // too short to judge
  const cyr = letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length;
  return cyr / letters.length;
}

type LintCard = Pick<EditorCard, 'formats' | 'hashtags' | 'hashtagMin' | 'hashtagMax' | 'footer' | 'linkStyle' | 'emojiPolicy' | 'bannedTerms' | 'language'> & RenderCard
  & Partial<Pick<EditorCard, 'humor' | 'slang' | 'emojiPref'>>;

export function lintPost(spec: PostSpec, card: LintCard): LintResult {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const err = (code: string, message: string) => errors.push({ code, message });
  const warn = (code: string, message: string) => warnings.push({ code, message });

  // ── format ────────────────────────────────────────────────────────────────
  if (!(SUPPORTED_FORMATS as readonly string[]).includes(spec.format)) {
    err('format_not_supported_yet', `формат ${spec.format} ще не підтримується; доступні: ${SUPPORTED_FORMATS.join(', ')}`);
  }
  const allowed = Object.entries(card.formats ?? {}).filter(([, w]) => Number(w) > 0).map(([f]) => f);
  if (allowed.length && !allowed.includes(spec.format)) {
    err('format_not_allowed', `формат ${spec.format} не дозволений у каналі; дозволені: ${allowed.join(', ')}`);
  }

  // ── origin / attribution ──────────────────────────────────────────────────
  if (spec.origin === 'external' && !spec.source) err('source_required', 'матеріал із зовнішнього джерела — додай source.url');
  if (spec.origin === 'library' && !spec.library_ref) err('library_ref_required', 'origin=library — додай library_ref (ref рядка з query_data або search_library)');

  // ── hashtags ──────────────────────────────────────────────────────────────
  const tags = spec.hashtags.map(normalizeHashtag);
  const vocab = new Set(card.hashtags.map(normalizeHashtag));
  for (const t of tags) {
    if (!/^[\p{L}\p{N}_]+$/u.test(t)) err('hashtag_format', `хештег "${t}" — лише літери, цифри, _`);
    else if (vocab.size && !vocab.has(t)) err('hashtag_not_in_vocabulary', `хештег "${t}" не зі словника: ${[...vocab].join(', ')}`);
  }
  if (new Set(tags).size !== tags.length) err('hashtag_duplicate', 'хештеги повторюються');
  if (spec.format !== 'poll' && spec.format !== 'quiz' && (tags.length < card.hashtagMin || tags.length > card.hashtagMax)) {
    err('hashtag_count', `хештегів має бути ${card.hashtagMin}–${card.hashtagMax}, зараз ${tags.length}`);
  }

  // ── media ─────────────────────────────────────────────────────────────────
  const n = spec.media.length;
  if (spec.format === 'photo' && n !== 1) {
    err('media_count', n === 0
      ? 'photo потребує рівно 1 зображення, зараз 0 — додай media: [{"url": "https://…"}] (пряме посилання на картинку з джерела, бібліотеки чи від власника) або зміни format на text'
      : `photo потребує рівно 1 зображення, зараз ${n} — залиш одне або зміни format на album`);
  }
  if (spec.format === 'album' && (n < 2 || n > 10)) err('media_count', `album потребує 2–10 зображень, зараз ${n}`);
  if ((spec.format === 'text' || spec.format === 'poll' || spec.format === 'quiz') && n > 1) err('media_count', `${spec.format}: максимум 1 зображення (як прев’ю)`);
  if (spec.format === 'longread' && n > 1) err('media_count', 'longread: максимум 1 зображення (обкладинка статті)');
  if (spec.format === 'carousel' && n > 0) err('media_count', 'carousel: зображення задаються в slides[].image, media має бути порожнім');
  if (spec.format === 'video') {
    if (n !== 1) err('media_count', `video потребує рівно 1 відео, зараз ${n}`);
    else if (!isDirectVideo(spec.media[0])) err('video_url', 'video: потрібне пряме посилання на файл .mp4 (або media[0].kind="video"), не сторінка YouTube/соцмережі');
  } else if (spec.media.some((m) => m.kind === 'video')) {
    err('media_kind', 'відео (kind="video") можна лише у format=video');
  }
  if ((spec.format === 'album' || spec.format === 'carousel') && (spec.buttons.length || spec.cta || card.linkStyle === 'button' && spec.source)) {
    err('album_with_buttons', `${spec.format === 'album' ? 'альбом' : 'карусель'} не підтримує кнопки — прибери cta/buttons або обери інший формат`);
  }

  // ── carousel / longread payloads ──────────────────────────────────────────
  if (spec.format === 'carousel') {
    const k = spec.slides?.length ?? 0;
    if (k < 2 || k > 10) err('slides_count', `carousel потребує 2–10 слайдів, зараз ${k}`);
  } else if (spec.slides?.length) {
    warn('slides_ignored', 'поле slides використовується лише у format=carousel');
  }
  if (spec.format === 'longread') {
    if (!spec.longread) err('longread_missing', 'longread потребує поля longread {title, blocks}');
    const teaser = bodyPlain(spec).length;
    if (teaser > TEASER_LIMIT) err('teaser_too_long', `тизер лонгріду ${teaser} > ${TEASER_LIMIT} символів — повний текст іде в longread.blocks`);
  } else if (spec.longread) {
    warn('longread_ignored', 'поле longread використовується лише у format=longread');
  }

  // ── poll / quiz ───────────────────────────────────────────────────────────
  if (spec.format === 'poll' || spec.format === 'quiz') {
    if (!spec.poll) err('poll_missing', `${spec.format} потребує поля poll`);
    else {
      if (spec.format === 'quiz') {
        const ci = spec.poll.correct_index;
        if (ci === undefined || ci < 0 || ci >= spec.poll.options.length) err('quiz_correct_index', 'вікторина: correct_index має вказувати на існуючий варіант');
        if (spec.poll.explanation && inlineToPlain(spec.poll.explanation).length > 200) err('quiz_explanation', 'пояснення ≤ 200 символів');
      }
      if (new Set(spec.poll.options.map((o) => o.trim().toLowerCase())).size !== spec.poll.options.length) err('poll_options', 'варіанти не мають повторюватись');
    }
  } else if (spec.poll) {
    warn('poll_ignored', 'поле poll ігнорується для цього формату');
  }

  // ── body / length ─────────────────────────────────────────────────────────
  if (['text', 'photo', 'album', 'carousel', 'longread', 'video'].includes(spec.format) && !spec.body.length) {
    err('empty_body', 'порожній текст поста');
  }
  if (errors.every((e) => e.code !== 'format_not_supported_yet' && e.code !== 'poll_missing')) {
    const rendered = renderTelegram(spec, card);
    // A rich message is checked against the Bot API limits, and its HTML fallback like any HTML message (spec 033).
    const checked: TgMessage[] = rendered.messages.flatMap((m): TgMessage[] => (m.method === 'sendRichMessage' ? [m, m.fallback] : [m]));
    for (const m of checked) {
      if (m.method === 'sendRichMessage') {
        const st = richStats(m.blocks);
        if (st.chars > RICH_MAX_CHARS) err('too_long', `rich-повідомлення ${st.chars} > ${RICH_MAX_CHARS} символів`);
        if (st.blocks > RICH_MAX_BLOCKS) err('too_many_blocks', `rich-повідомлення: ${st.blocks} блоків > ${RICH_MAX_BLOCKS}`);
        if (st.depth > RICH_MAX_DEPTH) err('too_deep', `rich-повідомлення: вкладеність ${st.depth} > ${RICH_MAX_DEPTH}`);
        continue;
      }
      const fb = rendered.messages.some((r) => r.method === 'sendRichMessage' && r.fallback === m) ? ' (HTML-резерв rich-поста)' : '';
      if (m.method === 'sendMessage' && visibleLength(m.text) > TEXT_LIMIT) err('too_long', `текст ${visibleLength(m.text)} > ${TEXT_LIMIT} символів${fb}`);
      if (m.method === 'sendMediaGroup' && visibleLength(m.caption) > CAPTION_LIMIT) err('too_long', `підпис альбому ${visibleLength(m.caption)} > ${CAPTION_LIMIT}`);
      if (m.method === 'sendVideo' && visibleLength(m.caption) > CAPTION_LIMIT) err('too_long', `підпис відео ${visibleLength(m.caption)} > ${CAPTION_LIMIT}${fb}`);
    }
  }
  // ── rich blocks (spec 033) ────────────────────────────────────────────────
  const allBlocks = [...spec.body, ...(spec.longread?.blocks ?? [])];
  for (const [where, blocks] of [['body', spec.body], ['longread.blocks', spec.longread?.blocks ?? []]] as const) {
    const total = countBlocks(blocks);
    if (total > MAX_BLOCKS) err('too_many_blocks', `${where}: ${total} блоків разом із вкладеними, максимум ${MAX_BLOCKS}`);
  }
  for (const b of allBlocks.flatMap((x) => (x.type === 'details' ? [x, ...x.body] : [x]))) {
    if (b.type === 'table' && b.rows.some((r) => r.length > b.header.length)) {
      err('table_shape', `таблиця: рядок довший за заголовок (${b.header.length} колонок) — вирівняй колонки`);
    }
  }
  const bodyLen = bodyPlain(spec).length;
  if (spec.body.some((b) => b.type === 'table') && bodyLen < RICH_SHORT_TABLE) {
    warn('table_in_short_post', `таблиця в короткому пості (${bodyLen} < ${RICH_SHORT_TABLE} символів) — тут краще звичайний текст або список`);
  }
  if (usesRichBlocks(spec.body) && !RICH_FORMATS.has(spec.format)) {
    warn('rich_in_caption', `${spec.format}: підпис не може бути rich-повідомленням — заголовки, таблиці й формули стануть простим текстом`);
  } else if (usesRichBlocks(spec.body) && (card.richPref === 'never' || card.richUnsupported)) {
    warn('rich_off', card.richPref === 'never'
      ? 'format_prefs.rich = never: заголовки, таблиці й формули підуть простим HTML-текстом'
      : 'канал зараз не приймає rich-повідомлення: заголовки, таблиці й формули підуть простим HTML-текстом');
  }
  const headings = spec.body.filter((b) => b.type === 'heading').length;
  if (headings > 2 && bodyLen < RICH_SHORT_HEADINGS) {
    warn('too_many_headings', `${headings} підзаголовки в короткому пості (${bodyLen} символів) — максимум 2, або прибери їх`);
  }

  if (spec.body.length && spec.body[0].type !== 'lead' && spec.format !== 'poll' && spec.format !== 'quiz') {
    warn('lead_missing', 'перший блок краще зробити lead (жирний гачок)');
  }

  // ── language, banned terms, emoji ─────────────────────────────────────────
  const plain = [spec.title, readerPlain(spec), spec.poll?.question ?? '', ...(spec.poll?.options ?? [])].join('\n');
  const share = cyrillicShare(readerPlain(spec) || plain);
  if (card.language === 'uk' && share < 0.6) {
    err('not_ukrainian', `текст має бути українською: кирилиці ${Math.round(share * 100)}% із потрібних 60% — перекажи англійські цитати й назви українською або винеси їх у посилання`);
  }
  // Spec 034 FR-003: normalised (case, ʼ ’ ') banned phrases are errors; the slop counters are warnings for the critic.
  for (const term of findSlopPhrases(plain)) err('banned_term', `заборонена фраза: "${term}"`);
  for (const term of findBannedTerms(plain, card.bannedTerms)) {
    const word = bannedTermContext(plain, term);
    err('banned_term', `заборонене слово з картки каналу: "${term}"${word && word !== normalizeSlop(term) ? ` (знайдено в «${word}»)` : ''}`);
  }
  const emoji = (readerPlain(spec).match(EMOJI_RE) ?? []).length;
  if (card.emojiPolicy === 'none' && emoji > 0) err('emoji_policy', 'у цьому каналі без емодзі');
  if (card.emojiPolicy === 'sparse' && emoji > 3) err('emoji_policy', `забагато емодзі (${emoji}), максимум 3`);
  const reader = [readerPlain(spec), spec.poll?.question ?? '', ...(spec.poll?.options ?? [])].filter(Boolean).join('\n');
  for (const w of slopWarnings({ body: bodyPlain(spec), all: reader, prefs: { humor: card.humor, slang: card.slang, emoji: card.emojiPref } })) {
    warn(w.code, w.message);
  }

  if (spec.format === 'photo' && !n) warn('no_media_for_photo_channel', 'photo без зображення');

  return { ok: errors.length === 0, errors, warnings };
}
