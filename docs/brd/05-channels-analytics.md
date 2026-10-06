# BRD (as-is) — Мої канали, аналітика, трекінг, логи

> Статус: чернетка, згенерована з коду 2026-10-05. Описує, як система ФАКТИЧНО працює зараз (гілка feat/editor-agent), а не як мала б.

## 1. Призначення розділу

Розділ покриває "операційну панель власника каналів": список власних Telegram-каналів із прив'язаним ботом і стратегіями (`/app/channels`), картку каналу з метриками та діями (`/app/channels/$id`), агреговану аналітику Telegram і Meta (`/app/analytics`), список чужих (відстежуваних) каналів (`/app/tracked`) і стрічку активності автоматизації (`/app/logs`).

Користувач один — власник/оператор, який публікує контент у свої канали, дивиться, чи росте аудиторія, і контролює, що автоматика реально зробила. Усі сторінки доступні лише після логіну (`/app` — захищений layout; бекенд-гард `TrackingAuthGuard`: cookie `tracking_jwt` або Bearer `TRACKING_TOKEN`; розподілу даних між користувачами немає).

Ключова особливість, яку треба розуміти для всього розділу: **усі метрики Telegram на цих сторінках беруться не з Bot API, а з MTProto-сесії "трекера"** (user-акаунт, gramjs), яка опитує канали за розкладом і пише в таблиці `tracked_*`. Паралельно існує другий, незалежний конвеєр статистики (`/stats`, таблиці `channel_stats_snapshots` / `post_stats_snapshots` / `published_posts`), але дашборд його не читає (див. розділ 4).

## 2. Сторінки розділу

| Сторінка | Маршрут | Коротко |
|---|---|---|
| Мої канали | `/app/channels` | Пагінований список власних (`is_mine`) каналів: бот, tier опитування, стратегії, підписники; додавання/редагування каналу |
| Картка каналу | `/app/channels/$id` | Метрики одного каналу (підписники, перегляди, ER, топ-пости, ROI), керування паузою/tier/ботом/темами, стратегії та forward-маршрути |
| Аналітика | `/app/analytics` | Дві вкладки: Telegram (власні канали, дані трекера) і Meta (IG/FB/Threads: фоловери, охоплення, перегляди профілю) |
| Відстежувані канали | `/app/tracked` | Список чужих каналів (`is_mine = false`), статус трекінгу, додавання та жорстке видалення |
| Логи | `/app/logs` | Стрічка активності: запуски стратегій і одноразові заплановані пости, з трасою виконання |

## 3. Сторінки

### 3.1 Мої канали — `/app/channels`

**Бізнес-мета.** Показати власнику всі канали, у які система публікує, і відразу підсвітити, що заважає публікації: немає бота, канал на паузі, у стратегії закінчується контент.

**Хто користується / доступ.** Оператор після логіну. Пункт сайдбару "Publishing → My channels" (веде на `/app/channels?filter=mine`).

**Що показує.**
- `GET /tracking/channels?filter=mine&page=N&pageSize=50[&q=…][&bot=<uuid>]` → `TrackingService.listChannels` → `TrackedChannelsRepository.list` (таблиця `tracked_channels`, `ORDER BY added_at DESC`, пошук `LIKE` по `title + username + channel_key`).
- Три KPI-плитки, які рахуються лише по елементах поточної сторінки (не по всьому набору): "Channels" / "On this page" (кількість рядків), "Need a bot" (`needsBot`), "Paused" (`publishPaused`).
- Рядок каналу (`ChannelRow`): назва (`title` → `channelKey` → `@username`), чипи `kind` (public/private), `mine`, `closed`, `paused`, чип бота (`bot.username`, напівпрозорий, якщо бот неактивний), попередження "No bot — add or set a default bot to publish" та "Subscribe to track", реальний Telegram-id (`@username` або числовий chat id), кількість підписників (`subsCount`, формат `1.2K`), чип tier (`hot|warm|cold`), "last polled" (відносний час), список стратегій-чипів (`type`, `↩` для forward-ролі, іконка попередження "low content").
- Дані про стратегії для рядка беруться не з SQL, а з кешу конфігурації в пам'яті (`ConfigCacheService.getBindings()/getForwardRoutes()`); "low content" рахується на фронтенді з `useStrategies()` (`content_remaining < low_content_threshold` для типів зі скінченним пулом: recipes, quotes, facts, curated-prompts, ai0-prompts, pdr-quiz, motivation-biography, assets).

**Дії користувача.**
- Кнопка **Add channel** → модалка `AddChannelModal` (`ownership="mine"`): Kind (private/public), Username або Chat id, Name, Bot (+ кнопка "Set default bot"), Poll tier (за замовчуванням warm), Ownership (завжди "Mine", заблокований чекбокс). Після створення — перехід на картку каналу.
  - Public + лише username без назви/бота/tier≠warm → `POST /tracking/channels {username}` (`addChannel`: upsert за username + постановка `poll-meta`/`poll-posts` у чергу).
  - Усі інші комбінації → `POST /tracking/channels/full` (`createFullChannel`, `is_mine = true`, для public+username додатково ставить опитування в чергу; для private опитування НЕ ставиться).
- Поле пошуку (`q`, скидає сторінку на 1), чип активного фільтра за ботом (знімається кліком; фільтр `bot` можна виставити лише через URL-параметр), пагінація по 50.
- Іконка олівця на рядку (лише для `isMine`) → `EditChannelModal` (див. 3.2).
- Клік по рядку → `/app/channels/$id`.

