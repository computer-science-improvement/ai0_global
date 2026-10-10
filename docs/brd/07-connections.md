# BRD (as-is) — Підключення: боти, MTProto, Meta, TikTok, Telegraph, групи

> Статус: оновлено з коду 2026-10-10 (коміт 54dd1eb, гілка feat/editor-agent). Описує, як система ФАКТИЧНО працює зараз, а не як мала б.

## Що змінилось з 2026-10-05

- Маршрут-заглушку `/app/connections/$platform` видалено; невідомий шлях `/app/connections/<x>` показує сторінку «not found» (spec 027).
- `/app/bots` і `/app/telegraph` більше не дублюють менеджери: це редиректи на `/app/connections?section=telegram&tab=bots|telegraph` (spec 027).
- Меню будується з реєстру `nav/registry.ts`: у групі «Connections» за замовчуванням «Connections» і «Groups»; «Bots», «Telegraph», «Meta accounts», «TikTok accounts» зареєстровані, але приховані (доступні з ⌘K). Сторінка деталей Meta-акаунта і Groups мають хлібні крихти замість посилання «Back to Meta accounts» (spec 027).
- Групи стали мережами незалежних ресурсів: режими `independent` (за замовчуванням) і `legacy_duplicate` замість `orchestrated` / `mirror` (міграція 061). Автодублювання тепер вирішує один гейт, закріплений на день плану; він діє і для стратегій, і для редактора (spec 024).
- Сторінка Groups: селектор «Auto-duplicate source» видно лише поки група автодублює, інакше чип «independent»; нове попередження про власні стратегії учасника незалежної мережі (spec 024).
- Власнику пропонується перевести legacy-мережу в незалежну: пункт `network_independent_offer` у `/app/agents/inbox` (таблиця `network_offers`, міграція 064, spec 024).
- `TrackingAuthGuard` перевіряє Bearer, відкликувану сесію (`auth_sessions`) і dev-обхід через `AuthService`; 401 містить `code` (spec 028). Адмін-бот `TELEGRAM_BOT_TOKEN` тепер також підписує вхід через Telegram (spec 028).
- Username агентської MTProto-сесії став запасним акаунтом для кнопок «Order an ad in Telegram» на лендінгу (spec 026).
- TikTok- і YouTube-акаунти з `group_id` тепер належать мережі в каталозі ресурсів агентів (spec 026); порту TikTok на сторінці Groups досі немає.
- Назву групи, її опис і порядок показує публічна вітрина мереж; опис і порядок редагуються на `/app/landing` (spec 026).
- Таблиця `recipes`, де Telegraph кешує посилання, тепер сумісний view над `data_items` (spec 032).
- YouTube і LinkedIn не підключаються: це майбутній spec 030.

## 1. Призначення розділу

Розділ «Connections» — єдине місце, де оператор підключає зовнішні акаунти, через які система публікує та збирає статистику: Telegram-ботів (публікація), MTProto-сесії користувацьких акаунтів (читання переглядів/реакцій, DM-тріаж агента), Telegraph (довгі пости з Instant View), Facebook/Instagram/Threads (Meta Graph API) і TikTok (OAuth, фотокарусель). Окрема сторінка «Groups» обʼєднує Telegram-канал і Meta-акаунти бренду в «мережу». Кожен член мережі — окремий ресурс: агент мережі сам вирішує, дублювати пост, адаптувати, написати унікальний чи пропустити. Автоматичне дублювання з «джерела» лишилось для legacy-мереж і для мереж, чий агент ще не в live (spec 024).

Користувач — єдиний оператор (власник) після логіну в `/app`. Усі бекенд-ендпоінти розділу закриті `TrackingAuthGuard`: Bearer `TRACKING_TOKEN`, або сесійна кукі `tracking_jwt` (сесія в `auth_sessions`, її можна відкликати), або локальний обхід `ALLOW_NO_AUTH=true` лише поза production і без `TRACKING_TOKEN` (spec 028); ролей немає.

Загальна модель секретів: токен вводиться у форму як значення, шифрується на сервері (AES-256-GCM, ключ `TOKEN_ENCRYPTION_KEY`) і більше ніколи не повертається. Історичний («legacy») шлях — зберігати в БД лише ІМʼЯ env-змінної (`token_env`), а значення тримати в `.env`.

## 2. Сторінки розділу

| Сторінка | Маршрут | Коротко |
|---|---|---|
| Connections (хаб) | `/app/connections` | Єдина сторінка з перемикачем провайдера Telegram / Meta / TikTok і підвкладками; пункт меню «Connections» |
| ~~Connections · платформа~~ | ~~`/app/connections/$platform`~~ | Видалено (spec 027), див. 3.2 |
| Groups | `/app/connections/groups` | Групи (мережі) бренду: Telegram + FB + IG + Threads, джерело автодублювання; пункт меню «Groups» |
| Meta (редирект) | `/app/connections/meta` | `redirect` на `/app/connections?section=meta[&tab=…]` |
| Деталі Meta-акаунта | `/app/connections/meta/$accountId` | Профіль, токен-панель, підписники, охоплення, перегляди профілю |
| TikTok (редирект) | `/app/connections/tiktok` | `redirect` на `/app/connections?section=tiktok[&tiktok=…]` |
| Bots (редирект) | `/app/bots` | `redirect` на `/app/connections?section=telegram&tab=bots` (spec 027) |
| Telegraph (редирект) | `/app/telegraph` | `redirect` на `/app/connections?section=telegram&tab=telegraph` (spec 027) |

Файли маршрутів мають суфікс `connections_` (TanStack escape), щоб `groups`, `meta`, `tiktok`, `meta_/$accountId` НЕ були вкладені в `app.connections` як діти.

Пункти меню задає реєстр `apps/dashboard/src/nav/registry.ts` (spec 027). Група «Connections» за замовчуванням містить «Connections» і «Groups». Записи «Bots», «Telegraph», «Meta accounts», «TikTok accounts» (вкладки хабу) зареєстровані як приховані: їх знаходить ⌘K, власник може додати їх у меню в Settings → Navigation.

## 3. Сторінки

### 3.1 Connections (хаб) — `/app/connections`

**Бізнес-мета.** Керувати всіма підключеннями в одному місці; кожен конектор має власну таблицю БД і репозиторій, сторінка лише компонує менеджери.

**Хто користується / доступ.** Тільки після логіну (`/app` layout редіректить на `/login`, якщо немає `me`). Усі виклики йдуть `api()` з `credentials: 'include'`.

**Що показує.** Заголовок «Connections» + підзаголовок залежно від провайдера. Верхні таби: `Telegram` | `Meta` | `TikTok` (`?section=`, дефолт `telegram`). Підтаби: Telegram → `Sessions` | `Bots` | `Telegraph` (`?tab=`, дефолт `sessions`); Meta → `Facebook` | `Instagram` | `Threads` (дефолт `facebook`); TikTok без підтабів, приймає `?tiktok=connected|error` для банера. Чужий/невідомий `tab` мовчки замінюється дефолтом; зміна провайдера скидає `tab`.

