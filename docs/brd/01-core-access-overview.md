# BRD (as-is) — Доступ, публічна частина, огляд і налаштування

> Статус: оновлено з коду 2026-10-10 (коміт 54dd1eb, гілка feat/editor-agent). Описує, як система ФАКТИЧНО працює зараз, а не як мала б.

## Що змінилось з 2026-10-05

- **Лендинг (spec 026).**
  - Новий hero: «A media network run by AI agents». Додано живу смугу цифр з `GET /api/landing/pulse`, схему агентів і вітрину, згруповану за мережами, з бейджами агентів.
  - Додано YouTube.
  - Реклама замовляється через Telegram DM з атрибуцією або через форму заявки; `mailto:` і бейдж «Self-serve — coming soon» прибрано.
  - Додано секцію та сторінку `/white-label`.
- **Вхід (spec 028).**
  - Сесії тепер серверні (`auth_sessions`) і відкликаються. Час життя: токен 60 хв, простій 7 днів, абсолютний ліміт 30 днів.
  - nginx перевіряє сесію через `GET /auth/check` ще до віддачі HTML, далі працює router guard з `next`.
  - Помилки входу мають точні тексти. Ліміт спроб живе в Redis з блокуванням, а аудит пишеться в `auth_events`.
  - Збірка без способу входу падає, і клієнт більше не вигадує dev-користувача.
- **Settings (specs 027, 028).** Додано вкладки Security (сесії, «Sign out everywhere», журнал входів) і Navigation (конструктор меню).
- **Меню (spec 027).** Меню будується з реєстру: 10 груп, 24 пункти. Пункти мають бейджі-лічильники, є палітра ⌘K і сторінка «Page not found» усередині оболонки. Старі адреси перенаправляються.
- **Overview (specs 023, 029).**
  - Плитку «Active strategies» замінила «Upcoming slots (24 h)». Картка «Upcoming runs» стала «Upcoming slots» (серії та піни), а «Strategy status» — «Legacy strategy runs».
  - Додано картки «Agents» і «AI spend». Лічильник витрат у «Network health» тепер бере дані з журналу `llm_usage`.
- **Нові сторінки.** `/app/models` (spec 035), `/app/spend` (spec 029) і `/app/data` (spec 032) коротко описано тут, у розділах 3.6–3.8.
- **Нові вимоги:** BR-CORE-46…68. Видалених вимог немає.

## 1. Призначення розділу

Розділ описує «вхідну» частину продукту ai0:
- публічний лендинг і сторінку `/white-label`;
- вхід оператора (власника мережі);
- оболонку панелі (меню, шапка, ⌘K);
- стартову сторінку `/app`;
- сторінку `/app/settings`;
- коротко — сторінки `/app/models`, `/app/spend`, `/app/data`, для яких окремого BRD ще немає.

Код розділу — `CORE`.

Єдиний користувач панелі — власник/оператор. Він входить токеном доступу або через Telegram зі списку дозволених ID. Ролей, команд і окремих акаунтів немає. Публічна частина розрахована на рекламодавців (вітрина мереж, медіакіт, замовлення реклами) і на тих, хто хоче white label.

## 2. Сторінки розділу

| Сторінка | Маршрут | Коротко |
|---|---|---|
| Публічний лендинг | `/` | Англійською: hero з живими цифрами, схема агентів, мережі з ресурсами, «How it works», реклама з медіакітом, white label |
| White label | `/white-label` | Опис пропозиції та форма заявки; показується, лише поки пропозицію не вимкнено |
| Вхід | `/login` | Telegram-віджет і/або форма токена (визначається при збірці); банер причини виходу |
| Оболонка застосунку | `/app` (layout) | Router guard + бокове меню з реєстру + шапка (пошук ⌘K, «New post», «Log out») |
| Огляд | `/app` | Плитки, картки «Agents», «AI spend», «Network health», «Upcoming slots», «Legacy strategy runs», «Meta accounts» |
| Налаштування | `/app/settings` | 5 вкладок: Telegram, AI, Meta, Security, Navigation |
| Моделі | `/app/models` | Модель за замовчуванням і модель/effort кожного агента |
| Витрати | `/app/spend` | Журнал витрат на AI, ціни, ліміти |
| Дані | `/app/data`, `/app/data/$key` | Датасети агентів, імпорт CSV/JSON/JSONL |

## 3. Сторінки

### 3.1 Публічний лендинг — `/`

**Бізнес-мета.** Показати, що ai0 — медіамережа, якою керують AI-агенти, довести це живими цифрами, продати рекламу й зібрати заявки на white label. Файли: `apps/dashboard/src/routes/index.tsx`, `components/landing/*`, `lib/landing-view.ts`, `index.html`.

**Хто користується / доступ.** Сторінка публічна, без авторизації. Мова — лише англійська (рішення власника 2026-10-06). `<title>` — «ai0 — a media network run by AI agents». OG/Twitter URL збирає Vite-плагін з `VITE_PUBLIC_URL`; без значення підставляється `https://dev.ai0.global` (`lib/public-url.ts`).

**Що показує (по порядку).**
- **Верхня панель:** «ai0»; «Advertise» — Telegram DM-посилання (якщо налаштовано) або якір `#advertise`; «Sign in →» → `/app`.
- **Hero:**
  - Бейдж «A network run by AI agents · N platforms».
  - Заголовок завжди «A media network run by AI agents».
  - Підзаголовок: оркестратори пишуть пости, «The owner approves structural changes and, during the launch period, each post before it goes out.» Речення про MANAGER залежить від `claims.managerLive`: або «A MANAGER agent watches the whole network…», або «…is coming soon.»
  - Кнопки «See the network ↓» і «Order an ad in Telegram» (якщо DM-посилання немає — «Advertise with us»). Посилання «White label for your own resources →» показується, якщо пропозиція увімкнена.
- **Смуга живих цифр** (`ProofStrip`) з `GET /api/landing/pulse`: «posts by agents in 7 days», «agents live», «of content created by agents», «last agent post».
  - Плитки з нулем приховані.
  - Якщо дані застарілі, під смугою стоїть «Numbers from the last successful update.»
  - Якщо pulse не відповів, смуги немає.
- **Схема агентів** (`AgentHierarchy`):
  - MANAGER, до 4 мереж (live → shadow → pipeline) і ролі Planner, Ideator, Idea reviewer, Executor, Reviewer. Ролі, що працювали цього тижня, підсвічені.
  - Без мереж показується заглушка «Orchestrator per network».
- **«Networks run by AI»** (`#networks`), дані з `GET /api/landing/networks`:
  - Лічильники «followers reached», «channels & profiles», «platforms».
  - Блоки мереж: назва (або «Standalone channels»), чип агента «Run by AI agent X · live» / «…in training (shadow)», опис, підписники, «Advertise in this network».
  - Картки ресурсів з бейджем «Run by an AI agent» / «Agent in shadow · classic pipeline publishes» / «Automated pipeline». Кнопка «Ads here» є лише там, де є активна ціна.
  - Платформи: Telegram, Instagram, Facebook, Threads, TikTok, YouTube.
- **«How it works»:**
  - Перший ряд — ланцюжок MANAGER → Orchestrator → Planner → Executor → Reviewer з приміткою про апрув власника.
  - Другий ряд — «How to order an ad»: Telegram DM → ціни й слот → оплата LiqPay → пост з #реклама і звітами через 24 і 72 год.
- **«Advertise with us»** (`#advertise`):
  - Текст про позначку #реклама і звіти.
  - Медіакіт (`GET /api/landing/media-kit`): підписники, середні перегляди за 30 днів, ціни в ₴, кнопка замовлення на кожен канал.
  - Пара кнопок «Order an ad in Telegram» + «No Telegram? Leave a request» (без DM-посилання — лише «Request an ad placement»).
  - Примітка, що відповіді готує AI-асистент, а власник їх перевіряє.
- **White label** (`#white-label`): «Run your own network with AI agents», 3 картки переваг, примітка про окремий екземпляр під клієнта, кнопка «See the white-label offer →».
- **Футер:** «© рік ai0 — a media network run by AI agents», посилання «The network», «Advertise», «White label», «Sign in».

