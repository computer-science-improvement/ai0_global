import { normalizeSlop, phraseRegex } from '../../slop-phrases';
import { sentencesOf } from '../../slop-lint';
import { excerptOf, readerText, type Finding, type IntegrityCheck } from '../types';

/**
 * Spec 037 T6: a sentence about the agent's own work instead of the news («Актуальних промокодів … не знайшлось,
 * тому в пості лише перевірені роздачі», Біржа Ігор 13.10). Phrases are normalised like the slop list (lowercase,
 * ʼ, no commas). EXPLICIT ones only ever describe the pipeline (the brief, the tools, «я перевірив») → error;
 * SOFT ones usually do but can describe the story («не вдалося знайти») → warning for the critic.
 */
export const PROCESS_LEAK_EXPLICIT: readonly string[] = [
  'не знайшлось тому', 'не знайшлося тому', 'у пості лише', 'в пості лише', 'у пості тільки', 'в пості тільки',
  'у цьому пості лише', 'в цьому пості лише', 'я перевірив', 'я перевірила', 'за моїми даними', 'інструмент повернув',
  'інструмент не повернув', 'згідно з брифом', 'згідно брифу', 'відповідно до брифу', 'у брифі', 'в брифі',
  'на жаль не вдалося знайти', 'web_fetch', 'fetch_feed', 'publish_post', 'skip_slot', 'library_ref',
];
export const PROCESS_LEAK_SOFT: readonly string[] = [
  'не вдалося знайти', 'не вдалося перевірити', 'пошук не дав', 'на момент написання', 'на момент підготовки',
  'я знайшов', 'я знайшла', 'я не знайшов', 'я не знайшла', 'мені не вдалося', 'у цьому пості', 'в цьому пості',
];

const compile = (list: readonly string[]) => list.map((p) => phraseRegex(normalizeSlop(p)));
const EXPLICIT = compile(PROCESS_LEAK_EXPLICIT);
const SOFT = compile(PROCESS_LEAK_SOFT);

export const processLeakCheck: IntegrityCheck = {
  id: 'process-leak',
  codes: ['process_leak'],
  run: (post) => sentencesOf(readerText(post)).flatMap((s): Finding[] => {
    const n = normalizeSlop(s);
    if (EXPLICIT.some((re) => re.test(n))) {
      return [{ code: 'process_leak', level: 'error' as const, message: 'речення про роботу агента, а не про новину — видали його', excerpt: excerptOf(s) }];
    }
    if (SOFT.some((re) => re.test(n))) {
      return [{ code: 'process_leak', level: 'warning' as const, message: 'схоже на речення про роботу агента (пошук, перевірка), а не про новину', excerpt: excerptOf(s) }];
    }
    return [];
  }),
};