**Дії користувача.** Перемикання табів лише міняє search-параметри URL (навігація без запитів). Усі дії — у менеджерах нижче (3.1a–3.1e).

**Бізнес-вимоги (as-is).**
- `BR-CON-01` Сторінка `/app/connections` показує три провайдери (Telegram, Meta, TikTok) та зберігає вибір у URL (`section`, `tab`, `tiktok`), тож перезавантаження/посилання відновлює стан.
- `BR-CON-02` Невалідне значення `section` замінюється на `telegram`, невалідний `tab` — на першу вкладку провайдера (без помилки).
- `BR-CON-03` Бекенд-ендпоінти всіх підключень вимагають автентифікації через `TrackingAuthGuard`; без неї повертається 401 з `code` (`no_credentials`, `bad_token`, `session_expired`, `session_revoked`, `session_legacy`), при недоступній перевірці — 503 `auth_unavailable`; дашборд веде на `/login?next=…&reason=…` (spec 028).

#### 3.1a Telegram → Sessions (MTProto-сесії) — компонент `SessionsPanel`, `AddMtprotoSessionModal`

**Бізнес-мета.** Дати системі користувацький Telegram-акаунт, бо Bot API не віддає перегляди/реакції постів. Сесії двох ролей: `tracker` (статистика, трекінг конкурентів) і `agent` (read-only тріаж особистих повідомлень).

**Що показує.** `GET /api/mtproto-sessions` → таблиця `mtproto_sessions`. Картка сесії: label; бейдж verified / unverified / текст помилки (перші 48 символів); `inactive`; роль; `in use`; `@username`, телефон, `User id`; «App credentials» (`api_id N` або «.env fallback»); «Last verified». Порожній стан: «No sessions yet».

**Дії користувача.**
- «Add session» → модалка: Label (≤80), Session string (textarea, маскований `-webkit-text-security`), Role (tracker/agent), API ID (цифри), API hash (маскований). API ID і hash — або обидва, або жодного (інакше кнопка Save неактивна). `POST /api/mtproto-sessions`: session і apiHash шифруються `SecretsService.encrypt` (без ключа — 503 «TOKEN_ENCRYPTION_KEY is not set»), `api_id` зберігається відкритим текстом.
- «Verify» → `POST /api/mtproto-sessions/:id/verify`: розшифровує сесію, підключається через gramjs (`TelegramClient.connect()` + `getMe()`), пише `username`, `phone`, `tg_user_id`, `last_verified_at`, чистить `verify_error`; помилка пишеться в `verify_error` і повертається як `{ok:false,error}`. Якщо в сесії нема `api_id/api_hash` і в `.env` нема `TELEGRAM_API_ID/HASH` — помилка «TELEGRAM_API_ID / TELEGRAM_API_HASH not set».
- Pause/Enable → `PATCH /api/mtproto-sessions/:id {active}`. Delete → `DELETE` (підтвердження через `useConfirm`).

**Бізнес-вимоги (as-is).**
- `BR-CON-04` Система приймає MTProto-сесію лише як значення, шифрує session string і api_hash у `mtproto_sessions.session_enc` / `api_hash_enc` (`enc:v1:`), а API ніколи не повертає ці поля (проєкція `toListItem` повертає `api_id`, `has_api_creds`, але не секрети).
- `BR-CON-05` Нова сесія створюється `active = true` і без верифікації; верифікація — окрема ручна дія «Verify» (`getMe`).
- `BR-CON-06` Для tracker-ролі клієнти трекінгу (`TrackingMtprotoClient`) та статистики (`TelegramStatsClient`) беруть ПЕРШУ (за `created_at`) активну сесію з `role='tracker'`; без такої — повертаються до `.env` (`TELEGRAM_TRACKING_SESSION_STRING` або `TELEGRAM_SESSION_STRING` за прапором `TELEGRAM_TRACKING_SHARE_SESSION`).
- `BR-CON-07` Сесія з `role='agent'` використовується лише `AgentMtprotoClient` (читання останніх 1:1 діалогів; методів відправки немає); клієнт створюється на кожен виклик, `FloodWindow` блокує читання на час FLOOD_WAIT.
- `BR-CON-08` Власні `api_id/api_hash` сесії мають пріоритет; відсутні — підставляються `TELEGRAM_API_ID/HASH` з `.env`.
- `BR-CON-49` `username` найстаршої активної сесії з `role='agent'` (заповнюється при Verify) — запасний акаунт для кнопок «Order an ad in Telegram» на публічному лендінгу: кнопки відкривають `https://t.me/<username>?text=…` з тегом `[ai0web:…]`. Налаштування `landing.ad_tg_username` на `/app/landing` має пріоритет; без жодного з них лендінг показує лише форму заявки (spec 026, `config/landing-config.service.ts`).

**Спостереження (3.1a).**
- Бейдж `in use` обчислюється на клієнті як перша активна сесія СЕРЕД УСІХ ролей (`data.find(s => s.active)`), а на бекенді вибір іде окремо по ролі. Якщо перша активна — `agent`, UI позначить «in use» не ту сесію, а tracker-сесії лишаться без бейджа.
- Текст модалки та підказки обіцяють «no restart needed on next read», але `TrackingMtprotoClient` і `TelegramStatsClient` читають активну сесію й будують клієнт лише в `onModuleInit` — зміна/вимкнення сесії для них діє після рестарту automation. Агентський клієнт читає при кожному виклику.
- Якщо активна DB-сесія зіпсована/протермінована, fallback на `.env` НЕ спрацьовує (fallback лише коли активного рядка немає).
- `Delete` сесії не перевіряє, що вона зараз «in use».
- Вимкнення чи видалення агентської сесії непомітно міняє рекламні кнопки лендінгу: через ≤300 с (кеш публічного конфігу) вони переходять на форму заявки, якщо `landing.ad_tg_username` не задано.

#### 3.1b Telegram → Bots (`BotsManager`, `AddBotModal`) — сюди веде й `/app/bots`

**Бізнес-мета.** Реєстр Telegram-ботів, якими канали публікують. Канал привʼязується до конкретного бота (`tracked_channels.bot_id`) або падає на «default» бота.

**Що показує.** `GET /api/my-bots` → `my_bots`. Рядок: `bot_id` (логічне імʼя), `@username`, бейдж verified/unverified/помилка, `inactive`, `default`, `env: <token_env>` (якщо є), «verified <дата|never>». Клік по рядку → `/app/channels?filter=mine&bot=<id>` (канали цього бота). Порожній стан: «No bots configured yet».

