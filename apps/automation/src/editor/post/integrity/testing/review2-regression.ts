import type { EditorCard } from '../../../card';

/**
 * Spec 041 FR-009 (T9): the defective posts of agent review 2 (dev stage, 2026-10-15 → 10-17) with the codes lint must
 * find in them. The specs are the stored `post_spec` of each slot; 1712, 1713 and 1714 were written without a stored
 * spec (chat drafts), so their texts are reconstructed around the defect the review quotes (`reconstructed`).
 * Defects only the critic can judge (a case, a pronoun, rule #11) are eval cases in `critic/evals/review2-cases.json`.
 */

export interface RegressionPost {
  /** published_posts.id of the dev stage. */
  id: number;
  channel: string;
  /** What review 2 found. */
  defect: string;
  spec: Record<string, unknown>;
  card: Partial<EditorCard>;
  /** Codes lint must report (errors or warnings). Empty: the defect is the critic's (see `critic_case`). */
  expect: string[];
  critic_case?: string;
  reconstructed?: true;
}

const NEWS_CARD: Partial<EditorCard> = { formats: { text: 1, photo: 1 }, hashtags: [], hashtagMin: 0, hashtagMax: 0, style: { hashtags: 'off', address: 'vy' } };
const GAMES_CARD: Partial<EditorCard> = { ...NEWS_CARD, style: { hashtags: 'off', address: 'vy', content_kind: 'games' } };
const AI0_CARD: Partial<EditorCard> = { formats: { text: 1, photo: 1, quiz: 0.3, poll: 0.3 }, hashtags: [], hashtagMin: 0, hashtagMax: 0, style: { hashtags: 'off', address: 'vy' } };
const PDR_BRIEF = 'Канал з питаннями ПДР для водіїв-початківців. Агент має публікувати запитання з варіантами відповіді українською, '
  + 'нейтральним навчальним тоном, у форматі опитувань із картинкою до запитання.';

const p = (text: string) => ({ type: 'p', text });
const lead = (text: string) => ({ type: 'lead', text });