**Бізнес-вимоги (as-is).**
- `BR-CHN-01` Сторінка завжди запитує `filter=mine`; параметр `filter` у URL валідується, але ігнорується (константа `FILTER = 'mine'`), вкладок all/external немає.
- `BR-CHN-02` Список сортується за датою додавання (нові зверху), розмір сторінки 50; сортування й фільтр за tier у UI відсутні (бекенд параметр `tier` підтримує, UI його не передає).
- `BR-CHN-03` Пошук виконується на бекенді регістронезалежним `LIKE '%q%'` по `title`, `username`, `channel_key`.
- `BR-CHN-04` Плитки "Need a bot" і "Paused" рахуються лише по каналах поточної сторінки; "Need a bot" = канал без `bot_id` за умови, що в системі немає жодного бота за замовчуванням (`needsBot = !botId && getDefaultBot() === null`).
- `BR-CHN-05` Підписники в рядку — це `tracked_channels.subs_count`, оновлюється воркером `poll-meta` через MTProto `channels.GetFullChannel → participantsCount`; якщо значення невідоме, показується "—".
- `BR-CHN-06` "Last polled" — це `tracked_channels.last_polled_at`; "never" означає, що жодне опитування для каналу не завершилось.
- `BR-CHN-07` Чип стратегії показує і "primary" (стратегія привʼязана до каналу), і "forward" (стратегія публікує в інший канал, з якого є forward-маршрут у цей); для forward додається `↩`.
- `BR-CHN-08` Бейдж "Subscribe to track" зʼявляється, коли `tracking_status = 'not_subscribed'`, тобто MTProto-акаунт трекера не бачить канал (не підписаний/не учасник).
- `BR-CHN-09` Додавання public-каналу тільки за username створює його з `is_mine = false` (див. "Спостереження"), а не `true`.
- `BR-CHN-10` Видалення каналу з цієї сторінки неможливе (кнопки delete немає; вона є лише на `/app/tracked`).

**Бізнес-правила й обмеження.**
- Валідація username (бекенд, `AddChannelDto`): `^@?[A-Za-z][A-Za-z0-9_]{3,31}$`. Для private chat id фронтенд вимагає, щоб значення починалось з `-`; бекенд вимагає лише непорожній `tgChatId`.
- Дубль за username у `createFullChannel` повертає HTTP 404 "already exists" (а не 409).
- Канал без бота й без дефолтного бота "не може публікувати" — лише UI-підказка; фактична відмова відбувається у публікаторі.

**Стани.** Завантаження: картка "Loading channels…". Помилка: картка "Couldn't load channels" + текст помилки. Порожньо без фільтрів: "No channels yet" + кнопка Add channel; з фільтрами: "No channels match your filters" + "Clear filters".

**Фонові процеси.** Дані рядків оновлює конвеєр трекінгу (розділ 4). Сторінка сама **не** оновлюється за таймером: `staleTime` 30 с, без `refetchInterval` (крім `useStrategies` — 10 с, але лише для чипів/low-content).

**Звʼязки.** → `/app/channels/$id`; ← сайдбар; використовує боти (`useBots`), стратегії (`useStrategies`). Інтеграції: Telegram MTProto (трекер), Telegram Bot API (публікація, поза цим розділом).

**Спостереження «як фактично зараз».**
- **Помилкова власність.** `AddChannelModal` у режимі "mine" для public+username-only викликає `addChannel`, який виконує `upsertByUsername` без `isMine` → `COALESCE(null,false)` → канал створюється як зовнішній і НЕ зʼявляється в "My channels" (хоча UI обіцяє "Mine"). За замовчуванням у цьому режимі вибрано kind=private, тож проблема проявляється, коли оператор перемикає на public.
- Підказка (tooltip) підписників згадує `getChat` бота, хоча фактично лічильник береться з MTProto трекера; для private-каналу без членства трекера число буде порожнім.
- Для щойно створеного private-каналу опитування не ставиться в чергу — показники зʼявляться після першого тік-циклу (за умови `TRACKING_ENABLED=true`) або після ручного "Fetch stats".
- Параметр `filter` і більшість пошукових полів у `Search` — залишки старого дизайну (коментар у коді: "Tracked/competitor channels live under Intelligence").

**Відкриті питання до власника.** Чи має "Add channel → public" завжди створювати канал як `mine`? Чи потрібне видалення власного каналу зі списку? Чи потрібен фільтр за tier/ботом у UI?

---

### 3.2 Картка каналу — `/app/channels/$id`

**Бізнес-мета.** Дати повну картину одного каналу: хто підписаний, як ростуть підписники, які пости працюють, які стратегії і коли публікують, і дозволити швидко призупинити публікацію чи змінити конфіг.

**Хто користується / доступ.** Оператор. Доступна для будь-якого `tracked_channels.id` (власного чи чужого — на неї також ведуть рядки зі сторінки Tracked).

**Що показує.** Паралельно завантажує п'ять запитів:
- `GET /tracking/channels/:id` (хедер і плитки);
- `GET /tracking/channels/:id/subs-history` → `tracked_subs_history` (повна історія без ліміту/агрегації);
- `GET /tracking/channels/:id/posts?limit=30` → `tracked_posts ORDER BY posted_at DESC LIMIT 30`;
- `GET /tracking/channels/:id/top-posts?metric=views&limit=5` → топ-5 за `views` за весь збережений період;
- `GET /api/tracked-channels/:id/themes` (кількість тем на кнопці Themes) + `useStrategies()` (кожні 10 с).