**Дії користувача.**
- «Add bot» → модалка: Bot id (логічне імʼя, `^[a-z0-9_]+$`, ≤64, унікальне; 409 при дублі), Token (value, `type=password`) АБО «env variable name (legacy)» (`UPPER_SNAKE_CASE`; поле блокується, якщо введено токен). `POST /api/my-bots`: токен → `my_bots.token_enc`; після збереження `ConfigEventsPublisher.publish('bot')` скидає кеш конфігурації.
- «Set default»/«Default» → `POST /api/my-bots/:id/set-default {default}`: у транзакції знімає прапор з усіх і ставить на цього; унікальний частковий індекс `uniq_my_bots_one_default`.
- «Verify» → `POST /api/my-bots/:id/verify`: резолв токена, `getMe` (`https://api.telegram.org/bot…/getMe`, таймаут 8 с, відхиляє токен коротший за 40 символів без `:`), пише `username`, `first_name`, `last_verified_at`; помилка редагується (`bot<REDACTED>`) і пишеться в `verify_error`.
- Pause/Enable → `PATCH /api/my-bots/:id {active}`.
- Delete → перед підтвердженням UI тягне привʼязані канали (`trackingApi.listChannels({bot})`); якщо є — діалог «delete bot … and unbind N channels» → `DELETE /api/my-bots/:id?unbind=true` (транзакція: `tracked_channels.bot_id = NULL`, `scheduled_publications.bot_id = NULL`, видалення); без привʼязок — звичайний `DELETE` з `FOR UPDATE`-перевіркою (409 «Bot still bound to N channel(s)»).

**Бізнес-вимоги (as-is).**
- `BR-CON-09` Система зберігає токен бота зашифрованим у `my_bots.token_enc`; якщо задано лише `token_env`, значення береться з `process.env` на момент використання (`SecretsService.resolveToken`: спершу `token_enc`, потім env).
- `BR-CON-10` Токен при збереженні не перевіряється; створений бот одразу `active = true`, статус «unverified», доки оператор не натисне Verify.
- `BR-CON-11` Не більше одного бота з `is_default = true` (частковий унікальний індекс + транзакція при перемиканні).
- `BR-CON-12` Публікація в канал (`ChannelConfigService.resolveChannel`) бере бота каналу (`bot_id`), інакше default-бота; якщо немає ні того, ні іншого — помилка «has no bot bound and no default bot is set».
- `BR-CON-13` Видалення бота з привʼязаними каналами без `unbind=true` відхиляється 409; з `unbind=true` канали переходять на default-бота (або перестають публікувати, якщо default немає).

**Спостереження (3.1b).**
- Прапор `active` у `my_bots` ніде не читається за межами репозиторію: кеш (`getBotById`, `getDefaultBot`) і `resolveChannel` ігнорують його. Підказка `BOT_STATUS_HELP.inactive` («no channels will publish through it») не відповідає коду — «Pause» бота косметичний. Те саме для default: неактивний бот може бути default.
- Підпис на сторінці досі «Tokens are stored in .env», хоча основний шлях — шифрування в БД; callout у модалці вже коректний.
- Verify при відсутній env-змінній повертає HTTP 400 (глобальний тост), а при помилці Telegram — 200 `{ok:false}` (лише бейдж, без тосту); поведінка різна. Якщо немає ні `token_enc`, ні значення env, повідомлення має вигляд «Env var <token_env> is not set» (для `token_env = NULL` — «Env var null is not set»).
- Окремий довгожитель-бот `TELEGRAM_BOT_TOKEN` (адмін-бот: owner-команди, long-poll `getUpdates` із `allowed_updates=message,callback_query,chat_member`, сповіщення `notifyAlert`) читається ТІЛЬКИ з `.env` і НЕ керується сторінкою Bots. Тим самим токеном перевіряється підпис входу через Telegram Login Widget (spec 028): без нього або без `TRACKING_ALLOWED_TG_USER_IDS` вхід через Telegram вимкнено.

#### 3.1c Telegram → Telegraph (`TelegraphManager`, `AddTelegraphAccountModal`) — сюди веде й `/app/telegraph`

**Бізнес-мета.** Акаунти telegra.ph для довгих постів (рецепти) з Instant View; сторінку для рецепта створюють один раз і кешують у `recipes.telegraph_url/path`. З spec 032 `recipes` — сумісний view над `data_items` (датасет `recipes`), запис іде через тригери view.

**Що показує.** `GET /api/telegraph-accounts` → `telegraph_accounts`: `account_id`, `short_name`, verified/unverified/помилка, `inactive`, `env: …`, «verified <дата>». Порожній стан: «No Telegraph accounts yet».

**Дії користувача.** «Add account» (Account id `^[a-z0-9_-]+$`, Token value АБО env-name, опційно Author name ≤128 і Author URL ≤512) → `POST /api/telegraph-accounts` (токен шифрується в `token_enc`; `publish('telegraph')`). Verify → `GET https://api.telegra.ph/getAccountInfo` (токен ≥20 символів; поля `short_name`, `author_name`, `author_url`, `page_count`), пише `short_name`, author, `last_verified_at`. Pause/Enable (`PATCH {active}`), Delete (`DELETE`, без перевірок залежностей).

**Бізнес-вимоги (as-is).**
- `BR-CON-14` Система зберігає Telegraph-токен зашифрованим (`telegraph_accounts.token_enc`) або як імʼя env-змінної; міграція 011 засіває рядок `default` з `TELEGRAPH_ACCESS_TOKEN`.
- `BR-CON-15` Для публікації `TelegraphService` бере найстарший активний акаунт (`findActive`: `active = true ORDER BY created_at LIMIT 1`); без активного акаунта чи токена створення сторінки падає «No active Telegraph account / token».
- `BR-CON-16` Verify підтверджує живий токен (`getAccountInfo`) і заповнює `short_name`; бейдж «verified» ставиться, якщо `short_name` непорожній і немає `verify_error`.

**Спостереження (3.1c).** Верифікація не є умовою вибору акаунта: непідтверджений, але активний акаунт усе одно буде використаний. Акаунти не мають вибору «за замовчуванням» — береться найстаріший активний, тож порядок визначається `created_at`. Підпис «Tokens in .env» застарілий (як у Bots). Токен створюється вручну через `api.telegra.ph/createAccount` (у системі немає кнопки «створити»).

#### 3.1d Meta → Facebook / Instagram / Threads (`MetaAccountsManager`, `AddMetaAccountModal`)

**Бізнес-мета.** Підключити Page / IG Business / Threads-акаунти для публікації, дублювання в групі та збору статистики.

**Що показує.** `GET /api/meta-accounts` (+ `useMetaAccountGroups`, `useStrategies`) → `meta_accounts` (відфільтровано на клієнті за обраною платформою). Картка: аватар, `display_name`/`account_id`, `@username`, `inactive`, бейдж групи, «N followers · <token_env> · id <target_id> · verified <дата>», бейдж `connected` / `unverified` / помилка, рядок токена: тип (PAGE зелений, USER жовтий, SYSTEM_USER нейтральний), «Token expires <дата> · in N days» (жовтий ≤30 днів, червоний ≤0), «Never expires», «Invalid token», «not checked — Verify to read», перші 3 scopes + «+N more». Для Threads рядок токена прихований, доки `token_checked_at` порожній. Клік по картці → сторінка 3.5.