**Дії користувача.**
- **Навігація:** якорі, зовнішні посилання на профілі.
- **Telegram DM.** Кнопка відкриває `t.me/<username>?text=…`. Текст повідомлення заповнено заздалегідь і закінчується тегом `[ai0web:<placement>[:<channel>]]`. DM-тріаж розбирає тег і показує на `/app/dm` чип «From landing».
- **Beacon.** Кожен клік по CTA шле `POST /api/landing/cta` (лічильник по днях у `landing_cta_daily`).
- **Форма заявки на рекламу** (модальне вікно «Request an ad placement»). Поля: контакт*, імʼя, канал, повідомлення, згода*. Відправляється на `POST /api/landing/leads`.

**Бізнес-вимоги (as-is).**
- `BR-CORE-01` Сторінка `/` не викликає жодного захищеного ендпоінта. Вона використовує лише публічні `GET /api/landing/config|networks|pulse|media-kit` і `POST /api/landing/cta|leads`.
- `BR-CORE-02` Вітрина показує ресурси, позначені для лендингу: Telegram-канали з `is_mine AND landing_visible`, featured-акаунти Meta/TikTok, YouTube з `landing_visible`. Ресурси згруповано за мережами (`meta_account_groups`); канали без мережі йдуть у «Standalone channels». Порядок — за `landing_order`.
- `BR-CORE-03` Для Telegram-карток аватар не показується. Для TikTok кількість підписників завжди `null`, для YouTube — `null`, поки її не заповнить колектор.
- `BR-CORE-04` Лічильники під заголовком «Networks run by AI» відображаються лише при успішній відповіді з ≥1 ресурсом. «followers reached» — сума підписників (TikTok додає 0), «platforms» — кількість різних платформ.
- `BR-CORE-05` Медіакіт відображається лише коли хоча б один канал має активну ціну в `ad_prices`; інакше компонент не рендериться (без порожнього стану).
- `BR-CORE-06` Реклама замовляється через Telegram DM з атрибуцією `[ai0web:…]` або через форму заявки. `mailto:` на лендингу немає. Username для DM береться з `landing.ad_tg_username`, інакше з активної MTProto-сесії з роллю `agent`. Якщо username немає, показується лише форма.
- `BR-CORE-07` «Sign in →» і «Sign in» ведуть на `/app`. Незалогіненого відвідувача nginx (або router guard) відправляє на `/login?next=/app`.
- `BR-CORE-08` Усі тексти лендингу — англійською, захардкоджені в TSX; мовного перемикача немає. Кирилиця на сторінці — лише «#реклама».
- `BR-CORE-46` Заголовок hero завжди «A media network run by AI agents», незалежно від цифр. Твердження про роботу MANAGER показується лише коли `claims.managerLive` = режим MANAGER `live` і хоча б одне його рев'ю за 7 днів. Інакше показується «coming soon».
- `BR-CORE-47` `GET /api/landing/pulse` рахує цифри одним read-only запитом з таймаутом 2 с (загальна межа 3 с). Відповідь кешується в процесі на 5 хв. Після збою наступна спроба — через 30 с. Застарілі дані віддаються до 1 год, далі — 503 `pulse_unavailable`. При помилці смуга на сторінці ховається.
- `BR-CORE-48` Заявки (`POST /api/landing/leads`) обмежені 5 на годину з одного IP; зберігається лише солений хеш IP. Далі за порядком:
  - Заповнений honeypot або форма, заповнена швидше за 2,5 с, → заявка зберігається як `spam`.
  - Повтор того самого контакту з того ж IP протягом 24 год оновлює існуючий рядок.
  - Нова заявка → `landing_leads`, елемент Inbox `landing_lead` без персональних даних і Telegram-сповіщення власнику (до 20 на день).
- `BR-CORE-49` Секція white label, посилання на неї і сторінка `/white-label` показуються, поки `landing.white_label_enabled` ≠ `false` (за замовчуванням увімкнено). Коли вимкнено, сторінка показує «The white-label offer is temporarily unavailable», а заявки white label отримують 403.
- `BR-CORE-50` `POST /api/landing/cta` приймає до 60 кліків на хвилину з одного клієнта. Невідомі CTA чи місця розміщення ігноруються, мова завжди `en`.

**Бізнес-правила й обмеження.**
- Публічні контролери (`landing`, `ads-public`) не мають гарда; глобального гарда немає.
- Публічні проєкції не містять токенів.
- Шаблон DM-повідомлення — до 240 символів, саме повідомлення — до 300; тег атрибуції не обрізається.
- `lost`/`spam`-заявки очищуються через `LANDING_LEAD_PURGE_DAYS` (180).

**Стани.**
- **Вітрина:** під час завантаження — 6 скелетонів; при помилці — «Couldn’t load the showcase right now. Please try again shortly.»; порожня — «No resources yet».
- **Форма:** помилки під полями та підсумок «Please fix these before sending:»; при 429 — «Too many requests from your network in the last hour…».
- **Анімації** поважають `prefers-reduced-motion`.

**Фонові процеси.** Немає власних. Цифри беруться з даних трекінгу, Meta-колектора й агентів. Retention очищує заявки.

**Звʼязки.**
- Видимість ресурсів, опис мереж, налаштування DM, заявки й статистика CTA — `/app/landing` (документ 08).
- Ціни — `/app/ads`. Звіт рекламодавця — `/report/$token`. Діалоги з рекламодавцями — `/app/dm`.

**Спостереження «як фактично зараз».**
- На головній сторінці модальне вікно заявки відкривається без DM-посилання, тож рядка «Or message us in Telegram» там немає.
- Без `VITE_PUBLIC_URL` OG-посилання вказують на `dev.ai0.global`. `docker-compose.yml` цю змінну не передає, її передають лише CI-workflows.
- Міграція 066 уже має колонки для української версії (`lang 'uk'`, `landing_blurb_uk`), але UI їх не використовує.

**Відкриті питання до власника.** Немає.

---

### 3.2 Оболонка застосунку — `/app` (layout) та навігація

**Бізнес-мета.** Єдиний каркас для всіх сторінок `/app/*`: перевірка сесії, меню, пошук, швидка дія «New post». Файли: `routes/app.tsx`, `components/AppShell.tsx`, `components/AppSidebar.tsx`, `components/CommandPalette.tsx`, `components/NotFound.tsx`, `nav/*`.

**Хто користується / доступ.** Тільки після входу (див. 3.3: nginx + router guard).

**Що показує.**
- **Перевірка сесії:**
  - Холодна перевірка (довша за 200 мс) показує «Checking your session…».
  - Якщо `/auth/me` не відповів, показується «Can't reach the server / We couldn't check your sign-in. Your session is not affected.» з кнопкою «Try again».
- **Шапка:**
  - Кнопка пошуку «Search…» з `⌘ K` (на мобільному — лише іконка).
  - `firstName · @username` (лише на десктопі).
  - «+ New post» → `/app/compose`.
  - «Log out».
  - На мобільному кнопка меню з крапкою, якщо прихований бейдж вимагає уваги.
- **Бічне меню.** Логотип «ai0», секція «Pinned», групи з реєстру, внизу «Edit menu» і «Collapse/Expand». Ширина 234 ↔ 64 px, стан зберігається в `localStorage` `dashboard:sidebar-collapsed`. На ≤860 px меню стає шторкою шириною 264 px.

Типове меню (`nav/registry.ts`, spec 027 + 023):

| Група | Пункти (підпис → маршрут) |
|---|---|
| Home | Overview → `/app` (exact); Posts to approve → `/app/agents/inbox?tab=approvals` |
| Agents | Agents → `/app/agents`; Chat → `/app/chat`; DM inbox → `/app/dm`; Models → `/app/models` |
| Publishing | Compose → `/app/compose`; Scheduled → `/app/scheduled`; Editor → `/app/editor`; Logs → `/app/logs`; My channels → `/app/channels?filter=mine` |
| Content | Data → `/app/data` |
| Analytics | Analytics → `/app/analytics`; Spend → `/app/spend`; Tracked → `/app/tracked` |
| Intelligence | Discovery → `/app/discovery`; Graph → `/app/graph`; Recommendations → `/app/recommendations` |
| Connections | Connections → `/app/connections` (exact); Groups → `/app/connections/groups` |
| Marketing | Landing → `/app/landing`; Ads → `/app/ads` |
| System | Settings → `/app/settings` |
| Legacy | Strategies → `/app/strategies` |