Блоки:
1. Хедер: назва, бейджі `paused` / `not subscribed` (danger) / `kind`, `@username` або chat id, підписники, випадаючий список tier, дата додавання ("added …"), опис `about`.
2. Стрічка плиток: **Subscribers** (`subs_count`), **Strategies** (кількість primary + forward), **Next post** (найближчий `next_run_at` серед увімкнених стратегій, формат "in 2h 5m"; якщо немає — "paused"), **Bot**, **Channel key**, **Themes** (до 3 чипів + "+N").
3. **Publishing strategies** (лише `isMine`): таблиця Strategy / Type / Schedule / Next run / Last run / Content / Status; для primary — inline-редагування cron-розкладу (`PATCH` стратегії), для forward — лише читання.
4. **Forward routes** (лише `isMine`): список/створення/видалення маршрутів `/api/forward-routes` (topic → target channel).
5. **ROI estimate** (`RoiPanel`, `GET /tracking/roi/:id`).
6. Графіки: **Subscribers over time**, **Views per post** (last 30), **Engagement rate**.
7. **Top posts by views** (top 5) і **Recent posts** (latest first) — `PostsList`: час, 👁 views · 🔁 forwards · ❤ reactions · 💬 comments, текст до 3 рядків або "(media only)".

**Дії користувача.**
- **Fetch stats** → `POST /tracking/channels/:id/poll` → у BullMQ ставляться `tracking.poll-meta` і `tracking.poll-posts`; через 4 с фронтенд інвалідує канал/історію/пости/топ. Також перевіряє підписку трекера.
- **Select poll tier** (hot/warm/cold) → підтвердження → `PATCH /tracking/channels/:id {pollTier}`.
- **Pause publishing / Resume publishing** (лише `isMine`) → підтвердження → `PATCH {publishPaused}`; публікатор і сервіс запланованих постів відмовляють у публікації в канал із `publish_paused = true`.
- **Themes (N)** → `EditThemesModal` (`/api/tracked-channels/:id/themes`).
- **Config** (лише `isMine`) → `EditChannelModal`: Name, Bot (+ Set default bot), Channel key, Chat id, Kind, Poll tier, Pause publishing, Ownership (Mine). Збереження → `PATCH /tracking/channels/:id` → подія `config:changed` оновлює кеш.
- **Recompute** у ROI → `GET /tracking/roi/:id?fresh=true` (може викликати платний LLM).
- Зміна розкладу стратегії, додавання/видалення forward — окремі ендпоінти (поза цим розділом).

**Метрики та їх походження.**

| Метрика на екрані | Формула / джерело |
|---|---|
| Subscribers | `tracked_channels.subs_count` ← MTProto `GetFullChannel.participantsCount` (воркер poll-meta) |
| Subscribers over time | точки `tracked_subs_history (snapshot_at, subs_count)`; точка пишеться при кожному успішному poll-meta з ненульовим `subsCount` |
| Views per post | `tracked_posts.views` для 30 останніх постів (NULL → 0), стовпці в хронологічному порядку, пік підсвічено |
| Engagement rate (на точку) | `(reactions_total + forwards + comments_count) / views`, лише для постів з `views > 0`; вісь у %, tooltip 2 знаки |
| Top posts | `ORDER BY views DESC NULLS LAST LIMIT 5` по всіх збережених постах каналу |
| Next post | `min(next_run_at)` по увімкнених стратегіях (primary + forward) |
| ROI | `avgViews(30д) × TRACKING_VIEW_TO_SUB_RATE(0.02) × multiplier(ER)`; див. 3.3 |

**Бізнес-вимоги (as-is).**
- `BR-CHN-11` Картка показує одну й ту саму структуру для будь-якого каналу; секції "Publishing strategies", "Forward routes" та кнопки "Pause/Resume" і "Config" зʼявляються лише коли `isMine = true`.
- `BR-CHN-12` Кнопка "Fetch stats" ставить у чергу дві задачі (meta + posts) і одразу повертає `{ok:true}`; результат у UI зʼявляється через ~4 с лише якщо воркер встиг.
- `BR-CHN-13` Зміна tier і паузи вимагає підтвердження через діалог; при скасуванні select повертається до збереженого значення.
- `BR-CHN-14` Пауза публікації блокує всі стратегії та forward-и в канал на етапі публікації, не змінюючи `enabled` самих стратегій.
- `BR-CHN-15` Плитка "Next post" показує "paused", коли немає жодної увімкненої стратегії з `next_run_at` (в тому числі коли стратегій взагалі немає).
- `BR-CHN-16` Графік підписників відображає всі наявні точки історії (до 365 днів за політикою retention) без даунсемплінгу; порожній стан — "No history yet. Wait for the next poll cycle."
- `BR-CHN-17` "Views per post" і "Engagement rate" будуються по 30 останніх постах із `tracked_posts`; у "Engagement rate" враховуються коментарі, хоча підпис блоку — "reactions + forwards / views".
- `BR-CHN-18` Лічильники views/forwards/reactions/comments посту записуються при першому виявленні посту воркером poll-posts і надалі **не оновлюються** (див. "Спостереження").
- `BR-CHN-19` У "Top posts" і "Recent posts" текст посту старше 30 днів відсутній (політика scrub `TRACKED_POST_TEXT_RETENTION_DAYS`, якщо `RETENTION_ENABLED=true`) і показується як "(media only)".
- `BR-CHN-20` Primary-розклад стратегії редагується inline прямо в таблиці (cron-вираз, UTC), forward-розклад — лише для читання з позначкою "edit on source".
- `BR-CHN-21` Колонка "Content" показує залишок контенту лише для стратегій зі скінченним пулом; при `content_remaining < low_content_threshold` — бейдж "Low: N / threshold".

**Бізнес-правила й обмеження.**
- Один канал може належати максимум одній "групі бренду" (`group_id`, унікальний індекс; конфлікт → HTTP 409); це лише організаційна привʼязка і з картки не редагується.
- Зміна `isMine` у Config переносить канал між "My channels" і "Tracked".
- Tier автоматично перераховується щодоби (див. розділ 4).

**Стани.** "Loading channel…", помилка "Couldn't load channel" + текст; кожен блок має власні loading/empty ("No posts yet", "No data", "No history yet").