**Дії користувача.**
- «Add account» → модалка: Name (slug `^[A-Za-z0-9._-]+$`, ≤64), Token value АБО env-name (за замовчуванням-підказки `FACEBOOK_PAGE_TOKEN` / `INSTAGRAM_TOKEN` / `THREADS_TOKEN`), Target id (page id / IG business-account id / Threads user id). `POST /api/meta-accounts`; дубль `(platform, account_id)` → 409.
- «Verify» → `POST /api/meta-accounts/:id/verify`: (1) для FB/IG викликає `GET graph.facebook.com/{ver}/debug_token` і зберігає ПОХІДНІ метадані (`token_type`, `token_expires_at`, `token_data_access_expires_at`, `token_scopes`, `token_valid`, `token_checked_at`) — токен не зберігається; (2) читає вузол: FB/IG — `/{target_id}` з полями (name, username, followers_count, picture), Threads — `graph.threads.net/{ver}/me` (id, username, name, threads_profile_picture_url); поле, відхилене Graph `(#100) nonexisting field`, відкидається й запит повторюється. Результат → `username`, `display_name`, `followers`, `picture_url`, `last_verified_at`; Threads самолікує `target_id` значенням з `/me`. Токен редагується з усіх повідомлень про помилку.
- «Refresh token» (лише Threads) → `POST /api/meta-accounts/:id/refresh-threads-token`: `GET graph.threads.net/refresh_access_token?grant_type=th_refresh_token`, новий токен шифрується в `token_enc` (повертається лише `expiresAt`), ставляться `token_type='THREADS'`, `token_scopes=[]`, `token_valid=true`.
- Pause/Activate (з підтвердженням) → `PATCH {active}`. Delete → якщо до акаунта привʼязані стратегії, UI показує їх і викликає `DELETE …?cascade=true` (видаляє `strategy_bindings` + `publish('strategy')`, потім акаунт); без cascade сервер віддає 409.

**Бізнес-вимоги (as-is).**
- `BR-CON-17` Система зберігає токен Meta зашифрованим у `meta_accounts.token_enc`; якщо задано лише `token_env`, токен береться з env; API повертає лише `token_env` і похідні метадані токена, ніколи сам токен.
- `BR-CON-18` Для FB/IG Verify незалежно від успіху зчитування вузла фіксує `token_valid`/тип/термін/scopes через `debug_token`, тож «токен мертвий» відрізняється від «target_id/права неправильні»; для Threads `debug_token` не викликається.
- `BR-CON-19` Threads-токен оновлюється тільки вручну кнопкою «Refresh token» (довгоживучий токен ~60 днів; потрібен лише чинний токен, без app secret); автоматичного оновлення (cron) у коді немає.
- `BR-CON-20` Неактивний акаунт не використовується: `DestinationResolver.resolve` кидає «meta account … is inactive»; групове дублювання бере тільки `findActiveByGroup`; hourly-колектор пропускає неактивні.
- `BR-CON-21` Видалення Meta-акаунта з привʼязаними стратегіями без `cascade=true` відхиляється 409; з cascade — привʼязки стратегій видаляються разом з акаунтом.
- `BR-CON-22` Дозволи (OAuth scopes) для Meta в системі не запитуються: токен вводиться вручну; код очікує, що він дозволяє читання вузла, `debug_token`, публікацію та інсайти (`threads_manage_insights` — для підписників Threads), але перелік не валідується.

**Спостереження (3.1d).**
- Результат Verify (`{ok:false,error}`) UI не показує тостом — лише бейдж із 48 символами `verify_error`.
- «Add account» не звіряє token з target_id; помилка видна лише після Verify.
- Підпис «Tokens are stored in .env» застарілий. Підказка бейджа групи каже «manage on the Groups tab», хоча Groups — окрема сторінка.
- Почасовий колектор (див. 3.5) щогодини перезаписує `verify_error`/`last_verified_at`, тож «Last verified» відображає не лише ручний Verify, а й автоматичний; а `debug_token` (термін токена) оновлюється тільки ручним Verify, тому «expires in N days» може бути застарілим, поки не натиснути Verify.
- Сповіщень про наближення терміну токена немає (є лише обчислення стану `token_expiring` для TikTok у каталозі ресурсів агентів).

#### 3.1e TikTok (`TikTokAccountsManager`)

**Бізнес-мета.** Підключити креатор-акаунт TikTok для публікації фотокарусельок (legacy-стратегія `recipe-carousel`, групове дублювання, агентські пости формату `tt_photo`).

**Що показує.** `GET /api/tiktok-accounts` → `tiktok_accounts` (без токенів): аватар, `display_name ?? username ?? open_id`, `@username`, `inactive`, «token refreshed <дата>», бейдж `connected` або `refresh_error`. Банер `?tiktok=connected` («TikTok account connected») / `?tiktok=error` («TikTok connection failed — try again.»). Порожній стан: «No TikTok accounts yet — connect one to publish carousels.»

**Дії користувача.**
- «Connect TikTok» → `GET /api/tiktok/oauth/start` (під guard) повертає authorize URL (`https://www.tiktok.com/v2/auth/authorize/`, `client_key=TIKTOK_CLIENT_KEY`, `redirect_uri=TIKTOK_REDIRECT_URI`, `scope=TIKTOK_SCOPES` або за замовчуванням `user.info.basic,video.publish`, `state` = HMAC-SHA256 підпис `exp.nonce`, TTL 10 хв, ключ `JWT_SECRET`); браузер робить `window.location.assign(url)`. Кнопка показує «Redirecting…».
- Callback `GET /api/tiktok/oauth/callback?code&state` — публічний; перевіряє підпис `state`, обмінює `code` на токени (`POST open.tiktokapis.com/v2/oauth/token/`), робить upsert за `open_id` (повторна авторизація реактивує акаунт і чистить `refresh_error`) і редіректить на `${DASHBOARD_URL}/connections/tiktok?tiktok=connected|error`.
- Pause/Activate (з підтвердженням) → `PATCH /api/tiktok-accounts/:id {active}`; Delete → `DELETE`.

**Бізнес-вимоги (as-is).**
- `BR-CON-23` Підключення TikTok виконується лише через OAuth (Authorization Code); у системі немає ручного введення токена.
- `BR-CON-24` Токени TikTok (access ~24 год, refresh) зберігаються в `tiktok_accounts.access_token/refresh_token` у БД, ніколи не повертаються API.
- `BR-CON-25` Access token оновлюється ліниво: `getValidAccessToken` рефрешить, коли до закінчення лишилося ≤60 с (перед публікацією); фонового оновлення немає. При невдалому refresh пишеться `refresh_error`; якщо вичерпано й refresh token — акаунт стає `active=false`.
- `BR-CON-26` Публікація — фото-пост `DIRECT_POST` з опитуванням статусу (до 10 спроб по 3 с); рівень приватності береться з `TIKTOK_PRIVACY_LEVEL`, за замовчуванням `SELF_ONLY`.
- `BR-CON-27` Редірект OAuth-callback формується як `${DASHBOARD_URL}/connections/tiktok?tiktok=…` (без префікса `/app`), якщо `DASHBOARD_URL` не заданий — відносний редірект на origin automation з warning у логах.

