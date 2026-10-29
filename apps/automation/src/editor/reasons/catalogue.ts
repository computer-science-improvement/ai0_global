import { agentCauseOf } from '../silent/skip-reasons';

/**
 * Spec 073 FR-014: ONE catalogue of the reasons a slot, a plan or a channel does not do what it should — the label the
 * dashboard shows (`en`), the words the owner bot sends (`uk`), the one sentence that says what to change (`fix`) and where
 * in the dashboard to change it (`link`). The Inbox notes, the silent-day lines and the slot details read it; the dashboard
 * mirrors `{ code, en, fix.en, link }` in `apps/dashboard/src/lib/reasons.ts` (its test reads THIS file and fails on a drift).
 *
 * `kind` is a DISPLAY group, not the skip class: a code may be kind `dataset` and still be in `CONFIG_FAILURE_CODES`.
 * `REASONS` is a plain literal (no helpers, no spreads): the dashboard's drift test evaluates it as it stands.
 */
export type ReasonEntry = {
  code: string;                        // snake_case, unique
  kind: 'skip' | 'preflight' | 'config' | 'doctor' | 'source' | 'dataset';
  en: string;                          // dashboard label, English, no Cyrillic
  uk: string;                          // owner bot / Telegram, Ukrainian
  fix?: { en: string; uk: string };    // one sentence: what to change
  link?: string;                       // dashboard path template; placeholders :channel :agent :dataset :series
};

