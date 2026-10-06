# BRD (as-is) — Доступ, публічна частина, огляд і налаштування

> Статус: чернетка, згенерована з коду 2026-10-05. Описує, як система ФАКТИЧНО працює зараз (гілка feat/editor-agent), а не як мала б.

## 1. Призначення розділу

Розділ описує «вхідну» частину продукту ai0: публічний лендінг для рекламодавців і випадкових відвідувачів, вхід оператора (власника мережі) в панель керування, оболонку панелі (бокове меню, шапка), стартову сторінку `/app` з оглядом стану мережі та сторінку `/app/settings` з кількома змінюваними параметрами сервісу. Код розділу — `CORE`.

Єдиний «справжній» користувач панелі — власник/оператор (один спільний секрет або список Telegram-ID); ролей, команд і окремих акаунтів у системі немає. Публічна частина розрахована на потенційних рекламодавців (вітрина каналів, медіакіт із цінами, кнопка «Contact us»).

## 2. Сторінки розділу

| Сторінка | Маршрут | Коротко |
|---|---|---|
| Публічний лендінг | `/` | Маркетингова сторінка (англ.): hero, вітрина каналів із живими цифрами, «How it works», блок реклами з медіакітом |
| Вхід | `/login` | Форма входу: токен (`token`), Telegram-віджет (`telegram`) або кнопка «Continue in dev mode» (`dev`) — режим визначається при збірці |
| Оболонка застосунку | `/app` (layout) | Гард авторизації + бокове меню (7 груп) + шапка («New post», «Log out») |
| Огляд | `/app` | Плитки метрик, картка «Network health», найближчі запуски, статус стратегій, акаунти Meta |
| Налаштування | `/app/settings` | 3 вкладки: Telegram (редагуються 6 параметрів), AI (read-only бейджі ключів), Meta (заглушка) |

## 3. Сторінки

### 3.1 Публічний лендінг — `/`

**Бізнес-мета.** Показати зовнішньому світові, що ai0 — «мережа мультиплатформного паблішингу», продемонструвати живі канали та продати рекламу (медіакіт + контакт). Файл: `apps/dashboard/src/routes/index.tsx`.

**Хто користується / доступ.** Публічна, без авторизації. Рендериться під `AuthProvider` у `__root.tsx`, але гарда немає. Мова інтерфейсу — англійська; `<title>` «ai0 — AI-powered content factory», OG-метадані вказують на `https://dev.ai0.global/` (захардкоджено в `apps/dashboard/index.html`).

**Що показує.**
- Верхня панель: логотип «ai0», посилання `Advertise` (якір `#advertise`) і `Sign in →` (звичайний `<a href="/app">`).
- Hero: бейдж «One network · five platforms», заголовок «Content, everywhere it should be.», підзаголовок про створення, планування і публікацію в Telegram, Instagram, Facebook, Threads і TikTok «automatically». Кнопки «Explore the network ↓» (`#resources`) та «Advertise with us» (`#advertise`). Анімована SVG-схема «ai0 pipeline → 5 платформ» (на екранах до 640px — просто ряд чипів).
- Живі лічильники (count-up) «followers reached», «channels & profiles», «platforms» — показуються лише коли API повернув ≥1 ресурс і немає помилки. Дані: `GET /api/landing/resources` → `LandingResourcesService.listPublic()` → таблиці `tracked_channels` (тільки `is_mine = true AND landing_visible = true`), Meta-акаунти та TikTok-акаунти з прапорцем featured; сортування за `landing_order`.
- Секція «Channels & profiles we run» (`#resources`): сітка карток (платформа, аватар, назва, @handle, кількість підписників у форматі 12.3K/1.2M, посилання на профіль у нову вкладку). Скелетон під час завантаження, жовтий callout «Couldn’t load the showcase right now…» при помилці, порожній стан «No resources yet».
- «How it works»: 4 кроки — Create, Schedule, Publish, Track (статичний текст).
- «Advertise with us» (`#advertise`): бейдж «Self-serve — coming soon», опис, що кожне розміщення позначається #реклама і супроводжується звітом через 24 і 72 год; компонент `MediaKit` (`GET /api/landing/media-kit` → `AdPricesRepository.mediaKit()`: канали з активними цінами в `ad_prices`, останній `subscribers` зі `channel_stats_snapshots`, середні перегляди за 30 днів із `editor_v_post_performance`, ціни в ₴); кнопка «Contact us» — `mailto:` на особисту адресу власника з темою «Ad placement — ai0 network».
- Футер: © поточний рік, посилання «The network», «Advertise», «Sign in».

**Дії користувача.** Лише навігація: якорі, зовнішні посилання на профілі каналів (t.me, instagram.com, facebook.com, threads.net, tiktok.com), `mailto:`, перехід на `/app`. Жодних форм, жодних записів у БД.

**Бізнес-вимоги (as-is).**
- `BR-CORE-01` Сторінка `/` доступна без авторизації і не викликає жодного захищеного ендпоінта: використовуються лише публічні `GET /api/landing/resources` та `GET /api/landing/media-kit`.
- `BR-CORE-02` Вітрина показує лише Telegram-канали з `is_mine = true AND landing_visible = true`, а також Meta/TikTok-акаунти, позначені як featured; порядок — за `landing_order`.
- `BR-CORE-03` Для Telegram-карток аватар не показується (завжди іконка платформи), для TikTok кількість підписників не показується (завжди `null`).
- `BR-CORE-04` Блок лічильників під hero відображається тільки при успішній відповіді API з ≥1 ресурсом; «followers reached» — сума `followerCount` усіх ресурсів (TikTok додає 0), «platforms» — кількість унікальних платформ у відповіді.
- `BR-CORE-05` Медіакіт відображається лише коли є хоча б один канал з активною ціною в `ad_prices`; інакше компонент не рендериться взагалі (без порожнього стану).
- `BR-CORE-06` Кнопка «Contact us» відкриває поштовий клієнт з `mailto:` на особисту gmail-адресу власника; форми заявки чи оплати на лендінгу немає.
- `BR-CORE-07` Кнопки «Sign in →» і «Sign in» ведуть на `/app` (а не на `/login`); незалогінений користувач потрапляє на `/login` через клієнтський гард (див. 3.3).
- `BR-CORE-08` Усі тексти лендінгу — англійською й захардкоджені в TSX; мовного перемикача немає.

