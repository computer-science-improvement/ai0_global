/**
 * Spec 072 FR-001: the reason codes the channel doctor emits, with the owner-facing texts. `ReasonEntry` is the lead contract's
 * shape, copied verbatim (the lead swaps this copy for 073's import at merge and appends `DOCTOR_REASONS` to `REASONS`).
 *
 * `en` is the finding's title in the dashboard, `uk` the owner bot's line; `fix` is one sentence: what to change. The detail
 * line of a finding (which skill, which dataset, which number) is made by its check; the catalogue holds what does not vary.
 * `source_unreachable` is a skip class and a pause cause, never a doctor code, so it has no entry here.
 */
export type ReasonEntry = {
  code: string;                        // snake_case, unique
  kind: 'skip' | 'preflight' | 'config' | 'doctor' | 'source' | 'dataset';
  en: string;                          // dashboard label, English, no Cyrillic
  uk: string;                          // owner bot / Telegram, Ukrainian
  fix?: { en: string; uk: string };    // one sentence: what to change
  link?: string;                       // dashboard path template; placeholders :channel :agent :dataset :series
};

/** The placeholders a link template may hold. */
export const LINK_PLACEHOLDERS = ['channel', 'agent', 'dataset', 'series'] as const;

export const DOCTOR_REASONS: ReasonEntry[] = [
  {
    code: 'series_source_contradicted', kind: 'doctor',
    en: 'A skill, rule or steering line sends the writer to a different source than the series requires.',
    uk: 'Скіл, правило чи настанова велить брати матеріал не з того джерела, яке вимагає серія.',
    fix: { en: 'Switch the skill off, or change the rule so it names the series source.', uk: 'Вимкніть скіл або виправте правило, щоб воно називало джерело серії.' },
    link: '/app/agents/:agent?tab=skills',
  },
  {
    code: 'origin_original_with_source', kind: 'doctor',
    en: 'A skill tells the writer to mark library or feed material as original.',
    uk: 'Скіл велить позначати матеріал із бібліотеки чи стрічки як власний (origin=original).',
    fix: { en: 'Switch the skill off, or rewrite the line so only free-written posts are original.', uk: 'Вимкніть скіл або перепишіть рядок: власними лишаються лише тексти без джерела.' },
    link: '/app/agents/:agent?tab=skills',
  },
  {
    code: 'skill_prescribes_source', kind: 'doctor',
    en: 'A skill names a source of its own.',
    uk: 'Скіл називає власне джерело матеріалу.',
    fix: { en: 'Check that the skill and the series agree on where material comes from.', uk: 'Переконайтеся, що скіл і серія беруть матеріал з одного місця.' },
    link: '/app/agents/:agent?tab=skills',
  },
  {
    code: 'dataset_without_series', kind: 'doctor',
    en: 'A dataset is on the channel card, but no series posts from it.',
    uk: 'Набір даних є в картці каналу, але жодна серія не бере з нього матеріал.',
    fix: { en: 'Add a series that reads the dataset, or remove the source from the card.', uk: 'Додайте серію, що читає цей набір, або приберіть джерело з картки.' },
    link: '/app/agents/:agent?tab=schedule',
  },
  {
    code: 'series_source_not_required', kind: 'doctor',
    en: 'A series on a dataset may be told to use another source.',
    uk: 'Серію на наборі даних можна переконати взяти інше джерело (режим «suggested»).',
    fix: { en: 'Require the source: the series becomes yours and is locked.', uk: 'Зробіть джерело обов’язковим: серія стане вашою і заблокується.' },
    link: '/app/agents/:agent?tab=schedule',
  },
  {
    code: 'dataset_post_requires_missing', kind: 'dataset',
    en: 'A dataset in use has no rule for what a postable row needs.',
    uk: 'Для набору даних не задано, що потрібно рядку, щоб його можна було опублікувати.',
    fix: { en: 'Set "post requires" on the dataset (the fields a row must have).', uk: 'Задайте для набору обов’язкові поля рядка (post_requires).' },
    link: '/app/data/:dataset',
  },
  {
    code: 'dataset_low_fill', kind: 'dataset',
    en: 'Most rows of a dataset have no text to post.',
    uk: 'У більшості рядків набору даних немає тексту для поста.',
    fix: { en: 'Require the text field in "post requires", or fill the missing text.', uk: 'Зробіть поле тексту обов’язковим (post_requires) або заповніть пропущений текст.' },
    link: '/app/data/:dataset',
  },
  {
    code: 'material_exhausted', kind: 'dataset',
    en: 'No unused rows are left for this channel.',
    uk: 'Для цього каналу не лишилось невикористаних рядків.',
    fix: { en: 'Add rows, or set Reuse to repeat in rounds.', uk: 'Додайте рядки або ввімкніть повтор по колу (Reuse).' },
    link: '/app/data/:dataset',
  },
  {
    code: 'material_low', kind: 'dataset',
    en: 'The material of a dataset runs out within two weeks.',
    uk: 'Матеріалу з набору даних вистачить менш ніж на два тижні.',
    fix: { en: 'Add more rows, or let the dataset repeat in rounds.', uk: 'Додайте рядків або дозвольте набору повторюватися по колу.' },
    link: '/app/data/:dataset',
  },
  {
    code: 'dataset_order_random', kind: 'dataset',
    en: 'The series needs an order, but the dataset reads in random order.',
    uk: 'Серії потрібен порядок, а набір даних читається у випадковому.',
    fix: { en: 'Set Reuse to a sequential round on the dataset.', uk: 'Задайте набору послідовне коло (Reuse).' },
    link: '/app/data/:dataset',
  },
  {
    code: 'tools_missing_for_source', kind: 'doctor',
    en: 'A source needs a tool the writer will not have.',
    uk: 'Джерелу потрібен інструмент, якого автор не матиме.',
    fix: { en: 'Allow the tool on the card or in the loadout.', uk: 'Дозвольте інструмент у картці або в наборі інструментів.' },
    link: '/app/editor/:channel',
  },
  {
    code: 'hashtag_min_without_vocabulary', kind: 'doctor',
    en: 'The card asks for hashtags, but its hashtag list is empty.',
    uk: 'Картка вимагає хештеги, але список хештегів порожній.',
    fix: { en: 'Set the minimum hashtags to 0, or add a hashtag list.', uk: 'Поставте мінімум хештегів 0 або додайте список хештегів.' },
    link: '/app/editor/:channel',
  },
  {
    code: 'config_conflict', kind: 'doctor',
    en: 'An owner rule contradicts the channel configuration.',
    uk: 'Правило власника суперечить налаштуванням каналу.',
    fix: { en: 'Resolve the conflict: the config follows the rule.', uk: 'Розв’яжіть конфлікт: налаштування підуть за правилом.' },
    link: '/app/agents/:agent?tab=memory',
  },
  {
    code: 'formats_diverge', kind: 'doctor',
    en: 'The card and the playbook enable different formats.',
    uk: 'Картка і плейбук вмикають різні формати.',
    fix: { en: 'Make the card and the playbook section list the same formats.', uk: 'Вирівняйте формати в картці та в секції плейбука.' },
    link: '/app/agents/:agent?tab=playbook',
  },
  {
    code: 'series_paused', kind: 'doctor',
    en: 'A series is paused by the system.',
    uk: 'Серію призупинила система.',
    fix: { en: 'Resume it once the cause is fixed.', uk: 'Відновіть її, коли причину усунено.' },
    link: '/app/agents/:agent?tab=overview',
  },
  {
    code: 'series_paused_by_owner', kind: 'doctor',
    en: 'A series is paused by you.',
    uk: 'Серію призупинено вами.',
    link: '/app/agents/:agent?tab=overview',
  },
  {
    code: 'pause_cause_gone', kind: 'doctor',
    en: 'A paused series can run again: the cause is gone.',
    uk: 'Призупинена серія може працювати: причина зникла.',
    fix: { en: 'Resume the series.', uk: 'Відновіть серію.' },
    link: '/app/agents/:agent?tab=overview',
  },
  {
    code: 'playbook_draft_waiting', kind: 'doctor',
    en: 'A playbook draft has waited for your decision for over a day.',
    uk: 'Чернетка плейбука чекає на ваше рішення понад добу.',
    fix: { en: 'Approve or reject the draft.', uk: 'Схваліть або відхиліть чернетку.' },
    link: '/app/agents/:agent?tab=playbook',
  },
  {
    code: 'bot_not_admin', kind: 'doctor',
    en: 'The bot cannot post to the channel.',
    uk: 'Бот не може публікувати в каналі.',
    fix: { en: 'Add the bot as an administrator of the channel.', uk: 'Додайте бота адміністратором каналу.' },
  },
  {
    code: 'auto_fixed', kind: 'doctor',
    en: 'Readiness fixed this by itself.',
    uk: 'Готовність виправила це сама.',
  },
];

const BY_CODE = new Map(DOCTOR_REASONS.map((r) => [r.code, r]));

export const doctorReason = (code: string): ReasonEntry | undefined => BY_CODE.get(code);

/** Values for the placeholders of a link template. */
export type LinkValues = Partial<Record<typeof LINK_PLACEHOLDERS[number], string | null | undefined>>;

/**
 * A link template with its placeholders filled; each value is URL-encoded. A placeholder with no value makes the link
 * unusable, so the result is null (a finding without a link shows no Open button).
 */
export function resolveLink(template: string | undefined | null, values: LinkValues): string | null {
  if (!template) return null;
  let missing = false;
  const out = template.replace(/:(channel|agent|dataset|series)\b/g, (_m, name: typeof LINK_PLACEHOLDERS[number]) => {
    const v = values[name];
    if (v == null || v === '') { missing = true; return ''; }
    return encodeURIComponent(v);
  });
  return missing ? null : out;
}