**Фонові процеси.** Крони трекінгу (hot 5 хв, warm 30 хв, cold 6 год), черги `tracking.*`, щоденний перерахунок tier о 03:30, нічне retention.

**Звʼязки.** ← `/app/channels`, `/app/tracked`, модалка Add channel (редірект після створення); → `/app/strategies`. Інтеграції: Telegram MTProto, Anthropic (ROI).

**Спостереження «як фактично зараз».**
- **Перегляди "заморожені" на моменті першого опитування.** `poll-posts` бере лише повідомлення з `id > max(tg_message_id)` (`minId`), тому вже збережений пост ніколи не оновлюється. Воркер `refresh-metrics` та таблиця `tracked_post_metrics_history` існують, але `addRefreshMetrics` ніде не викликається — історія метрик посту порожня. Для власних каналів пост опитується через 5–60 хв після публікації, тому "Views per post", "Engagement rate", "Avg views" та ROI систематично занижені відносно реальних цифр у Telegram.
- Ручна зміна **Name** у Config перезаписується наступним `poll-meta` (він завжди патчить `title` і `about` значеннями з Telegram), якщо трекер має доступ до каналу. Підказка в `AddChannelModal` ("manual for private") цього не відображає.
- Щодоби о 03:30 `recomputeTiers` перезаписує `poll_tier` (за кількістю постів за 7 днів: ≥3/день hot, ≥0.5/день warm, інакше cold; перші 3 дні — warm) для каналів з `username`, тож ручний вибір tier на картці живе максимум до наступної ночі. Private-канали без username не перераховуються.
- Тултіп бейджа `not subscribed` на картці говорить про "publishing bot", а в списку — про "tracker account"; правильне — друге (перевіряється MTProto-сесія трекера, а не бот).
- Блок "Views per post" має підпис "last 30", а "Top posts" — "top 5" без обмеження за часом: після 30 днів тексти зникають.
- Блок ROI на власному каналі формулюється як "estimated subscribers per ad placement" (оцінка реклами), що має сенс для зовнішніх каналів, а не для власних.

**Відкриті питання до власника.** Чи треба оновлювати метрики постів протягом перших 48 год? Чи має ручний tier блокувати автоперерахунок? Чи потрібен блок ROI для власних каналів?

---

### 3.3 Аналітика — `/app/analytics`

**Бізнес-мета.** Один екран "як ростуть мої канали й акаунти": підписники/фоловери, середні перегляди, реакції, охоплення.

**Хто користується / доступ.** Оператор після логіну. Сайдбар "Analytics → Analytics".

**Що показує.** Перемикач платформи **Telegram | Meta** (стан лише в памʼяті, у URL не зберігається) і селектор обʼєкта.

*Вкладка Telegram.* Селектор каналів — `GET /tracking/channels?filter=mine&pageSize=200` (перший у списку, тобто найновіший, вибирається за замовчуванням). Для вибраного каналу: `GET …/subs-history`, `GET …/posts?limit=30` та ROI. Плитки:
- **Subscribers** = остання точка історії (або `subs_count`, якщо історії немає); delta = `остання − перша точка` усієї отриманої історії з підписом "· tracked range" (період не фіксований, залежить від доступної історії).
- **Avg views** = округлене арифметичне `views` 30 останніх постів (NULL рахується як 0); підпис "last N posts".
- **Reactions** = сума `reactions_total` по тих самих постах; підпис "across N posts".
Блоки: "Subscribers" (лінійний графік, "N points"), "Views" (стовпчики по постах), "Engagement" (лінія ER по постах), `RoiPanel`.

*Вкладка Meta.* Селектор — активні (`active = true`) акаунти з `GET /api/meta-accounts`. Плитки та графіки:
- **Followers** = `current` з `GET /api/meta-accounts/:id/follower-history` (інакше `followers` акаунта), delta "24h" = `followers_delta_24h` (різниця між останнім знімком і найближчим знімком ≤ now−24h);
- **Followers Δ 7d** = різниця між останнім знімком і найближчим знімком ≤ now−7d;
- **Reach** = сума `reach` по днях з `GET /api/meta-accounts/:id/insights`, підпис "N-day total" (N = кількість повернутих днів);
- графіки "Followers over time" (`meta_follower_history`), "Reach & impressions", "Profile views" (`meta_account_insights`).

**Дії користувача.** Перемикання платформи та обʼєкта. Кнопок оновлення/експорту/діапазону дат на сторінці **немає**; ручний `POST /api/meta-accounts/refresh-stats` доступний лише на Overview і на сторінці акаунта Meta.

**Бізнес-вимоги (as-is).**
- `BR-CHN-22` Вкладка Telegram показує тільки власні канали (`is_mine`), максимум 200 у селекторі; без каналів — "No channels. Add your own channel (is_mine) to see analytics."
- `BR-CHN-23` Усі Telegram-метрики сторінки беруться з таблиць трекера `tracked_subs_history` та `tracked_posts`, а не з `/stats`-таблиць.
- `BR-CHN-24` "Avg views" і "Reactions" рахуються на фронтенді по 30 останніх постах каналу без вибору періоду.
- `BR-CHN-25` Delta підписників порівнює першу й останню точки всієї історії, тож підпис "tracked range" означає "увесь період, що є в БД" (до 365 днів).
- `BR-CHN-26` Історія підписників Telegram додається точкою при кожному успішному poll-meta: кожні ≥5 хв (hot), ≥30 хв (warm) або ≥6 год (cold), а також при ручному "Fetch stats".
- `BR-CHN-27` Дані Meta збирає `MetaStatsCollectorService` щогодини (`@Cron(EVERY_HOUR)`) для всіх активних акаунтів, у яких розшифровується токен: знімок фоловерів у `meta_follower_history` + щоденні інсайти за останні 30 днів у `meta_account_insights` (upsert за `(account_id, day)`).
- `BR-CHN-28` Мапа інсайтів: Instagram — `reach`, `impressions`, `profile_views`; Facebook — `page_impressions_unique`, `page_impressions`, `page_views_total`; Threads — лише `views` (як `impressions`); недоступні метрики мовчки лишаються `null`.
- `BR-CHN-29` Для Threads фоловери беруться окремим викликом `threads_insights followers_count`; якщо немає scope `threads_manage_insights`, знімок не створюється.
- `BR-CHN-30` Вкладка Meta показує лише активні акаунти; порожній стан — "No Meta accounts".
- `BR-CHN-31` TikTok на сторінці аналітики відсутній (лише Telegram та Meta).
- `BR-CHN-32` Відкриття сторінки з холодним кешем ROI може запустити платний виклик `claude-haiku-4-5` (кеш ROI живе 7 днів у `tracked_roi_cache`).