**Бізнес-правила й обмеження.** Публічний API віддає лише проєкцію `LandingResource` (platform, handle, displayName, avatarUrl, followerCount, url, order) без токенів. URL профілю будується з handle (`landingUrl`). Контролери `landing` і `ads-public` не мають `@UseGuards` (гарди в застосунку — на рівні контролера, глобального `APP_GUARD` немає).

**Стани.** Завантаження — 6 скелетон-карток; помилка — callout; порожньо — «No resources yet / Featured channels and profiles will appear here once they’re published.»; `prefers-reduced-motion` вимикає анімації.

**Фонові процеси.** Немає (цифри беруться з даних, які збирають трекінг і Meta-колектор).

**Звʼязки.** Керування видимістю ресурсів на лендінгу — сторінка `/app/landing` (`PATCH /api/landing/admin/:platform/:id`); ціни — `/app/ads`; публічний звіт рекламодавця — `/report/$token`.

**Спостереження «як фактично зараз».**
- Бейдж «Self-serve — coming soon» при тому, що в бекенді вже є модуль платежів (LiqPay-callback, замовлення реклами) — лендінг самообслуговування не пропонує, лише email.
- Hero стверджує «five platforms», хоча в каталозі ресурсів агентів уже є YouTube (на лендінгу його немає).
- OG-URL/зображення захардкоджені на `dev.ai0.global`; у `mailto:` — особиста пошта власника.
- Лендінг і вся панель — англійською, документація/агенти — українською.

**Відкриті питання до власника.** Чи лишати особистий email у публічному `mailto:`? Чи потрібен окремий `/login`-лінк у верхній панелі замість `/app`? Коли вмикати самообслуговування реклами?

---

### 3.2 Оболонка застосунку — `/app` (layout) та навігація

**Бізнес-мета.** Єдиний каркас для всіх сторінок `/app/*`: захист від незалогіненого доступу, навігація, швидка дія «New post». Файли: `routes/__root.tsx`, `routes/app.tsx`, `components/AppShell.tsx`, `components/AppSidebar.tsx`.

**Хто користується / доступ.** Тільки після логіну (клієнтський гард у `app.tsx`).

**Що показує.**
- `__root.tsx` — тонкий корінь: `AuthProvider` + `<Outlet/>`; `/` і `/login` (а також публічний `/report/$token`) рендеряться без гарда.
- `app.tsx` (`/app`): поки `AuthProvider` вантажить `/auth/me` — неоформлений текст «Loading…»; якщо `me` відсутній — `window.location.href = '/login'` (повне перезавантаження сторінки) і порожній рендер; інакше `AppShell`.
- `AppShell`: ліворуч бічне меню, зверху липка шапка, у `<main>` (max-width 1320px) — вкладена сторінка; усе обгорнуто в `ConfirmProvider` (глобальний діалог підтвердження). Брейкпоінт мобільного режиму — 860px (меню стає висувною шторкою з затемненням; кнопка «Open menu»).
- Шапка (справа): імʼя користувача `me.firstName · @username` (тільки на десктопі); кнопка `+ New post` (на мобільному — лише іконка) → `/app/compose`; кнопка `Log out` — лише коли `AUTH_MODE !== 'dev'`.
- Бічне меню (логотип «ai0» → `/app`; кнопка «Collapse/Expand» внизу на десктопі: ширина 234px ↔ 64px, стан у `localStorage` ключ `dashboard:sidebar-collapsed`). Групи та пункти — рівно як у `AppSidebar.tsx`:

Типове меню (spec 027 FR-003, schema v1; з T2 — з реєстру `nav/registry.ts`, власник може змінити його в Settings → Navigation):

| Група | Пункти (підпис → маршрут) |
|---|---|
| Home | Overview → `/app` (exact); Posts to approve → `/app/agents/inbox?tab=approvals` (бейдж очікування) |
| Agents | Agents → `/app/agents`; Chat → `/app/chat`; DM inbox → `/app/dm` |
| Publishing | Compose → `/app/compose`; Scheduled → `/app/scheduled`; Editor → `/app/editor`; Logs → `/app/logs`; Strategies → `/app/strategies`; My channels → `/app/channels?filter=mine` |
| Content | Data → `/app/data` |
| Analytics | Analytics → `/app/analytics`; Spend → `/app/spend`; Tracked → `/app/tracked` |
| Intelligence | Discovery → `/app/discovery`; Graph → `/app/graph`; Recommendations → `/app/recommendations` |
| Connections | Connections → `/app/connections` (exact); Groups → `/app/connections/groups` |
| Marketing | Landing → `/app/landing`; Ads → `/app/ads` |
| System | Settings → `/app/settings` |

**Дії користувача.** Навігація; згортання меню; «New post» → `/app/compose`; «Log out» → `POST /auth/logout`, потім у будь-якому разі `window.location.replace('/login')` (помилку запиту ігнорує).

**Бізнес-вимоги (as-is).**
- `BR-CORE-09` Усі маршрути `/app/*` рендеряться лише всередині `AppLayout`; без `me` користувач переспрямовується на `/login` повним перезавантаженням (`window.location.href`).
- `BR-CORE-10` Поки триває початкова перевірка сесії, `/app/*` показує текст «Loading…» без скелетону.
- `BR-CORE-11` Типове бічне меню містить 9 груп і 23 пункти (таблиця вище, spec 027 FR-003); пункт «Compose» дублює кнопку «New post».
- `BR-CORE-12` Пункт «My channels» завжди відкриває `/app/channels` з пошуковим параметром `filter=mine`; «Overview» і «Connections» підсвічуються тільки при точному збігу маршруту.
- `BR-CORE-13` Стан згорнутого меню зберігається в `localStorage` (`dashboard:sidebar-collapsed`); на екранах ≤860px меню завжди повної ширини (264px) як шторка, згортання недоступне.
- `BR-CORE-14` Кнопка «New post» у шапці присутня на всіх сторінках `/app/*` і веде на `/app/compose`.
- `BR-CORE-15` Кнопка «Log out» показується лише при `VITE_AUTH_MODE=token` або заданому `VITE_TG_BOT_USERNAME`; у режимі `dev` її немає.
- `BR-CORE-16` Імʼя користувача в шапці береться з відповіді `/auth/me`: для токен-входу це «Operator · @token», для Telegram — імʼя й username користувача Telegram.