**Бейджі.** Лічильники беруться з `GET /api/nav/badges` (кожні 30 с, поки вкладка видима; на сервері кеш 10 с) і `GET /api/editor/approvals/count` (кожні 60 с). «Сьогодні» — від київської півночі. Понад 99 показується «99+».

| Пункт | Що рахує |
|---|---|
| Posts to approve | пости, що чекають на апрув |
| Agents | непрочитані в Inbox агентів + директиви `awaiting_owner`/`contested` |
| Chat | картки дій у чаті, що чекають на підтвердження |
| DM inbox | нові DM-треди + відповіді на апрув |
| Editor | слоти `failed` сьогодні |
| Scheduled | ручні пости `failed`/`unknown` сьогодні |

**Дії користувача.**
- **Меню.** Навігація й згортання. Швидкі правки з контекстного меню пункту («Pin to the top», «Hide from the menu», «Rename…») зберігаються одразу.
- **⌘K / Ctrl K** відкриває палітру. Вона шукає сторінки (включно з прихованими), власні посилання, агентів `@handle` і 4 дії: «New post», «Pin current page», «Edit menu», «Collapse sidebar». Останні 5 виборів показуються першими.
- **«Log out»** → `POST /auth/logout` (сесія відкликається), очищення кешу запитів, перехід на `/login`.

**Бізнес-вимоги (as-is).**
- `BR-CORE-09` Усі маршрути `/app/*` рендеряться всередині layout `/app`. Його `beforeLoad` перевіряє сесію (`GET /auth/me`, кеш 60 с). Без сесії — router-редирект на `/login?next=<поточна адреса>&reason=<код>` без повного перезавантаження.
- `BR-CORE-10` Поки триває холодна перевірка сесії (довше 200 мс), `/app/*` показує оформлений екран «Checking your session…». Збій перевірки показує екран «Can't reach the server» і не виконує вихід.
- `BR-CORE-11` Типове бічне меню містить 10 груп і 24 пункти (таблиця вище). «Compose» дублює кнопку «New post»; «Strategies» стоїть в останній групі «Legacy».
- `BR-CORE-12` Пункт «My channels» відкриває `/app/channels?filter=mine`. «Overview» і «Connections» підсвічуються лише при точному збігу маршруту.
- `BR-CORE-13` Стан згорнутого меню зберігається в `localStorage` (`dashboard:sidebar-collapsed`). На екранах ≤860 px меню завжди повної ширини (264 px), як шторка; згортання недоступне.
- `BR-CORE-14` Кнопка «New post» у шапці є на всіх сторінках `/app/*` і веде на `/app/compose`.
- `BR-CORE-15` Кнопку «Log out» видно завжди, крім випадку, коли сесію підтверджено сервером як локальний dev-обхід (`method = 'dev'`).
- `BR-CORE-16` Імʼя в шапці береться з `/auth/me`: для токен-входу — «Operator · @token», для Telegram — імʼя й username користувача Telegram.
- `BR-CORE-51` Власник змінює меню в Settings → Navigation (див. 3.5). Меню зберігається одним рядком `app_settings` `ui.nav` (схема v1) з ревізією; збереження з застарілої ревізії отримує 409. «Overview» і «Settings» приховати не можна. Приховування пункту не вимикає сторінку.
- `BR-CORE-52` Бейджі меню показують лічильники з таблиці вище. Нуль або невідоме значення означає, що бейджа немає. Кожна успішна мутація в дашборді оновлює бейджі.
- `BR-CORE-53` Палітра ⌘K знаходить кожну зареєстровану сторінку, зокрема приховані з меню, а також агентів за `@handle`.
- `BR-CORE-54` Невідомий шлях `/app/*` показує всередині оболонки «Page not found» з кнопкою «Go to Overview» і підказкою про ⌘K. Старі адреси перенаправляються:
  - `/app/bots`, `/app/telegraph` → `/app/connections?section=telegram&tab=…`;
  - `/app/calendar` → `/app/scheduled`;
  - `/app/agent` → `/app/dm` (пошукові параметри зберігаються);
  - `/app/connections/meta|tiktok` → `/app/connections?section=…`.

**Бізнес-правила й обмеження.**
- Ліміти конфігурації меню: 20 груп, 150 посилань на пункти, 50 власних посилань, 10 закріплених, підпис до 40 символів, 32 KB.
- Меню для першого рендеру кешується в `localStorage` `dashboard:nav-cache`.
- Заголовок сторінки малює кожна сторінка сама (`PageHeader`) разом із хлібними крихтами з реєстру.

**Стани.** Екран перевірки сесії, екран недоступного сервера; шторка меню на мобільному (закривається кліком по затемненню).

**Фонові процеси.** Немає (лише опитування бейджів).

**Звʼязки.** Зареєстровані, але приховані сторінки (доступні з ⌘K і хлібних крихт): «Agent inbox», «Directives», «Bots», «Telegraph», «Meta accounts», «TikTok accounts», «Navigation», «Security», «AI keys», «New strategy». Детальні сторінки (`/app/agents/$handle`, `/app/channels/$id`, `/app/editor/*`, `/app/strategies/$id`, `/app/data/$key`, `/app/connections/meta/$accountId`) живуть лише в хлібних крихтах.

**Спостереження «як фактично зараз».**
- Бейджі Agents і Agent inbox частково дублюють одне одного: обидва рахують непрочитане в Inbox.

**Відкриті питання до власника.** Немає.

---

### 3.3 Вхід — `/login` та бекенд-автентифікація

**Бізнес-мета.** Пустити в панель лише власника й мати змогу відкликати будь-яку сесію. Файли:
- дашборд: `routes/login.tsx`, `routes/app.tsx`, `auth/*` (`session.ts`, `next.ts`, `messages.ts`, `unauthorized.ts`), `api/auth.ts`, `api/client.ts`, `lib/auth-mode.ts`, `router.ts`, `vite.config.ts`, `nginx.conf`, `public/auth-unavailable.html`;
- бекенд: `apps/automation/src/auth/*`, `tracking/api/tracking-auth.guard.ts`;
- міграція `055_auth_sessions.sql`.

**Хто користується / доступ.** Сторінка публічна. Спосіб входу задається при **збірці** (`lib/auth-mode.ts`):
- `VITE_TG_BOT_USERNAME` задано → `telegram`;
- інакше `VITE_AUTH_MODE=token` → `token`;
- інакше `dev`.

Форма токена доступна при `VITE_AUTH_MODE=token`. У режимі `telegram` вона згорнута під кнопкою «Use access token». Dockerfile без обох змінних збирає режим `token`.

**Що показує.** Заголовок «ai0», текст «Sign in to the dashboard.», банер причини, якщо `?reason=` відомий:
- «Your session expired. Please sign in again.»
- «You were signed out from another device.»
- «Please sign in again after the security update.»

Далі залежно від режиму:
- **`telegram`:** Telegram Login Widget, а якщо увімкнено і токен — кнопка «Use access token».
- **`token`:** поле «Access token» і кнопка «Sign in» («Checking…» під час запиту; поки діє блокування, кнопку вимкнено зі зворотним відліком).
- **`dev`:**
  - на `localhost` / `127.0.0.1` / `::1` / `*.localhost` — «Local dev build — the backend's local no-auth bypass decides access.» і кнопка «Continue in dev mode»;
  - на будь-якому іншому хості — червоний банер «This build has no sign-in method».

**Дії користувача.**
- **Токен** → `POST /auth/token-login {token}` → видалення кешу сесії → перехід на `next` (або `/app`).
- **`/login?token=…`.** Токен одразу прибирається з адреси. Якщо вхід токеном увімкнено, він відправляється як `via: 'link'` (в аудиті метод `link`).
- **Telegram-віджет** → `POST /auth/telegram-login` → перехід на `next` (або `/app`). Помилки показуються в рядку під формою.
- **Уже залогінений** користувач на `/login` одразу йде на `next` або `/app`.

**Бекенд (`AuthController`, префікс `/auth`).**

