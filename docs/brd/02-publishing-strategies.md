# BRD (as-is) — Публікація: стратегії, розклад, ручні пости

> Статус: чернетка, згенерована з коду 2026-10-05. Описує, як система ФАКТИЧНО працює зараз (гілка feat/editor-agent), а не як мала б.

## 1. Призначення розділу

Розділ описує «класичний» (не-редакторський) контур публікації: **стратегії** — крон-розклад + джерело контенту + генерація + публікація в Telegram-канал, Meta-акаунт (Instagram / Facebook / Threads) або TikTok-акаунт, а також **ручні відкладені пости** (`/app/compose` → `/app/scheduled`). Користується власник мережі (один оператор). Автономний AI-редактор, агенти, чат і реклама (`/app/editor`, `/app/agents`, `/app/chat`, `/app/ads`) — окремі розділи; тут вони згадуються лише там, де пишуть у ті самі таблиці.

Ключова модель: **канал не має логіки — це лише точка публікації**; вся логіка в стратегії. Один рядок таблиці `strategy_bindings` = «тип стратегії + розклад + місце призначення + params (JSON)».

## 2. Сторінки розділу

| Сторінка | Маршрут | Коротко |
|---|---|---|
| Список стратегій | `/app/strategies` | Усі привʼязки стратегій: статус, розклад, наступний запуск, останній запуск, пауза/видалення, розгорнутий журнал і попередній перегляд |
| Нова стратегія | `/app/strategies/new` | Форма створення привʼязки (завжди стартує на паузі) |
| Деталі/редактор стратегії | `/app/strategies/$id` | Редагування полів, JSON-params, приклад поста, для `recipe-carousel` — редактор підписів Meta |
| Заплановані пости | `/app/scheduled` | Черга ручних (і створених агентами) одноразових постів у Telegram; скасування й перехід до редагування |
| Календар / черга | `/app/calendar` | Заглушка «Calendar soon» |
| Новий / редагування поста | `/app/compose` (`?id=<uuid>`) | Редактор разового Telegram-поста з прев’ю та вибором часу |

Допоміжно: кнопка **New post** у шапці дашборду (`AppShell`) та на `/app/scheduled` веде на `/app/compose`. У бічному меню є «Strategies» і «Scheduled»; **«Calendar» у меню відсутній** (сторінка досяжна лише прямим URL).

## 3. Сторінки

### 3.1 Список стратегій — `/app/strategies`

**Бізнес-мета.** Дати власнику огляд усіх автоматичних публікаторів: що, куди, коли і чи працює, з можливістю призупинити або видалити.

**Хто користується / доступ.** Тільки після логіну (`/app/*`). Усі ендпоінти `/api/strategies*` захищені `TrackingAuthGuard` (Bearer `TRACKING_TOKEN`, JWT-cookie `tracking_jwt`, або локальний обхід лише за `ALLOW_NO_AUTH=true` поза production).

**Що показує.**
- `GET /api/strategies` (оновлюється кожні 30 с) → `StrategiesController.list` читає `strategy_bindings`, останній запуск кожної стратегії з `strategy_runs`, список Meta-акаунтів, цілі крос-постингу, кеш каналів/forward-маршрутів, лічильник «запасу контенту» (`ContentRunwayService`).
- Рядок стратегії: індикатор статусу (сірий — пауза, червоний — останній запуск `error`, зелений — решта), `ext_id`, чіп типу, іконки платформ (лише на вкладці «All»), чіп `paused`, бейдж **No bot** (Telegram-канал без привʼязаного бота й без дефолтного бота), призначення (`channel_key` або `@username` Meta-акаунта), cron-вираз, «next in …» (лише для enabled), клітинка «Last run» (`ok` / `error` / `skipped` / `never`, давність, тривалість).
- Фільтр платформи `?platform=` (All / Telegram / Meta). Вкладка Meta показує стратегії з Meta-призначенням або Telegram-стратегії з Meta-крос-постингом; вкладка TikTok недоступна (`ACTIVE_PLATFORMS = all, telegram, meta`).
- Клік по рядку розгортає панель: «Channels reached» (primary + forward-канали з `forward_routes`), «Next-up preview» (`GET /api/strategies/:id/preview`, до 3 елементів), «Execution log · last 20 runs» (`GET /api/strategies/:id/runs`, оновлення кожні 10 с).

**Дії користувача.**
| Дія | Що відбувається |
|---|---|
| **Add strategy** | перехід на `/app/strategies/new` |
| Клік по рядку | розгортає/згортає деталі |
| Олівець | перехід на `/app/strategies/$id` |
| Pause / Enable | `PATCH /api/strategies/:id` `{enabled}` → оновлення БД → подія Redis `config:changed` → планувальник зареєструє/зупинить cron за ≈0,5 с |
| Delete (з підтвердженням) | `DELETE /api/strategies/:id` → рядок видаляється, **разом з історією `strategy_runs` (FK `ON DELETE CASCADE`)**; cron знімається |

**Бізнес-вимоги (as-is).**
- `BR-PUB-01` Система показує всі рядки `strategy_bindings`, відсортовані за `ext_id`, незалежно від платформи; фільтр платформи лише ховає рядки на клієнті.
- `BR-PUB-02` Для кожної увімкненої стратегії система обчислює `next_run_at` тією ж бібліотекою `cron` і в тому ж часовому поясі (`SCHEDULER_TZ`), що й планувальник; для призупинених `next_run_at = null`.
- `BR-PUB-03` Колір індикатора: призупинена → нейтральний; `last_run.status = error` → червоний; інакше зелений. Статус `skipped` не вважається помилкою.
- `BR-PUB-04` Бейдж «No bot» з’являється лише для Telegram-привʼязок, у яких канал не має `bot_id` і в системі немає бота за замовчуванням.
- `BR-PUB-05` Pause/Enable не видаляє привʼязку: `enabled=false` лише знімає cron-завдання; ручний запуск «зараз» у UI відсутній.
- `BR-PUB-06` Видалення стратегії незворотне, потребує підтвердження й каскадно видаляє її журнал запусків.
- `BR-PUB-07` Журнал запусків показує останні 20 записів `strategy_runs` (статуси `running`, `ok`, `error`, `skipped`, тривалість, текст помилки до 1000 символів).
- `BR-PUB-08` Панель «Channels reached» для Telegram-привʼязки показує primary-канал і всі канали-цілі forward-маршрутів, що виходять з цього каналу, незалежно від того, чи реально ця стратегія форвардить (форвард робиться лише за AI-маршрутизацією тем у `ai0-news` та `ua-news`).
- `BR-PUB-09` Для типів без реалізації попереднього перегляду API повертає `kind: 'unsupported'` з повідомленням; помилка перегляду не дає HTTP 500.
- `BR-PUB-10` Сторінка не показує «запас контенту» (`content_remaining`) і попередження про низький запас; ці дані відображаються лише на `/app/channels` та `/app/channels/$id`.

