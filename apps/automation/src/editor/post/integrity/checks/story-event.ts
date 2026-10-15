import { parseDeclaredEventAt, textNamesDate } from '../../../story/story-event';
import { excerptOf, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-003 (T3): an announcement (`story.event_at`) carries its date in the text — the reader learns when the
 * event is, and the registry stores the date the post shows. Read by the T5 date parser: «13 жовтня о 16:00 за
 * Києвом», «13.10», «23 жовтня»; a declared time must be the text's time too. A post without `event_at` is not
 * checked (an export never declares one).
 */
export const storyEventCheck: IntegrityCheck = {
  id: 'story-event',
  codes: ['event_date_missing'],
  run: (post) => {
    const raw = post.story?.eventAt;
    if (!raw) return [];
    const declared = parseDeclaredEventAt(raw, post.timezone || 'Europe/Kyiv');
    if (!declared) {
      return [{ code: 'event_date_missing', level: 'error', excerpt: excerptOf(raw, 40), message: `story.event_at «${raw}» не розібрати: «2026-10-13T16:00» або «2026-10-13»` }];
    }
    if (textNamesDate(post, declared)) return [];
    const [, m, d] = declared.day.split('-');
    const at = declared.time ? ` о ${declared.time}` : '';
    return [{
      code: 'event_date_missing', level: 'error', excerpt: excerptOf(raw, 40),
      message: `анонс події без її дати в тексті: напиши дату${declared.time ? ' й час' : ''} події («${Number(d)}.${m}${at}» або «${Number(d)} <місяця>${at} за Києвом»), як у story.event_at ${declared.day}${declared.time ? ` ${declared.time}` : ''}`,
    }];
  },
};