| Ендпоінт | Гард | Поведінка |
|---|---|---|
| `POST /auth/token-login` | — | порівнює з `TRACKING_TOKEN` (constant-time); створює сесію; помилки `{code}`; при 429 — заголовок `Retry-After` |
| `POST /auth/telegram-login` | — | HMAC віджета ключем з `TELEGRAM_BOT_TOKEN`, вік payload ≤ 24 год, ID зі списку `TRACKING_ALLOWED_TG_USER_IDS` |
| `GET /auth/me` | — | приймає і Bearer, і cookie; повертає `{tgUserId, firstName, username, method, sessionId?, expiresAt?}` або `null`. Для мертвої cookie очищає її й ставить `X-Auth-Reason`; якщо БД недоступна — 503 |
| `GET /auth/check` | — | для nginx: 204 / 401 / 503, порожнє тіло, без записів і продовження сесії |
| `POST /auth/logout` | — | відкликає сесію з cookie (`revoked_reason='logout'`), очищає cookie |
| `GET /auth/sessions` | TrackingAuthGuard | список сесій, позначка поточної |
| `DELETE /auth/sessions/:id` | TrackingAuthGuard | відкликає одну сесію |
| `POST /auth/sessions/revoke-all {includeCurrent}` | TrackingAuthGuard | відкликає інші сесії або всі |
| `GET /auth/events?limit=` | TrackingAuthGuard | журнал (за замовчуванням 50, максимум 200) |

**Сесії.**
- Рядок `auth_sessions` (метод `token`/`telegram`/`link`, IP, user agent, `last_seen_at`, `revoked_at`).
- JWT `{sub, sid, method, v:2}` живе `AUTH_ACCESS_TTL_MIN` (60 хв).
- Сесія дійсна, поки не відкликана і поки `last_seen + AUTH_IDLE_TTL_DAYS` (7) та `created + AUTH_ABSOLUTE_TTL_DAYS` (30) у майбутньому.
- Після половини терміну JWT запит під гардом отримує нову cookie (ковзне продовження).
- `last_seen_at` пишеться не частіше ніж раз на 5 хв. Кеш стану сесії — 60 с, при відкликанні скидається одразу.
- Cookie `tracking_jwt`: `httpOnly`, `sameSite=lax`, `secure` лише при `NODE_ENV=production`, `maxAge` = вікно простою.

**Захист решти API (`TrackingAuthGuard` → `AuthService.authenticate`).**
- **Порядок перевірки:**
  1. `Authorization: Bearer <TRACKING_TOKEN>` (сесію не створює);
  2. cookie сесії;
  3. локальний обхід — лише коли `ALLOW_NO_AUTH=true`, `NODE_ENV` ≠ `production`, `TRACKING_TOKEN` порожній і жодних облікових даних не передано.
- **Коди 401:** `no_credentials`, `bad_token`, `session_expired`, `session_revoked`, `session_legacy`.
- **Збій БД:** JWT, термін якого ще не минув, приймається; інакше — 503, а не 401.
- **Контролери:** 43, з них 35 під `TrackingAuthGuard` на рівні класу і `/stats/*` під `ApiKeyGuard` (`X-API-Key`).
- **Публічні:** `api/landing/*` (крім `admin`), `api/landing/prices|media-kit`, `api/ads/report/:token`, `api/payments/liqpay/callback`, `/r/:code`, `GET /health`, TikTok OAuth callback, частина `/auth`.

**Ліміт спроб (`login-limiter.ts`).** Обидва ендпоінти входу ділять один ліміт:
- 10 прийнятих спроб на хвилину з IP (Redis ZSET);
- 20 невдач за годину з IP → блокування IP на 1 год (`locked_out`);
- 50 невдач за годину з усіх IP разом → одне сповіщення власнику, без блокування.
- Якщо Redis недоступний або відповідає довше 500 мс, ті самі правила працюють у памʼяті процесу.

**Клієнтська обробка 401.** `api()` скидає кеш сесії й один раз (single-flight) робить router-перехід на `/login?next=…&reason=…`, лише якщо користувач на `/app/*`. Запити не повторюються на 401. Глобальний тост для 401 не показується.

**Бізнес-вимоги (as-is).**
- `BR-CORE-17` Спосіб входу (`telegram` / `token` / `dev`) визначається на етапі збірки через `VITE_TG_BOT_USERNAME` і `VITE_AUTH_MODE`; зміна потребує перезбирання образу. Обидва способи можуть бути на сторінці одночасно (Telegram + згорнута форма токена).
- `BR-CORE-18` Вхід токеном — через форму або відкриттям `/login?token=…`. Токен прибирається з адресного рядка до відправки. Після входу користувач потрапляє на безпечний `next`: лише шлях, що починається з `/app`, без `//`, зворотного слеша чи керівних символів; інакше `/app`. Токен-вхід і Telegram ведуть на ту саму адресу.
- `BR-CORE-19` Вхід створює рядок `auth_sessions` і cookie `tracking_jwt` (JWT 60 хв з ковзним продовженням). Сесія закінчується через 7 днів простою або через 30 днів від входу. `secure` ставиться лише в production.
- `BR-CORE-20` Telegram-вхід приймає лише користувачів зі списку `TRACKING_ALLOWED_TG_USER_IDS`. Порожній список повністю вимикає Telegram-вхід (`telegram_login_disabled`). Payload, старший за 24 год, відхиляється.
- `BR-CORE-21` Обидва ендпоінти входу разом обмежені 10 спробами на хвилину з одного IP. 20 невдач за годину блокують IP на 1 год. Стан живе в Redis; без Redis — у памʼяті процесу за тими самими правилами.
- `BR-CORE-22` Контролери керування приймають `Bearer TRACKING_TOKEN` або дійсну cookie сесії; без них — 401 з кодом причини.
- `BR-CORE-23` Відповідь 401 на API-виклик дашборду скидає сесію і робить один router-перехід на `/login` з `next` і `reason`, без повного перезавантаження сторінки.
- `BR-CORE-24` Вихід відкликає сесію на сервері, очищає cookie й кеш запитів і переходить на `/login` із заміною історії.
- `BR-CORE-25` Сесію можна відкликати: вихід, «Revoke», «Sign out other sessions» або «Sign out everywhere» у Settings → Security. Наступний запит відкликаної сесії отримує 401 `session_revoked`. Bearer-виклики сесій не мають і відкликанням не зачіпаються.
- `BR-CORE-26` Помилка входу показується текстом за кодом:
  - `bad_token`, `token_login_disabled`, `bad_signature`, `payload_expired`, `not_allowlisted`, `telegram_login_disabled`;
  - `rate_limited` / `locked_out` (з часом очікування);
  - `network` → «Can't reach the server…».
  Назви змінних середовища в інтерфейсі не показуються.
- `BR-CORE-55` Кожна спроба входу, вихід, відкликання і блокування пишуться в `auth_events`. Записи про ліміт пишуться не частіше ніж раз на хвилину на IP. Токенів і хешів журнал не зберігає. Успішний вхід з нового пристрою (немає входу з тієї ж мережі /24 (/48) і того ж браузера за 30 днів) надсилає власнику Telegram-повідомлення. Щодня о 03:41 видаляються події старші за 180 днів (`AUTH_EVENTS_RETENTION_DAYS`) і сесії, мертві понад 30 днів.
- `BR-CORE-56` Production-збірка дашборду без способу входу падає, якщо не задано `VITE_ALLOW_DEV_AUTH=true`. Клієнт ніколи не створює dev-користувача сам: dev-ідентичність приходить лише з бекенду.
- `BR-CORE-57` У production nginx віддає `/app` і `/app/*` лише після `GET /auth/check` = 204. При 401 — 302 на `/login?reason=…&next=<адреса>`. При 5xx — сторінка 503 «ai0 is temporarily unavailable», а не вихід. HTML `/app` має `Cache-Control: no-store`. `/`, `/login`, `/report/*`, `/assets/*` і API-префікси не перевіряються.

**Бізнес-правила й обмеження.**
- Токен ≤ 512 символів; вікно Telegram-payload — 24 год.
- Без `JWT_SECRET` production не стартує; поза production використовується dev-секрет.
- Ротація `JWT_SECRET` розлогінює всіх (`session_expired`).
- Старі cookie без `sid` дають `session_legacy`: потрібен один повторний вхід.

**Стани.** Банер причини; помилка під формою; кнопка заблокована на час запиту і на час блокування.

**Фонові процеси.** Крон `auth-purge` (щодня 03:41). Ліміт спроб — у Redis.

**Звʼязки.** Telegram Login Widget (домен і BotFather `/setdomain`), `TELEGRAM_BOT_TOKEN`, `TRACKING_TOKEN`, `JWT_SECRET`, `TRACKING_ALLOWED_TG_USER_IDS`, `AUTH_*_TTL_*`. Сповіщення надсилає `TelegramNotifier`.