**Бізнес-правила й обмеження.** Тип стратегії, не зареєстрований у `ContentStrategyRegistry`, не планується (лише WARN у лозі) — у UI такий рядок усе одно виглядає «enabled» з «next in …». Фільтр «Telegram» ховає Meta-привʼязки; TikTok-привʼязки видно лише на «All».

**Стани.** Завантаження: «Loading…». Помилка API: червоний текст. Порожньо: «No strategies yet» (для вкладки Meta: «No Meta-enabled strategies»). Помилка підтвердження видалення/паузи окремо не показується.

**Фонові процеси.** `SchedulerService` (`apps/automation/src/scheduler/scheduler.service.ts`): на старті реєструє по одному `CronJob` на кожну enabled-привʼязку; підписаний на Redis-канал `config:changed` (події `strategy`, `channel`, `all`), з дебаунсом 500 мс виконує `reconcile()` — зупиняє видалені, перезапускає ті, у яких змінилися `schedule` або канал. Зміни `params`/`type` підхоплюються наступним тіком (привʼязка перечитується на кожному тіку). `AlertingService` кожні 15 хв шле власнику DM про стратегію з ≥3 `error` поспіль (`ALERT_CONSECUTIVE_ERRORS`) або про запуск, що висить у `running` довше 20 хв (`ALERT_STUCK_RUNNING_MINUTES`); сповіщення де-дублюються в памʼяті.

**Звʼязки.** `/app/strategies/new`, `/app/strategies/$id`, `/app/channels` (запас контенту, паузa каналу), `/app/logs` (активність), `/app/` (Overview: «Active strategies», «Upcoming runs»). Інтеграції: Telegram Bot API, Meta Graph API, TikTok Content API, Redis (`config:changed`).

**Спостереження «як фактично зараз».**
- Крон-стратегії публікують **без попереднього схвалення людиною** — як тільки привʼязка enabled і настав час. Нова привʼязка створюється на паузі, це єдина «страховка».
- Для TikTok-привʼязок у списку немає ні іконки (`PLATFORM_GLYPH` не має `tiktok`), ні назви призначення — рядок показує «no destination»; панель «Channels reached» повідомляє «No channels resolved — primary binding may be misconfigured» і для Meta-привʼязок теж (їх призначення — акаунт, а не канал).
- Сторінка стверджує «Cron-scheduled content generators bound to channels», хоча привʼязка може бути до Meta/TikTok-акаунта.
- Вікно «last run = ok» не означає, що пост вийшов: у багатьох стратегіях помилка публікації перехоплюється всередині `execute()` і журнал фіксує `ok` (див. розділ 4, «Збої»).
- Підказка `STRATEGY_STATUS_HELP.paused` («Cron is NOT registered») коректна; але якщо канал на паузі (`publish_paused`), cron продовжує спрацьовувати: у загальному конвеєрі запуск пишеться як `skipped`, а в стратегіях з `execute()`, що перехоплюють помилку публікації, — як `ok`, причому для стратегій із відміткою «до публікації» (`ai0-news`, `ua-news`, `facts`, `pdr-quiz`, `game-channel`) елемент контенту **згорає** (див. 4.4).

**Відкриті питання до власника.** Потрібен ручний «Run now»? Чи показувати запас контенту й TikTok у списку? Чи треба видаляти історію запусків разом зі стратегією?

---

### 3.2 Нова стратегія — `/app/strategies/new`

**Бізнес-мета.** Створити привʼязку «тип + розклад + призначення». Новий запис не публікує, поки власник його не увімкне.

**Хто користується / доступ.** Тільки після логіну.

**Що показує.** Форма `StrategyForm` у картці: «Strategy id (logical name)», «Destination» (Telegram channel / Meta account (Instagram / Facebook / Threads) / TikTok account), вибір призначення, «Type», «Schedule (cron)» з чіпами-шаблонами, жовте попередження, кнопки Cancel / Save.
- Список каналів: `GET /tracking/channels?filter=mine&pageSize=200` (лише «мої»).
- Список Meta-акаунтів — лише `active`; TikTok-акаунтів — лише `active`.
- Типи: `GET /api/strategies/types` → усі зареєстровані типи крім прихованих `daily-photo`, `ua-news`, `movies`, з масивом `supportedPlatforms`. Список «Type» фільтрується за платформою призначення (для Meta — за платформою обраного акаунта) і групується: RSS / Source / AI / Other.
- Під селектом типу — опис зі словника `STRATEGY_DESCRIPTIONS` (його немає для `recipe-carousel`, `network-digest`, `topic-digest`).

**Дії користувача.**
| Дія | Що відбувається |
|---|---|
| Вибір типу | якщо є дефолтний розклад — підставляється (`network-digest`, `topic-digest`: `*/10 19-20 * * *`) |
| Чіпи розкладу | підставляють cron: щогодини, кожні 30 хв, 09:00, 18:00, будні 09:00, кожні 4 год |
| Save | `POST /api/strategies` з `enabled:false`, `params:{}`; після успіху — повернення на список |
| Cancel | повернення на список |

**Бізнес-вимоги (as-is).**
- `BR-PUB-11` Кнопка Save активна лише коли заповнені id, cron, призначення і тип, що підтримує платформу призначення; тип скидається, якщо після зміни призначення він більше не підтримується.
- `BR-PUB-12` `ext_id` має відповідати `^[a-z0-9_:-]+$` (без урахування регістру), до 80 символів, і бути унікальним; дублікат → HTTP 409 `ext_id … already exists`.
- `BR-PUB-13` Cron-вираз валідується серверною бібліотекою `cron` у часовому поясі планувальника (`makeCronJob`); некоректний → HTTP 400 `Invalid cron expression`.
- `BR-PUB-14` Нова привʼязка завжди створюється з `enabled=false` (UI передає `false`; серверний дефолт теж `false`).
- `BR-PUB-15` Сервер перевіряє, що тип підтримує обрану платформу (`supportedPlatforms` стратегії; за замовчуванням лише `telegram`), інакше 400.
- `BR-PUB-16` Telegram-привʼязка вимагає існуючий `channel_id` і не може мати `meta_account_id`/`tiktok_account_id`; Meta-привʼязка вимагає `meta_account_id` (існуючий) і не має `channel_id`; TikTok — аналогічно з `tiktok_account_id`.
- `BR-PUB-17` Після створення сервер публікує подію `config:changed` (`strategy`), тож cron реєструється без перезапуску сервісу — **якщо** привʼязку потім увімкнено.
- `BR-PUB-18` Через UI створити привʼязку з непорожніми `params` неможливо: форма завжди шле `{}`; параметри задаються лише на сторінці редагування.

**Бізнес-правила й обмеження.** `schedule` ≤ 120 символів; `type` ≤ 64; допускаються 5- та 6-польні cron-вирази (бібліотека `cron` приймає секунди), мінімального інтервалу немає. Часовий пояс розкладу — `SCHEDULER_TZ` (див. розділ 4).