**Бізнес-правила й обмеження.**
- ROI: `estimate = round(avgViews30d × 0.02 × m)`, де `m = 0.5` при ER < 1 %, `1.5` при ER > 5 %, інакше `1`; `ER30d = Σ(reactions+forwards+comments) / Σviews`. Confidence: `high` — ≥30 днів від `added_at` і ≥50 постів за 30 днів; `medium` — ≥14 днів і ≥20 постів; інакше `low`. За наявності `ANTHROPIC_API_KEY` оцінка уточнюється Claude і обмежується діапазоном [0.5×; 2×] евристики; при помилці — fallback на евристику (`source: heuristic`, без narrative).
- Усі часові мітки на графіках відображаються в часовому поясі браузера.

**Стани.** Кожен графік має окремі "Loading …" та "No … yet". Помилки запитів окремо не показуються — блок просто лишається порожнім.

**Фонові процеси.** Для Telegram — трекінг (розділ 4); для Meta — щогодинний collector; нічне retention (`meta_follower_history` 365 днів, `tracked_subs_history` 365 днів).

**Звʼязки.** Дані з Connections (Meta-акаунти, токени), Strategies (публікації, що створюють пости). Інтеграції: Telegram MTProto, Meta Graph API, Threads API, Anthropic.

**Спостереження «як фактично зараз».**
- Через заморожені перегляди (див. 3.2) "Avg views" і "Reactions" — це значення станом на перше опитування, а не поточні.
- Meta Reach для **Threads** показує `0`, а не "—": плитка перевіряє `hasReach` (є `reach` АБО `impressions`), а сума рахує лише `reach`.
- Повідомлення "Not available on Threads" зʼявляється лише коли даних немає зовсім; фактично для Threads є `impressions` (метрика `views`), тому графік "Reach & impressions" може показувати лише одну лінію.
- У `/stats`-контролері (`GET /stats/channels`, `/stats/summary`, `/stats/posts/:id` тощо, захист `X-API-Key`) є готові агрегати "зміна за 24 год", "daily subscribers", "top posts" — але дашборд їх не викликає.
- Помилки Graph API (недоступні метрики Facebook) логуються на рівні debug, тож у UI це виглядає як "No insight data yet".
- Сторінка не має селектора періоду: Telegram — "усе/останні 30 постів", Meta — фіксовані 30 днів.

**Відкриті питання до власника.** Чи потрібен вибір періоду та експорт? Додати TikTok? Чи показувати "Avg views" лише по постах старших за N годин? Чи залишати `/stats` API (X-API-Key) або підключити його до UI?

---

### 3.4 Відстежувані канали — `/app/tracked`

**Бізнес-мета.** Керований список конкурентів/референсних каналів, за якими збирається статистика та рекламні звʼязки (вхід для Graph, Discovery, Recommendations).

**Хто користується / доступ.** Оператор. Сайдбар "Intelligence → Tracked".

**Що показує.** `GET /tracking/channels?filter=external&page&pageSize=50[&q]` (`is_mine = false`). Плитки (лише коли `total > 0`): "Total tracked" (загальна кількість із відповіді), "Tracking ok" та "Needs subscribe" (рахуються лише по поточній сторінці за `tracking_status`). Легенда статусів: **Tracking** (`ok`), **Not subscribed**, **Unknown**. Рядки — той самий `ChannelRow`, що й у "My channels", але без кнопки редагування (вона лише для `isMine`) і з кнопкою **Delete channel**.

**Дії користувача.**
- **Add channel** → `AddChannelModal` (`ownership="external"`, за замовчуванням kind=public). Завжди йде гілка `POST /tracking/channels/full` з `isMine=false` (спрощена гілка `addChannel` вимагає `forcedMine`); для public+username ставляться в чергу poll-meta і poll-posts.
- Пошук, пагінація.
- **Delete** (іконка кошика) → підтвердження "delete … and all its collected stats (posts, subscriber history, ad edges)" → `DELETE /tracking/channels/:id` → жорстке видалення; каскадно зникають `tracked_posts`, `tracked_subs_history`, `tracked_roi_cache`, ребра `tracked_ad_edges` де канал — джерело; ребра де він — ціль лишаються як неозначені зовнішні посилання (`target_channel_id = NULL`). Після видалення інвалідуються кеші списку каналів і графа.