**Бізнес-правила й обмеження.** Меню захардкоджене (немає прав на пункти, немає «бейджів» лічильників). Заголовок сторінки шапка не показує — його малює кожна сторінка через `PageHeader`.

**Стани.** Loading (див. вище); на мобільному — відкриття/закриття шторки; клік по затемненню закриває її.

**Фонові процеси.** Немає.

**Звʼязки.** Після spec 027 T1 (2026-10-06): `/app/bots` і `/app/telegraph` — лише редиректи на `/app/connections?section=telegram&tab=bots|telegraph`; `/app/calendar` — редирект на `/app/scheduled` (заглушку видалено); `/app/connections/$platform` видалено (тепер `/app/connections/instagram` показує сторінку «Page not found» усередині оболонки); `/app/agent` перейменовано на «DM inbox» `/app/dm`, старий шлях перенаправляє туди зі збереженням пошукових параметрів (`?cat=ad`). Будь-який невідомий шлях `/app/*` показує not-found сторінку з посиланням на Overview і підказкою «⌘K». Сторінки без пункту в типовому меню (досяжні з ⌘K та хлібних крихт): `/app/agents/inbox`, `/app/agents/$handle`, `/app/editor/*`, `/app/strategies/new`, `/app/strategies/$id`, `/app/channels/$id`, `/app/data/$key`, `/app/connections/meta/$accountId`.

**Спостереження «як фактично зараз».**
- Гард суто клієнтський: після `window.location.href` компонент повертає `null`, але реальний захист даних — гарди контролерів на бекенді (див. «Наскрізні правила»).
- Два пункти меню з близькими назвами: «Agents» (Publishing, `/app/agents` — іменовані агенти платформи) і «Agent» (Analytics, `/app/agent` з іконкою `bots` — інбокс/статус «агента», окрема сторінка); для оператора розрізнення неочевидне.
- Пункт «Logs» (Analytics) і «Scheduled» лежать у різних групах з логічно суміжними даними — це лише спостереження про групування, не помилка.
- «Loading…» без стилів/центрування, тоді як решта UI оформлена.

**Відкриті питання до власника.** Чи треба перейменувати «Agent» (Analytics), щоб не плутати з «Agents»? Чи потрібне посилання на `/app/calendar` або видалення заглушки?

---

### 3.3 Вхід — `/login` та бекенд-автентифікація

**Бізнес-мета.** Пустити в панель тільки власника. Файли: `routes/login.tsx`, `api/auth.ts`, `auth/auth-context.tsx`, `lib/env.ts`; бекенд `apps/automation/src/auth/*` та `tracking/api/tracking-auth.guard.ts`.

**Хто користується / доступ.** Публічна сторінка. Режим входу визначається при **збірці** фронтенду (`lib/env.ts`): якщо заданий `VITE_TG_BOT_USERNAME` — `telegram`; інакше якщо `VITE_AUTH_MODE=token` — `token`; інакше — `dev`. У `docker-compose.yml` обидві змінні передаються як build-args з порожнім значенням за замовчуванням.

**Що показує.** Картка із заголовком «Channel Tracker» (не «ai0») і залежно від режиму:
- `token`: текст «Enter your access token to continue.», поле типу password з плейсхолдером «Access token» (автофокус), кнопка «Sign in» (під час запиту — «Checking…»; неактивна при порожньому значенні), помилка «Invalid token» червоним, підказка, що токен звіряється з `TRACKING_TOKEN` на сервері й зберігається в сесійній cookie.
- `telegram`: «Sign in with Telegram to continue.» і Telegram Login Widget (скрипт `telegram.org/js/telegram-widget.js?22`, `data-request-access=write`).
- `dev`: «Dev mode — authorization disabled.», кнопка «Continue in dev mode», підказка про змінні `VITE_AUTH_MODE` / `VITE_TG_BOT_USERNAME`.

**Дії користувача.**
- Відправка токена → `POST /auth/token-login` `{token}` → при успіху: `AuthProvider.refresh()` → `GET /auth/me` → перехід на `/app`.
- «Authorization link»: у режимі `token` URL `/login?token=…` автоматично відправляє токен при відкритті (закладка для входу в один клік).
- Telegram-віджет → `POST /auth/telegram-login` (payload віджета) → `refresh()` → перехід на `/app/channels`; помилка показується через браузерний `alert('Login failed: …')`.
- «Continue in dev mode» → `refresh()` (ставить фіктивного користувача) → `/app`.
- Вихід: `POST /auth/logout`.

**Бекенд (`AuthController`, префікс `/auth`, без `TrackingAuthGuard`).**

| Ендпоінт | Поведінка |
|---|---|
| `POST /auth/token-login` | DTO: `token` — рядок 1–512 символів; порівняння з `TRACKING_TOKEN` через `safeEqual` (constant-time); якщо `TRACKING_TOKEN` порожній — 401 «Token auth not configured»; видає JWT з `{sub:0, username:'token', firstName:'Operator'}` |
| `POST /auth/telegram-login` | Перевіряє HMAC-підпис віджета ключем `sha256(TELEGRAM_BOT_TOKEN)`, вік `auth_date` ≤ 24 год, і що `id` входить у `TRACKING_ALLOWED_TG_USER_IDS` (порожній список = вхід заборонений, 403) |
| `GET /auth/me` | Читає cookie `tracking_jwt`, повертає `{tgUserId, firstName, username}` або `null` (HTTP 200 навіть без сесії) |
| `POST /auth/logout` | Очищає cookie з тими самими атрибутами, `{ok:true}` |

Cookie `tracking_jwt`: JWT (термін 30 днів), `httpOnly`, `sameSite=lax`, `secure` лише при `NODE_ENV=production`, `maxAge` 30 діб. Підпис — `JWT_SECRET`; у production без `JWT_SECRET` сервіс не стартує, поза production використовується відкритий dev-секрет.

