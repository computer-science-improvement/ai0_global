import type { SetupPost } from '../setup-posts.types';
import type { SubmitSetupInput } from '../setup-analysis';

/** Spec 042 tests: a synthetic channel's last posts (newest first) and a valid onboarder answer for them. */

const T0 = Date.parse('2026-10-15T09:05:00Z');

function post(n: number, text: string, o: Partial<SetupPost> = {}): SetupPost {
  return {
    key: `p${n}`, id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, msgId: 1000 - n,
    postedAt: new Date(T0 - (n - 1) * 12 * 3_600_000), text, hasMedia: false, mediaType: null,
    views: 1000 + n * 10, forwards: 3, reactionsTotal: 20, comments: 2, ...o,
  };
}

export const SIGNATURE = 'Підписуйтесь на @tips_ua 👇';

export function samplePosts(): SetupPost[] {
  return [
    post(1, `📌 Порада дня: зберігайте паролі в менеджері, а не в нотатках.\n\nТак ви не загубите доступ до пошти.\n\n${SIGNATURE}`, { views: 2400, reactionsTotal: 90 }),
    post(2, `Нова версія застосунку вже доступна: що змінилось і чи варто оновлюватись.\n\n${SIGNATURE}`, { hasMedia: true, mediaType: 'photo' }),
    post(3, `📌 Порада дня: вмикайте двофакторну автентифікацію всюди, де можна.\n\n${SIGNATURE}`, { views: 2100, reactionsTotal: 70 }),
    post(4, 'Що ви робите, коли телефон гальмує? Розкажіть у коментарях.', { hasMedia: true, mediaType: 'photo', comments: 40 }),
    post(5, `📌 Порада дня: перевіряйте адресу сайту перед тим, як вводити пароль.\n\n${SIGNATURE}`),
    post(6, 'Огляд тижня: три новини про безпеку, які варто знати. #безпека', { hasMedia: true, mediaType: 'photo' }),
    post(7, 'Як зрозуміти, що лист — фішинг: пʼять ознак. #безпека', {}),
    post(8, `Чому оновлення системи — це не забаганка, а захист.\n\n${SIGNATURE}`, { views: 900 }),
  ];
}

export function validSetup(): SubmitSetupInput {
  return {
    summary: 'Канал коротких порад про цифрову безпеку для звичайних користувачів; пропозиція фіксує рубрику «Порада дня» і тон.',
    brief_profile: {
      profile: {
        topic: 'Цифрова безпека простими словами', audience: { who: 'звичайні користувачі смартфонів і компʼютерів' },
        language: 'uk', goals: ['engagement', 'growth'], tone: 'спокійний, практичний, на «ви»', taboo: ['залякування'], notes: 'вік аудиторії з постів не видно',
      },
      brief: 'Канал публікує короткі практичні поради з цифрової безпеки для звичайних користувачів. Щодня виходить «Порада дня» — одна дія, яку читач може зробити одразу. '
        + 'Між порадами — огляди новин про безпеку і питання до читачів. Тон спокійний, без залякування, звертання на «ви». Пости короткі, з підписом каналу в кінці.',
      evidence: { post_ids: ['p1', 'p3', 'p5'], note: 'поради з однаковим початком і тоном' },
    },
    formatting: {
      format_prefs: { emoji: 'light', length: { target: 300, max: 700 }, cta: 'Підписка в останньому рядку', signature: SIGNATURE },
      style: { address: 'vy' },
      card: { hashtags: ['безпека'], hashtag_min: 0, hashtag_max: 1, footer: SIGNATURE, emoji_policy: 'sparse' },
      evidence: { post_ids: ['p1', 'p6'], note: 'підпис у 5 з 8 постів, хештег лише #безпека' },
    },
    format_mix: { formats: { text: 0.6, photo: 0.4 }, evidence: { post_ids: ['p2', 'p4'], note: '3 з 8 постів з фото' } },
    series_pillars: {
      series: [{ name: 'Порада дня', cadence: 'daily@09:00', format: 'text', brief: 'Одна практична порада з безпеки, яку можна виконати одразу.', post_ids: ['p1', 'p3', 'p5'] }],
      pillars: [{ name: 'Поради', share: 50 }, { name: 'Новини безпеки', share: 30 }, { name: 'Питання до читачів', share: 20 }],
      evidence: { post_ids: ['p1', 'p6', 'p4'], note: 'три типи постів' },
    },
    schedule: {
      posts_per_day_min: 1, posts_per_day_max: 2, quiet_start_hour: 23, quiet_end_hour: 8, best_hours: [12, 9],
      evidence: { post_ids: [], note: 'два пости на день, найкращі перегляди вранці' },
    },
    examples_voice: {
      example_ids: ['p1', 'p3', 'p7'],
      voice: {
        description: 'Коротко, спокійно, з однією дією для читача.',
        rules: ['Одна порада — одна дія', 'Звертання на «ви»', 'Без залякування', 'Підпис каналу в кінці', 'Не більше одного хештегу'],
        quotes: ['зберігайте паролі в менеджері, а не в нотатках', 'вмикайте двофакторну автентифікацію всюди'],
      },
      evidence: { post_ids: ['p1', 'p3'], note: 'найкраще залучення' },
    },
  };
}