**Бізнес-вимоги (as-is).**
- `BR-CHN-33` Сторінка показує лише канали з `is_mine = false`, нові зверху, по 50 на сторінку.
- `BR-CHN-34` Список поповнюється не лише вручну: коли `poll-posts` знаходить у постах згадки `@username`/`t.me/+hash`, `resolve-discovery` автоматично створює відповідні канали (tier `cold`, `is_mine=false`), які зʼявляються на цій сторінці.
- `BR-CHN-35` Статус трекінгу виставляється воркером `poll-meta`: `ok` — MTProto-сесія бачить канал; `not_subscribed` — ні (після цього `poll-posts` для каналу пропускається, поки `poll-meta` не побачить доступ).
- `BR-CHN-36` Для відстеження каналу трекер-акаунт має бути його учасником (для private) або мати змогу резолвити публічний username; сама сторінка підписку не виконує.
- `BR-CHN-37` Видалення каналу незворотне й каскадне, виконується одразу після підтвердження.
- `BR-CHN-38` Додавання зовнішнього каналу з username, що вже існує, повертає помилку "Channel @… already exists" (HTTP 404), яка показується в модалці.
- `BR-CHN-39` Для invite-каналів (`channel_key = 'invite:<hash>'`) метадані (`title`, `subs_count`) оновлюються через `messages.checkChatInvite` без вступу в канал.
- `BR-CHN-40` Канали з `is_closed = true` не опитуються (виключені з `listForPolling`).

**Бізнес-правила й обмеження.** Ті самі, що в 3.1 (валідація username, chat id). Опитування чужих каналів підпадає під той самий розклад tier-ів і ліміти FLOOD_WAIT Telegram.

**Стани.** Скелетон із 6 рядків; помилка "Couldn't load tracked channels"; порожньо — "No tracked channels yet" або "No channels match your search"; помилка видалення показується окремою карткою.

**Фонові процеси.** Крони `tracking.tier-*`, воркери `poll-meta`, `poll-posts`, `resolve-discovery` (concurrency 3 / 5 / 1), `FLOOD_WAIT` → задачі опитування пропускаються (скіп), `resolve-discovery` — відкладається на точний час очікування.

**Звʼязки.** → `/app/channels/$id`; повʼязано з `/app/graph`, `/app/discovery`, `/app/recommendations`.

**Спостереження «як фактично зараз».**
- Рядок на цій сторінці успадковує чипи власних каналів: для чужого каналу може зʼявитись "No bot — add or set a default bot to publish", хоча публікація в нього не передбачена.
- Для "Tracked" немає фільтрів за tier/статусом і сортування, а плитки "Tracking ok"/"Needs subscribe" не відображають весь набір.
- Підказка "subscribe to start collecting stats" не має кнопки-дії: оператор мусить сам підписати акаунт трекера в Telegram.
- Список може швидко рости через автодискавері (cold-tier), без ліміту й очищення.
- Через `createFullChannel` для public-каналу без username (лише `channelKey`) опитування не ставиться в чергу.

**Відкриті питання до власника.** Чи потрібен ліміт/архівування автооткритих каналів? Чи потрібна кнопка "Subscribe" (через акаунт трекера)? Чи треба м'яке видалення замість жорсткого?

---

### 3.5 Логи — `/app/logs`

**Бізнес-мета.** Відповісти на питання "що автоматика зробила і де помилилась": опубліковані пости, помилки, пропуски, поточні запуски.

**Хто користується / доступ.** Оператор. Сайдбар "Analytics → Logs".

**Що показує.** `GET /activity?platform=…&type=…&from=…&to=…&strategy=…&channelId=…&limit=50&offset=…` → `ActivityService` → `ActivityRepository` (UNION двох джерел, `ORDER BY at DESC`, окремий `count(*)` для підсумку) та `GET /activity/run/:runId/steps` для траси.

Джерела подій:
1. `strategy_runs` (LEFT JOIN `strategy_bindings`, `tracked_channels`, `meta_accounts`, `tiktok_accounts`): час = `started_at`; тип = `ok→posted`, `error→error`, `skipped→skipped`, інше (`running`) → `running`; деталь = `error` (текст помилки), інакше "Completed in X.X s" з `duration_ms`.
2. `scheduled_publications` (одноразові заплановані пости оператора): час = `updated_at`; `sent→posted`, `failed→error`, `canceled→skipped`, **усе інше (`pending`, `sending`, `unknown`) → `running`**; платформа завжди `telegram`; стратегія — "Scheduled post".

Елементи UI: вкладки платформи (Telegram / Meta / TikTok), вкладки типу (All, Posts, Errors, Skipped, Running), діапазон (All time, 24h, 7 days, 30 days, Custom — два `type=date`), селектори стратегії (за `ext_id`) та каналу/акаунта, лічильник "N events", список з індикатором статусу, пагінація по 50. Рядок "strategy run" розгортається й показує трасу кроків (`service · action · ms`, помилка червоним, деталь кроку).

**Дії користувача.** Фільтри (кожна зміна скидає сторінку на 1; зміна платформи скидає стратегію і канал), розгортання рядка, кнопка **Retry** при помилці завантаження. Жодних дій над подіями (повтор, видалення, експорт) немає — сторінка read-only.

**Бізнес-вимоги (as-is).**
- `BR-CHN-41` Сторінка показує лише дві категорії подій: запуски стратегій (`strategy_runs`) і одноразові заплановані публікації (`scheduled_publications`); дії редактора, агентів, трекінгу, AI-логів, платежів у стрічку не потрапляють.
- `BR-CHN-42` Вкладка платформи мапиться так: Telegram → `telegram`; Meta → `instagram`, `facebook`, `threads`; TikTok → `tiktok`. Запуск без привʼязки (`strategy_bindings` не знайдено) вважається `telegram`.
- `BR-CHN-43` Лише рядки `strategy_run` розгортаються; для них траса завантажується ліниво (`staleTime` 30 с) із `strategy_runs.steps` (jsonb); якщо трасу не записано — "No execution trace recorded for this run."
- `BR-CHN-44` Розмір сторінки 50 (бекенд обмежує 1–200), загальна кількість рахується окремим `count(*)` по тому ж UNION.
- `BR-CHN-45` Фільтр часу "24h/7 days/30 days" обчислюється від поточного моменту на клієнті й передається як ISO `from`; "All time" = без нижньої межі (фактично ≤90 днів — retention `strategy_runs`).
- `BR-CHN-46` Список каналів для вкладки Telegram формується з каналів, до яких привʼязані стратегії (`strategy.channel_id`), а для Meta/TikTok — з відповідних акаунтів; якщо варіантів немає, селектор неактивний.
- `BR-CHN-47` Запуски, що застрягли в `running` після перезапуску сервісу, при старті переводяться в `error` з повідомленням "interrupted: service restarted mid-run".
- `BR-CHN-48` Сторінка не оновлюється автоматично (немає `refetchInterval`); оновлення — при зміні фільтра або перезавантаженні.