**Стани.** Кнопка «Saving…»; помилка сервера показується червоним під формою (текст відповіді як є). Селект типу заблокований, доки не обрано призначення.

**Фонові процеси.** Після створення — `reconcile()` планувальника (див. 3.1).

**Звʼязки.** `/app/strategies`; довідники каналів (`/tracking/channels`), Meta/TikTok-акаунтів (`/app/connections*`).

**Спостереження «як фактично зараз».**
- Жовте застереження на формі «Restart automation after creating — scheduler picks up new strategies on boot» **застаріле**: фактично діє гаряче перезавантаження через `config:changed`.
- Для Meta-акаунта форма показує лише акаунти `active`, але підпис підказки каже «verified accounts only»; перевірки `verify_error` немає (на відміну від крос-постингу).
- TikTok-бінд можна створити лише для типу `recipe-carousel` (єдиний із `tiktok` у `supportedPlatforms`).
- На створенні немає вибору часового поясу чи підказки, що cron інтерпретується в `SCHEDULER_TZ`.

**Відкриті питання до власника.** Чи потрібні в майстрі поля params (категорія, `dataSource` тощо) відразу? Чи прибрати застаріле попередження?

---

### 3.3 Деталі / редактор стратегії — `/app/strategies/$id`

**Бізнес-мета.** Змінити будь-яке поле привʼязки, подивитися приклад поста і (для `recipe-carousel`) відредагувати підписи Meta.

**Хто користується / доступ.** Тільки після логіну.

**Що показує.** Дані беруться зі списку `GET /api/strategies` (окремого ендпоінта «одна стратегія» немає). Дві колонки:
- Ліва: панель «Edit strategy» — Name (id), Type (вільний текст з datalist), Channel (селект лише для Telegram; для Meta/TikTok — лише текст), Schedule (cron + чіпи), Params (JSON, «full replacement on save»), Notes, «Low-content alert (posts)» (лише для «скінченних» типів: `recipes`, `quotes`, `facts`, `curated-prompts`, `ai0-prompts`, `pdr-quiz`, `motivation-biography`, `assets`), чекбокс Enabled, блок «Meta cross-posting».
- Права: «Configuration» (read-only), «Example post» (`GET /api/strategies/:id/preview` у вигляді Telegram-бульбашки), для `recipe-carousel` — «Post Preview».

**Дії користувача.**
| Дія | Що відбувається |
|---|---|
| Save | `PATCH /api/strategies/:id` лише зі зміненими полями; `params` замінюється повністю; показується «Saved» |
| Meta cross-posting → Add / Enable / Disable / Delete | `POST/PATCH/DELETE /api/channels/:channelId/crossposts[/id]` — додає/вмикає/видаляє цілі дзеркалювання Telegram-каналу в Meta-акаунт (режим `mirror` або `teaser`; для Instagram лише `mirror`) |
| Post Preview → вкладки Facebook/Instagram/Threads/Telegram | показує частини підпису (`GET /api/strategies/:id/post-preview`) і зібраний текст |
| Save caption overrides | `PATCH` з `params.metaCaption = {intro, cta, outro, hashtags[], tgLinkLabel}` (зливається з рештою params) |

**Бізнес-вимоги (as-is).**
- `BR-PUB-19` Місце призначення (канал/акаунт/платформа) після створення змінити неможливо в UI; для Telegram-привʼязки можна змінити лише канал (`channel_id`).
- `BR-PUB-20` UI надсилає лише змінені поля; якщо змін немає — показує «Saved» без запиту.
- `BR-PUB-21` Перейменування `ext_id` дозволене (regex з BR-PUB-12); колізія → 409 і повідомлення «Id … already exists — pick another».
- `BR-PUB-22` Params має бути JSON-обʼєктом; не-обʼєкт блокує Save; зберігається повна заміна (`params = $::jsonb`).
- `BR-PUB-23` Зміна `schedule`/каналу застосовується негайно (перезапуск cron через `config:changed`), зміни params — з наступного тіку.
- `BR-PUB-24` Поле «Low-content alert» зберігає `low_content_threshold` (ціле ≥ 0; порожнє = дефолт 100); використовується лише для підсвітки на сторінках каналів.
- `BR-PUB-25` Для `recipe-carousel` Post Preview збирає підпис із частин: частини з БД рецептів (назва, категорія, БЖВ) лише для читання; intro/cta/outro/hashtags/мітка Telegram-посилання редагуються й зберігаються в `params.metaCaption`; Instagram підпис без Telegram-посилання.
- `BR-PUB-26` «Example post» для типів із семплом у БД показує зразок («Sample from the content pool»), для стрічкових — останні елементи з `posted_news` («Example from recent history»); без зразка — плейсхолдер Lorem ipsum із поміткою.
- `BR-PUB-27` Блок «Meta cross-posting» створює/вмикає цілі в `meta_crosspost_targets`; дзеркалення виконується **після кожного Telegram-посту** каналу тими стратегіями, що викликають `CrossPostService.afterPublish`, з окремим cooldown на акаунт (Instagram 30, Facebook 15, Threads 10 хв).
- `BR-PUB-28` PATCH перевіряє існування `channel_id`, Meta/TikTok-акаунтів та підтримку платформи типом лише якщо передано відповідні поля.

**Бізнес-правила й обмеження.** `notes` ≤ 500 символів. Заборонено одночасно `channel_id` та `meta_account_id` (400). Поле Type у UI — вільний текст.

**Стани.** «Loading…»; «Strategy not found — it may have been deleted.»; помилки збереження — червоний рядок; для Post Preview — «Loading preview…» і текст помилки.

**Фонові процеси.** Див. 3.1 (reconcile). Попередній перегляд кешується клієнтом на 60 с.

**Звʼязки.** `/app/strategies`, `/app/connections*` (акаунти), `/app/channels` (канал, пауза).

**Спостереження «як фактично зараз».**
- Type — вільний текст: можна ввести неіснуючий тип або приховані (`daily-photo`, `ua-news`, `movies` присутні в datalist). PATCH не перевіряє, що тип зареєстрований, і не перевіряє його сумісність з уже збереженою платформою (перевірка лише якщо в тілі є `platform`). Привʼязка з невідомим типом лишається «enabled», але cron не реєструється.
- Блок «Meta cross-posting» показується й для Meta/TikTok-привʼязок, у яких `channel_id = null`; кнопка Add для них викликала б `/api/channels/null/crossposts`. Telegram-стратегії, що **не** викликають `afterPublish` (`network-digest`, `topic-digest`, `recipe-carousel`), не дзеркалять у Meta попри налаштовані цілі.
- Поле порогу низького запасу показується для `motivation-biography`, але реальний тип стратегії називається `birthday-strategy`: для нього поле не зʼявляється, а лічильник запасу повертає `null`.
- Попередній перегляд — не «наступний пост»: для `quotes`/`facts`/`recipes`/`assets`/`prompts` це 3 останні записи таблиці (`ORDER BY created_at DESC`) або перші питання ПДР, тоді як стратегія бере випадковий/найстарший нещойно опублікований запис. Для `recipe-carousel`, `network-digest`, `topic-digest`, `curated-prompts` перегляду немає («No preview implementation»).
- `TelegramPreview` рендерить HTML через `dangerouslySetInnerHTML`; текст зразка зі скрейпнутих таблиць (`facts`, `quotes`) вставляється без екранування.
- Зміна `type`/платформи/акаунта не перезапускає cron (diff лише за `schedule` і каналом), але привʼязка перечитується на кожному тіку, тож розбіжності немає.