**Спостереження «як фактично зараз».**
- На dev-stage `NODE_ENV=dev-stage`, тобто не `production`. Тому cookie там без `secure`, а локальний обхід формально можливий, якщо хтось задасть `ALLOW_NO_AUTH=true` і не задасть `TRACKING_TOKEN`.
- Невідомий `reason` (наприклад `no_credentials` від nginx) банера не показує — це очікувано.
- Ліміт у памʼяті без Redis скидається при рестарті.

**Відкриті питання до власника.** Чи потрібна 2FA (TOTP) для входу токеном (spec 028 відклав)?

---

### 3.4 Огляд — `/app`

**Бізнес-мета.** Одним екраном побачити «пульс» мережі: аудиторію, роботу агентів, витрати на AI, здоровʼя ресурсів, найближчі публікації. Файли: `routes/app.index.tsx`, `components/overview/AgentsCard.tsx`, `components/overview/AiSpendCard.tsx`, `components/agents/NetworkHealth.tsx`.

**Хто користується / доступ.** Тільки після входу; типова сторінка після логіну.

**Що показує** (заголовок «Overview», підзаголовок «Telegram + Meta · audience, publishing, status»):
1. **Плитки метрик (5):**
   - «Subscribers (Telegram)» — сума `subsCount` з `GET /tracking/channels?filter=mine&pageSize=200`;
   - «Followers (Meta)» — сума `followers` з `GET /api/meta-accounts`;
   - «Meta Δ 24h» — сума `followers_delta_24h`;
   - «Upcoming slots (24 h)» — кількість з `GET /api/schedule/upcoming?hours=24&limit=8`; при ≥8 показується «8+»;
   - «Errors» — legacy-стратегії з `last_run.status = 'error'`, з підписом «needs attention» / «all clear».
2. **Картка «Agents»** (`GET /api/overview/agents`, кожні 60 с):
   - кореневі агенти за режимами Live / Approve / Shadow / Off і на паузі;
   - «Runs» (сьогодні / 7 днів), «Success 7d», «Posts today», «Posts 7d» (опубліковано / shadow);
   - «Awaiting approval» з посиланням на апрув;
   - «Directives» (відкриті, «await you», застосовані та спрацювали за 30 днів).
3. **Картка «AI spend»** (`GET /api/spend/summary?range=7d`, кожні 60 с; журнал `llm_usage`):
   - плитки Today / 7 days / 30 days (USD, Δ до попереднього періоду, токени);
   - смуги лімітів («$x / $cap» або «no daily cap»);
   - при блокуванні — callout «… is blocking AI calls until Kyiv midnight or until the cap is raised.» з посиланням «Raise a cap»;
   - «Top agents · 7 days», «Top features · 7 days», вартість shadow-прогонів.
4. **Картка «Network health»** (`GET /api/kpi/digest`, кожні 5 хв, без повторів при помилці):
   - «updated <час>»;
   - посилання «Agents spent $X.XX today · see AI spend» (витрати `editor.*` за київську добу з `llm_usage`);
   - «N anomalies» / «no anomalies»;
   - «N directives await you» / «N open directives» → `/app/agents/manager?tab=directives`;
   - плитки ресурсів з бейджем здоровʼя, `@agent` і 6 KPI (views/post, engagement, posts, follower growth, transitions, revenue): значення за 7 днів проти 28-денної бази, позначки «stale» / аномалія;
   - таблиця «Answers to @manager · 30 days» (поради виконані / відхилені, оскаржені, автозастосовані директиви);
   - на ≤600 px показуються лише ресурси з аномаліями і кнопка «N healthy resources».
5. **«Upcoming slots»** («series and pins · next 24 h»): найближчі екземпляри серій і піни всіх агентів з Telegram-якорем (режим не `off`) зі статусом слота, що їх реалізує («not planned», якщо слота ще немає). Рядок веде на вкладку Schedule агента.
6. **«Legacy strategy runs»:** до 6 стратегій з останнім запуском (статус, помилка, час).
7. **«Meta accounts»:** платформа, `@username`, підписники, дельта 24 год. Клік → `/app/connections/meta/$accountId`. Кнопка «Refresh» → `POST /api/meta-accounts/refresh-stats`.

**Дії користувача.** Єдина дія зі змінами — «Refresh» у картці Meta: запит до Meta Graph для всіх активних акаунтів і запис знімків. Решта — перегляд і переходи.

**Бізнес-вимоги (as-is).**
- `BR-CORE-27` Сторінка вантажить незалежно кожне джерело: стратегії (`/api/strategies`, кожні 30 с), мої Telegram-канали (до 200), Meta-акаунти, найближчі слоти, огляд агентів, зведення витрат і KPI-дайджест. Кожен блок має власний стан завантаження.
- `BR-CORE-28` Плитка «Subscribers (Telegram)» сумує `subsCount` не більше ніж 200 «моїх» каналів; відсутні значення рахуються як 0.
- `BR-CORE-29` Плитка «Errors» рахує legacy-стратегії, чий останній запуск завершився `error`, без обмеження за часом; стратегії без запусків не враховуються.
- `BR-CORE-30` «Upcoming slots» показує екземпляри серій і піни на найближчі 24 год (максимум 8, за часом). «Legacy strategy runs» показує максимум 6 найсвіжіших запусків стратегій за `started_at`.
- `BR-CORE-31` Картка «Network health» оновлюється кожні 5 хвилин; кожен запит `GET /api/kpi/digest` будує дайджест із БД заново.
- `BR-CORE-32` KPI рахує код, а не LLM. «Поточне» — останні 7 повних днів, «база» — попередні 28 днів; доба для кожного ресурсу береться в його часовому поясі. Аномалія: (|z| ≥ 2 і |Δ| ≥ 10 %) або падіння ≥ 25 %. Середні метрики з даними менше ніж за 2 дні позначаються «stale» і аномаліями не вважаються.
- `BR-CORE-33` Ресурси в дайджесті — усі підключені: Telegram-канали (`is_mine` або з `editor_channels`), активні `meta_accounts`, `tiktok_accounts` і `youtube_accounts` (якщо таблиця існує).
- `BR-CORE-34` «Network health» показує лише суму витрат агентів (`llm_usage`, `feature LIKE 'editor.%'`) за київську добу. Лімітів там немає: шкали лімітів показує картка «AI spend». Ліміт агентів береться з рядка `llm_budgets` (`editor.`), а без нього — з `EDITOR_DAILY_BUDGET_USD` (за замовчуванням $2).
- `BR-CORE-35` Кнопка «Refresh» у блоці «Meta accounts» запускає ручне оновлення підписників та інсайтів усіх активних Meta-акаунтів; показується, лише коли акаунти є.
- `BR-CORE-36` Без даних сторінка показує порожні стани з підказками, а не помилки:
  - «No agents yet»;
  - «No AI calls recorded yet»;
  - «No series or pins in the next 24 hours»;
  - «No runs yet»;
  - «No Meta accounts yet»;
  - «No resources in the digest yet — connect a channel and give it an orchestrator.»
- `BR-CORE-58` Картка «Agents» показує кореневих агентів за режимами (`off`/`shadow`/`approve`/`live`) і на паузі, прогони сьогодні та за 7 днів з часткою успіху, пости агентів (опубліковано / shadow) і пости на апруві (слоти + платформні пости зі статусом `awaiting_approval`). Кожне число веде на свою сторінку.
- `BR-CORE-59` Картка «AI spend» рахує всі виклики LLM з `llm_usage` за сьогодні, 7 і 30 днів (київські доби) з порівнянням з попереднім періодом. Вона показує ліміти й те, які з них зараз блокують виклики.

**Бізнес-правила й обмеження.**
- Час у списках — відносний.
- Межі діб для KPI ресурсів — у часовому поясі ресурсу; для витрат і лімітів — `Europe/Kyiv`.
- «Meta Δ 24h» — сума дельт усіх акаунтів.
- У лічильнику директив — до 20 відкритих, без shadow; «await you» рахує `awaiting_owner` і `contested`.

**Стани.** Під час завантаження — «—» у плитках, «Loading upcoming slots…», «Loading recent runs…», «Loading Meta accounts…», сірий скелетон у «Network health». Помилка дайджесту — callout; помилка слотів — «Upcoming slots unavailable». Помилки запитів стратегій, каналів і Meta явно не показуються.