export const REASONS: ReasonEntry[] = [
  // ── the skip groups (a dark-day line names a group when the error has no code of its own) ─────────────────────────
  { code: 'critic', kind: 'skip', en: 'Stopped by the critic', uk: 'Зупинив критик',
    fix: { en: 'Read the critic notes on the slot and adjust the brief or the skills that shaped the post.', uk: 'Прочитайте нотатки критика на слоті й поправте бриф чи навички, з яких писався пост.' }, link: '/app/editor/:channel' },
  { code: 'lint', kind: 'skip', en: 'Text checks failed', uk: 'Пост не пройшов перевірки тексту',
    fix: { en: 'Open the slot to see which check failed and fix the brief or the skill that causes it.', uk: 'Відкрийте слот, щоб побачити, яка перевірка не пройшла, і поправте бриф чи навичку, що її викликає.' }, link: '/app/editor/:channel' },
  { code: 'cap', kind: 'skip', en: 'A posting limit applied', uk: 'Спрацював ліміт публікацій',
    fix: { en: 'Check the limits and quiet hours in the channel card.', uk: 'Перевірте ліміти й тихі години в картці каналу.' }, link: '/app/editor/:channel' },
  { code: 'nothing_fresh', kind: 'source', en: 'Nothing fresh to post', uk: 'Немає свіжого матеріалу',
    fix: { en: 'Add material for the series: rows in its dataset or another source.', uk: 'Додайте матеріал для серії: рядки в її наборі даних або інше джерело.' }, link: '/app/editor/:channel' },
  { code: 'budget', kind: 'skip', en: 'Skipped over the budget', uk: 'Пропущено через бюджет',
    fix: { en: 'Raise the daily budget or wait for it to reset.', uk: 'Підніміть денний бюджет або зачекайте, поки він оновиться.' } },
  { code: 'other', kind: 'skip', en: 'Skipped by the agent — other reason', uk: 'Агент пропустив слот з іншої причини',
    fix: { en: 'Open the slot to read the explanation the agent gave.', uk: 'Відкрийте слот, щоб прочитати пояснення агента.' } },

  // ── why an executor skipped its own slot (skip_slot.cause) ─────────────────────────────────────────────────────────
  { code: 'no_material', kind: 'skip', en: 'Skipped by the agent — no material', uk: 'Агент пропустив слот: немає матеріалу',
    fix: { en: 'Add material: rows in the dataset or another source for the series.', uk: 'Додайте матеріал: рядки в наборі даних або інше джерело для серії.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'source_unreachable', kind: 'skip', en: 'Skipped by the agent — source unreachable', uk: 'Агент пропустив слот: джерело недоступне',
    fix: { en: 'Check that the source opens, or add another source.', uk: 'Перевірте, чи джерело відкривається, або додайте інше.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'source_used', kind: 'skip', en: 'Skipped by the agent — source already used', uk: 'Агент пропустив слот: джерело вже використано',
    fix: { en: 'Add another source or wait for new items.', uk: 'Додайте інше джерело або зачекайте на нові матеріали.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'quality', kind: 'skip', en: 'Skipped by the agent — weak material', uk: 'Агент пропустив слот: матеріал слабкий',
    fix: { en: 'Add stronger material for this series.', uk: 'Додайте сильніший матеріал для цієї серії.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'skipped_by_agent', kind: 'skip', en: 'Skipped by the agent', uk: 'Агент пропустив слот',
    fix: { en: 'Open the slot to read the explanation the agent gave.', uk: 'Відкрийте слот, щоб прочитати пояснення агента.' } },
  { code: 'skipped_by_owner', kind: 'skip', en: 'Skipped by you', uk: 'Пропущено вами' },

  // ── content failures of the publish guards (the fallback ladder retries these) ─────────────────────────────────────
  { code: 'lint_failed', kind: 'skip', en: 'Post failed the text checks', uk: 'Пост не пройшов перевірки тексту',
    fix: { en: 'Open the slot to see which check failed and fix the brief or the skill that causes it.', uk: 'Відкрийте слот, щоб побачити, яка перевірка не пройшла, і поправте бриф чи навичку, що її викликає.' }, link: '/app/editor/:channel' },
  { code: 'guard_failed', kind: 'skip', en: 'Publishing guard refused the post', uk: 'Захист публікації відхилив пост',
    fix: { en: 'Open the slot to see which guard refused the post.', uk: 'Відкрийте слот, щоб побачити, який захист відхилив пост.' }, link: '/app/editor/:channel' },
  { code: 'too_similar', kind: 'skip', en: 'Too similar to a recent post', uk: 'Надто схожий на недавній пост',
    fix: { en: 'Give the slot a different angle or source so that it does not repeat a recent post.', uk: 'Дайте слоту інший кут чи джерело, щоб він не повторював недавній пост.' } },
  { code: 'too_verbatim', kind: 'skip', en: 'Copies its source too closely', uk: 'Надто дослівно повторює джерело',
    fix: { en: 'Ask for a retelling in the channel voice, or mark the text as a quotation with its source.', uk: 'Попросіть переказ у голосі каналу або позначте текст як цитату з посиланням на джерело.' } },
  { code: 'source_already_posted', kind: 'source', en: 'Source already posted', uk: 'Джерело вже публікували',
    fix: { en: 'Add another source or let the series take the next item.', uk: 'Додайте інше джерело або дозвольте серії взяти наступний матеріал.' } },
  { code: 'library_item_already_posted', kind: 'dataset', en: 'Library row already posted', uk: 'Рядок бібліотеки вже публікували',
    fix: { en: 'Add rows to the dataset or point the series at another one.', uk: 'Додайте рядки в набір даних або вкажіть серії інший.' }, link: '/app/data/:dataset' },
  { code: 'already_posted', kind: 'source', en: 'Already posted', uk: 'Це вже публікували',
    fix: { en: 'Pick a different item for this slot.', uk: 'Оберіть для слота інший матеріал.' } },
  { code: 'quiz_answer_mismatch', kind: 'dataset', en: 'Quiz answer does not match the dataset', uk: 'Відповідь вікторини не збігається з даними',
    fix: { en: 'Mark the answer that the dataset row gives and do not correct it from memory.', uk: 'Позначте відповідь, яку дає рядок набору даних, і не виправляйте її з памʼяті.' }, link: '/app/data/:dataset' },
  { code: 'library_ref_not_found', kind: 'dataset', en: 'Library row not found', uk: 'Рядка бібліотеки не знайдено',
    fix: { en: 'Check that the slot names a row that exists in the dataset.', uk: 'Перевірте, що слот посилається на рядок, який є в наборі даних.' }, link: '/app/data/:dataset' },
  { code: 'series_source_mismatch', kind: 'config', en: 'The post source is not the series source', uk: 'Джерело поста не збігається з джерелом серії',
    fix: { en: 'Make the post use the source the series names, or change the source of the series.', uk: 'Зробіть так, щоб пост брав джерело, яке названо в серії, або змініть джерело серії.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'live_source_missing', kind: 'source', en: 'Live slot without its source', uk: 'Живий слот без джерела',
    fix: { en: 'Add the feed the live slot reads, or turn the slot into a plain one.', uk: 'Додайте стрічку, яку читає живий слот, або зробіть слот звичайним.' } },
  { code: 'not_next_in_order', kind: 'dataset', en: 'Row is not next in the series order', uk: 'Рядок не наступний у порядку серії',
    fix: { en: 'Take the row the series names as next, or set the series to random order.', uk: 'Візьміть рядок, який серія називає наступним, або поставте серії довільний порядок.' }, link: '/app/data/:dataset' },

  // ── the slot pre-flight (checked for $0 before a run is paid for) ──────────────────────────────────────────────────
  { code: 'preflight_no_material', kind: 'preflight', en: 'Nothing to post from the library row', uk: 'Немає з чого публікувати: рядок бібліотеки порожній',
    fix: { en: 'Add rows with the fields this series needs, or change its source.', uk: 'Додайте рядки з полями, потрібними серії, або змініть її джерело.' }, link: '/app/data/:dataset' },
  { code: 'preflight_source_used', kind: 'preflight', en: 'Source already used', uk: 'Джерело вже використано',
    fix: { en: 'Add another source or wait for new items.', uk: 'Додайте інше джерело або зачекайте на нові матеріали.' } },
  { code: 'preflight_stale', kind: 'preflight', en: 'Source is too old', uk: 'Джерело застаріло',
    fix: { en: 'Add a fresher source or raise the age limit in the channel card.', uk: 'Додайте свіжіше джерело або підніміть ліміт віку в картці каналу.' }, link: '/app/editor/:channel' },
  { code: 'preflight_host_blocked', kind: 'preflight', en: 'Source site is blocking us', uk: 'Сайт джерела нас блокує',
    fix: { en: 'Add another source for the series; the site is tried again after the block expires.', uk: 'Додайте серії інше джерело; сайт буде опитано знову, коли блок спливе.' } },
  { code: 'preflight_format_unavailable', kind: 'config', en: 'Format cannot be produced here', uk: 'Цей формат тут не можна зробити',
    fix: { en: 'Set up what the format needs (for a carousel, slide hosting) or change the format of the series.', uk: 'Налаштуйте те, чого потребує формат (для каруселі це хостинг слайдів), або змініть формат серії.' }, link: '/app/editor/:channel' },

  // ── limits and quiet hours ─────────────────────────────────────────────────────────────────────────────────────────
  { code: 'daily_cap_reached', kind: 'skip', en: 'Daily post limit reached', uk: 'Досягнуто денний ліміт постів',
    fix: { en: 'Raise the maximum posts per day in the channel card if more should go out.', uk: 'Підніміть максимум постів на день у картці каналу, якщо їх має виходити більше.' }, link: '/app/editor/:channel' },
  { code: 'poll_cap_reached', kind: 'skip', en: 'Weekly poll limit reached', uk: 'Досягнуто тижневий ліміт опитувань',
    fix: { en: 'Raise the poll limit in the channel card, or make the question a series, which the limit does not cover.', uk: 'Підніміть ліміт опитувань у картці каналу або зробіть питання серією: ліміт на неї не поширюється.' }, link: '/app/editor/:channel' },
  { code: 'min_gap', kind: 'skip', en: 'Too soon after the previous post', uk: 'Надто скоро після попереднього поста',
    fix: { en: 'Lower the minimum gap in the channel card or move the slots further apart.', uk: 'Зменште мінімальний інтервал у картці каналу або рознесіть слоти.' }, link: '/app/editor/:channel' },
  { code: 'quiet_hours', kind: 'skip', en: 'Inside quiet hours', uk: 'У тихі години',
    fix: { en: 'Move the slot out of the quiet hours or change them in the channel card.', uk: 'Перенесіть слот поза тихими годинами або змініть їх у картці каналу.' }, link: '/app/editor/:channel' },
  { code: 'blackout_window', kind: 'skip', en: 'Inside a blackout window', uk: 'У вікні, коли публікувати заборонено',
    fix: { en: 'Move the slot or change the blackout rule in the schedule.', uk: 'Перенесіть слот або змініть правило заборони в розкладі.' }, link: '/app/agents/:agent?tab=schedule' },

  // ── the critic and the budget ──────────────────────────────────────────────────────────────────────────────────────
  { code: 'critic_rejected', kind: 'skip', en: 'Rejected by the critic', uk: 'Критик відхилив пост',
    fix: { en: 'Read the critic notes on the slot and adjust the brief or the sources if the same reason repeats.', uk: 'Прочитайте нотатки критика на слоті й поправте бриф чи джерела, якщо причина повторюється.' }, link: '/app/editor/:channel' },
  { code: 'critic_failed', kind: 'skip', en: 'Critic unavailable — held', uk: 'Критик недоступний, пост утримано',
    fix: { en: 'Check that the critic model answers; the post is held until then.', uk: 'Перевірте, чи відповідає модель критика; до того пост утримується.' } },
  { code: 'budget_exceeded', kind: 'skip', en: 'Budget exhausted', uk: 'Бюджет вичерпано',
    fix: { en: 'Raise the daily budget or wait for it to reset.', uk: 'Підніміть денний бюджет або зачекайте, поки він оновиться.' } },
  { code: 'waiting_for_budget', kind: 'skip', en: 'Waiting for budget', uk: 'Чекає на бюджет',
    fix: { en: 'Raise the daily budget or wait; the slot tries again by itself.', uk: 'Підніміть денний бюджет або зачекайте: слот спробує знову сам.' } },

  // ── sources ────────────────────────────────────────────────────────────────────────────────────────────────────────
  { code: 'no_fresh_item', kind: 'source', en: 'Nothing fresh in the sources', uk: 'У джерелах немає свіжого',
    fix: { en: 'Add a source that publishes more often, or raise the maximum age in the channel card.', uk: 'Додайте джерело, що виходить частіше, або підніміть максимальний вік у картці каналу.' }, link: '/app/editor/:channel' },
  { code: 'source_not_published', kind: 'source', en: 'Source post not published yet', uk: 'Першоджерело ще не опубліковане',
    fix: { en: 'Wait for the source post to go out first.', uk: 'Зачекайте, поки вийде пост-першоджерело.' } },
  { code: 'required_source_empty', kind: 'source', en: 'Required source of the series has nothing left', uk: 'В обовʼязковому джерелі серії нічого не лишилося',
    fix: { en: 'Add rows or items to the source, or change the source of the series.', uk: 'Додайте рядки чи матеріали в джерело або змініть джерело серії.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'host_blocked', kind: 'source', en: 'Source site is blocked', uk: 'Сайт джерела заблоковано',
    fix: { en: 'Add another source; the site is tried again when the block expires.', uk: 'Додайте інше джерело; сайт буде опитано знову, коли блок спливе.' } },
  { code: 'feed_too_large', kind: 'source', en: 'Source is too large to read', uk: 'Джерело завелике для читання',
    fix: { en: 'Use a smaller feed or another source.', uk: 'Візьміть меншу стрічку або інше джерело.' } },
  { code: 'fetch_failed', kind: 'source', en: 'Source could not be fetched', uk: 'Джерело не вдалося завантажити',
    fix: { en: 'Check that the source opens, or add another one.', uk: 'Перевірте, чи джерело відкривається, або додайте інше.' } },
  { code: 'story_skip', kind: 'skip', en: 'Story already told', uk: 'Цю історію вже розповідали',
    fix: { en: 'Give the slot a different topic.', uk: 'Дайте слоту іншу тему.' } },
  { code: 'story_repeat', kind: 'skip', en: 'Story repeats an earlier post', uk: 'Історія повторює попередній пост',
    fix: { en: 'Give the slot a different topic.', uk: 'Дайте слоту іншу тему.' } },

  // ── the system's and the owner's own decisions (never a miss) ──────────────────────────────────────────────────────
  { code: 'superseded', kind: 'skip', en: 'Replaced by a newer plan', uk: 'Замінено новішим планом' },
  { code: 'mode_changed', kind: 'skip', en: 'Channel mode changed', uk: 'Режим каналу змінено' },
  { code: 'draft_canceled', kind: 'skip', en: 'Draft canceled', uk: 'Чернетку скасовано' },
  { code: 'series_paused', kind: 'skip', en: 'Series paused', uk: 'Серію призупинено',
    fix: { en: 'Resume the series when its material is back.', uk: 'Відновіть серію, коли зʼявиться матеріал.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'rejected_by_owner', kind: 'skip', en: 'Rejected by you', uk: 'Відхилено вами' },
  { code: 'resource_paused', kind: 'skip', en: 'Resource paused', uk: 'Ресурс призупинено',
    fix: { en: 'Resume the resource to plan posts for it again.', uk: 'Відновіть ресурс, щоб для нього знову планувались пости.' }, link: '/app/agents/:agent' },
  { code: 'agent_paused', kind: 'skip', en: 'Agent paused', uk: 'Агента призупинено',
    fix: { en: 'Resume the agent so that its slots run again.', uk: 'Відновіть агента, щоб його слоти знову виконувались.' }, link: '/app/agents/:agent' },
  { code: 'resource_unavailable', kind: 'skip', en: 'Connection broken', uk: 'Підключення зламане',
    fix: { en: 'Reconnect the resource in Connections.', uk: 'Підключіть ресурс заново в розділі Connections.' } },

  // ── the planner ────────────────────────────────────────────────────────────────────────────────────────────────────
  { code: 'planner_no_material', kind: 'skip', en: 'Declared empty by the planner', uk: 'Планувальник оголосив день порожнім: немає матеріалу',
    fix: { en: 'Add material for the series, or pause it until there is some.', uk: 'Додайте матеріал для серії або призупиніть її, доки його немає.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'planner_source_unreachable', kind: 'skip', en: 'Declared empty by the planner (sources unreadable)', uk: 'Планувальник оголосив день порожнім: джерела не читаються',
    fix: { en: 'Check that the sources of the series open, or add another one.', uk: 'Перевірте, чи відкриваються джерела серії, або додайте інше.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'planner_skipped', kind: 'skip', en: 'Skipped by the planner', uk: 'Планувальник пропустив цей випуск',
    fix: { en: 'Read the reason the planner gave on the slot, and fix what it names.', uk: 'Прочитайте причину, яку назвав планувальник, і виправте те, що в ній сказано.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'series_format_unavailable', kind: 'config', en: 'Series format cannot be produced here', uk: 'Формат серії тут не можна зробити',
    fix: { en: 'Set up what the format needs, or change the format of the series.', uk: 'Налаштуйте те, чого потребує формат, або змініть формат серії.' }, link: '/app/agents/:agent?tab=schedule' },
  { code: 'series_in_quiet_hours', kind: 'config', en: 'Series time falls in quiet hours', uk: 'Час серії припадає на тихі години',
    fix: { en: 'Move the time of the series out of the quiet hours, or change the quiet hours in the channel card.', uk: 'Перенесіть час серії поза тихими годинами або змініть тихі години в картці каналу.' }, link: '/app/editor/:channel' },
  { code: 'series_stalled', kind: 'skip', en: 'Series has not gone out two days in a row', uk: 'Серія не виходить два дні поспіль',
    fix: { en: 'Open the latest skipped slot of the series to see why it stops.', uk: 'Відкрийте останній пропущений слот серії, щоб побачити, чому вона зупинилась.' }, link: '/app/agents/:agent?tab=schedule' },

  // ── how a run ended (a failed slot keeps the run status in front of the message) ───────────────────────────────────
  { code: 'retrying', kind: 'skip', en: 'Retrying after a failed attempt', uk: 'Повторна спроба після невдалої' },
  { code: 'max_steps', kind: 'skip', en: 'Run hit its step limit', uk: 'Запуск вичерпав ліміт кроків',
    fix: { en: 'Simplify the brief of this slot; a run that takes too many steps is cut off.', uk: 'Спростіть бриф цього слота: запуск, якому треба забагато кроків, обривається.' } },
  { code: 'no_terminal', kind: 'skip', en: 'Run ended without a result', uk: 'Запуск завершився без результату',
    fix: { en: 'Try the slot again; if it repeats, simplify the brief.', uk: 'Спробуйте слот ще раз; якщо повторюється, спростіть бриф.' } },
  { code: 'error', kind: 'skip', en: 'Run failed with an error', uk: 'Запуск завершився помилкою',
    fix: { en: 'Open the run trace to see the error.', uk: 'Відкрийте слід запуску, щоб побачити помилку.' } },
  { code: 'disabled', kind: 'skip', en: 'Run switched off', uk: 'Запуск вимкнено',
    fix: { en: 'Resume the agent or switch the editor on.', uk: 'Відновіть агента або ввімкніть редактор.' } },
  { code: 'stale', kind: 'skip', en: 'Missed its time window', uk: 'Слот пропустив своє вікно часу',
    fix: { en: 'Check that the editor was running at that time and that the budget was not used up.', uk: 'Перевірте, що редактор працював у цей час і що бюджет не вичерпано.' } },
];

const BY_CODE = new Map<string, ReasonEntry>(REASONS.map((e) => [e.code, e]));

/** The entry of a code, or undefined (a caller falls back to the bare code). */
export function reasonFor(code: string | null | undefined): ReasonEntry | undefined {
  return code ? BY_CODE.get(code) : undefined;
}

/** Legacy slot errors that carry no code of their own: the text written before the codes existed, and the system's own notes. */
const LEGACY: Array<[RegExp, string]> = [
  [/^superseded by a new plan/, 'superseded'],
  [/^draft canceled/, 'draft_canceled'],
  [/^rejected by owner/, 'rejected_by_owner'],
  [/^agent @.* is paused/, 'agent_paused'],
  [/^agent paused/, 'agent_paused'],
  [/^series ".*": required source .* has nothing left/, 'required_source_empty'],
  [/^retry after\b/, 'retrying'],
  [/^waiting for budget\b/, 'waiting_for_budget'],
  [/^skipped by owner\b/, 'skipped_by_owner'],
];

/**
 * The code of a stored slot error or skip text, or null when it has none the catalogue knows: `skipped by agent: <cause>:`
 * gives the cause, a bare `skipped by agent: <free text>` gives `skipped_by_agent`, the legacy texts («superseded by a new
 * plan», «stale: …», «series "X": required source … has nothing left», «retry after …») give theirs, and any other error
 * gives its leading `<code>` or `<code>:` token when that is a catalogue code (`planner_*` included).
 */
export function reasonOfError(text: string | null | undefined): string | null {
  const e = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!e) return null;
  const cause = agentCauseOf(e);
  if (cause) return cause;
  if (/^skipped by agent\b/i.test(e)) return 'skipped_by_agent';
  for (const [re, code] of LEGACY) if (re.test(e)) return code;
  const token = /^[a-z][a-z0-9_]*(?=$|[:\s])/.exec(e)?.[0];
  return token && BY_CODE.has(token) ? token : null;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What follows the code in a stored error: the system's or the agent's own words (never the code itself). */
function detailOf(error: string, code: string): string {
  let d = error.replace(/\s+/g, ' ').trim().replace(/^skipped by agent:?\s*/i, '');
  d = d.replace(/^(no_material|source_unreachable|source_used|quality|other):\s*/, '');
  if (d.toLowerCase().startsWith(code)) d = d.slice(code.length).replace(/^:?\s*/, '');
  else if (LEGACY.some(([re]) => re.test(d))) d = '';
  return d.trim();
}

/**
 * One line about a stored error for an owner note: «<label>: <detail> — <what to change>». The label and the fix come from the
 * catalogue in the asked language; the detail is the system's or the agent's own words, clipped. An error with no entry
 * stays what it was: its own text, clipped.
 */
export function reasonText(error: string | null | undefined, lang: 'en' | 'uk', max = 260): string {
  const raw = (error ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return lang === 'uk' ? 'причину не записано' : 'no reason recorded';
  const code = reasonOfError(raw);
  const entry = reasonFor(code);
  if (!entry || !code) return clip(raw.replace(/^skipped by agent:?\s*/i, ''), max);
  const label = lang === 'uk' ? entry.uk : entry.en;
  const detail = clip(detailOf(raw, code), 80);
  const fix = entry.fix ? (lang === 'uk' ? entry.fix.uk : entry.fix.en) : '';
  const same = detail.toLowerCase() === entry.en.toLowerCase();
  return clip(`${label}${detail && !same ? `: ${detail}` : ''}${fix ? ` — ${fix}` : ''}`, max);
}
