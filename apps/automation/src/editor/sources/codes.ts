/**
 * Spec 076 FR-008 / L4 / A31: the owner-visible codes of the source checks and notes, in the contract's `ReasonEntry` shape.
 *
 * W1 isolation (L10): `ReasonEntry` is copied here verbatim from the contract and nothing imports the reasons catalogue. At the
 * lead's merge the copy is swapped for the catalogue's import and `SOURCE_REASONS` is appended to its `REASONS`.
 *
 * - The five finding codes are `doctor` entries, as 072's doctor codes are. `source_unreachable` is the skip class and the pause
 *   cause, never a code here (the doctor's code for the same fact is `source_probe_failed`).
 * - The two note codes are `source` entries and are the notes' own Inbox kinds: `host_struck` (not `host_unreachable`, which is
 *   already a tool error code that 073's `reasonOfError` would misread) and `resync_failed`.
 */
export type ReasonEntry = {
  code: string;                        // snake_case, unique
  kind: 'skip' | 'preflight' | 'config' | 'doctor' | 'source' | 'dataset';
  en: string;                          // dashboard label, English, no Cyrillic
  uk: string;                          // owner bot / Telegram, Ukrainian
  fix?: { en: string; uk: string };    // one sentence: what to change
  link?: string;                       // dashboard path template; placeholders :channel :agent :dataset :series
};

export const SOURCE_REASONS: ReasonEntry[] = [
  {
    code: 'source_probe_failed', kind: 'doctor',
    en: 'The server cannot read this source',
    uk: 'Сервер не може прочитати це джерело',
    fix: {
      en: 'Route the site through the proxy, upload the page, or remove the source.',
      uk: 'Пусти сайт через проксі, завантаж сторінку вручну або прибери джерело.',
    },
    link: '/app/agents/:agent?tab=settings',
  },
  {
    code: 'source_empty', kind: 'doctor',
    en: 'The source is empty or not a feed',
    uk: 'Джерело порожнє або це не стрічка',
    fix: {
      en: 'Check the address, then replace or remove the source.',
      uk: 'Перевір адресу, потім заміни або прибери джерело.',
    },
    link: '/app/agents/:agent?tab=settings',
  },
  {
    code: 'source_untested', kind: 'doctor',
    en: 'The server has not read this source yet',
    uk: 'Сервер ще не читав це джерело',
    fix: {
      en: 'Press "Test from server" on the source.',
      uk: 'Натисни «Test from server» біля джерела в налаштуваннях агента.',
    },
    link: '/app/agents/:agent?tab=settings',
  },
  {
    code: 'card_without_sources', kind: 'doctor',
    en: 'No sources: the channel writes from its brief only',
    uk: 'Без джерел: канал пише лише з брифу',
    fix: {
      en: 'Add a feed, a page or a dataset if posts need facts.',
      uk: 'Додай стрічку, сторінку або датасет, якщо постам потрібні факти.',
    },
    link: '/app/agents/:agent?tab=settings',
  },
  {
    code: 'dataset_resync_manual', kind: 'doctor',
    en: 'Imported from an uploaded page: re-sync is manual',
    uk: 'Імпортовано із завантаженої сторінки: оновлення лише вручну',
    fix: {
      en: 'Upload the page again to add new entries.',
      uk: 'Щоб додати нові записи, завантаж сторінку ще раз.',
    },
    link: '/app/data/:dataset',
  },
  {
    code: 'host_struck', kind: 'source',
    en: 'A site refuses the server or cannot be reached from it',
    uk: 'Сайт відмовляє серверу або недоступний із нього',
    fix: {
      en: 'Route it through the proxy, upload the page, or remove the source.',
      uk: 'Пусти його через проксі, завантаж сторінку або прибери джерело.',
    },
    link: '/app/agents/:agent?tab=settings',
  },
  {
    code: 'resync_failed', kind: 'source',
    en: 'Re-sync of an imported dataset failed',
    uk: 'Не вдалося оновити імпортований датасет',
    fix: {
      en: 'Upload the page if the server cannot reach the site.',
      uk: 'Якщо сервер не бачить сайту, завантаж сторінку вручну.',
    },
    link: '/app/data/:dataset',
  },
];

const BY_CODE = new Map(SOURCE_REASONS.map((r) => [r.code, r]));

/** The entry of one of these codes; undefined for any other code. */
export const sourceReason = (code: string): ReasonEntry | undefined => BY_CODE.get(code);