**Фонові процеси.** Дані готують трекінг Telegram, Meta-колектор (щогодини), агенти (слоти, прогони), журнал витрат. Сама сторінка нічого не запускає, окрім ручного «Refresh».

**Звʼязки.** `/app/agents`, `/app/agents/inbox?tab=approvals`, `/app/agents/manager?tab=directives`, `/app/agents/$handle?tab=schedule`, `/app/spend`, `/app/connections/meta/$accountId`, `/app/editor`, `/app/scheduled`.

**Спостереження «як фактично зараз».**
- «Subscribers (Telegram)» береться з пагінацією 200: якщо каналів більше, сума тихо неповна.
- «Followers (Meta)» сумує всі акаунти зі списку, включно з неактивними, а дайджест рахує лише активні.
- Плитка «Errors» і картка «Legacy strategy runs» стосуються лише legacy-стратегій. Помилки агентів видно на бейджі Editor і в картці «Agents».
- Дайджест будується на кожен запит без кешу (MANAGER використовує той самий розрахунок).
- Помилки запитів стратегій, каналів і Meta користувачу не показуються.

**Відкриті питання до власника.** Чи потрібна плитка підписників Instagram/TikTok/YouTube окремо від «Meta»? Чи прибрати «Errors» і «Legacy strategy runs» після видалення стратегій (spec 023 T7 фаза B)?

---

### 3.5 Налаштування — `/app/settings`

**Бізнес-мета.** Змінювати кілька параметрів рівня env без редагування `.env`, бачити, які AI-ключі задано, керувати сесіями входу й меню. Файли: `routes/app.settings.tsx`, `components/settings/SecurityTab.tsx`, `components/settings/NavigationTab.tsx`, бекенд `apps/automation/src/settings/*`, `settings/nav/*`.

**Хто користується / доступ.** Тільки після входу; `@Controller('settings') @UseGuards(TrackingAuthGuard)`.

**Що показує.** Заголовок «Settings», підзаголовок «Values from .env · changes are saved in the DB and override .env». Вкладки (`SegmentedTabs`): Telegram, AI, Meta, Security, Navigation. Вкладка зберігається в `?tab=` (за замовчуванням `telegram`).

- **Telegram → блок «Tracking»** (6 рядків; позначка `overridden`, якщо ключ є в `app_settings`):

| Параметр (як у UI) | Контрол | Діапазон / формат | Підпис у UI |
|---|---|---|---|
| `TRACKING_ENABLED` | перемикач | true/false (за замовч. `false`) | жовтий callout «TRACKING_ENABLED ≠ true — subscriber statistics are not being collected» |
| `TELEGRAM_OWNER_ID` | текстове поле | лише цифри або порожньо | «admin notifications recipient» |
| `TELEGRAM_TRACKING_SHARE_SESSION` | перемикач | true/false | «applies after restart» |
| `STATS_POST_AGE_DAYS` | число, «days» | 1–365 (за замовч. 30) | — |
| `POSTING_COOLDOWN_MIN` | число, «min» | 1–1440 (за замовч. 20) | — |
| `FETCH_TIMEOUT` | число, «ms» | 1000–120000 (за замовч. 15000) | «pipeline only · after restart» |

- **AI:** картка «AI keys», 4 рядки (`ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`, `GROK_API_KEY`) з бейджем «set» / «not set». Лише перегляд.
- **Meta:** заглушка «Meta — coming soon».
- **Security** (spec 028):
  - Картка «Sessions» (кожні 60 с): пристрій, «This device», метод, «IP · signed in … · last seen … · expires …». Кнопки «Revoke» (для поточної — «Sign out this device»), «Sign out other sessions», «Sign out everywhere». Порожньо — «No active sessions».
  - Картка «Recent sign-in activity»: When / Event / Method / Detail / IP / Device.
- **Navigation** (spec 027) — конструктор меню:
  - перетягування або ↑/↓ (Alt+↑/↓);
  - перейменування, приховування й видалення власних груп, «Add group»;
  - для пункту: підпис, іконка, закріплення, лічильник on/off, приховування;
  - «Add a link» на будь-яку сторінку `/app` з фільтрами («Add current page»);
  - список прихованих з «Restore»;
  - «Preview»;
  - «Save», «Discard», «Reset to default».
  Нічого не надсилається до «Save». Перед виходом із незбереженими змінами сторінка питає підтвердження.

**Дії користувача.**
- **Telegram.** Кожна зміна має окреме підтвердження: діалог «Confirm — Are you sure you want to change <KEY>?» зі смужкою «старе → нове» і кнопкою «Save» → `PATCH /settings` з одним полем. Пакетного збереження немає.
- **Security.** `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-all`. Кожна дія потребує підтвердження («Sign out» / «Sign out everywhere»). Відкликання поточної сесії відправляє на `/login`.
- **Navigation.** `PUT /api/nav/config {config, baseRevision}`; при 409 — «Changed in another tab…» (чернетка зберігається). `DELETE /api/nav/config` скидає меню до типового.

**Бекенд.**
- `SettingsService.get()` → `{telegram:{…6 полів}, ai:{anthropic, perplexity, openai, grok}, overrides:[…]}`.
- Ефективне значення: рядок `app_settings` → `process.env` → вбудоване значення за замовчуванням. Кеш у памʼяті процесу оновлюється при збереженні.
- DTO `UpdateSettingsDto` з `forbidNonWhitelisted`: `trackingEnabled`, `telegramOwnerId` (`^(\d+)?$`), `trackingShareSession`, `statsPostAgeDays` 1–365, `postingCooldownMin` 1–1440, `fetchTimeoutMs` 1000–120000.
- **Без рестарту** діють: `trackingEnabled` (`TrackingScheduler`), `postingCooldownMin` (`PostingThrottleService`), `statsPostAgeDays` (`StatsCollectorService`), `telegramOwnerId` (`TelegramNotifierService`), кулдауни Meta (`CrossPostService`). `trackingShareSession` діє після рестарту.

**Бізнес-вимоги (as-is).**
- `BR-CORE-37` Сторінка має 5 вкладок: Telegram, AI, Meta, Security, Navigation. Активна вкладка зберігається в URL (`?tab=`); невідоме значення замінюється на `telegram`.
- `BR-CORE-38` На вкладці Telegram редагуються лише 6 параметрів блоку «Tracking». Кожна зміна зберігається окремим `PATCH /settings` після підтвердження в діалозі зі старим і новим значенням.
- `BR-CORE-39` Збережені значення записуються в `app_settings` і мають пріоритет над `.env`. Позначка «overridden» показується для ключів, що є в таблиці.
- `BR-CORE-40` Діапазони перевіряються і на клієнті, і на сервері: `STATS_POST_AGE_DAYS` 1–365, `POSTING_COOLDOWN_MIN` 1–1440, `FETCH_TIMEOUT` 1000–120000 мс; `TELEGRAM_OWNER_ID` — лише цифри.
- `BR-CORE-41` Зміни `TRACKING_ENABLED`, `POSTING_COOLDOWN_MIN`, `STATS_POST_AGE_DAYS`, `TELEGRAM_OWNER_ID` діють без рестарту; `TELEGRAM_TRACKING_SHARE_SESSION` — після рестарту.
- `BR-CORE-42` Вкладка AI показує лише, чи задано 4 ключі (set / not set). Значення на клієнт не передаються, змінити їх зі сторінки не можна.
- `BR-CORE-43` Вкладка Meta не має функціоналу — лише заглушка «coming soon».
- `BR-CORE-44` Вимкнений `TRACKING_ENABLED` зупиняє постановку задач опитування каналів (трекінг підписників); сторінка попереджає про це жовтим callout.
- `BR-CORE-45` Помилку збереження показує callout «Failed to save: …». Мутація не має власного `onError`/`silentError`, тому додатково спрацьовує глобальний тост — повідомлення дублюється.
- `BR-CORE-60` Вкладка Security показує активні сесії дашборду з методом, пристроєм, IP і термінами, а також останні 50 подій входу. Звідти можна відкликати одну сесію, усі інші або всі, включно з поточною.
- `BR-CORE-61` Вкладка Navigation змінює меню лише після «Save», з перевіркою ревізії. «Reset to default» видаляє групи, перейменування, закріплення, приховування й власні посилання; сторінки при цьому працюють далі. Меню, збережене новішою версією схеми, редагувати не можна.
- `BR-CORE-62` Ключі `app_settings` з префіксами `ui.*` (меню), `cap.*` (прапорці можливостей), `landing.*` (лендинг) і `ai.*` (моделі) не є перевизначеннями env. Сторінка Settings їх не показує й не змінює.