**Бізнес-правила й обмеження.** `limit` ≤ 200; невідомий `type` ігнорується (= All); невідома платформа → `telegram`.

**Стани.** Скелетон-рядки; помилка "Couldn't load activity" + Retry; порожньо — "Nothing here yet".

**Фонові процеси.** Записи створює планувальник стратегій та сервіс запланованих постів (`strategy_runs`, `scheduled_publications`); нічне retention видаляє `strategy_runs` старші за 90 днів.

**Звʼязки.** Дані з `/app/strategies`, `/app/scheduled`, `/app/connections`; платформи Telegram, Meta, TikTok.

**Спостереження «як фактично зараз».**
- **Фільтр "канал/акаунт" не працює для Meta і TikTok.** Фронтенд передає UUID Meta/TikTok-акаунта як `channelId`, а SQL порівнює його з `tc.id` (`tracked_channels`), який для Meta/TikTok-подій дорівнює NULL → вибір акаунта повертає 0 подій.
- Майбутні та ще не відправлені заплановані пости (`pending`) відображаються як "Running" зі спінером і датою `updated_at`, а не як "заплановано".
- "Custom" діапазон: `to` — це `new Date('YYYY-MM-DD')` (північ UTC), тож вибраний останній день не включається повністю.
- Назва "Logs" вужча за зміст: стрічка не показує помилки Meta/TikTok публікацій поза `strategy_runs`, роботу редактора, трекінгу, AI.
- Текст помилки виводиться як є (`sr.error`/`sp.error`), без нормалізації й без посилання на стратегію/пост.
- У стрічці немає фільтра за текстом/ID і немає експорту.

**Відкриті питання до власника.** Чи має Logs стати єдиним журналом (редактор, агенти, трекінг)? Чи показувати майбутні заплановані пости окремим статусом? Чи потрібне автооновлення?

---

## 4. Наскрізні правила розділу

### 4.1 Як збираються метрики Telegram (конвеєр "трекінг")

| Крок | Що | Як часто | Деталі |
|---|---|---|---|
| Крон hot | `enqueueTier('hot', 5)` | кожні 5 хв | вибираються канали `poll_tier='hot'`, `is_closed=false`, `last_polled_at` NULL або старший за 5 хв, ≤`TRACKING_BATCH_SIZE`(50) за цикл |
| Крон warm | `enqueueTier('warm', 30)` | `*/30 * * * *` | аналогічно, поріг 30 хв |
| Крон cold | `enqueueTier('cold', 360)` | `0 */6 * * *` | поріг 6 год |
| `poll-meta` (concurrency 3) | MTProto `GetFullChannel` → `title`, `about`, `subs_count`, `last_polled_at`, точка в `tracked_subs_history`, `tracking_status` | на кожен канал за циклом | invite-канали — `checkChatInvite` |
| `poll-posts` (concurrency 5) | `messages.GetHistory(minId=max_id, limit=50)` → upsert `tracked_posts` (views, forwards, reactions, replies, ad_refs) + ребра `tracked_ad_edges` + черга `resolve-discovery` | разом із poll-meta | пропускається для `not_subscribed` |
| Перерахунок tier | `recomputeTiers` | щодня 03:30 | див. 3.2 |
| Ручний запуск | `POST /tracking/channels/:id/poll` | за кліком "Fetch stats" | ті самі дві черги |

Усі крони працюють лише при `TRACKING_ENABLED=true` (значення читається з налаштувань, що можна змінити з дашборду; у коді за замовчуванням `false`, в `apps/automation/.env.example` — `true`). Додавання каналу й ручний "Fetch stats" ставлять задачі в чергу незалежно від цього прапорця. Змінні `TRACKING_POLL_INTERVAL_HOT_MIN` / `_WARM_MIN` / `_COLD_HOURS` з `.env.example` у коді **не використовуються** — інтервали зашиті в `@Cron`.

FLOOD_WAIT від Telegram: клієнт відкриває "вікно" й усі виклики трекінгу миттєво відмовляються; задачі опитування пропускаються (їх перепостановить наступний крон), `resolve-discovery` відкладається на точний час очікування. Повторні спроби BullMQ: до 3 з експоненційною затримкою від 5 с.

Сесія трекера: першу активну зашифровану MTProto-сесію з БД (Connections) використовують у пріоритеті; інакше — `TELEGRAM_TRACKING_SESSION_STRING`; інакше за `TELEGRAM_TRACKING_SHARE_SESSION=true` — спільна `TELEGRAM_SESSION_STRING`. Без сесії клієнт вимкнений, а всі опитування повертають порожній результат.

### 4.2 Другий конвеєр: `/stats` (для сторінок розділу не використовується)