**Rate limit.** `RateLimitGuard`: 10 запитів/хв на IP, спільний лічильник для обох логін-ендпоінтів, ковзне вікно, у памʼяті процесу (скидається при рестарті); перевищення → HTTP 429 «Too many login attempts — try again in a minute». IP береться з `req.ip` (`trust proxy` для loopback/linklocal/uniquelocal).

**Захист решти API (`TrackingAuthGuard`).** Застосовується до ~33 контролерів на рівні класу. Порядок перевірок: (1) заголовок `Authorization: Bearer <TRACKING_TOKEN>`; (2) cookie `tracking_jwt`; (3) локальний обхід лише коли `ALLOW_NO_AUTH=true`, `NODE_ENV != production`, `TRACKING_TOKEN` не заданий і жодних облікових даних не передано; інакше 401 «Invalid or missing credentials». Публічні контролери (без гарда): `auth`, `api/landing/resources`, `api/landing/prices`, `api/landing/media-kit`, `api/ads/report/:token`, `api/payments/liqpay/callback`, `GET /health`. `StatsController` (`/stats/*`) захищений окремим `ApiKeyGuard` (заголовок `X-API-Key`), дашборд його не викликає.

**Клієнтська обробка 401.** `api()` у `api/client.ts` при відповіді 401 робить `window.location.href = '/login'` (якщо вже не на `/login`) і кидає `ApiError(401)`; глобальний обробник мутацій у `main.tsx` для 401 тост не показує.

**Бізнес-вимоги (as-is).**
- `BR-CORE-17` Режим входу (`telegram` / `token` / `dev`) визначається на етапі збірки через `VITE_TG_BOT_USERNAME` та `VITE_AUTH_MODE`; зміна потребує перезбирання образу дашборду.
- `BR-CORE-18` У режимі `token` вхід можливий вставкою `TRACKING_TOKEN` у форму або відкриттям `/login?token=…`; успішний вхід веде на `/app`.
- `BR-CORE-19` Токен-вхід видає сесію «Operator» (`sub = 0`) на 30 днів у cookie `tracking_jwt` (`httpOnly`, `sameSite=lax`, `secure` лише в production).
- `BR-CORE-20` Telegram-вхід приймає лише користувачів зі списку `TRACKING_ALLOWED_TG_USER_IDS`; порожній список повністю блокує Telegram-вхід (fail-closed); payload старший за 24 год відхиляється.
- `BR-CORE-21` Обидва логін-ендпоінти разом обмежені 10 спробами на хвилину з одного IP; ліміт зберігається в памʼяті одного процесу.
- `BR-CORE-22` Усі контролери керування приймають або `Bearer TRACKING_TOKEN`, або cookie `tracking_jwt`; без них — 401.
- `BR-CORE-23` Будь-яка відповідь 401 на API-виклик дашборду миттєво переспрямовує браузер на `/login`.
- `BR-CORE-24` Вихід очищає cookie на сервері та завжди перенаправляє на `/login`, навіть якщо запит завершився помилкою.
- `BR-CORE-25` Сесія не відкликається на сервері: JWT дійсний до закінчення 30 днів, `logout` лише видаляє cookie у цьому браузері.
- `BR-CORE-26` Помилка токен-входу в UI завжди «Invalid token» — незалежно від причини (хибний токен, 429, мережа, `TRACKING_TOKEN` не налаштований).

**Бізнес-правила й обмеження.** Токен ≤ 512 символів; JWT 30 днів; вікно Telegram-payload 24 год; ліміт 10/хв/IP. Локальний обхід авторизації вимагає явного `ALLOW_NO_AUTH=true` і не працює в production.

**Стани.** Помилка токена — червоний рядок; кнопка заблокована під час запиту; Telegram — `alert`.

**Фонові процеси.** Немає (JWT stateless; лічильник rate-limit чиститься лениво раз на вікно).

**Звʼязки.** Telegram Login Widget (потрібні домен і BotFather `/setdomain`), `TELEGRAM_BOT_TOKEN`, `TRACKING_TOKEN`, `JWT_SECRET`, `TRACKING_ALLOWED_TG_USER_IDS`.

**Спостереження «як фактично зараз».**
- **Режим `dev` — типовий.** Якщо `VITE_AUTH_MODE` не задано при збірці (compose передає порожній рядок), дашборд вважає себе в dev-режимі: підставляє фіктивного користувача «Dev · @dev» без запиту до бекенду і приховує «Log out», але бекенд у production відхиляє запити без токена/cookie (`ALLOW_NO_AUTH` у production не діє). Результат — інтерфейс відкривається, а всі API-виклики дають 401 і відправляють на `/login`, де знову «Continue in dev mode» (цикл).
- `/login` не перенаправляє вже залогіненого користувача на `/app` — форма просто показується знову.
- У режимі `telegram` форма токена недоступна (Telegram має пріоритет), тож `TRACKING_TOKEN` лишається лише як Bearer для скриптів.
- Підказка в UI розкриває імʼя змінної середовища `TRACKING_TOKEN`; заголовок картки «Channel Tracker» не збігається з брендом «ai0».
- Telegram-логін ведуть на `/app/channels`, токен-логін — на `/app` (різна «домашня» сторінка).
- Є дубль-логіка: `GET /auth/me` не приймає Bearer — «токеном для скриптів» у UI не увійти.
- Rate-limit у памʼяті: після рестарту або при кількох інстансах лічильник скидається.

**Відкриті питання до власника.** Яким має бути єдиний режим входу в production (token чи telegram)? Чи потрібне відкликання сесій / коротший термін JWT? Чи прибрати цикл dev-режиму (фейл збірки без `VITE_AUTH_MODE`)?

---

### 3.4 Огляд — `/app`

**Бізнес-мета.** Одним екраном побачити «пульс» мережі: аудиторія Telegram і Meta, стан стратегій, найближчі публікації, здоров'я ресурсів, витрати на AI. Файл: `routes/app.index.tsx`, картка — `components/agents/NetworkHealth.tsx`.

**Хто користується / доступ.** Тільки після логіну; сторінка за замовчуванням для токен-входу.