**Спостереження (3.1e).**
- Шлях `/connections/tiktok` у дашборді не існує (маршрут лише `/app/connections/tiktok`, а клієнтський шлях `/connections/*` не оголошений; nginx віддає `index.html`). Нова сторінка «not found» spec 027 покриває лише `/app/*`, тож після успішного OAuth користувач, найімовірніше, бачить стандартне «Not Found» роутера, а не банер. Юніт-тест контролера фіксує саме `…/connections/tiktok`, тож розбіжність закріплена тестом.
- `username`/`display_name`/`avatar_url` ніде не заповнюються: `upsertFromTokens` пише лише токени, `scope` і `open_id`, виклику user-info немає — картка завжди показує `open_id`, без фото й @username; у `resource-catalog` назви ресурсу теж порожні, а на лендінгу TikTok-картка не має посилання на профіль (URL будується з `username`).
- UI-текст «tokens are stored securely and refreshed automatically» справедливий лише в момент публікації; для неактивних акаунтів refresh не відбувається.
- `TikTokTokenService` шифрує токени через жорсткий `encrypt` (503 без `TOKEN_ENCRYPTION_KEY`), тоді як репозиторій додатково викликає `encryptIfConfigured`; з ключем значення шифруються двічі, і читання працює лише тому, що `decode` + `maybeDecrypt` знімають обидва шари. Без ключа обмін коду й refresh падають (OAuth завершується `?tiktok=error`), хоча коментар у репозиторії обіцяє роботу без ключа.
- Вимкнення/видалення TikTok-акаунта не перевіряє `strategy_bindings.tiktok_account_id` (на відміну від Meta, де є 409/cascade); FK `strategy_bindings.tiktok_account_id` без cascade, тож видалення такого акаунта, імовірно, завершиться помилкою БД.
- `state` не одноразовий (replay у межах TTL), що зафіксовано в коментарі коду.

### 3.2 ~~Connections · платформа — `/app/connections/$platform`~~ (видалено)

Файл `app.connections.$platform.tsx` видалено (spec 027 FR-002). Шлях `/app/connections/<будь-що>`, крім `groups`, `meta`, `tiktok`, тепер показує сторінку «not found» усередині оболонки `/app` (посилання на Overview і підказка про ⌘K). Тест `nav/legacy-redirects.test.ts` перевіряє, що заглушки немає.

- ~~`BR-CON-28`~~ видалено: маршрут-заглушку прибрано (spec 027).
- ~~`BR-CON-29`~~ видалено: хаб більше не перехоплює `/app/connections/<x>`, такий шлях дає «not found» (spec 027).
- ~~`BR-CON-30`~~ видалено: динамічного сегмента `$platform` більше немає (spec 027).
- `BR-CON-50` Невідомий шлях під `/app/connections/` (наприклад `/app/connections/instagram`) показує сторінку «not found» у межах `/app`, а не хаб (spec 027).

### 3.3 Groups — `/app/connections/groups`

**Бізнес-мета.** Обʼєднати присутність бренду («мережу»): один Telegram-канал + по одному акаунту Facebook, Instagram, Threads. Кожен член — окремий ресурс: агент мережі вирішує для кожного поста, дублювати, адаптувати, писати унікальний чи пропустити (spec 024). Поки група автодублює (legacy-мережа або агент ще не в live), публікація в «джерело автодублювання» копіюється на інших членів.

**Хто користується / доступ.** Після логіну; пункт «Groups» у групі меню «Connections», хлібні крихти «Connections / Groups». Лише тут створюються/видаляються групи й привʼязуються призначення.

**Що показує.** Компонент `MetaGroupsManager`: `GET /api/meta-account-groups` (`meta_account_groups`, тепер з `mode` і `auto_duplicate`), `GET /api/meta-accounts`, список «своїх» каналів (`trackingApi.listChannels({filter:'mine', pageSize:200})`), `useStrategies`. Для кожної групи: назва, «N of 4 destinations linked», кнопка Delete і 4 «порти»: Telegram, Facebook, Instagram, Threads. Поки група автодублює (`autoDuplicates`: режим не `independent` або сьогоднішній гейт `auto_duplicate` не `false`), видно випадаючий «Auto-duplicate source»; інакше — чип «independent». Заповнений порт — привʼязаний акаунт/канал із кнопкою «×» (Remove from group); порожній — `Assign…` зі списком вільних (без групи) або «None available». Порти показують: SOURCE-бейдж на джерелі (лише поки група автодублює); попередження «No bot — this channel can't send or receive group posts» для Telegram без бота; червоний блок «Double-posts — this member also publishes on its own» із розкладами («Auto-duplicate source» і «This member», cron + next run) і кнопкою «Pause <ext_id>» (`PATCH` стратегії `enabled:false`), коли група автодублює, а не-джерельний член має власну активну стратегію. У незалежній мережі замість цього — жовте попередження «Strategy <type> publishes into an independent network on its own; retire it or keep the group on auto-duplicate.» для кожного типу ввімкненої стратегії члена. Порожній стан: «No groups yet».