**Відкриті питання до власника.** Чи обмежити Type переліком зареєстрованих типів? Чи прибрати блок крос-постингу для не-Telegram привʼязок? Який тип має бути канонічним — `birthday-strategy` чи `motivation-biography`?

---

### 3.4 Заплановані пости — `/app/scheduled`

**Бізнес-мета.** Показати чергу одноразових постів, складених вручну (і поставлених агентами, напр. рекламні розміщення), та дозволити їх змінити або скасувати.

**Хто користується / доступ.** Тільки після логіну; ендпоінти `/scheduled-posts*` захищені `TrackingAuthGuard`.

**Що показує.** `GET /scheduled-posts` (без пагінації, `ORDER BY scheduled_at DESC`, усі статуси) → таблиця `scheduled_publications`. Плитки: Scheduled (= **усі** рядки), Pending, Sent, Failed. Список «Queue»: індикатор статусу, дата/час (локальна часова зона браузера, формат «1 Oct 2026, 10:00»), відправник (Bot / MTProto), канал (назва з `/tracking/channels?filter=mine&pageSize=100`), бейдж статусу, іконка помилки з tooltip, текст без HTML-тегів (обрізаний).

**Дії користувача.**
| Дія | Що відбувається |
|---|---|
| New post | перехід на `/app/compose` |
| Edit (лише `pending`) | перехід на `/app/compose?id=<uuid>` |
| Cancel (лише `pending`, з підтвердженням) | `POST /scheduled-posts/:id/cancel` → `status='canceled'` |

**Бізнес-вимоги (as-is).**
- `BR-PUB-29` Система зберігає ручні пости в `scheduled_publications` зі статусами `pending`, `sending`, `sent`, `failed`, `canceled`, `unknown`.
- `BR-PUB-30` Edit і Cancel доступні лише для `pending`; PATCH/cancel на інший статус → 400 «post not found or not editable/pending».
- `BR-PUB-31` Cancel не видаляє рядок: пост лишається в списку зі статусом `canceled`; API видалення не існує.
- `BR-PUB-32` Плитка «Scheduled» показує загальну кількість рядків (включно з `sent`, `failed`, `canceled`), а не кількість очікуваних.
- `BR-PUB-33` Статус `unknown` (рядок «завис» у `sending` > 5 хв після збою процесу) позначається жовтим; такий пост **не відправляється повторно**; власник отримує DM-алерт і має перевірити канал та за потреби перепланувати вручну.
- `BR-PUB-34` Список не оновлюється автоматично (немає `refetchInterval`); актуальність — після перезавантаження/refocus вікна.
- `BR-PUB-35` Дані відображаються в часовій зоні браузера користувача, а не в Kyiv.

**Бізнес-правила й обмеження.** Список охоплює лише Telegram (іконка Telegram жорстко); канали в підписах беруться з перших 100 «моїх».

**Стани.** Скелетони під час завантаження; порожньо: «Nothing scheduled — Compose a post and pick a send time»; помилка API — червона картка.

**Фонові процеси.** `ScheduledPostsWorker` — `@Cron(EVERY_30_SECONDS)`, не допускає перекриття тіків; `publishDue()`: 1) переводить `sending` старші за 5 хв у `unknown` + DM-алерт; 2) у циклі `claimDue` (атомарно `UPDATE … FOR UPDATE SKIP LOCKED`, найстаріші першими) бере кожен `pending` з `scheduled_at <= now` і відправляє його послідовно.

**Звʼязки.** `/app/compose`; `/app/logs` (події «Scheduled post» з `scheduled_publications`); агентський контур (`agent-schedule.executor` створює рядки через `ScheduledPostsRepository.create`).

**Спостереження «як фактично зараз».**
- Заголовок «Scheduled posts in Telegram» і мітка «Scheduled» вводять в оману: тут **немає** запусків стратегій за кроном — вони видимі лише на Overview («Upcoming runs») і в списку стратегій.
- Пост, час якого минув під час простою сервісу, буде відправлено при першому тіку після старту без обмеження «давності» (немає порога прострочення).
- Список зростає без обмежень (немає пагінації, видалення чи архівації; `scheduled_publications` не входить у політики retention).
- Неможливо скасувати пост у статусі `sending`/`unknown` і повторити `failed` — потрібно створювати новий.

**Відкриті питання до власника.** Чи потрібна пагінація/фільтр за статусом (API підтримує `?status=`, UI не використовує)? Чи потрібен «Retry» для `failed`?

---

### 3.5 Календар / черга — `/app/calendar`

**Бізнес-мета.** (Задумано) Календарний огляд запланованих публікацій.

**Хто користується / доступ.** Тільки після логіну; у меню відсутня.

**Що показує.** Заголовок «Calendar / queue», підзаголовок «Scheduling publications» і картка-заглушка «Calendar soon — Queue and calendar of scheduled posts.».

**Дії користувача.** Немає. Запитів до API не робить.

**Бізнес-вимоги (as-is).**
- `BR-PUB-36` Сторінка `/app/calendar` є статичною заглушкою без даних та дій.
- `BR-PUB-37` Посилання на `/app/calendar` у навігації відсутні; сторінка досяжна лише за прямим URL.

**Бізнес-правила й обмеження.** Немає.

**Стани.** Один: заглушка.

**Фонові процеси.** Немає.

**Звʼязки.** Функціональний аналог — `/app/scheduled` (список) та `/app/editor` (слоти редактора).

**Спостереження «як фактично зараз».** Заглушка з часів першої версії; календарного відображення ні стратегій, ні ручних постів, ні слотів редактора не існує.

**Відкриті питання до власника.** Видалити маршрут чи реалізувати єдиний календар (стратегії + відкладені + слоти редактора)?

---

### 3.6 Новий / редагований пост — `/app/compose`

**Бізнес-мета.** Скласти один Telegram-пост (текст, медіа, кнопки-посилання) і поставити його на публікацію у вибраний час.

**Хто користується / доступ.** Тільки після логіну. Кнопка «New post» є в шапці кожної сторінки `/app/*`.