**Що показує.**
1. **Плитки метрик** (`stat-grid`, 5 шт.):
   - «Subscribers (Telegram)» — сума `subsCount` моїх каналів: `GET /tracking/channels?filter=mine&pageSize=200` (таблиця `tracked_channels`, `is_mine`). Показує «—» при завантаженні.
   - «Followers (Meta)» — сума `followers` за `GET /api/meta-accounts` (`meta_accounts`).
   - «Meta Δ 24h» — сума `followers_delta_24h` (зі `meta_follower_history`), колір дельти зелений/червоний/нейтральний.
   - «Active strategies» — кількість стратегій з `enabled` із `GET /api/strategies` (оновлюється кожні 30 с).
   - «Errors» — кількість стратегій, у яких `last_run.status = 'error'`; підпис «needs attention» або «all clear».
2. **Картка «Network health»** (`GET /api/kpi/digest`, оновлення кожні 5 хв, без повторів при помилці):
   - заголовок праворуч: «updated <відносний час>» (час `generatedAt`);
   - лінійка «AI spend today»: `$витрачено / $ліміт cap` (витрати = `SUM(cost_usd)` з `editor_runs` за поточну київську добу; ліміт = `EDITOR_DAILY_BUDGET_USD`, за замовчуванням 3), колір смуги: акцент < 70 %, жовтий ≥ 70 %, червоний ≥ 90 %;
   - «N anomalies» / «no anomalies»;
   - посилання «N directives await you» / «N open directives» → `/app/agents/manager?tab=directives` (директиви зі статусом `awaiting_owner`, лише не-shadow);
   - плитки ресурсів (платформа, назва, бейдж здоровʼя: healthy / no access / token expiring / token invalid / rate limited / unknown, або «not checked»; посилання на `@agent`) із 6 KPI: views/post, engagement, posts, follower growth, transitions, revenue — значення за 7 днів і відхилення (%) від 28-денної бази; приглушені, якщо «stale», підсвічені, якщо «anomaly». Ресурси з аномаліями — першими. На екранах ≤600px показуються тільки ресурси з аномаліями + кнопка «N healthy resources» для розгортання.
   - порожній стан: «No resources in the digest yet — connect a channel and give it an orchestrator.»; помилка — червоний callout.
3. **«Upcoming runs»**: до 6 увімкнених стратегій із `next_run_at` (відсортовані за часом): `ext_id`, `channel_key`, відносний час.
4. **«Strategy status»**: до 6 стратегій з останнім запуском: статус (ok/error/skipped/running), текст помилки, час завершення.
5. **«Meta accounts»**: рядки з платформою, `@username`, кількістю підписників, дельтою 24 год; клік → `/app/connections/meta/$accountId`. Кнопка «Refresh» (видима лише якщо акаунти є) → `POST /api/meta-accounts/refresh-stats` (той самий колектор, що годинний крон; повертає `{accounts, snapshots, insightDays}`), під час запиту «Refreshing…»; після успіху інвалідуються кеші акаунтів, історії підписників та інсайтів.

**Дії користувача.** Єдина дія зі змінами — «Refresh» у картці Meta (запит до Meta Graph API для всіх активних акаунтів, запис знімків у БД). Решта — перегляд і переходи (картка директив, акаунти Meta).

**Бізнес-вимоги (as-is).**
- `BR-CORE-27` Сторінка завантажує стратегії (`/api/strategies`), мої Telegram-канали (до 200, `/tracking/channels`), Meta-акаунти (`/api/meta-accounts`) і KPI-дайджест (`/api/kpi/digest`) незалежно; кожен блок має власний стан завантаження.
- `BR-CORE-28` Плитка «Subscribers (Telegram)» сумує `subsCount` не більше ніж 200 «моїх» каналів; відсутні значення рахуються як 0.
- `BR-CORE-29` Плитка «Errors» рахує стратегії, чий останній запуск завершився `error`, без обмеження за часом; стратегії без запусків не враховуються.
- `BR-CORE-30` «Upcoming runs» показує лише увімкнені стратегії з розрахованим `next_run_at`, максимум 6, за зростанням часу; «Strategy status» — максимум 6 найсвіжіших за `started_at`.
- `BR-CORE-31` Картка «Network health» оновлюється кожні 5 хвилин; кожен запит `GET /api/kpi/digest` перераховує дайджест із БД заново (кешу немає).
- `BR-CORE-32` KPI рахуються кодом, не LLM: «поточне» = середнє/сума за останні 7 повних київських днів, «база» = попередні 28 днів; аномалія = (|z| ≥ 2 і |Δ| ≥ 10 %) або падіння ≥ 25 %; значення без свіжих даних (менше 2 днів) позначаються «stale» і аномаліями не вважаються.
- `BR-CORE-33` Ресурси в дайджесті — усі підключені: Telegram-канали (`is_mine` або з `editor_channels`), активні `meta_accounts`, активні `tiktok_accounts`, активні `youtube_accounts` (якщо таблиця існує).
- `BR-CORE-34` Індикатор «AI spend today» порівнює сумарні витрати всіх запусків редактора за київську добу з єдиним глобальним лімітом `EDITOR_DAILY_BUDGET_USD` (за замовчуванням $3; порожнє значення змінної трактується як default).
- `BR-CORE-35` Кнопка «Refresh» у блоці «Meta accounts» запускає ручне оновлення підписників та інсайтів усіх активних Meta-акаунтів; показується лише коли акаунти є.
- `BR-CORE-36` Без жодного Meta-акаунта, запуску чи стратегії сторінка показує порожні стани («No Meta accounts yet», «No scheduled runs», «No runs yet») з підказками, а не помилки.

**Бізнес-правила й обмеження.** Час у «Upcoming/Strategy status» — відносний (`date-fns`, «через 3 години»); добові межі KPI та бюджету — `Europe/Kyiv`. Значення «Meta Δ 24h» — сума дельт по всіх акаунтах. Директиви в лічильнику — до 20 відкритих, без shadow.

**Стани.** Завантаження — «—» у плитках, «Loading scheduled runs…», «Loading recent runs…», «Loading Meta accounts…», сірий скелетон 120px у «Network health». Помилка дайджесту — callout (`describeError`); помилки решти запитів на сторінці явно не показуються (плитки лишаються «—»/0).