**Бізнес-правила й обмеження.**
- Кеш перевизначень живе в памʼяті одного процесу.
- Кулдауни Meta (`INSTAGRAM_COOLDOWN_MIN` 30, `FACEBOOK_COOLDOWN_MIN` 15, `THREADS_COOLDOWN_MIN` 10 хв) читаються за тією ж схемою, але в UI не редагуються.

**Стани.** «Loading…» на час запиту; помилка запиту — червоний текст; Security — порожні стани «No active sessions» / «No events yet».

**Фонові процеси.** Власних немає. Значення впливають на крон трекінгу, ліміт частоти публікацій і колектор статистики.

**Звʼязки.** Таблиця `app_settings`; споживачі — трекінг, `posting-throttle.service`, `telegram-notifier.service`, `stats-collector.service`, `cross-post.service`; `auth_sessions` / `auth_events`; меню (3.2).

**Спостереження «як фактично зараз».**
- `FETCH_TIMEOUT` з UI **ні на що не впливає**. `SettingsService.fetchTimeoutMs()` ніхто не викликає. Pipeline (`apps/pipeline/src/lib/fetch.js`) і Meta-клієнти (`meta-graph.client.ts`, `meta-graph.util.ts`) читають env напряму.
- `TELEGRAM_OWNER_ID` з UI впливає лише на `TelegramNotifierService`. `AdminBotService` читає env один раз при старті, тож два «власники» можуть розійтися.
- Очищення поля `TELEGRAM_OWNER_ID` зберігає порожній рядок як перевизначення. Тому сповіщення вимикаються, а не повертаються до значення з env, хоча коментар у DTO обіцяє інше.
- Вкладка AI не показує `OPENROUTER_API_KEY`, хоча саме він потрібен усім агентам. Посилання на `/app/models` і `/app/spend` на сторінці немає.
- Підпис «Values from .env» вводить в оману: сторінка показує вже обчислене значення (DB ?? env ?? default).
- Вкладка Meta — заглушка, а кулдауни Meta існують у бекенді.

**Відкриті питання до власника.** Прибрати `FETCH_TIMEOUT` зі Settings чи підʼєднати його до споживачів? Додати у вкладку AI `OPENROUTER_API_KEY`? Чи потрібна вкладка Meta (кулдауни)?

---

### 3.6 Моделі — `/app/models` (spec 035)

**Бізнес-мета.** Обрати, на якій LLM працює кожен агент, і задати модель за замовчуванням. Файли: `routes/app.models.tsx`, `components/models/ModelSelect.tsx`, `api/models.ts`; бекенд `apps/automation/src/editor/models/*`, `editor/llm/model-registry.ts`, `editor/llm/model-defaults.ts`.

**Хто користується / доступ.** Тільки після входу.

**Що показує.** «Models — Choose the LLM each agent runs on. Agents without their own model use the default.»
- **Картка «Default model»:** вибір моделі з пошуком, ціна in/out за 1M токенів, контекст, бейдж «Custom» / «Built-in», кнопка «Use the built-in default».
- **«Agents»:** масовий вибір + «Apply to all agents», «Reset all to default». Таблиця Agent · Role · Model · Source (`Agent` / `Channel` / `Env` / `Default`) · In / 1M · Out / 1M · Effort · дії (редагування моделі й reasoning effort, скидання).
- **«Channel overrides (legacy)»** — лише якщо в картках каналів є старі перевизначення.
- **Callouts:** про `EDITOR_MODEL_*`, що задані на сервері; «OpenRouter list unavailable», якщо каталог не завантажився.

**Дії користувача.** Кожна зміна потребує підтвердження. Ендпоінти:
- `PUT /api/models/default {model|null}`;
- `POST /api/models/bulk {apply_all|reset_all}`;
- `POST /api/models/channels/clear`;
- `PATCH /api/agents/:handle {model, reasoning_effort}`.

**Бізнес-вимоги (as-is).**
- `BR-CORE-63` Модель агента обирається в такому порядку:
  1. власна модель агента (рольові агенти успадковують модель оркестратора);
  2. legacy-перевизначення в картці каналу;
  3. env `EDITOR_MODEL_<ROLE>`;
  4. глобальна модель `app_settings` `ai.default_model`;
  5. вбудована `z-ai/glm-5.3-flash` для всіх ролей.
- `BR-CORE-64` Каталог моделей (`GET /api/models`) береться з публічного списку OpenRouter, лише моделі з підтримкою tools. Кеш у процесі — 24 год; після збою — пауза 5 хв. Без мережі віддається останній вдалий список або запасний список з `llm_prices`. Нову модель можна обрати, лише якщо вона є в каталозі або вже використовується; інакше — 400 `unknown_model`.
- `BR-CORE-65` Якщо обраної моделі немає в `llm_prices`, її ціна з каталогу додається туди автоматично, щоб витрати рахувались точно. «Reset all to default» скидає моделі всіх агентів, але не їхній reasoning effort.

**Спостереження.** Env `EDITOR_MODEL_<ROLE>` на сервері важливіший за модель за замовчуванням зі сторінки; сторінка лише показує, які ключі задано.

---

### 3.7 Витрати на AI — `/app/spend` (spec 029)

**Бізнес-мета.** Бачити токени й гроші, витрачені на всі виклики LLM, і керувати лімітами. Файли: `routes/app.spend.tsx`, `api/spend.ts`; бекенд `apps/automation/src/spend/*`, `common/ai/usage/*`; міграція `056_llm_usage.sql`.

**Що показує.** «AI spend — Tokens and USD across every LLM call: agents, strategies, DM triage, ROI, dedup, routing». Вкладки в `?tab=`:
- **Report:** період Today / 7 days / 30 days / Month to date / Custom, фільтри, графік «Daily spend», «Breakdown» за днем / агентом / роллю / ресурсом / провайдером / моделлю / функцією / прогоном, експорт CSV;
- **Prices:** «Price table», «Add price», «Reprice estimates»;
- **Budgets:** «Caps» (Total / Feature prefix / Provider / Resource) і «Per-agent caps». Коли щось блокує, вкладка називається «Budgets · N blocking».

**Бізнес-вимоги (as-is).**
- `BR-CORE-66` Кожен виклик LLM (OpenRouter, Anthropic, OpenAI, Perplexity, xAI, Claude Agent SDK) і кожен платний інструмент агента пишуть рядок у `llm_usage`: провайдер, модель, функція, агент, ресурс, токени, ціна, статус. Текст промптів і відповідей не зберігається.
- `BR-CORE-67` Ліміти в `llm_budgets` за замовчуванням блокують виклики. Початкові значення беруться з env: `AI_DAILY_BUDGET_USD` $3 (усі виклики), `EDITOR_DAILY_BUDGET_USD` $2 (агенти), `EDITOR_CHANNEL_DAILY_BUDGET_USD` $0.30 (ресурс), плюс денний ліміт кожного агента. Після перевищення виклик відхиляється до київської півночі або до підняття ліміту. Власник змінює ліміти на вкладці Budgets без рестарту; рядок можна зробити лише сповіщувальним (`enforce=false`).

---

### 3.8 Дані — `/app/data`, `/app/data/$key` (spec 032)

**Бізнес-мета.** Датасети, з яких агенти беруть контент (рецепти, цитати, факти, промпти…), з імпортом без міграцій. Файли: `routes/app.data.tsx`, `routes/app.data_.$key.tsx`, `api/data.ts`; бекенд `apps/automation/src/data/*`; міграція `058_data_store.sql`.

**Що показує.** «Data — Datasets the agents read from: what each one holds, its fields, rows and imports».
- Таблиця Dataset / Entity / Rows / Unposted / Last import / Status і картка «Recent imports».
- Кнопки «Refresh stats» і «Import file» (майстер імпорту CSV, JSON, JSONL).
- Сторінка датасету має вкладки Items, Schema, Imports.