**Що показує.** Режим «New post» або (за `?id=`) «Edit post» — завантажується `GET /scheduled-posts/:id`. Зліва — редактор: канал (мої, до 100), відправник (**Bot** / **MTProto-user**), бот (для Bot; `useBots`), текст (Telegram HTML), лічильник `довжина/ліміт`, тип медіа (no media / photo / video) + URL + розміщення (above / below text), кнопки (url), `datetime-local` («local time»). Справа — прев’ю «бульбашки» Telegram. Вкладки платформ: Telegram активна, **Meta і TikTok вимкнені з міткою «soon»**.

**Дії користувача.**
| Дія | Що відбувається |
|---|---|
| Schedule | `POST /scheduled-posts` (новий) або `PATCH /scheduled-posts/:id` (редагування) → рядок `pending`; повернення на `/app/scheduled` |
| Cancel | повернення на `/app/scheduled` без збереження |
| «+ button» / ✕ | додає/видаляє кнопку (label + https-URL); UI формує лише **один ряд** кнопок |

Сама публікація відбувається **не** по натисканню кнопки, а воркером у вказаний час (див. 3.4).

**Бізнес-вимоги (as-is).**
- `BR-PUB-38` Сторінка планує пост лише в Telegram; публікації в Meta, TikTok чи Telegraph із неї немає.
- `BR-PUB-39` Час публікації обовʼязковий і має бути в майбутньому (перевіряється в UI за годинником браузера та на сервері: `scheduledAt` > now).
- `BR-PUB-40` Ліміти довжини (видимі символи без HTML-тегів): текст без медіа — 4096; з медіа — 1024 для Bot і 2048 для MTProto-user. Підпис 1025–2048 символів з фото/відео над текстом без кнопок вимагає MTProto-user (серверна помилка пояснює це).
- `BR-PUB-41` Для відправника Bot обовʼязково вибрати бота; бот має існувати в кеші конфігурації. Приналежність бота до каналу сервер **не** перевіряє.
- `BR-PUB-42` Кнопки доступні лише для Bot (MTProto-user не підтримує); при наявності кнопок відправник примусово перемикається на Bot; кожна кнопка вимагає непорожню мітку (≤ 64) і URL `http(s)://` (≤ 2048).
- `BR-PUB-43` Для photo/video обовʼязковий URL `http(s)`; медіа не завантажується на наш бік — Telegram (або MTProto-клієнт) сам тягне його за посиланням.
- `BR-PUB-44` MTProto-user не може розміщувати медіа «below text»; UI примусово ставить «above».
- `BR-PUB-45` Пост без тексту, медіа й кнопок відхиляється («post is empty»).
- `BR-PUB-46` Бот-відправка з розміщенням «above» і медіа — `sendPhoto`/`sendVideo` із підписом (`parse_mode=HTML`); у решті випадків — `sendMessage` із `link_preview_options` (медіа показується як превʼю посилання над/під текстом).
- `BR-PUB-47` MTProto-user відправка йде через сесію `TelegramStatsClient` (`parseMode: html`); якщо сесія не налаштована, пост отримає `failed` з помилкою «MTProto-user session not configured/ready» (перевірки при плануванні немає).
- `BR-PUB-48` Опублікований ручний пост індексується в `published_posts` зі `strategy_type='scheduled-post'` (заголовок — перший рядок тексту до 200 символів), тож потрапляє в збір статистики та дайджести.
- `BR-PUB-49` Ручний пост **не** проходить `guardText`, ліміт posting-cooldown (`POSTING_COOLDOWN_MIN`), не дзеркалиться в Meta (крос-постинг), не надсилає DM «✅ опубліковано».
- `BR-PUB-50` Перед відправкою воркер перевіряє канал: якщо `publish_paused=true` — пост стає `failed` («channel is paused (publish_paused)»), а не відкладається.

**Бізнес-правила й обмеження.** Тільки поля з DTO (`forbidNonWhitelisted`); `text` ≤ 4096; `mediaUrl` ≤ 2048. Валідація HTML не виконується — некоректні теги дадуть помилку Telegram під час відправки (`failed`).

**Стани.** «Loading post…» під час завантаження редагованого; список помилок валідації червоним над кнопкою; помилка сервера — під формою; кнопка «Saving…». Кнопка завжди називається «Schedule» (навіть у режимі Edit).

**Фонові процеси.** Воркер із 3.4; при помилці — одразу `failed` (повторних спроб немає); у разі успіху `status='sent'` і `message_id`.

**Звʼязки.** `/app/scheduled`; довідники каналів (`/tracking/channels`), ботів (`/app/bots`); MTProto-сесії (`/app/connections`).

**Спостереження «як фактично зараз».**
- Час вводиться через `datetime-local` у часовій зоні браузера (підпис «(local time)»), а не в Kyiv; у БД зберігається UTC. Якщо браузер не в Kyiv, час публікації зсунеться відносно очікуваного.
- Розміщення медіа «below text» у реальному пості — це лише превʼю посилання під текстом, тоді як превʼю в UI малює справжнє фото під текстом: розбіжність «прев’ю ≠ результат».
- Редактор кнопок генерує один ряд; бекенд підтримує кілька рядів.
- Немає вибору кількох каналів/платформ, немає шаблонів і «Publish now» (мінімум — майбутній час).
- Текст ставиться як є; AI-перевірки (`ReviewAgent`, `guardText`) не застосовуються.

**Відкриті питання до власника.** Чи потрібен «Publish now»? Чи треба обмежити вибір бота ботами каналу? Чи дзеркалити ручні пости в Meta?

---

## 4. Наскрізні правила розділу

### 4.1 Каталог типів стратегій (зареєстровані в `ContentStrategyRegistry`)