`StatsCollectorService` щогодини (`EVERY_HOUR`) через окремий MTProto-клієнт знімає підписники/онлайн для кожного каналу з `channel_key` (`channel_stats_snapshots`) та перегляди/реакції/пересилання/відповіді для кожного поста, опублікованого системою за останні `STATS_POST_AGE_DAYS` (30) днів (`published_posts` → `post_stats_snapshots`). На відміну від трекера, ці знімки **повторно оновлюються щогодини**, тож вони точніші для "моїх" постів. Їх споживають редактор, звіти про рекламу, дайджести, `platform_posts` — але не `/app/channels` та `/app/analytics`. REST `/stats/*` захищений заголовком `X-API-Key` (`STATS_API_KEY`); якщо ключ не заданий, усі запити повертають 500. Retention: 90 днів.

### 4.3 Таблиці розділу

| Таблиця | Призначення | Ключ дедуплікації |
|---|---|---|
| `tracked_channels` | усі канали (власні й чужі): конфіг + останні метрики | унікальні `LOWER(username)`, `tg_chat_id`, `channel_key` |
| `tracked_subs_history` | історія підписників (retention 365 д) | PK `(channel_id, snapshot_at)` |
| `tracked_posts` | пости каналів із метриками; текст стирається після 30 д | UNIQUE `(channel_id, tg_message_id)` |
| `tracked_post_metrics_history` | історія метрик посту (фактично порожня) | PK `(post_id, snapshot_at)` |
| `tracked_ad_edges` | рекламні/згадкові звʼязки між каналами | PK `(source, target_username, target_kind)` |
| `tracked_roi_cache` | кеш ROI, TTL 7 днів | по `channel_id` |
| `meta_follower_history` | щогодинні знімки фоловерів Meta (retention 365 д) | PK `(account_id, snapshot_at)` |
| `meta_account_insights` | щоденні reach/impressions/profile_views | `(account_id, day)` (upsert) |
| `strategy_runs`, `scheduled_publications` | джерела стрічки Logs | — |
| `channel_stats_snapshots`, `post_stats_snapshots`, `published_posts` | паралельний конвеєр `/stats` | `(channel_id, message_id)` |

### 4.4 Загальні правила
- Усі запити сторінок розділу йдуть через `api()` із cookie-автентифікацією; відповідь 401 перенаправляє на `/login`.
- `staleTime` React Query — 30 с, `retry: 1`; автоматичного polling на сторінках розділу немає (крім стратегій — 10 с).
- Числа форматуються `fmtNumber`: `1234 → 1.2K`, `1 500 000 → 1.5M`, NULL → "—"; дати — `en-GB`, 24-годинний формат.
- Видалення каналу — єдиний незворотний крок розділу; будь-яка зміна конфігу каналу публікує подію `config:changed` і оновлює кеш без перезапуску.

## 5. Глосарій розділу

- **tier (hot/warm/cold)** — частота опитування каналу трекером: 5 хв / 30 хв / 6 год.
- **трекер** — MTProto-сесія (user-акаунт), що читає канали; не плутати з ботом-публікатором (Bot API).
- **tracking_status** — `unknown` (ще не опитували), `ok`, `not_subscribed` (сесія не бачить канал).
- **ER (engagement rate)** — `(реакції + пересилання + коментарі) / перегляди`.
- **ROI estimate** — оцінка кількості підписників від одного рекламного розміщення в каналі.
- **needsBot** — у каналу немає бота й немає бота за замовчуванням.
- **publish_paused** — вимикач публікації на рівні каналу.
- **primary / forward** — роль стратегії щодо каналу: публікує напряму або через forward-маршрут.

## 6. Джерела в коді

Дашборд:
- `apps/dashboard/src/routes/app.channels.tsx`, `app.channels_.$id.tsx`, `app.analytics.tsx`, `app.tracked.tsx`, `app.logs.tsx`
- `apps/dashboard/src/api/tracking.ts`, `activity.ts`, `meta-accounts.ts`, `forward-routes.ts`, `discovery.ts`
- `apps/dashboard/src/components/ChannelRow.tsx`, `AddChannelModal.tsx`, `EditChannelModal.tsx`, `RoiPanel.tsx`, `SubsHistoryChart.tsx`, `ViewsBarChart.tsx`, `EngagementChart.tsx`, `PostsList.tsx`, `ForwardRoutesPanel.tsx`, `InlineScheduleEditor.tsx`
- `apps/dashboard/src/lib/labels.ts`, `format.ts`, `runway.ts`; `components/AppSidebar.tsx`

Бекенд (`apps/automation/src`):
- `tracking/api/tracking.controller.ts`, `tracking.service.ts`, `tracking-auth.guard.ts`
- `tracking/tracking.scheduler.ts`, `tracking-queue.service.ts`, `workers/poll-meta.worker.ts`, `poll-posts.worker.ts`, `refresh-metrics.worker.ts`, `resolve-discovery.worker.ts`
- `tracking/mtproto/tracking-mtproto.client.ts`
- `tracking/repositories/tracked-channels.repository.ts`, `tracked-posts.repository.ts`
- `tracking/processors/roi-analyzer.service.ts`, `roi-heuristic.ts`, `tier-classifier.ts`
- `stats/stats-collector.service.ts`, `stats.service.ts`, `stats.controller.ts`, `telegram-stats.client.ts`, `meta-stats-collector.service.ts`, `meta-follower-history.repository.ts`, `meta-account-insights.repository.ts`
- `config/api/meta-accounts.controller.ts`, `config/meta-graph.client.ts`, `config/meta-insights.ts`
- `activity/activity.controller.ts`, `activity.service.ts`, `activity.repository.ts`; `config/strategy-runs.repository.ts`
- `common/retention/retention.service.ts`; `settings/settings.service.ts`

БД (`database/migrations`): `001_stats.sql`, `002_tracking.sql`, `005_config.sql`, `007_publish_paused.sql`, `013_tracking_status.sql`, `014_scheduled_publications.sql`, `021_meta_follower_history.sql`, `022_meta_account_insights.sql`, `034_tracked_channel_group.sql`, `045_scheduled_publications_unknown.sql`.
