import { formatLocalStamp, sourceAgeHours } from '../post/dates';

/**
 * Spec 037 T5 (FR-005): the critic does not know when the post goes out. These lines give it the publish time in the
 * resource zone, the source's publication date and, when known, the first post of the story, so «завтра», «щойно»
 * and stale news are judged against the real calendar.
 */
export interface CriticDates {
  /** Scheduled publish instant (ISO). */
  publishAt: string;
  /** Resource zone (IANA). */
  timezone: string;
  /** The source's publication: ISO instant or YYYY-MM-DD; null / absent when unknown. */
  sourcePublishedAt?: string | null;
  /** Where the source date comes from: the page / feed item, or the date in the article URL. */
  sourceDateFrom?: 'page' | 'url';
  /** The first post of the same story on the resource (T2 fills it), ISO. */
  storyFirstPostAt?: string | null;
}

const dayOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const ddmmyyyy = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;

function ago(hours: number | null): string {
  if (hours == null) return '';
  if (hours < 0) return ' (після публікації?)';
  return hours < 48 ? ` — за ${Math.round(hours)} год до публікації` : ` — за ${Math.round(hours / 24)} дн. до публікації`;
}

/** The date lines of the critic prompt, e.g. «Публікація: середа, 08.10.2026 14:00 (Europe/Kyiv). …». */
export function criticDatesLines(d: CriticDates): string[] {
  const out = [`Публікація: ${formatLocalStamp(d.publishAt, d.timezone)}. «Сьогодні», «завтра», «щойно» і дні тижня в пості рахуй від цієї дати.`];
  if (d.sourcePublishedAt) {
    const when = dayOnly(d.sourcePublishedAt) ? ddmmyyyy(d.sourcePublishedAt) : formatLocalStamp(d.sourcePublishedAt, d.timezone);
    out.push(`Дата джерела: ${when}${d.sourceDateFrom === 'url' ? ' (з адреси статті)' : ''}${ago(sourceAgeHours(d.sourcePublishedAt, d.publishAt))}.`);
  }
  if (d.storyFirstPostAt) {
    out.push(`Перший пост цієї історії на ресурсі: ${formatLocalStamp(d.storyFirstPostAt, d.timezone)}${ago(sourceAgeHours(d.storyFirstPostAt, d.publishAt))}.`);
  }
  return out;
}