**Фонові процеси.** Дані готують крони трекінгу Telegram, Meta-колектор (щогодини), планувальник стратегій (`next_run_at`), `editor_runs` (витрати), станом здоровʼя ресурсів і дельти займаються сервіси платформи агентів. Сторінка їх сама не запускає (окрім ручного «Refresh»).

**Звʼязки.** `/app/strategies`, `/app/agents/manager?tab=directives`, `/app/agents/$handle` (через `@agent` у плитці), `/app/connections/meta/$accountId`; бекенд `ManagerController` (`@UseGuards(TrackingAuthGuard)`, `GET /api/kpi/digest`).

**Спостереження «як фактично зараз».**
- Для «Subscribers (Telegram)» береться фільтр «mine» з пагінацією 200 — якщо каналів більше, сума тихо неповна.
- «Followers (Meta)» сумує всі акаунти зі списку, включно з неактивними (`MetaAccountsRepository.list()` без фільтра `active`); а дайджест враховує тільки активні (`m.active`) — цифри в плитці й у картці можуть не збігатися.
- Дайджест будується синхронно на кожен запит із ~10 SQL-запитів без кешу; його ж використовує MANAGER (там додатково пишеться `kpi_snapshots`, на сторінці — ні).
- Лінійка «cap» показує глобальний ліміт, тоді як у агентів є власні бюджети; картка бюджетів по агентах — на сторінці Agents.
- Підсумкова плитка «Errors» не показує ні що саме впало, ні чи минуло відтоді нове успішне виконання поза «останнім запуском».
- Помилки трьох перших запитів (стратегії, канали, Meta) не повідомляються користувачу.

**Відкриті питання до власника.** Чи потрібна плитка Instagram/TikTok-підписників окремо від «Meta»? Чи рахувати «Errors» лише за останні N годин? Чи додати у сторінку картку доходу (ads) та YouTube?

---

### 3.5 Налаштування — `/app/settings`

**Бізнес-мета.** Дати оператору змінювати кілька «env-рівня» параметрів без редагування `.env` і рестарту (де це реально працює), та бачити, які AI-ключі налаштовані. Файли: `routes/app.settings.tsx`, `api/settings.ts`, бекенд `apps/automation/src/settings/*`.

**Хто користується / доступ.** Тільки після логіну; бекенд `@Controller('settings') @UseGuards(TrackingAuthGuard)`.

**Що показує.** Заголовок «Settings», підзаголовок «Values from .env · changes are saved in the DB and override .env»; перемикач вкладок (`SegmentedTabs`), активна вкладка — у параметрі `?tab=telegram|ai|meta` (за замовчуванням `telegram`; невідоме значення → `telegram`). Дані — `GET /settings`.
- **Telegram → блок «Tracking»** (6 рядків, кожен із позначкою `overridden`, якщо ключ є в `app_settings`):

| Параметр (як у UI) | Контрол | Діапазон / формат | Підпис у UI |
|---|---|---|---|
| `TRACKING_ENABLED` | перемикач | true/false (за замовч. `false`) | жовтий callout «TRACKING_ENABLED ≠ true — subscriber statistics are not being collected» при вимкненому |
| `TELEGRAM_OWNER_ID` | текстове поле | лише цифри або порожньо | «admin notifications recipient» |
| `TELEGRAM_TRACKING_SHARE_SESSION` | перемикач | true/false | «applies after restart» |
| `STATS_POST_AGE_DAYS` | число, «days» | 1–365 (за замовч. 30) | — |
| `POSTING_COOLDOWN_MIN` | число, «min» | 1–1440 (за замовч. 20) | — |
| `FETCH_TIMEOUT` | число, «ms» | 1000–120000 (за замовч. 15000) | «pipeline only · after restart» |

- **AI**: «AI keys» — 4 рядки `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`, `GROK_API_KEY` з бейджем «set» (зелений) / «not set». Значення ключів ніколи не повертаються (лише boolean). Редагування немає.
- **Meta**: заглушка `Placeholder` «Meta — coming soon / Facebook / Instagram / Threads integration will be added later.»

**Дії користувача.** Кожна зміна — окреме підтвердження, пакетного збереження немає: перемикач або число/текст → діалог «Confirm — Are you sure you want to change <KEY>?» зі смужкою «старе → нове» і кнопкою «Save» (скасування — «Cancel»/Escape) → `PATCH /settings` з одним полем → відповідь оновлює кеш запиту. Числові й текстові поля показують кнопки «Save»/«Cancel» лише коли значення змінене й валідне. Порожнє `TELEGRAM_OWNER_ID` очищає DB-перевизначення (повернення до env, потім «вимкнено»); у діалозі показується «—».

**Бекенд.**
- `SettingsService.get()` → `{ telegram:{trackingEnabled, ownerId, trackingShareSession, statsPostAgeDays, postingCooldownMin, fetchTimeoutMs}, ai:{anthropic, perplexity, openai, grok}, overrides:[ключі з app_settings] }`.
- `update(patch)` для кожного переданого поля робить `INSERT … ON CONFLICT (key) DO UPDATE` у таблицю `app_settings(key, value, updated_at)` (міграція 015) і одразу оновлює кеш у памʼяті процесу; лог «settings updated: …». Ефективне значення: рядок `app_settings` → `process.env` → вбудований default; кеш читається один раз при старті.
- Валідація DTO (`UpdateSettingsDto`, глобальний `ValidationPipe` з `forbidNonWhitelisted`): `trackingEnabled` bool; `telegramOwnerId` регекс `^(\d+)?$`; `trackingShareSession` bool; `statsPostAgeDays` int 1–365; `postingCooldownMin` int 1–1440; `fetchTimeoutMs` int 1000–120000; будь-яке інше поле → 400.
- Хто читає значення: `trackingEnabled` — `TrackingScheduler.enabled()` на кожному тіку (live); `postingCooldownMin` — `PostingThrottleService` (live); `statsPostAgeDays` — `StatsCollectorService` (live); `telegramOwnerId` — `TelegramNotifierService` (live); `trackingShareSession` — `TrackingMtprotoClient` (при підключенні, тобто після рестарту).

