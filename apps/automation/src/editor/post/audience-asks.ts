import { normalizeSlop } from './slop-phrases';
import { sentencesOf } from './slop-lint';

/**
 * Spec 034 FR-005: fewer polls and questions to the audience by default.
 *
 * Caps live in the resource profile's `format_prefs` (owner-editable and lockable like the other fields):
 *   • `polls_per_week` — poll + quiz posts on the resource in any 7 days (published and planned);
 *   • `questions_to_readers_per_day` — reader-directed questions; the lint enforces it per post;
 *   • `content_kind` — what the resource is (general / news / education / quiz); it only moves the defaults.
 * Defaults when a cap is not set:
 *   • polls: 1 a week; a `quiz` resource has no default cap (polls are its content);
 *   • reader questions: 1 per post; 0 on a news resource.
 * A resource is "news" when `content_kind` says so or, without `content_kind`, when the profile topic
 * names news (NEWS_TOPIC_RE). Nothing else is inferred: education and quiz resources are set by the
 * builder or the owner.
 */

export const POLL_FORMATS: readonly string[] = ['poll', 'quiz'];
export const isPollFormat = (format: string): boolean => POLL_FORMATS.includes(format);

export const CONTENT_KINDS = ['general', 'news', 'education', 'quiz'] as const;
export type ContentKind = typeof CONTENT_KINDS[number];

export const DEFAULT_POLLS_PER_WEEK = 1;
export const DEFAULT_READER_QUESTIONS = 1;
export const NEWS_READER_QUESTIONS = 0;

/** A profile topic that names news («Новини Києва», «tech news», «дайджест»). */
export const NEWS_TOPIC_RE = /новин|news|дайджест|зведенн/iu;

export interface AudienceCapPrefs {
  content_kind?: ContentKind;
  polls_per_week?: number;
  questions_to_readers_per_day?: number;
}

export interface AudienceCaps {
  kind:            ContentKind;
  /** true when `kind` comes from the topic (no explicit content_kind). */
  kindInferred:    boolean;
  /** Poll + quiz posts in any 7 days; null = no cap (a quiz resource without an explicit cap). */
  pollsPerWeek:    number | null;
  /** Reader-directed questions allowed in one post. */
  questionsPerDay: number;
}

export function contentKindOf(prefs: AudienceCapPrefs | null | undefined, topic?: string | null): { kind: ContentKind; inferred: boolean } {
  if (prefs?.content_kind) return { kind: prefs.content_kind, inferred: false };
  return { kind: topic && NEWS_TOPIC_RE.test(topic) ? 'news' : 'general', inferred: true };
}

/** The effective caps of a resource from its format_prefs and profile topic. */
export function audienceCaps(prefs: AudienceCapPrefs | null | undefined, topic?: string | null): AudienceCaps {
  const { kind, inferred } = contentKindOf(prefs, topic);
  return {
    kind, kindInferred: inferred,
    pollsPerWeek: prefs?.polls_per_week ?? (kind === 'quiz' ? null : DEFAULT_POLLS_PER_WEEK),
    questionsPerDay: prefs?.questions_to_readers_per_day ?? (kind === 'news' ? NEWS_READER_QUESTIONS : DEFAULT_READER_QUESTIONS),
  };
}

/** The caps of a stored profile JSON (format_prefs + topic), tolerant to anything malformed. */
export function audienceCapsOfProfile(raw: unknown): AudienceCaps {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fp = (r.format_prefs && typeof r.format_prefs === 'object' ? r.format_prefs : {}) as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
  const kind = typeof fp.content_kind === 'string' && (CONTENT_KINDS as readonly string[]).includes(fp.content_kind) ? fp.content_kind as ContentKind : undefined;
  return audienceCaps(
    { content_kind: kind, polls_per_week: int(fp.polls_per_week), questions_to_readers_per_day: int(fp.questions_to_readers_per_day) },
    typeof r.topic === 'string' ? r.topic : null,
  );
}

// ── reader-directed questions ────────────────────────────────────────────────