export const REVIEW2_POSTS: RegressionPost[] = [
  {
    id: 1712, channel: '@ai0_news_dev', defect: 'hashtags on a channel with hashtags off', reconstructed: true,
    spec: {
      format: 'text', title: 'Microsoft обʼєднала галереї Windows, OneDrive та iCloud у новому Photos', origin: 'external',
      body: [lead('Microsoft обʼєднала галереї Windows, OneDrive та iCloud у новому Photos'), p('Застосунок показує знімки з усіх трьох сховищ в одній стрічці.')],
      media: [], hashtags: ['Microsoft', 'Windows'],
      source: { url: 'https://www.theverge.com/tech/1012003/microsoft-windows-11-new-photos-app-onedrive-icloud', label: 'The Verge' },
    },
    card: NEWS_CARD, expect: ['hashtag_while_off'],
  },
  {
    id: 1713, channel: '@ai0_global', defect: 'wrong case «у найвідоміших сервісів»', reconstructed: true, critic_case: 'review2-1713-case',
    spec: {
      format: 'quiz', title: 'Вікторина: галюцинації ШІ простими словами', origin: 'library', library_ref: 'data://facts/0',
      body: [lead('Галюцинація — це коли ШІ впевнено вигадує факт.'), p('Таке трапляється навіть у найвідоміших сервісів: ChatGPT назвав статтю, якої не існує.')],
      poll: { question: 'Як називають вигадані ШІ факти?', options: ['Галюцинації', 'Баги', 'Фейки'], correct_index: 0, anonymous: true },
      media: [], hashtags: [],
    },
    card: AI0_CARD, expect: ['language_case'],
  },
  {
    id: 1714, channel: '@game_exchange_dev', defect: 'calque «заточений», hashtags while off', reconstructed: true,
    spec: {
      format: 'text', title: 'Escher\'s Dream — безкоштовний мод для Portal 2 про неможливу геометрію', origin: 'external',
      body: [lead('Escher\'s Dream — безкоштовний мод для Portal 2 про неможливу геометрію'), p('Ідея проста, і рівень під це заточений: сходи ведуть у стелю, а двері — у ту саму кімнату.')],
      media: [], hashtags: ['Portal2'],
      source: { url: 'https://www.rockpapershotgun.com/eschers-dream-is-a-portal-2-mod', label: 'Rock Paper Shotgun' },
    },
    card: GAMES_CARD, expect: ['language_calque', 'hashtag_while_off'],
  },
  {
    id: 1715, channel: '@ai0_global', defect: '«на борту» about a mug',
    spec: {
      format: 'photo', title: 'Промпт тижня: картинка за однією формулою', origin: 'original',
      body: [
        lead('Промпт тижня: скопіюйте рядок нижче в будь-який генератор картинок і подивіться, що вийде.'),
        p('«Керамічний гурток з чорним горобцем на борту стоїть на деревʼяному підвіконні, акварельний стиль, мʼяке ранкове світло з вікна, теплі відблиски на стіні»'),
        p('У промпті три частини: обʼєкт (гурток з птахом), стиль (акварель), світло (ранкове, з вікна). Замініть будь-яку з них на свою, наприклад «олійний стиль» чи «вечірнє світло лампи», і картинка зміниться повністю.'),
      ],
      media: [{ url: 'https://prdruteophdbnypnikij.supabase.co/storage/v1/object/public/common/01-prompt.png', alt: 'Промпт для генерації зображення' }], hashtags: [],
    },
    card: AI0_CARD, expect: ['language_suspect'],
  },
  {
    id: 1717, channel: '@ai0_global', defect: 'owner rule #11 «простіше» broken by «816 млрд параметрів… MCP-Atlas»', critic_case: 'review2-1717-rule11',
    spec: {
      format: 'text', title: 'AI-новини дня: Muse Spark Open і d1-ultra', origin: 'external',
      body: [
        lead('За останню добу дві новини про відкриті AI-моделі. Коротко.'),
        p('Meta випустила Muse Spark Open: відкрита модель на 816 млрд параметрів, з яких одночасно працюють 42 млрд. Контекст сягає 1 мільйона токенів. Серед відкритих моделей вона зараз перша в бенчмарку MCP-Atlas.'),
      ],
      media: [], hashtags: [],
      source: { url: 'https://www.marktechpost.com/2026/10/15/meta-muse-spark-open-816b-open-weight-model/', label: 'MarkTechPost' },
    },
    card: AI0_CARD, expect: [],
  },
  {
    id: 1719, channel: '@ai0_news_dev', defect: '«виїхало по перевернутій рампі»', critic_case: 'review2-1719-ramp',
    spec: {
      format: 'photo', title: 'Tesla Roadster з прискорювачами SpaceX: демо', origin: 'external',
      body: [
        lead('Tesla показала Roadster другого покоління з прискорювачами SpaceX'),
        p('На демо під Вейко в Техасі авто з допомогою вентиляторів і прискорювачів виїхало по перевернутій рампі, розвернулося й приземлилося.'),
      ],
      media: [{ url: 'https://techcrunch.com/wp-content/uploads/2026/10/tesla-roadster-2-fly.jpg', credit: 'TechCrunch' }], hashtags: [],
      source: { url: 'https://techcrunch.com/2026/10/15/tesla-reveals-spacex-powered-roadster-that-flies-and-falls-with-style/', label: 'TechCrunch' },
    },
    card: NEWS_CARD, expect: ['language_suspect'],
  },
  {
    id: 1721, channel: '@ai0_news_dev', defect: 'euphony «У інших»; an evergreen glossary on a news channel',
    spec: {
      format: 'text', title: 'Глосарій: техніки промптингу', origin: 'external', story: { key: 'prompting-techniques-glossary', kind: 'evergreen' },
      body: [
        lead('Чотири техніки промптингу, які варто відрізняти'),
        p('Огляд більше ніж зі ста досліджень показав, що chain-of-thought дає великий приріст переважно в математичних, логічних і символьних задачах. У інших видах завдань покращення набагато менші.'),
      ],
      media: [], hashtags: [],
      source: { url: 'https://en.wikipedia.org/wiki/Prompt_engineering', label: 'Wikipedia' },
    },
    card: NEWS_CARD, expect: ['language_euphony'],
  },
  {
    id: 1724, channel: '@ai0_global', defect: 'pronoun «її» points at the licence, not at the code', critic_case: 'review2-1724-pronoun',
    spec: {
      format: 'text', title: 'Perplexity відкрила код SPACE', origin: 'external',
      body: [
        lead('Perplexity відкрила код SPACE — «пісочниці», в якій працюють її ШІ-агенти'),
        p('Код опублікований на GitHub за ліцензією Apache 2.0, її можуть використовувати й інші команди, що створюють ШІ-агентів.'),
      ],
      media: [], hashtags: [],
      source: { url: 'https://www.marktechpost.com/2026/10/16/perplexity-open-sources-space-firecracker-microvm-sandbox-ai-agents/', label: 'MarkTechPost' },
    },
    card: AI0_CARD, expect: [],
  },
  {
    id: 1725, channel: '@pdr_dev_channel', defect: 'a poll without the picture the brief asks for',
    spec: {
      format: 'poll', title: 'Вікторина: що таке гальмовий шлях', origin: 'original', body: [],
      poll: {
        question: 'Що за ПДР називають гальмовим шляхом?', anonymous: true,
        options: ['Відстань від моменту, коли водій побачив небезпеку, до зупинки', 'Відстань від початку дії водія на гальмову систему до повної зупинки', 'Відстань, яку авто проїжджає за час реакції водія'],
      },
      media: [], hashtags: [],
    },
    card: { formats: { poll: 1, photo: 1 }, hashtags: [], hashtagMin: 0, hashtagMax: 0, brief: PDR_BRIEF },
    expect: ['brief_media_missing'],
  },
  {
    id: 1726, channel: '@game_exchange_dev', defect: 'gaming slang «ачівки», «синґл» with slang off',
    spec: {
      format: 'text', title: 'Steam Achievement Sets у бета-тесті', origin: 'external',
      body: [
        lead('Steam тестує Achievement Sets: ачівки гри діляться на набори'),
        p('Розробники самі групують досягнення: базова гра окремо, кожне DLC окремо, синґл окремо від мультиплеєра.'),
      ],
      media: [{ url: 'https://assetsio.gnwcdn.com/steam-achievement-sets-beta-rollout-01.jpg' }], hashtags: [],
      source: { url: 'https://www.rockpapershotgun.com/valve-roll-out-steam-achievement-sets-in-beta', label: 'Rock Paper Shotgun' },
    },
    card: GAMES_CARD, expect: ['slop_slang_off'],
  },
];