**Бізнес-вимоги (as-is).**
- `BR-CORE-37` Сторінка має рівно 3 вкладки: Telegram, AI, Meta; активна вкладка зберігається в URL (`?tab=`), невалідне значення замінюється на `telegram`.
- `BR-CORE-38` Редагуються лише 6 параметрів блоку «Tracking»; кожна зміна зберігається окремим `PATCH /settings` після підтвердження в діалозі зі старим і новим значенням.
- `BR-CORE-39` Збережені значення записуються в `app_settings` і мають пріоритет над `.env`; позначка «overridden» показується для ключів, що є в таблиці.
- `BR-CORE-40` Діапазони значень перевіряються і на клієнті (поля), і на сервері (DTO): `STATS_POST_AGE_DAYS` 1–365, `POSTING_COOLDOWN_MIN` 1–1440, `FETCH_TIMEOUT` 1000–120000 мс; `TELEGRAM_OWNER_ID` — тільки цифри.
- `BR-CORE-41` Зміни `TRACKING_ENABLED`, `POSTING_COOLDOWN_MIN`, `STATS_POST_AGE_DAYS`, `TELEGRAM_OWNER_ID` набирають чинності без рестарту; `TELEGRAM_TRACKING_SHARE_SESSION` — після рестарту.
- `BR-CORE-42` Вкладка AI показує лише факт наявності 4 ключів (set / not set); значення ключів ніколи не передаються на клієнт, змінити їх зі сторінки не можна.
- `BR-CORE-43` Вкладка Meta не містить функціоналу — лише заглушка «coming soon».
- `BR-CORE-44` Вимкнений `TRACKING_ENABLED` зупиняє постановку задач опитування каналів (трекінг статистики підписників); сторінка попереджає про це жовтим callout.
- `BR-CORE-45` Помилка збереження показується callout-ом «Failed to save: …» над блоком; оскільки мутація не має власного `onError`/`silentError`, додатково спрацьовує глобальний тост-помилка (подвійне повідомлення).

**Бізнес-правила й обмеження.** Єдиний інстанс бекенду — кеш `overrides` у памʼяті процесу (при кількох інстансах розʼїдуться). Кулдауни Meta (`INSTAGRAM_COOLDOWN_MIN` 30, `FACEBOOK_COOLDOWN_MIN` 15, `THREADS_COOLDOWN_MIN` 10 хв) читаються сервісом із тієї ж схеми «DB → env → default», але через API/UI не редагуються (немає в `FIELD_TO_KEY`).

**Стани.** «Loading…» (сірий текст) на час запиту; помилка запиту — червоний текст з повідомленням; порожніх станів немає.

**Фонові процеси.** Немає власних; значення впливають на крон трекінгу, чергу публікацій і колектор статистики.

**Звʼязки.** Таблиця `app_settings`; споживачі — трекінг (`tracking.scheduler`, `tracking-mtproto.client`), `posting-throttle.service`, `telegram-notifier.service`, `stats-collector.service`, `cross-post.service` (кулдауни Meta).

**Спостереження «як фактично зараз».**
- `FETCH_TIMEOUT` з UI **нікуди не діє**: pipeline читає лише `process.env.FETCH_TIMEOUT` (`apps/pipeline/src/lib/fetch.js`), а Meta-клієнти (`meta-graph.util.ts`, `meta-graph.client.ts`) — `config.get('FETCH_TIMEOUT')` з env; `SettingsService.fetchTimeoutMs()` не має споживачів. Підпис «after restart» вводить в оману — навіть після рестарту береться значення з `.env`.
- `TELEGRAM_OWNER_ID` з UI впливає лише на `TelegramNotifierService`; `AdminBotService` читає `TELEGRAM_OWNER_ID` напряму з env, тож адмін-бот ігнорує DB-перевизначення — два «власники» можуть розійтися.
- Вкладка AI не показує `OPENROUTER_API_KEY`, хоча саме він керує агентами редактора, чатом і платформою агентів (`editor.module.ts`, `editor-chat.service.ts`); показані ж 4 ключі стосуються старих агентів (`claude/openai/grok/perplexity.agent.ts`) і ROI-аналізатора. Користувач не бачить, чи чат/редактор реально ввімкнені.
- Підпис «Values from .env» декларує, що сторінка відображає .env, але вона показує вже обчислене значення (DB ?? env ?? default); «overridden» лише позначає DB.
- Вкладка Meta — заглушка, тоді як Meta-параметри (кулдауни) існують у бекенді, а керування акаунтами живе на `/app/connections`.
- Бюджет редактора (`EDITOR_DAILY_BUDGET_USD`) показується на `/app`, але змінити його зі Settings не можна.
- У `DEFAULTS` бекенду та у UI-діалозі підтвердження кнопка завжди «Save» без попередження про відкладений ефект (restart) для `TRACKING_SHARE_SESSION`, окрім дрібного підпису в рядку.

**Відкриті питання до власника.** Чи прибрати `FETCH_TIMEOUT` зі Settings або підʼєднати його до споживачів? Чи додати в AI-вкладку `OPENROUTER_API_KEY` і бюджет редактора? Чи потрібна вкладка Meta (кулдауни)?

---

## 4. Наскрізні правила розділу

**Автентифікація й доступ.**
- Один клас доступу: «оператор». Ролей немає. Способи: `TRACKING_TOKEN` (форма або `Bearer` для скриптів), Telegram-віджет зі списком дозволених ID, або локальний обхід `ALLOW_NO_AUTH=true` (лише не-production).
- Сесія: cookie `tracking_jwt` (JWT на 30 днів, `httpOnly`, `sameSite=lax`, `secure` у production). Перевірка сесії на клієнті — `GET /auth/me` при кожному завантаженні застосунку (`AuthProvider`), у режимі `dev` — фіктивний користувач без запиту.
- Гарди: клієнтський (`app.tsx`) лише керує UX; реальна авторизація — `TrackingAuthGuard` на контролерах. Публічними лишаються: `/`, `/login`, `/report/$token` (сторінки) та ендпоінти `auth`, `api/landing/*`, `api/ads/report/:token`, `api/payments/liqpay/callback`, `GET /health`.
- Вихід: `POST /auth/logout` + жорстке перенаправлення на `/login`.