**Бізнес-вимоги (as-is).**
- `BR-CORE-68` Усі датасети живуть в одній таблиці `data_items` зі схемами в `data_schemas`. Колишні контентні таблиці (`recipes`, `quotes`, `facts`, `prompts`, `pdr_questions`, `birthdays`, `assets` та інші) — це views над `data_items`; оригінали перейменовано в `legacy_*`. Імпорт іде через пробний прогін (dry run), commit і можливість скасування (undo) й записується в `data_imports`. «Unposted» рахується за журналом `content_ledger`.

**Спостереження.** Окремого BRD для `/app/data`, `/app/spend` і `/app/models` ще немає; тут описано лише головне.

---

## 4. Наскрізні правила розділу

**Автентифікація й доступ.**
- Клас доступу один: «оператор»; ролей немає.
- Способи входу: токен доступу (форма, `/login?token=` або Bearer для скриптів), Telegram-віджет зі списком дозволених ID, локальний обхід `ALLOW_NO_AUTH=true` (лише не в production і без `TRACKING_TOKEN`).
- Сесія живе на сервері (`auth_sessions`). Cookie `tracking_jwt` несе JWT на 60 хв з ковзним продовженням; сесія діє до 7 днів простою і максимум 30 днів. Її можна відкликати.
- Перевірок три: nginx (`/auth/check`) для HTML `/app`, router guard (`/auth/me`) для переходів у клієнті, `TrackingAuthGuard` для API.
- Публічні: `/`, `/white-label`, `/login`, `/report/$token` і ендпоінти `/auth` (крім sessions/events), `api/landing/*` (крім admin), `api/ads/report/:token`, `api/payments/liqpay/callback`, `/r/:code`, `GET /health`.

**Базовий шлях API та проксі.**
- `API_BASE` за замовчуванням порожній; `AUTH_BASE` — `/auth`.
- Dev (`vite.config.ts`, порт 5173) і prod (`nginx.conf`) проксують на automation без зміни шляху префікси `/api`, `/auth`, `/tracking`, `/activity`, `/scheduled-posts`, `/settings`, `/stats`, `/r` (і `/health` лише в nginx). Новий «голий» контролер треба додати в обидва місця.
- CORS дозволяє лише `http://localhost:5173` з credentials.
- Swagger (`/api/docs`) — коли `NODE_ENV` ≠ `production` або `SWAGGER_ENABLED=true`.

**Обробка помилок і тости.**
- `api()` кидає `ApiError(status, body)`; при 401 скидає сесію і переходить на `/login` (single-flight).
- `QueryClient`: `staleTime` 30 с, один повтор (на 401 — без повтору).
- Глобальний `MutationCache.onError` показує тост для мутацій без власного `onError` і без `meta.silentError`, окрім 401. Успішна мутація оновлює бейджі меню.
- `Toaster`: максимум 4 одночасно; помилка висить 8 с, успіх 4 с.
- Помилки читань тостами не показуються: кожна сторінка показує свій інлайн-стан.
- Деструктивні дії підтверджуються через `ConfirmDialog` («Confirm», «Are you sure you want to …?»).

**Тема й адаптивність.**
- Одна темна тема (акцент зелений, `--color-accent`); перемикача світлої теми немає.
- Брейкпоінти: 860 px (шторка меню), 600 px (картка «Network health»), 640/600/480 px на лендингу.
- Анімації поважають `prefers-reduced-motion`.
- Мова UI — лише англійська (рішення власника 2026-10-06); контент і промпти агентів — українською.

## 5. Глосарій розділу

| Термін | Значення |
|---|---|
| `TRACKING_TOKEN` | Спільний адмін-секрет: вхід токеном і `Bearer` для API |
| `tracking_jwt` | Назва session-cookie (JWT 60 хв з продовженням) |
| `auth_sessions` / `auth_events` | Серверні сесії дашборду / журнал входів |
| `app_settings` | Таблиця `key/value/updated_at`: перевизначення env і службові ключі `ui.*`, `cap.*`, `landing.*`, `ai.*` |
| `overridden` | Бейдж у Settings: ключ є в `app_settings` |
| `ui.nav` | Збережене меню (конструктор навігації) |
| KPI-дайджест | Розрахунок 6 метрик по ресурсах (7 днів проти 28-денної бази) + витрати агентів + директиви |
| Аномалія | (|z| ≥ 2 і |Δ| ≥ 10 %) або падіння ≥ 25 % |
| `stale` | Менше 2 днів свіжих даних у вікні — метрика не оцінюється |
| `llm_usage` / `llm_budgets` | Журнал викликів LLM з ціною / ліміти витрат |
| Pulse | Живі цифри автономності агентів для лендингу (`/api/landing/pulse`) |
| Ресурс (resource_ref) | `telegram:<channel_key>`, `instagram:<uuid>`, `facebook:<uuid>`, `threads:<uuid>`, `tiktok:<uuid>`, `youtube:<uuid>` |

## 6. Джерела в коді

- **Дашборд, маршрути:** `apps/dashboard/src/routes/index.tsx`, `white-label.tsx`, `login.tsx`, `__root.tsx`, `app.tsx`, `app.index.tsx`, `app.settings.tsx`, `app.models.tsx`, `app.spend.tsx`, `app.data.tsx`, `app.data_.$key.tsx`; редиректи `app.calendar.tsx`, `app.agent.tsx`, `app.bots.tsx`, `app.telegraph.tsx`, `app.connections_.meta.tsx`, `app.connections_.tiktok.tsx`.
- **Оболонка й меню:** `apps/dashboard/src/components/AppShell.tsx`, `AppSidebar.tsx`, `CommandPalette.tsx`, `NotFound.tsx`, `nav/*` (`registry.ts`, `badges.ts`, `store.ts`, `resolve.ts`, `config.ts`, `palette.ts`), `components/settings/NavigationTab.tsx`, `ui/Toast.tsx`, `ui/ConfirmDialog.tsx`, `router.ts`.
- **Лендинг:** `apps/dashboard/src/components/landing/*`, `lib/landing-view.ts`, `lib/lead-form.ts`, `lib/white-label-copy.ts`, `lib/public-url.ts`, `api/landing.ts`, `api/ads.ts`, `index.html`.
- **Автентифікація (клієнт):** `apps/dashboard/src/auth/*`, `api/auth.ts`, `api/client.ts`, `lib/auth-mode.ts`, `lib/env.ts`, `components/settings/SecurityTab.tsx`.
- **Огляд:** `apps/dashboard/src/components/overview/AgentsCard.tsx`, `AiSpendCard.tsx`, `components/agents/NetworkHealth.tsx`, `api/manager.ts`, `api/spend.ts`, `api/upcoming.ts`, `api/tracking.ts`, `api/meta-accounts.ts`, `api/strategies.ts`.
- **Проксі/збірка:** `apps/dashboard/vite.config.ts`, `apps/dashboard/nginx.conf`, `apps/dashboard/Dockerfile`, `apps/dashboard/public/auth-unavailable.html`, `docker-compose.yml`, `.env.example`.
- **Бекенд, auth:** `apps/automation/src/auth/*` (`auth.controller.ts`, `auth.service.ts`, `session.service.ts`, `login-limiter.ts`, `auth-cookie.ts`, `auth-events.repository.ts`, `auth-sessions.repository.ts`), `tracking/api/tracking-auth.guard.ts`, `main.ts`; `database/migrations/055_auth_sessions.sql`.
- **Бекенд, settings і меню:** `apps/automation/src/settings/*`, `settings/nav/*`; `database/migrations/015_app_settings.sql`.
- **Бекенд, лендинг:** `apps/automation/src/config/api/landing.controller.ts`, `landing-admin.controller.ts`, `config/landing-*.ts`, `payments/ads-public.controller.ts`; `database/migrations/066_landing_ai_network.sql`.
- **Бекенд, огляд:** `apps/automation/src/editor/manager/kpi-digest.service.ts`, `kpi-math.ts`, `editor/agents/resource-catalog.ts`, `editor/schedule/upcoming.ts`, `spend/*`, `common/ai/usage/*`; `database/migrations/056_llm_usage.sql`.
- **Бекенд, моделі й дані:** `apps/automation/src/editor/models/*`, `editor/llm/model-registry.ts`, `editor/llm/model-defaults.ts`, `data/*`; `database/migrations/058_data_store.sql`.