| Тип | Платформи | Джерело контенту | AI | Ключ дедупу | Примітки |
|---|---|---|---|---|---|
| `quotes` | TG | таблиця `quotes`, випадковий | ні | `posted[channel_key]` | `params.category`; 🎂 якщо автор має день народження (таблиця `birthdays`) |
| `facts` | TG | таблиця `facts` (faktypro), випадковий | ні | `posted[channel_key]` | `params.articleTitles`; позначає **до** публікації |
| `birthday-strategy` | TG | `birthdays` + Wikipedia | Claude + ReviewAgent | `posted[channel_key]` | на дату `CURRENT_DATE` БД |
| `pdr-quiz` | TG | `pdr_questions` послідовно (білет→питання) | ні | `posted[channel_key]` | Telegram quiz-poll; позначає **до** публікації |
| `recipes` | TG, IG, FB, Threads | таблиця `recipes` (найстаріший без `posted[key]`, з БЖВ) | Claude Sonnet — одноразовий переклад з кешем | `posted['TELEGRAM' / 'IG:<uuid>' / …]` | TG: Telegraph-сторінка + підпис; Meta: підпис + фото |
| `recipe-carousel` | TG, IG, FB, Threads, TikTok | рецепти, **вже опубліковані в TG** | ні (рендер 3 слайдів Satori) | `posted[postedKey]` | слайди хостяться (Supabase), після публікації видаляються; TikTok — 1080×1920 |
| `ai0-prompts` | TG, IG, FB, Threads | таблиця `prompts` + скрейп PromptHero | ні | `posted[postedKey]` | Meta — лише категорія `fashion`; TG — випадкова категорія з `config/sources/ai0-prompts.json` |
| `curated-prompts` | TG, IG, FB, Threads | таблиця `prompts` (GitHub-промпти) | ні | `posted[postedKey]` | `params.provider`, `params.mediaType`; відео — лише TG |
| `assets` | TG | таблиця `assets` за `params.dataSource` | Claude | `posted[channel_key]` | `params.posterUrl`, `params.tag` |
| `ai0-news` | TG | 5 фіксованих джерел у `config/sources/ai0-news.json` (RSS + HTTP) | PostGenerationAgent + семантичний дедуп | `posted_news` (глобально за URL) | форвард у канал за AI-темою |
| `ua-news` (прихований) | TG | RSS `params.feedUrl` | як у `ai0-news` | `posted_news` | не пропонується при створенні |
| `game-channel` | TG | GamerPower, Epic, Steam, новини | AI | `posted_news` | `params.sources`; чергування giveaway/інше |
| `space-news` | TG | SpaceNews API | Claude | `posted_news` | загальний конвеєр runner |
| `on-this-day` | TG | Byabbe API | Claude | `posted_news` | загальний конвеєр |
| `daily-photo` (прихований) | TG | NASA APOD | Claude (переклад) | `posted_news` | загальний конвеєр |
| `movies` (прихований) | TG | TMDB trending | Claude | `posted_news` | загальний конвеєр |
| `network-digest` | TG | `published_posts` власних каналів + знімки переглядів | ні | `posted_news` (`digest://network/<канал>/<дата Kyiv>`) | 3–8 пунктів, мін. за `minItems`; спонсорський слот |
| `topic-digest` | TG | `published_posts` за `params.strategyTypes` | Claude (переписує заголовки, з відкатом) | `posted_news` (`digest://topic/…`) | те саме |

Для 11 типів без `supportedPlatforms` дозволений лише Telegram. Дайджести не дзеркалюються в Meta (deep-link `t.me` там безглузді).

### 4.2 Конвеєр запуску (кожен тік крону)

1. `SchedulerService` перевіряє «in-flight» по `strategy:<ext_id>`: якщо попередній запуск ще триває — пише запуск `skipped` («previous run still in flight»).
2. Перечитує привʼязку (enabled? тип зареєстрований?), `DestinationResolver` визначає призначення: Telegram — `channel_key`; Meta — токен (зашифрований `token_enc`, інакше env із `token_env`), акаунт має бути `active`; TikTok — акаунт `active`.
3. Створюється рядок `strategy_runs` (`running`), далі `ContentStrategyRunner.run()` з жорстким таймаутом 5 хв (`STRATEGY_RUN_TIMEOUT_MS`).
4. Runner бере блокування на ключ призначення (`PostingThrottleService.tryLock`): відмова, якщо інша стратегія тримає канал або діє cooldown після останньої публікації → запуск `skipped`.
5. Типи з `execute()` керують усім самі; решта (`on-this-day`, `daily-photo`, `space-news`, `movies`) ідуть загальним конвеєром: fetch → дедуп → generate → review (`ReviewAgent`) → завантаження картинки → публікація → відмітка в дедуп-леджері → DM «✅» → `published_posts` → крос-постинг у Meta.
6. Статус запуску: `ok`; `skipped` (канал на паузі `ChannelPausedError`, cooldown/lock); `error` (будь-яке інше виключення, включно з таймаутом).

### 4.3 Часовий пояс (Kyiv)

- Cron-вирази стратегій обчислюються в `SCHEDULER_TZ`. **Код-дефолт — часовий пояс процесу (UTC у Docker)**, тобто опція «opt-in»: порожній `SCHEDULER_TZ` = UTC. `.env.example` має `SCHEDULER_TZ=` порожнім; у локальному `.env` значення `Europe/Kyiv` задано (з коментарем-застереженням, що розклад старих стратегій зсувається). У коментарі в `scheduler.service.ts` написано «Europe/Kyiv by default» — це неактуально.
- Дайджести завжди рахують «добу» за Kyiv (`kyivDate`, `Intl` `Europe/Kyiv`), незалежно від `SCHEDULER_TZ`. Рекомендований розклад дайджестів `*/10 19-20 * * *` розрахований на Kyiv; при `SCHEDULER_TZ=UTC` він спрацьовує о 22–23 за Kyiv (літо).
- Ручні пости: `scheduledAt` вводиться в часовій зоні **браузера**, зберігається в UTC (`timestamptz`); воркер порівнює з `now()`, дашборд показує знову в зоні браузера. Kyiv не застосовується ніде.
- Стратегії, що використовують «поточну дату» (`on-this-day`: `new Date().getMonth()/getDate()`) беруть дату за часовим поясом процесу, `birthday-strategy` і `quotes` — за `CURRENT_DATE` Postgres (зона сервера БД). При UTC на межі доби (00:00–03:00 Kyiv) «сьогодні» може бути вчорашнім.

### 4.4 Дедуп

- Два механізми: (а) JSONB-колонка `posted` у таблицях контенту (`recipes`, `quotes`, `facts`, `pdr_questions`, `prompts`, `assets`, `birthdays`) — ключ `channel_key` для `quotes`/`facts`/`pdr-quiz`/`assets`/`birthday-strategy`, але `'TELEGRAM'` / `IG:<uuid>` / `FB:<uuid>` / `TH:<uuid>` / `TT:<uuid>` для `recipes`, `recipe-carousel`, `ai0-prompts`, `curated-prompts` (тобто для Telegram дедуп **спільний на всі TG-канали**: два канали з `recipes` ділять один пул); (б) таблиця `posted_news` (`source_url`, `channel_id`) для стрічкових стратегій.
- `DedupService.filterUnposted` фільтрує **глобально за `source_url`** (а не по каналу): джерело, опубліковане в одному каналі, іншими каналами й стратегіями вже не публікується.
- Постійно непублікабельні елементи помічаються як «помилка» (`markError`: `posted_news.content_type='error'` або `posted:["error:<key>"]` / `status='ERROR'`), щоб черга не зациклювалась.
- Для `ai0-news`, `ua-news`, `facts`, `pdr-quiz`, `game-channel` запис у дедуп робиться **до** публікації (щоб збій процесу не дав дублікат): при збої публікації елемент втрачається назавжди.
- **`on-this-day`:** `sourceUrl` = `https://byabbe.se/on-this-day/<місяць>/<день>` без року, а дедуп глобальний і `posted_news` не очищується retention-політикою — кожна календарна дата публікується **один раз за всю історію системи** (наступного року той самий URL уже «posted» → «Already posted», запуск `ok` без поста), і лише в одному каналі.
- Дайджести: один на канал на добу Kyiv (сентинел `digest://…/<дата>`), решта тіків дня — no-op.
- Ручні пости дедупа не мають (кожен POST — окремий рядок).