**Дії користувача.**
- «Create group» (Enter теж) → `POST /api/meta-account-groups {name}`; ідемпотентно: однойменна група повертається без помилки. Назва: `^[A-Za-z0-9 ._-]+$`, ≤64.
- Assign/Remove для Meta → `PATCH /api/meta-accounts/:id {groupId|null}`; для Telegram → `trackingApi.patchChannel(id, {groupId})`.
- Auto-duplicate source → `PATCH /api/meta-account-groups/:id {sourcePlatform: facebook|instagram|threads|telegram}`.
- Delete group → підтвердження («Members (channel + accounts) are kept — they're just un-grouped (auto-duplication stops).») → `DELETE /api/meta-account-groups/:id`; `group_id` членів стає NULL (`ON DELETE SET NULL`).
- Режим мережі на цій сторінці не міняється (див. BR-CON-36).

**Бізнес-вимоги (as-is).**
- `BR-CON-31` Група містить не більше одного акаунта на платформу (унікальний індекс `meta_accounts_group_platform_uq (group_id, platform)`) і не більше одного Telegram-каналу (`tracked_channels_group_uq`); спроба порушити повертає 409 (для Meta — «That group already has a <platform> account»).
- `BR-CON-32` Для групи зберігається `source_platform` (default `'facebook'`, CHECK: facebook/instagram/threads/telegram); автодублювання відбувається, лише коли публікація йде в члена, чия платформа збігається з `source_platform`, і гейт групи відкритий (BR-CON-47).
- `BR-CON-33` `GroupFanOutService` дублює на всіх ІНШИХ активних членів групи: Meta-акаунти з токеном, TikTok-акаунти групи (потрібне зображення; фото-режим) і привʼязаний Telegram-канал (обкладинка + підпис, без альбому); збій одного призначення не блокує інші й основну публікацію; результат пишеться в трасу запуску (`GroupFanOut`). Якщо гейт закритий, кожне призначення пишеться як `skipped` з причиною «independent network».
- `BR-CON-34` Дублювання з групи викликають legacy-стратегії `recipe-carousel` і `ai0-prompts` (поки їхні привʼязки не виведені, spec 023) та живі пости редактора (`EditorCrossPoster`); інші типи стратегій `GroupFanOutService` не викликають. Редактор не дублює на платформу, чий ресурс поставлено на паузу директивою `pause_resource` (spec 025).
- `BR-CON-35` Для груп з Telegram-каналом, що має публічний username, до Facebook/Threads-підписів додається посилання `https://t.me/<username>` (`resolveGroupTelegramLink`).
- `BR-CON-36` Група має режим мережі `mode`: `independent` (за замовчуванням для нових груп) | `legacy_duplicate`. Міграція 061 перейменувала `orchestrated` → `independent` і `mirror` → `legacy_duplicate`. Режим міняється не на цій сторінці, а `POST /api/agents/:handle/network-mode` (старі назви приймаються як застарілі синоніми; Telegram-канал агента має бути в групі, інакше 400 `no_network`). Зміна режиму діє з наступного дня плану й лишає запис в Inbox агентів (spec 024).
- `BR-CON-37` Видалення групи не видаляє акаунти/канал, лише знімає привʼязку (зупиняє автодублювання).
- `BR-CON-47` Автодублювання вирішує один гейт `NetworkRepository.autoDuplicateActive` для стратегій (`GroupFanOutService`) і редактора (`EditorCrossPoster`). Гейт закритий лише коли разом: режим `independent`, у Telegram-оркестратора мережі є активний плейбук, картка каналу й оркестратор мають ефективний режим `live`, агент не на паузі. Значення закріплюється на локальний день плану Telegram-якоря (`auto_duplicate_day`, `auto_duplicate`), тож зміна набуває сили наступного дня. Невідома група або помилка читання → дублювання триває (spec 024 FR-003).
- `BR-CON-48` Для legacy-мережі система один раз пропонує власнику перейти на незалежні ресурси: рядок у `network_offers` і пункт Inbox `network_independent_offer` у `/app/agents/inbox`. «Залишити» — `POST /api/network-offers/:groupId/keep`, після чого пропозиція не повторюється; перший затверджений плейбук повторює її один раз; перемикання режиму закриває пропозицію (spec 024 FR-010).

**Бізнес-правила й обмеження.** Список опцій для Assign показує лише обʼєкти без групи. Селектор «Auto-duplicate source» disabled, поки в групі немає привʼязаних членів; якщо поточне джерело не привʼязане, воно додається як «(not linked)». Meta- і TikTok-ресурси групи не мають власного режиму агента: вони йдуть за режимом Telegram-каналу мережі (spec 031).

**Стани.** Завантаження: «Loading…»; помилки першої з мутацій/запитів виводяться одним червоним рядком.

**Фонові процеси.** Немає власних. Гейт автодублювання закріплюється при першому зверненні в день плану (планувальник редактора звертається на кожному тіку); обслуговування мережі створює пропозиції `network_offers`. Група впливає на публікації стратегій і редактора, мережеві агенти (`resource-catalog`, `network.repository` читають `meta_account_groups`) і вітрину мереж лендінгу.

**Звʼязки.** Сторінка Channels (`bot`-фільтр, привʼязка бота), Strategies (legacy, колізії), Agents (режим мережі, плейбук, рішення duplicate/adapt/unique/skip), `/app/agents/inbox` (пропозиції мережі), `/app/landing` (опис і порядок мережі на публічній сторінці, spec 026), Meta (3.1d), TikTok (3.1e).

**Спостереження «як фактично зараз».**
- Заголовок сторінки згадує Telegram + Facebook + Instagram + Threads, але TikTok (і YouTube, `youtube_accounts`, міграція 051) не мають порту на UI: `tiktok_accounts.group_id` існує, дублювання на TikTok-членів групи працює в коді, каталог ресурсів агентів з spec 026 відносить такий акаунт до мережі, але ні сторінка, ні API не дозволяють привʼязати TikTok до групи — це можливо лише напряму в БД. «N of 4» не враховує TikTok. Підключення YouTube не існує (spec 030 — майбутнє).
- Правило назви групи (латиниця, цифри, пробіл, `. _ -`) відхиляє українські назви на кшталт «Рецепти» (валідація DTO 400); у плейсхолдері — «Recipes».
- У режимі погодження (`approve`, spec 031) ефективний режим не `live`, тож гейт лишається відкритим: незалежна мережа в період запуску ще автодублює пости Telegram на інші платформи.
- Підзаголовок сторінки («Link a brand's Telegram channel + Facebook, Instagram and Threads accounts») не каже, що мережа тепер складається з незалежних ресурсів; це пояснює лише абзац над списком.
- Двопости (double-post) лише виявляються й показуються; автоматично їх ніщо не запобігає. Стратегії стали legacy (spec 023): на сторінці Strategies їх можна лише поставити на паузу, не ввімкнути.

**Відкриті питання до власника.** Додати порт TikTok на сторінку Groups (YouTube — разом зі spec 030)? Дозволити кириличні назви груп (назва показується на публічному лендінгу)? Чи має мережа в режимі погодження (`approve`) уже вимикати автодублювання?

### 3.4 Редиректи `/app/connections/meta` та `/app/connections/tiktok`

**Бізнес-мета.** Збереження старих закладок і OAuth-повернення TikTok після об'єднання сторінок.

**Що відбувається.** `beforeLoad` кидає `redirect({to:'/app/connections', search:{section:'meta', tab}})` або `{section:'tiktok', tiktok}`; власного UI немає. `validateSearch` зберігає `?tab=` (meta) та `?tiktok=connected|error` (tiktok).

**Бізнес-вимоги (as-is).**
- `BR-CON-38` `/app/connections/meta[?tab=facebook|instagram|threads]` перенаправляє на `/app/connections?section=meta&tab=…`.
- `BR-CON-39` `/app/connections/tiktok[?tiktok=connected|error]` перенаправляє на `/app/connections?section=tiktok&tiktok=…`.

**Спостереження.** Для TikTok це саме той маршрут, на який мав би приходити OAuth-callback, але бекенд редіректить на `/connections/tiktok` (без `/app`) — див. 3.1e. Посилання «Back to Meta accounts» на сторінці деталей замінили хлібні крихти, які повертають на таб платформи акаунта (spec 027).

### 3.5 Деталі Meta-акаунта — `/app/connections/meta/$accountId`

**Бізнес-мета.** Побачити стан одного Meta-акаунта: ідентичність, токен, динаміку підписників і охоплення.

**Хто користується / доступ.** Після логіну; відкривається кліком по картці акаунта (3.1d) або з рядка картки «Meta accounts» на Overview (`app.index.tsx`).

**Що показує.** Хлібні крихти «Connections / Meta accounts» (останній крок веде на `/app/connections?section=meta&tab=<платформа акаунта>`, spec 027). Шапка: аватар (або монограма), назва, `@username`, чип платформи, `Active`/`Paused`, `Verify error` (з title = помилка) або `Verified` (якщо є `username`), кнопка «Refresh». KPI: «Followers», «Δ 24h», «Δ 7d». Панель «Access token» (тип, термін із кольором, «Source» = `token_env` або «—», scopes); для Threads приховується, доки `token_checked_at` порожній. Графіки: «Followers over time» (`SubsHistoryChart`), «Reach & impressions», «Profile views». Дані: `GET /api/meta-accounts` (знайти за id на клієнті), `GET /api/meta-accounts/:id/follower-history` (`meta_follower_history`), `GET /api/meta-accounts/:id/insights` (`meta_account_insights`).

**Дії користувача.** «Refresh» → `POST /api/meta-accounts/refresh-stats` — запускає `MetaStatsCollectorService.runOnce()` для ВСІХ активних акаунтів (не лише поточного), після чого інвалідуються списки, історія й інсайти. Помилка виводиться червоним рядком. Повернення до списку — через хлібні крихти.

**Бізнес-вимоги (as-is).**
- `BR-CON-40` Колектор `MetaStatsCollectorService` працює щогодини (`@Cron(EVERY_HOUR)`) і за ручним «Refresh»: для кожного активного акаунта з токеном викликає Graph verify, оновлює профіль (`markVerified`), пише знімок підписників у `meta_follower_history` і щоденні `reach/impressions/profileViews` у `meta_account_insights` (30 днів назад); прапор `running` не дає паралельного запуску.
- `BR-CON-41` Метрики інсайтів: Instagram — `reach`, `impressions`, `profile_views`; Facebook — `page_impressions_unique`, `page_impressions`, `page_views_total`; Threads — лише `views` (як impressions); недоступна метрика дає `null` без помилки.
- `BR-CON-42` Підписники Threads збираються через `threads_insights?metric=followers_count` (потрібен scope `threads_manage_insights`); без нього знімок не пишеться.
- `BR-CON-43` Історія `meta_follower_history` очищається за `META_HISTORY_RETENTION_DAYS` (за замовчуванням 365).
- `BR-CON-44` Помилка в одному акаунті записується в його `verify_error` й не зупиняє колектор для решти.

**Стани.** Немає даних: «No follower data yet», «No insight data yet» (для Threads — «Not available on Threads.»), завантаження «Loading insight data…». Невідомий `accountId` — сторінка рендерить заголовок з id і порожні блоки (без 404).

**Спостереження.** Кнопка «Refresh» (підказка «Fetch the latest followers + insights now») оновлює всі акаунти, що може бути повільним і витрачає ліміти Graph API. Бейдж «Verified» залежить лише від наявності `username`, а не від свіжості перевірки. Для Threads повідомлення «Not available on Threads» показується, коли немає ні reach, ні impressions, хоча Threads має impressions-еквівалент `views`. Каталог ресурсів агентів оцінює «доступ» Meta-акаунта тільки за `active`, `verify_error`, `last_verified_at` — без `token_valid` і терміну токена.

### 3.6 Bots — `/app/bots` (редирект)

**Бізнес-мета.** Зберегти старі посилання на менеджер ботів.

**Що відбувається.** `beforeLoad` кидає `redirect` на `/app/connections?section=telegram&tab=bots` з `replace: true`; власного UI немає (spec 027 FR-002).

**Бізнес-вимоги (as-is).**
- `BR-CON-45` `/app/bots` лише перенаправляє на вкладку Telegram → Bots хабу `/app/connections`; окремої сторінки-дубля немає (spec 027).

### 3.7 Telegraph — `/app/telegraph` (редирект)

**Бізнес-мета.** Зберегти старі посилання на менеджер Telegraph-акаунтів.

**Що відбувається.** `beforeLoad` кидає `redirect` на `/app/connections?section=telegram&tab=telegraph` з `replace: true` (spec 027 FR-002).

**Бізнес-вимоги (as-is).**
- `BR-CON-46` `/app/telegraph` лише перенаправляє на вкладку Telegram → Telegraph хабу `/app/connections`; окремої сторінки-дубля немає (spec 027).

## 4. Наскрізні правила розділу

**Шифрування токенів (AES-256-GCM).** `TOKEN_ENCRYPTION_KEY` (довільна фраза → SHA-256 → 32-байтовий ключ). Формат `enc:v1:<iv b64>:<tag b64>:<ciphertext b64>`, 12-байтовий випадковий IV, GCM-тег автентифікує цілісність; неправильний ключ/пошкодження дає виняток. `SecretsService` (глобальний `CryptoModule`):
- `encrypt` — обовʼязково потребує ключа, інакше `503 TOKEN_ENCRYPTION_KEY is not set` (усі «додати» ендпоінти: MTProto, боти, Telegraph, Meta);
- `encryptIfConfigured` — шифрує за наявності ключа, інакше зберігає відкритий текст (використовує репозиторій TikTok);
- `maybeDecrypt` — розшифровує `enc:v1:`-значення, відкритий текст пропускає як є; зашифроване без ключа → помилка;
- `resolveToken({enc, env})` — пріоритет `token_enc`, потім `process.env[token_env]`, інакше `undefined`.
Міграції 028 (`token_enc` для `meta_accounts`, `my_bots`, `telegraph_accounts`) і 029 (`token_env` став NULLABLE). Існуючі рядки з імʼям env-змінної працюють без змін; автоматичного перешифрування старих токенів немає. Ротація/зміна `TOKEN_ENCRYPTION_KEY` не передбачена — після зміни ключа всі шифровані токени стають нечитабельними. Секрети не логуються; помилки Graph/Telegram/Telegraph проходять редакцію токена (`access_token=<REDACTED>`, `bot<REDACTED>`, hex ≥40).

**Матриця токенів.**

| Підключення | Таблиця | Де секрет | Оновлення | Перевірка здоровʼя |
|---|---|---|---|---|
| Telegram-бот | `my_bots` | `token_enc` або env `token_env` | немає (довгоживучий) | ручний Verify → `getMe` |
| MTProto | `mtproto_sessions` | `session_enc`, `api_hash_enc` | немає | ручний Verify → `getMe` (gramjs) |
| Telegraph | `telegraph_accounts` | `token_enc` або env | немає | ручний Verify → `getAccountInfo` |
| Facebook / Instagram | `meta_accounts` | `token_enc` або env | вручну (новий токен) | ручний Verify (`debug_token` + вузол); щогодинний колектор оновлює профіль/помилку |
| Threads | `meta_accounts` | `token_enc` або env | кнопка «Refresh token» (~60 днів) | ручний Verify (`/me`), `debug_token` не застосовується |
| TikTok | `tiktok_accounts` | `access_token`, `refresh_token` (БД) | лінивий refresh при публікації | `refresh_error`, стан у каталозі агентів (`token_invalid`/`token_expiring` <7 днів до кінця refresh) |
| YouTube | `youtube_accounts` | `access_token_enc`, `refresh_token_enc` | немає коду | немає (`'YouTube — 019b'`) |

**Що підключення вмикають далі.**
- Telegram-бот → публікація постів у канали (`ChannelConfigService.resolveChannel`, `TelegramPublisher`), пересилання, виконавці розкладів; default-бот — запасний. Rich-повідомлення (spec 033) вимикаються для каналу на 7 днів, якщо Telegram відповів «unsupported» (`app_settings` `cap.tg_rich_unsupported:<channel>`); прапор привʼязаний до каналу, не до бота.
- MTProto tracker → перегляди/реакції постів і трекінг конкурентів (`TrackingMtprotoClient`, `TelegramStatsClient`); agent → читання DM для агента-тріажу (зокрема атрибуція DM з лендінгу за тегом `[ai0web:…]`) і запасний username для рекламних кнопок лендінгу (BR-CON-49).
- Telegraph → довгі сторінки рецептів з Instant View (`TelegraphService`, кеш у `recipes.telegraph_url`).
- Meta → публікація (`PublisherDispatcher`: Facebook/Instagram/Threads, у т. ч. каруселі), крос-пости з Telegram-каналу (`meta_crosspost_targets`, режими mirror/teaser; Instagram лише mirror; з spec 024 підлягають тому ж гейту автодублювання), групове дублювання, статистика (3.5), публічний лендінг (`landing_visible`, вітрина мереж).
- TikTok → фотокарусель (`TikTokCarouselPublisher`) і дублювання групи.
- Група → мережа для агентів (рішення duplicate/adapt/unique/skip, spec 024) і блок мережі на публічному лендінгу (назва, опис `landing_blurb_en`, порядок `landing_order`, spec 026).
- Запрошення (invite): у розділі немає UI; `chat_member`-оновлення від адмін-бота (`TELEGRAM_BOT_TOKEN`, бот має бути адміном каналу) використовуються для обліку приєднань за відстежуваними invite-посиланнями (спец. 022) — це окремий від `my_bots` бот. Той самий токен підписує вхід через Telegram (spec 028).
- YouTube і LinkedIn: підключень немає; `youtube_accounts` існує лише як таблиця для майбутнього spec 030.

**Кеш конфігурації.** Мутації ботів і Telegraph публікують `ConfigEventsPublisher.publish('bot'|'telegraph')` у Redis; `ConfigCacheService` перезавантажується з debounce 500 мс. Мутації Meta/TikTok/MTProto подій не публікують — їх читають напряму з БД на кожне використання (крім MTProto tracker/stats, що читають при старті).

**Спільна UX-поведінка.** Глобальний обробник помилок мутацій показує тост (`describeError`), крім 401 та мутацій із `meta.silentError`. Видалення/пауза мають діалог підтвердження. Секретні поля — `type=password` або маска.

## 5. Глосарій розділу

- **Мережа / група** — запис `meta_account_groups`: Telegram-канал (`tracked_channels.group_id`) + по одному акаунту на платформу. Кожен член — окремий ресурс (spec 024).
- **Джерело автодублювання (source)** — член групи (`source_platform`), публікація в якого дублюється на решту, поки гейт відкритий.
- **Гейт автодублювання** — `auto_duplicate` групи на день плану (BR-CON-47).
- **Режим мережі** — `independent` | `legacy_duplicate` (колонка `meta_account_groups.mode`; до міграції 061 — `orchestrated` | `mirror`).
- **token_env / token_enc** — імʼя env-змінної (legacy) / зашифрований токен у БД.
- **MTProto** — протокол користувацького акаунта Telegram (бібліотека gramjs), на відміну від Bot API.
- **Double-post** — член групи, що одночасно отримує автодубль і виконує власну активну стратегію.

## 6. Джерела в коді

Дашборд:
- `apps/dashboard/src/routes/app.connections.tsx`, `app.connections_.groups.tsx`, `app.connections_.meta.tsx`, `app.connections_.tiktok.tsx`, `app.connections_.meta_.$accountId.tsx`, `app.bots.tsx`, `app.telegraph.tsx` (редиректи), `routeTree.gen.ts`; `apps/dashboard/src/nav/registry.ts`, `nav/legacy-redirects.test.ts`, `components/NotFound.tsx`
- `apps/dashboard/src/components/connections/` (`SessionsPanel`, `AddMtprotoSessionModal`, `BotsManager`, `TelegraphManager`, `MetaAccountsManager`, `AddMetaAccountModal`, `MetaGroupsManager`, `TikTokAccountsManager`), `components/AddBotModal.tsx`, `components/AddTelegraphAccountModal.tsx`, `components/AppSidebar.tsx`
- `apps/dashboard/src/api/bots.ts`, `mtproto-sessions.ts`, `meta-accounts.ts`, `tiktok-accounts.ts`, `telegraph.ts`, `network.ts`, `client.ts`; `apps/dashboard/nginx.conf`

Бекенд (`apps/automation/src`):
- `config/api/my-bots.controller.ts`, `mtproto-sessions.controller.ts`, `meta-accounts.controller.ts`, `meta-account-groups.controller.ts`, `telegraph-accounts.controller.ts`, `tiktok-accounts.controller.ts`, `tiktok-oauth.controller.ts`, `meta-crossposts.controller.ts`, `dto/*`
- `config/my-bots.repository.ts`, `mtproto-sessions.repository.ts`, `meta-accounts.repository.ts`, `meta-account-groups.repository.ts`, `telegraph-accounts.repository.ts`, `tiktok-accounts.repository.ts`, `tiktok-token.service.ts`, `tiktok-oauth.service.ts`, `tiktok-oauth-state.util.ts`
- `config/telegram-getme.client.ts`, `mtproto-verify.client.ts`, `meta-graph.client.ts`, `meta-insights.ts`, `telegraph-getinfo.client.ts`, `config-cache.service.ts`, `channel-config.service.ts`
- `common/crypto/token-crypto.ts`, `secrets.service.ts`, `crypto.module.ts`
- `common/content-strategy/destination-resolver.service.ts`, `group-fanout.service.ts`
- `publishers/telegraph.service.ts`, `publishers/tiktok/tiktok-carousel.publisher.ts`, `publishers/admin-bot.service.ts`, `publishers/chat-member-bus.ts`, `publishers/cross-post.service.ts`
- `stats/meta-stats-collector.service.ts`, `stats/telegram-stats.client.ts`, `tracking/mtproto/tracking-mtproto.client.ts`, `agent/agent-mtproto.client.ts`
- `tracking/api/tracking-auth.guard.ts`, `auth/auth.service.ts`, `editor/network/network.controller.ts` / `network.service.ts` / `network.repository.ts` (гейт), `editor/network/network-offers.ts`, `editor/agents/resource-catalog.ts`, `editor/publish/editor-crosspost.ts`, `config/landing-config.service.ts`

БД (`database/migrations`): `005_config` (my_bots), `011_telegraph`, `016_meta_accounts`, `021/022` (історія й інсайти), `023_tiktok_accounts`, `026/027` (метадані токена), `028_token_encryption`, `029_token_env_nullable`, `030_default_bot`, `031/032/037` (mtproto_sessions), `033/034/035` (групи), `051_platform_posts` (youtube_accounts, tiktok group_id), `052_playbooks_ideas` (mode), `055_auth_sessions`, `058_data_store` (`recipes` → view), `061_independent_resources` (режими, гейт), `064_network_offers`, `066_landing_ai_network` (опис і порядок мережі); `.env.example` (`TOKEN_ENCRYPTION_KEY`, `DASHBOARD_URL`, `TIKTOK_*`, `TELEGRAM_*`).