/**
 * Words and phrases that address the reader (normalised: lowercase, ʼ). A question sentence containing one of
 * them is a question to the readers. Word-bounded; `*` = the rest of the word. Kept as a list so tests pin it.
 */
export const READER_MARKERS: readonly string[] = [
  // you (plural / polite) and your
  'ви', 'вас', 'вам', 'вами', 'ваш*',
  // you (singular) and your
  'ти', 'тебе', 'тобі', 'тобою', 'твій', 'твоя', 'твоє', 'твої', 'твого', 'твоєї', 'твоєму', 'твоїй', 'твоїм', 'твоїх', 'твоїми',
  // asks and prompts
  'як думаєте', 'як вважаєте', 'що скажете', 'що думаєте', 'а ви', 'а ти', 'а у вас', 'а в вас',
  'чи доводилось', 'чи доводилося', 'чи траплялось', 'чи траплялося', 'чи пробували', 'чи знали',
  'напишіть', 'пишіть', 'поділіться', 'діліться', 'розкажіть', 'відповідайте', 'голосуйте', 'згодні', 'погоджуєтес*',
  'у коментарях', 'в коментарях', 'у коментарі', 'в коментарі',
];

const W = '[\\p{L}\\p{N}ʼ]';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARKER_RES = READER_MARKERS.map((m) => new RegExp(`(?<!${W})${m.split('*').map(esc).join(`${W}*`)}(?!${W})`, 'u'));

/**
 * Second-person verb forms («думаєте», «пробували б», «знаєш», «уявіть»): plural/polite present -ете/-єте/-ите/-їте,
 * singular -єш/-еш/-иш/-їш, imperative -іть/-йте(ся). Words shorter than 5 letters and a few adjectives in -ите are left out.
 */
const SECOND_PERSON = /(?<![\p{L}ʼ])([\p{L}ʼ]{3,}(?:ете|єте|ите|їте|єш|еш|иш|їш|іть|йте|іться|йтеся))(?![\p{L}ʼ])/u;
const NOT_VERB = new Set(['відкрите', 'закрите', 'вкрите', 'розлите', 'вбите', 'вмите', 'прожите', 'забите', 'пробите', 'зшите', 'покрите', 'розбите', 'добите', 'шите', 'бангладеш', 'століть', 'десятиліть', 'тисячоліть', 'почуттів']);

/** Quoted speech is somebody else's question, not the post's: «…», „…“, “…”, "…". */
const QUOTED = /«[^»\n]*»|„[^“”\n]*[“”]|“[^”\n]*”|"[^"\n]*"/gu;

const isQuestion = (s: string) => /\?[!.…»"”)\s]*$/u.test(s);

/** Is one sentence a question to the readers? */
export function isReaderQuestion(sentence: string): boolean {
  if (!isQuestion(sentence)) return false;
  const n = normalizeSlop(sentence);
  if (MARKER_RES.some((re) => re.test(n))) return true;
  const m = n.match(SECOND_PERSON);
  return !!m && !NOT_VERB.has(m[1]);
}

/** The reader-directed questions of a text (quoted speech removed first). */
export function readerQuestions(text: string): string[] {
  return sentencesOf(text.replace(QUOTED, '«…»')).filter(isReaderQuestion);
}

/** The lint error over the cap (null = fine). `max` absent → the general default (1). */
export function readerQuestionsIssue(text: string, max: number | null | undefined): { code: 'reader_questions'; message: string } | null {
  const cap = max ?? DEFAULT_READER_QUESTIONS;
  const qs = readerQuestions(text);
  if (qs.length <= cap) return null;
  const quote = qs.slice(0, 3).map((q) => `«${q.slice(0, 80)}»`).join(', ');
  return {
    code: 'reader_questions',
    message: `питань до читачів ${qs.length}, ліміт ресурсу ${cap} на пост (questions_to_readers_per_day${cap === 0 ? '; новинний ресурс — без питань' : ''}): ${quote} — заміни на твердження з фактом або прибери`,
  };
}