### 4.5 Паузи та обмеження частоти

- **Привʼязка** `enabled=false` — cron не реєструється. **Канал** `publish_paused=true` — будь-яка публікація Telegram-стратегії кидає `ChannelPausedError` (у загальному конвеєрі запуск = `skipped`; у стратегіях, що самі ловлять помилку, — `ok`, див. 4.6), форварди в цей канал мовчки пропускаються, ручні пости стають `failed`.
- **Posting-cooldown** для Telegram: `POSTING_COOLDOWN_MIN` (дефолт 20 хв, змінюється на сторінці Settings без перезапуску) — мінімальний проміжок між публікаціями в один канал + взаємне блокування одночасних стратегій одного каналу. Стан **лише в памʼяті процесу** (`Map`): після перезапуску cooldown обнуляється; висячий lock живе максимум 10 хв (`LOCK_TTL_MS`). Другий екземпляр сервісу призведе до подвійних публікацій.
- **Meta-привʼязки** не мають cooldown у runner (блокування знімається після кожного тіку; частоту задає cron). Cooldown `INSTAGRAM_COOLDOWN_MIN`=30, `FACEBOOK_COOLDOWN_MIN`=15, `THREADS_COOLDOWN_MIN`=10 діє лише для **крос-постингу** з Telegram.
- Ручні відкладені пости cooldown не враховують і його не запускають.

### 4.6 Збої, повтори, сповіщення

- **Автоматичних повторів на рівні публікаторів немає.** Повтор = наступний спрацьовування cron. Тому для дайджестів стоїть розклад «кожні 10 хв 19:00–20:50».
- **Помилка публікації й статус запуску.** Загальний конвеєр і стратегії, які перекидають виключення (Meta/TikTok-гілки `recipes`, `recipe-carousel`, `ai0-prompts`, `curated-prompts`; Telegram-гілка `recipe-carousel`), дають `error`. Натомість в Telegram-гілках `recipes`, `quotes`, `ai0-news`, `ua-news`, `facts`, `pdr-quiz`, `game-channel`, `assets`, `curated-prompts`, `ai0-prompts`, `birthday-strategy`, `network-digest`, `topic-digest` виключення публікації перехоплюється й лише логується (деякі шлють `notifyFailed` DM) — запуск у журналі лишається `ok`.
- **Сповіщення власнику** (Telegram DM, потрібні `TELEGRAM_BOT_TOKEN` і `TELEGRAM_OWNER_ID`): «✅ опубліковано», «❌ збій» (у частині стратегій), «ℹ️ пропущено» (`ai0-news`), оперативні алерти (≥3 помилки поспіль, запуск завис >20 хв, пост завис у `sending`). Без токена/ID сповіщення мовчки вимкнені.
- **Збій одного з Meta-дзеркал** ізольований: не впливає на Telegram-публікацію й сусідні цілі; пишеться лише в трейс запуску/лог. Постійні помилки медіа Meta (`aspect ratio`, `unsupported`…) позначають рядок як виконаний для цього призначення, щоб черга рухалась.
- **Пауза каналу + відмітка «до публікації».** `ChannelPausedError` у цих стратегіях теж перехоплюється; оскільки `ai0-news`, `ua-news`, `facts`, `pdr-quiz`, `game-channel` уже встигли записати елемент у дедуп, кожен тік на паузованому каналі спалює один елемент контенту (в журналі — `ok`). Планувальник не перевіряє `publish_paused` до запуску.
- **Постійні помилки Telegram** (неправильний HTML, `PHOTO_INVALID`, `Publish blocked:`…) позначаються в дедупі як «error»; тимчасові (chat not found, flood, 5xx) — ні, елемент повториться наступного тіку.
- **Перезапуск сервісу:** запуски, що лишилися `running`, при старті стають `error` («interrupted: service restarted mid-run»); ручні пости в `sending` >5 хв → `unknown`. Таймаут запуску 5 хв **не скасовує** фактичну роботу — проміс продовжує виконуватись і може опублікувати вже після запису `error`.
- Журнал `strategy_runs` очищується політикою retention (90 діб, `STRATEGY_RUNS_RETENTION_DAYS`).

## 5. Шар публікаторів — що реально працює (`apps/automation/src/publishers`)

| Публікатор | Файл | Що робить | Статус |
|---|---|---|---|
| Telegram (стратегії) | `telegram.publisher.ts` | Bot API: текст (`sendMessage`), фото+підпис ≤1024, 1025–2048 — через MTProto-користувача (з відкатом на «фото + reply»), >2048 — фото + reply; `publishPrompt` (фото + підпис + reply), `publishVideo`, `forward`; `guardText` блокує текст <20 символів та AI-сміття (`SKIP_POST`, «as an ai», «"error":» …); перевірка `publish_paused` | працює |
| Telegram (ручні пости) | `composed-sender.service.ts` | Bot API (`sendPhoto`/`sendVideo`/`sendMessage` + inline-кнопки-URL) або MTProto-користувач; без throttle/guardText | працює |
| Telegram-сповіщення | `telegram-notifier.service.ts` | DM власнику | працює (за наявності токена й ID) |
| Instagram | `instagram.publisher.ts` | Graph API: контейнер → `media_publish`; одне зображення або карусель до 10; підпис ≤2200, ≤30 тегів; без зображення — виняток | працює; потрібен публічний URL зображення |
| Facebook | `facebook.publisher.ts` | `/photos` або `/feed`; альбом як `/feed` з кількома фото; підпис ≤60000 | працює |
| Threads | `threads.publisher.ts` | `graph.threads.net` (версія `v1.0`): TEXT/IMAGE/CAROUSEL; текст ≤500, без тегів | працює |
| TikTok | `tiktok/tiktok-carousel.publisher.ts` | Photo-carousel `DIRECT_POST`: init + опитування статусу до 10×3 с; приватність за `TIKTOK_PRIVACY_LEVEL` (**дефолт `SELF_ONLY`**, тобто пост видимий лише власнику акаунта); поза `recipe-carousel` (і дзеркала групи) не використовується | частково: лише фото-каруселі |
| Telegraph | `telegraph.service.ts` | створює сторінку з повним рецептом (токен з активного `telegraph_accounts` або env `TELEGRAPH_ACCESS_TOKEN`), кешує URL у `recipes`; при недоступності — відкат на inline-підпис + reply | працює тільки в `recipes` (TG) та редакторі (longread); сторінки «/app/telegraph» не належать до цього розділу |
| Диспетчер Meta | `publisher-dispatcher.service.ts` | маршрутизує `instagram`/`facebook`/`threads`; Telegram ним не обслуговується | працює |
| Крос-постинг | `cross-post.service.ts` | після TG-посту повторює його в ввімкнені цілі `meta_crosspost_targets` (режими `mirror`, `teaser`), cooldown на акаунт, не кидає виключень | працює для 11 стратегій з `execute()` та для загального конвеєра (`on-this-day`, `daily-photo`, `space-news`, `movies`); не викликається в `network-digest`, `topic-digest`, `recipe-carousel` |
| Групове дзеркалення | `common/content-strategy/group-fanout.service.ts` | якщо призначення — «джерело» групи (`source_platform`), той самий контент іде у всі інші акаунти групи: Meta (карусель/одиночний), TikTok (потрібно ≥1 зображення), Telegram (обкладинка + підпис) | працює для `recipe-carousel`, `ai0-prompts` (+ редактор) |
| Хостинг слайдів | `hosting/slide-hosting.service.ts` | тимчасове сховище (Supabase) для слайдів каруселі; видаляються після публікації | працює |