**Базовий шлях API та проксі.**
- `API_BASE` за замовчуванням порожній: усі виклики `api()` містять повний бекенд-шлях (`/api/strategies`, `/tracking/channels`, `/settings`, …); `AUTH_BASE` за замовчуванням `/auth` (`api/auth.ts` використовує `fetch` напряму, не `api()`).
- Dev (`vite.config.ts`, порт 5173) і prod (`nginx.conf`) проксують без зміни шляху на автоматизацію (`localhost:3000` / `automation:3000`) префікси: `/api`, `/auth`, `/tracking`, `/activity`, `/scheduled-posts`, `/settings`, `/stats`, `/r` (+ `/health` лише в nginx). Новий «голий» контролер потребує запису в обох місцях.
- Бекенд: частина контролерів під префіксом `api/…`, частина в корені (`auth`, `tracking`, `settings`, `activity`, `scheduled-posts`, `stats`). CORS на бекенді дозволяє лише `http://localhost:5173` з credentials. Swagger (`/api/docs`) — лише поза production або з `SWAGGER_ENABLED=true`.
- Для всіх запитів `credentials: 'include'`; `Content-Type: application/json` проставляється за замовчуванням; 204 повертає `undefined`.

**Обробка помилок і тости.**
- `api()` кидає `ApiError(status, bodyText)` при `!res.ok`; 401 → редирект на `/login`.
- `main.tsx`: `QueryClient` зі `staleTime` 30 с і одним повтором запитів; глобальний `MutationCache.onError` показує тост-помилку (`toast.error(describeError(e))`) для кожної мутації, у якої немає власного `onError` і `meta.silentError`, окрім 401.
- `Toaster` (`components/ui/Toast.tsx`): знизу праворуч, максимум 4 одночасно; помилки висять 8 с, успіх 4 с; однакове повідомлення не дублюється; клік закриває. `describeError` розбирає JSON-тіла `{error, details, issues}` та Nest `{message}`.
- Помилки запитів-читань (`useQuery`) тостами не показуються — кожна сторінка виводить свій інлайн-стан (або нічого).
- Підтвердження деструктивних і критичних дій — `ConfirmDialog` («Confirm», «Are you sure you want to …?»), що замінює `window.confirm`.

**Тема й адаптивність.**
- Одна темна тема (Supabase-подібна, акцент зелений `--color-accent`); `:root { color-scheme: dark }`, `theme-color #1b1b1b`; перемикача світлої теми немає. Токени — у `src/index.css` (`@theme`).
- Мобільний брейкпоінт панелі — 860px (шторка меню), для картки «Network health» — 600px; лендінг має брейкпоінти 640/600/480px; анімації поважають `prefers-reduced-motion`.
- Мова UI — англійська; мова даних/агентів і документації — українська.

## 5. Глосарій розділу

| Термін | Значення |
|---|---|
| `TRACKING_TOKEN` | Спільний адмін-секрет: токен-вхід і `Bearer` для API |
| `tracking_jwt` | Назва session-cookie (JWT, 30 днів) |
| `app_settings` | Таблиця `key/value/updated_at` з DB-перевизначеннями env-параметрів |
| `overridden` | Бейдж у Settings: ключ є в `app_settings` |
| KPI-дайджест | Розрахунок 6 метрик по ресурсах (7 днів проти 28-денної бази) + бюджет + директиви |
| Аномалія | (|z| ≥ 2 і |Δ| ≥ 10 %) або падіння ≥ 25 % |
| `stale` | Менше 2 днів свіжих даних у вікні — метрика не оцінюється |
| Ресурс (resource_ref) | `telegram:<channel_key>`, `instagram:<uuid>`, `facebook:<uuid>`, `threads:<uuid>`, `tiktok:<uuid>`, `youtube:<uuid>` |

## 6. Джерела в коді

- Дашборд: `apps/dashboard/src/routes/index.tsx`, `login.tsx`, `__root.tsx`, `app.tsx`, `app.index.tsx`, `app.settings.tsx`, `app.calendar.tsx`
- Оболонка: `apps/dashboard/src/components/AppShell.tsx`, `AppSidebar.tsx`, `ui/Toast.tsx`, `ui/ConfirmDialog.tsx`, `ui/Placeholder.tsx`
- Лендінг: `apps/dashboard/src/components/landing/ResourceShowcase.tsx`, `MediaKit.tsx`, `api/landing.ts`, `api/ads.ts` (`useMediaKit`), `apps/dashboard/index.html`
- Автентифікація (клієнт): `apps/dashboard/src/auth/auth-context.tsx`, `use-auth.ts`, `api/auth.ts`, `api/client.ts`, `lib/env.ts`, `main.tsx`
- Огляд: `apps/dashboard/src/components/agents/NetworkHealth.tsx`, `api/manager.ts`, `api/network.ts`, `api/tracking.ts`, `api/meta-accounts.ts`, `api/strategies.ts`
- Проксі/збірка: `apps/dashboard/vite.config.ts`, `apps/dashboard/nginx.conf`, `docker-compose.yml`, `.env.example`
- Бекенд auth: `apps/automation/src/auth/auth.controller.ts`, `auth.service.ts`, `auth.module.ts`, `rate-limit.guard.ts`, `token-login.dto.ts`, `telegram-login.dto.ts`; `apps/automation/src/tracking/api/tracking-auth.guard.ts`; `apps/automation/src/main.ts`
- Бекенд settings: `apps/automation/src/settings/settings.controller.ts`, `settings.service.ts`, `update-settings.dto.ts`, `settings.module.ts`; `database/migrations/015_app_settings.sql`
- Бекенд лендінгу: `apps/automation/src/config/api/landing.controller.ts`, `config/landing-resources.service.ts`, `payments/ads-public.controller.ts`, `payments/ad-prices.repository.ts`
- Бекенд огляду: `apps/automation/src/editor/manager/manager.controller.ts`, `manager.service.ts`, `kpi-digest.service.ts`, `kpi-math.ts`, `editor/agents/resource-catalog.ts`, `config/api/meta-accounts.controller.ts`, `config/api/strategies.controller.ts`
