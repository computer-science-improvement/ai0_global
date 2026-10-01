import type { EditorCard } from '../card';
import { PostSpec, SUPPORTED_FORMATS } from './post-spec';
import { inlineToPlain, visibleLength } from './inline-markup';
import { CAPTION_LIMIT, TEXT_LIMIT, normalizeHashtag, renderTelegram } from './render-telegram';

export interface LintIssue { code: string; message: string }
export interface LintResult { ok: boolean; errors: LintIssue[]; warnings: LintIssue[] }

/** Signature AI phrasings (from the anti-slop skill) that are never acceptable in a published post. */
export const GLOBAL_BANNED = [
  'варто зазначити', 'слід відзначити', 'важливо розуміти', 'не можна не згадати',
  'у сучасному світі', 'в умовах сьогодення', 'як ніколи раніше', 'на сьогоднішній день',
  'знаменує поворотний момент', 'віха в історії', 'відіграє ключову роль', 'невід\'ємна частина',
  'захоплююча подорож', 'нова ера', 'давайте розберемося', 'розберімось', 'уявіть собі',
  'підсумовуючи', 'у цій статті', 'як штучний інтелект', 'as an ai',
];

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

function bodyPlain(spec: PostSpec): string {
  return spec.body.map((b) => (b.type === 'list' ? b.items.join('\n') : b.text)).map(inlineToPlain).join('\n');
}

function cyrillicShare(text: string): number {
  const letters = text.replace(/https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return 1; // too short to judge
  const cyr = letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length;
  return cyr / letters.length;
}

type LintCard = Pick<EditorCard, 'formats' | 'hashtags' | 'hashtagMin' | 'hashtagMax' | 'footer' | 'linkStyle' | 'emojiPolicy' | 'bannedTerms' | 'language'>;

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
  if (spec.origin === 'library' && !spec.library_ref) err('library_ref_required', 'origin=library — додай library_ref із search_library');

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
  if (spec.format === 'photo' && n !== 1) err('media_count', `photo потребує рівно 1 зображення, зараз ${n}`);
  if (spec.format === 'album' && (n < 2 || n > 10)) err('media_count', `album потребує 2–10 зображень, зараз ${n}`);
  if ((spec.format === 'text' || spec.format === 'poll' || spec.format === 'quiz') && n > 1) err('media_count', `${spec.format}: максимум 1 зображення (як прев’ю)`);
  if (spec.format === 'album' && (spec.buttons.length || spec.cta || card.linkStyle === 'button' && spec.source)) {
    err('album_with_buttons', 'альбом не підтримує кнопки — прибери cta/buttons або обери інший формат');
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
  if ((spec.format === 'text' || spec.format === 'photo' || spec.format === 'album') && !spec.body.length) {
    err('empty_body', 'порожній текст поста');
  }
  if (errors.every((e) => e.code !== 'format_not_supported_yet' && e.code !== 'poll_missing')) {
    const rendered = renderTelegram(spec, card);
    for (const m of rendered.messages) {
      if (m.method === 'sendMessage' && visibleLength(m.text) > TEXT_LIMIT) err('too_long', `текст ${visibleLength(m.text)} > ${TEXT_LIMIT} символів`);
      if (m.method === 'sendMediaGroup' && visibleLength(m.caption) > CAPTION_LIMIT) err('too_long', `підпис альбому ${visibleLength(m.caption)} > ${CAPTION_LIMIT}`);
    }
  }
  if (spec.body.length && spec.body[0].type !== 'lead' && spec.format !== 'poll' && spec.format !== 'quiz') {
    warn('lead_missing', 'перший блок краще зробити lead (жирний гачок)');
  }

  // ── language, banned terms, emoji ─────────────────────────────────────────
  const plain = [spec.title, bodyPlain(spec), spec.poll?.question ?? '', ...(spec.poll?.options ?? [])].join('\n');
  if (card.language === 'uk' && cyrillicShare(bodyPlain(spec) || plain) < 0.6) err('not_ukrainian', 'текст має бути українською');
  const low = plain.toLowerCase();
  for (const term of [...GLOBAL_BANNED, ...card.bannedTerms.map((t) => t.toLowerCase())]) {
    if (term && low.includes(term)) err('banned_term', `заборонена фраза: "${term}"`);
  }
  const emoji = (bodyPlain(spec).match(EMOJI_RE) ?? []).length;
  if (card.emojiPolicy === 'none' && emoji > 0) err('emoji_policy', 'у цьому каналі без емодзі');
  if (card.emojiPolicy === 'sparse' && emoji > 3) err('emoji_policy', `забагато емодзі (${emoji}), максимум 3`);

  if (spec.format === 'photo' && !n) warn('no_media_for_photo_channel', 'photo без зображення');

  return { ok: errors.length === 0, errors, warnings };
}