**Не підключено / відсутнє:** публікація стратегій у TikTok поза `recipe-carousel`; ручний пост у Meta/TikTok (вкладки «soon»); відео в Meta; повторні спроби й черга BullMQ для публікацій стратегій і ручних постів (усе в процесі через `@nestjs/schedule`/`cron`, BullMQ у цьому контурі не використовується); механізм «відкладена публікація» Meta/TikTok; перевірка статусу контейнера Instagram перед `media_publish`.

**Бізнес-вимоги (as-is) до шару публікаторів.**
- `BR-PUB-51` Система публікує Telegram-пости ботом каналу (`tracked_channels.bot_id`) або ботом за замовчуванням; якщо немає жодного — публікація кидає помилку «no bot bound and no default bot is set».
- `BR-PUB-52` Токени Meta/TikTok/ботів беруться спершу з зашифрованого поля `token_enc` (AES-256-GCM), потім з env-змінної, імʼя якої зберігає `token_env`; порожній токен → стратегія завершується помилкою призначення.
- `BR-PUB-53` Telegram-публікація стратегії обирає шлях за довжиною видимого тексту й наявністю зображення (≤1024 — підпис; ≤2048 — MTProto-користувач; інакше — фото + reply); збій reply після публікації фото не робить публікацію невдалою.
- `BR-PUB-54` Facebook-альбом та Instagram/Threads-карусель публікують зображення, завантажені на тимчасовий хостинг; після публікації копії видаляються (Facebook-фото з `published:false` лишаються на сторінці — відомий компроміс).
- `BR-PUB-55` Без зображення Instagram-публікація не виконується (крос-постинг мовчки пропускає такі пости зі статусом `skipped: no image`).
- `BR-PUB-56` TikTok-пост за замовчуванням публікується з рівнем приватності `SELF_ONLY`, поки в env не задано інший `TIKTOK_PRIVACY_LEVEL`.
- `BR-PUB-57` Реєстр типів визначає, які платформи дозволені для кожної стратегії; форма й API відхиляють неприпустиму комбінацію «тип + платформа» при створенні.

## 6. Глосарій розділу

| Термін | Значення |
|---|---|
| Привʼязка (binding) | рядок `strategy_bindings`: `ext_id`, `type`, місце призначення, `schedule`, `params`, `enabled` |
| `ext_id` | логічна назва стратегії (унікальна), напр. `recipes:local` |
| Призначення | Telegram-канал, Meta-акаунт (IG/FB/Threads) або TikTok-акаунт |
| `postedKey` | ключ дедупу в JSONB `posted`: `TELEGRAM`, `IG:<uuid>`, `FB:<uuid>`, `TH:<uuid>`, `TT:<uuid>` |
| Cooldown / lock | міжпостова пауза й блокування каналу в памʼяті процесу |
| Крос-постинг | повтор Telegram-посту в Meta після публікації (`mirror` / `teaser`) |
| Fan-out групи | дзеркалення контенту з «джерела» групи на решту її акаунтів |
| Ручний пост | рядок `scheduled_publications` (разовий) |

## 7. Джерела в коді

- Дашборд: `apps/dashboard/src/routes/app.strategies.tsx`, `app.strategies_.new.tsx`, `app.strategies_.$id.tsx`, `app.scheduled.tsx`, `app.calendar.tsx`, `app.compose.tsx`; `components/StrategyForm.tsx`, `SchedulePicker.tsx`, `CrosspostSection.tsx`, `post/PostComposer.tsx`, `post/TelegramPreview.tsx`, `AppShell.tsx`, `AppSidebar.tsx`; `api/strategies.ts`, `api/scheduled-posts.ts`, `api/crossposts.ts`; `lib/labels.ts`, `lib/strategy-types.ts`, `lib/runway.ts`, `lib/usePlatform.ts`.
- API/конфіг: `apps/automation/src/config/api/strategies.controller.ts`, `config/api/dto/strategies.dto.ts`, `config/strategy-bindings.repository.ts`, `config/strategy-runs.repository.ts`, `config/strategy-preview.service.ts`, `config/channel-config.service.ts`.
- Планувальник: `apps/automation/src/scheduler/scheduler.service.ts`, `scheduler/schedule-time-zone.ts`; `common/content-strategy/*` (runner, registry, destination-resolver, group-fanout, publish-destination); `common/alerting/alerting.service.ts`; `common/dedup/dedup.service.ts`; `common/content-runway/content-runway.service.ts`; `common/retention/retention.service.ts`.
- Стратегії: `apps/automation/src/strategies/*/*.strategy.ts` (+ репозиторії), дані фетчерів `apps/automation/src/workflows/*/fetchers`, `config/sources/ai0-news.json`, `config/sources/ai0-prompts.json`.
- Ручні пости: `apps/automation/src/scheduled-posts/*` (controller, service, worker, repository, `post-validation.ts`, `dto/composed-post.dto.ts`), `publishers/composed-sender.service.ts`.
- Публікатори: `apps/automation/src/publishers/*` (`telegram.publisher.ts`, `posting-throttle.service.ts`, `errors.ts`, `publisher-dispatcher.service.ts`, `instagram|facebook|threads.publisher.ts`, `meta-graph.util.ts`, `cross-post.service.ts`, `telegraph.service.ts`, `telegram-notifier.service.ts`, `tiktok/`, `hosting/`).
- Міграції: `database/migrations/005_config.sql`, `006_strategy_runs.sql`, `014_scheduled_publications.sql`, `019_strategy_low_content_threshold.sql`, `020_strategy_binding_destination.sql`, `024_strategy_binding_tiktok.sql`, `036_strategy_run_steps.sql`, `045_scheduled_publications_unknown.sql`.
- Специфікації: `specs/002-publish-correctness/spec.md`, `specs/009-strategy-retirement/spec.md` (18 «ручних» стратегій заплановано до заміни редактором).
