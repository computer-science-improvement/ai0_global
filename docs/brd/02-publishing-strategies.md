# BRD (as-is) — Публікація: стратегії (legacy), розклад, ручні пости

> Статус: оновлено з коду 2026-10-10 (коміт 54dd1eb, гілка feat/editor-agent). Описує, як система ФАКТИЧНО працює зараз, а не як мала б.

## Що змінилось з 2026-10-05

- **Стратегії стали legacy (spec 023 T7, фаза A).**
  - `/app/strategies` тепер лише для перегляду: стратегію можна поставити на паузу, змінити нотатки або видалити.
  - Створити чи увімкнути стратегію не можна: `POST /api/strategies` → 410, `PATCH` з будь-яким полем, крім `enabled:false` і `notes`, → 410.
  - Форму створення й редактори розкладу видалено, сторінка `/app/strategies/new` лише пояснює, що створення більше немає. У меню «Strategies» перенесено в останню групу «Legacy».
- **Перенесення стратегій в агентів (spec 023 T6).** Банер «Content is run by agents» на `/app/strategies` має кнопки Migrate (чернетка плейбука з серіями), Cutover (вимикає стратегії, агент переходить в `approve`) і Rollback. Є також CLI `migrate:strategies --dry-run`.
- **Видалення модулів стратегій (T7 фаза B) не виконано:** чекає рішення власника. Крон досі публікує всі увімкнені привʼязки.
- **Журнал контенту (spec 023 T1).** Публікації стратегій потрапляють у `content_ledger` через тригери на `data_items.posted` і `posted_news` та через `published_posts`. Агенти бачать, що вже опублікувала стратегія. Самі стратегії цей журнал не читають.
- **Дані (spec 032).** Таблиці `recipes`, `quotes`, `facts`, `prompts`, `pdr_questions`, `birthdays`, `assets` та інші тепер є views над `data_items`. Стратегії пишуть `posted` через ці views.
- **Календар (spec 027).** `/app/calendar` тепер перенаправляє на `/app/scheduled`; заглушку видалено. Пункт «Scheduled» у меню має бейдж ручних постів, що впали сьогодні.
- **Rich-повідомлення (spec 033).** Агентські Telegram-пости можуть іти через `sendRichMessage` з HTML-запасом. Legacy-стратегії й ручні пости цього не вміють.
- **Режим апруву й паузи (specs 031, 025).** Ручні пости й legacy-стратегії режим `approve` і паузи ресурсів (`resource_pauses`) не перевіряють.
- **Нові вимоги:** BR-PUB-58…67.
- **Видалені вимоги:** BR-PUB-11, 12, 13, 15, 16, 17, 18, 20, 21, 22, 24, 28, 36 (форма створення й редагування стратегій, заглушка календаря).

## 1. Призначення розділу

Розділ описує не-агентський контур публікації:
- **legacy-стратегії** — крон-розклад + джерело контенту + генерація + публікація в Telegram-канал, Meta-акаунт (Instagram / Facebook / Threads) або TikTok-акаунт. Їх переносять у серії агентів;
- **ручні відкладені пости** (`/app/compose` → `/app/scheduled`);
- **шар публікаторів**, який використовують і стратегії, і агенти.

Користувач — власник мережі (один оператор). Агенти, чат, апрув і реклама (`/app/editor`, `/app/agents`, `/app/chat`, `/app/ads`) описані в інших розділах; тут вони згадуються лише там, де пишуть у ті самі таблиці.

Ключова модель стратегії: **канал не має логіки, це лише точка публікації**; уся логіка — у стратегії. Один рядок `strategy_bindings` = «тип стратегії + розклад + місце призначення + params (JSON)». Нові рядки через UI чи API створити не можна. Основний шлях контенту тепер — серії агентів (документи 03, 04).

## 2. Сторінки розділу

| Сторінка | Маршрут | Коротко |
|---|---|---|
| Список стратегій (legacy) | `/app/strategies` | Банер перенесення в агентів; усі привʼязки: статус, розклад, наступний і останній запуск, пауза/видалення, журнал і превʼю |
| Нова стратегія | `/app/strategies/new` | Лише пояснення «Strategies can no longer be created» |
| Деталі стратегії | `/app/strategies/$id` | Лише перегляд: конфігурація, нотатки, пауза, цілі крос-постингу, приклад поста |
| Заплановані пости | `/app/scheduled` | Черга ручних (і рекламних) одноразових постів у Telegram; скасування й редагування |
| Новий / редагування поста | `/app/compose` (`?id=<uuid>`) | Редактор разового Telegram-поста з превʼю та вибором часу |

`/app/calendar` перенаправляє на `/app/scheduled` (spec 027). Кнопка **New post** у шапці дашборду і на `/app/scheduled` веде на `/app/compose`. У меню: «Compose» і «Scheduled» — у групі Publishing, «Strategies» — у групі Legacy.

## 3. Сторінки

### 3.1 Список стратегій — `/app/strategies`

**Бізнес-мета.** Показати власнику, які legacy-стратегії ще працюють, дати змогу поставити їх на паузу й перенести канал до агента.

**Хто користується / доступ.** Тільки після входу. Ендпоінти `/api/strategies*` і `/api/strategies/migration*` захищені `TrackingAuthGuard`.

**Що показує.**
- **Заголовок:** «Strategies», підзаголовок «Legacy: cron-scheduled generators bound to channels. Read-only — pause or migrate them to agents. Click a row to see its execution log.»
- **Банер «Content is run by agents»** (`components/strategies/MigrationBanner.tsx`, `GET /api/strategies/migration`):
  - Текст: «Strategies are legacy and read-only: you can pause them and edit notes, nothing else. Migrate each channel…».
  - Рядок на кожен канал із привʼязками:
    - бейдж стану: «No agent», «Not migrated», «Draft awaits approval», «Agent in shadow», «Ready for cutover», «Retired», «Nothing enabled»;
    - посилання `@agent` на вкладку Schedule;
    - лічильники «N enabled · N retired · agent mode X»;
    - статистика shadow: «N days in shadow, P% of N instances».
  - Кнопки **Migrate**, **Cutover**, **Rollback** і картки, що чекають рішення, з «Apply» / «Discard».
- **Список** (`GET /api/strategies`, оновлення кожні 30 с):
  - індикатор статусу, `ext_id`, тип, бейдж «retired» («Retired <дата>: the agent's series took over.») або «paused»;
  - посилання на серії агента («series X, Y · @handle →»);
  - бейдж «No bot», призначення, cron, «next in …», останній запуск (`ok` / `error` / `skipped` / `never`, давність, тривалість).
  - Вилучені рядки йдуть в кінці.
- **Фільтр платформи** `?platform=` (All / Telegram / Meta; TikTok вимкнено).
- **Розгорнутий рядок:** «Channels reached», «Next-up preview» (`GET /api/strategies/:id/preview`, до 3 елементів), «Execution log · last 20 runs» (`GET /api/strategies/:id/runs`, оновлення кожні 10 с).

**Дії користувача.**

| Дія | Що відбувається |
|---|---|
| Клік по рядку | розгортає або згортає деталі |
| Око | перехід на `/app/strategies/$id` |
| Pause (лише для увімкнених) | `PATCH /api/strategies/:id {enabled:false}` → подія Redis `config:changed` → крон знімається приблизно за 0,5 с |
| Delete (з підтвердженням) | `DELETE /api/strategies/:id` → рядок видаляється разом з історією `strategy_runs` (`ON DELETE CASCADE`) |
| Migrate | модальне вікно з пробним прогоном (`GET /api/strategies/migration/proposal?channel=`): як кожна увімкнена привʼязка лягає в серію, частоту чи не переноситься. «Create migration draft» створює й застосовує картку `migrate_strategies` |
| Cutover | підтвердження → застосування картки `strategy_cutover` |
| Rollback | застосування картки `strategy_rollback` |

**Бізнес-вимоги (as-is).**
- `BR-PUB-01` Система показує всі рядки `strategy_bindings` незалежно від платформи; вилучені (`retired_at`) — в кінці. Фільтр платформи лише ховає рядки на клієнті.
- `BR-PUB-02` Для кожної увімкненої стратегії `next_run_at` рахується тією ж бібліотекою `cron` і в тому ж часовому поясі (`SCHEDULER_TZ`), що й у планувальника; для призупинених — `null`.
- `BR-PUB-03` Колір індикатора: призупинена → нейтральний; `last_run.status = error` → червоний; інакше зелений. Статус `skipped` не вважається помилкою.
- `BR-PUB-04` Бейдж «No bot» зʼявляється лише для Telegram-привʼязок, у яких канал не має `bot_id` і в системі немає бота за замовчуванням.
- `BR-PUB-05` Стратегію можна лише поставити на паузу (`enabled=false`); увімкнути її з UI чи API не можна. `PATCH` з `enabled:true` повертає 410 `strategies_legacy`, а для вилученої привʼязки — 409 `binding_retired`. Ручного запуску «зараз» немає.
- `BR-PUB-06` Видалення стратегії незворотне, потребує підтвердження й каскадно видаляє журнал її запусків.
- `BR-PUB-07` Журнал запусків показує останні 20 записів `strategy_runs` (статуси `running`, `ok`, `error`, `skipped`, тривалість, текст помилки до 1000 символів).
- `BR-PUB-08` Панель «Channels reached» для Telegram-привʼязки показує primary-канал і всі канали-цілі forward-маршрутів з цього каналу. Це показується незалежно від того, чи стратегія справді форвардить (форвард роблять лише `ai0-news` і `ua-news` за AI-маршрутизацією тем).
- `BR-PUB-09` Для типів без реалізації превʼю API повертає `kind: 'unsupported'` з повідомленням; помилка превʼю не дає HTTP 500.
- `BR-PUB-10` Сторінка не показує запас контенту (`content_remaining`); його видно лише на `/app/channels` і `/app/channels/$id`.
- `BR-PUB-58` Банер показує для кожного каналу з привʼязками стан перенесення, агента, кількість увімкнених і вилучених привʼязок та статистику shadow. Картки, що чекають рішення, показуються, лише якщо створені за останні 24 год.
- `BR-PUB-59` Migrate працює так:
  - Будує пропозицію: крон переводиться в каденцію серії в часовому поясі ресурсу (за сьогоднішнім зсувом); Meta/TikTok-привʼязки отримують нативний формат платформи; дайджести стають джерелом «network highlights».
  - Записує версію плейбука `created_by='migration'` у статусі `pending_owner` і елемент Inbox `playbook_pending`; тон-скіли перенесених типів підʼєднуються до оркестратора.
  - Привʼязки при цьому продовжують публікувати.
  - Пропозиція відхиляється як `stale`, якщо привʼязки змінились, і як `nothing_to_migrate`, якщо нічого не переноситься.
- `BR-PUB-60` Cutover доступний, коли агент пропрацював у shadow ≥7 днів і реалізував ≥80 % очікуваних екземплярів серій; потрібен `EDITOR_ENABLED=true`, інакше 409 `editor_disabled`. Однією транзакцією:
  - картка й оркестратор переходять у `approve`;
  - перенесені привʼязки вимикаються з `retired_reason='migrated'` і `migrated_to={agent_id, handle, playbook_id, series[]}`.
  Щодня о 06:41 (часовий пояс процесу) система сама пропонує cutover, коли канал готовий.
- `BR-PUB-61` Rollback однією транзакцією знову вмикає привʼязки, вилучені для цього агента, і повертає оркестратор та картку в `shadow`. Пости, що чекали на апрув, при цьому скидаються.
- `BR-PUB-62` Поки в мережі є увімкнені привʼязки, перевести її агента чи картку в `live` не можна: 409 `bindings_still_enabled`. Для Telegram-якоря ця перевірка охоплює всю групу акаунтів. БД-обмеження `strategy_bindings_retired_chk` не дає вилученому рядку бути увімкненим.

**Бізнес-правила й обмеження.**
- Тип, не зареєстрований у `ContentStrategyRegistry`, не планується (лише WARN у лозі).
- Фільтр «Telegram» ховає Meta-привʼязки; TikTok-привʼязки видно лише на «All».
- CLI `pnpm --filter automation migrate:strategies --dry-run [--channel @key] [--json]` працює на read-only зʼєднанні й нічого не пише.

**Стани.**
- Завантаження: «Loading…»; помилка API — червоний текст.
- Порожньо: «No strategies» (на вкладці Meta — «No Meta-enabled strategies») з приміткою «Strategies are legacy: new content is planned and written by agents.» і кнопкою «Open Agents».
- Журнал без запусків: «No runs recorded yet…».

**Фонові процеси.**
- **`SchedulerService`.** На старті реєструє по одному `CronJob` на кожну увімкнену привʼязку зареєстрованого типу. Підписаний на Redis `config:changed`; з дебаунсом 500 мс робить `reconcile()`.
- **`AlertingService`** (кожні 15 хв) шле власнику DM: «🔴 Strategy … failed N× in a row» (≥3 помилки поспіль, `ALERT_CONSECUTIVE_ERRORS`) і «⏳ … stuck 'running'» (>20 хв, `ALERT_STUCK_RUNNING_MINUTES`). Вимикається `ALERT_ENABLED=false`.
- **`StrategyMigrationUpkeep`** (06:41) пропонує cutover.
- **Retention** видаляє `strategy_runs`, старші за 90 днів (`STRATEGY_RUNS_RETENTION_DAYS`, лише при `RETENTION_ENABLED=true`).

**Звʼязки.**
- Сторінки: `/app/agents/$handle?tab=schedule` (серії), `/app/agents/inbox` (чернетка плейбука), `/app/channels` (запас контенту, пауза каналу), `/app/logs`, Overview («Legacy strategy runs», «Errors»).
- Інтеграції: Telegram Bot API, Meta Graph API, TikTok Content API, Redis (`config:changed`).
- @ai0 має інструмент `propose_strategy_migration` (preview / migrate / cutover / rollback).

**Спостереження «як фактично зараз».**
- Увімкнені стратегії публікують **без апруву власника**, як і раніше. Режим `approve` і паузи ресурсів (`resource_pauses`, spec 025) на них не діють; діє лише пауза каналу `publish_paused`.
- Видалення лишилось, хоча банер каже «you can pause them and edit notes, nothing else».
- На свіжій БД без маркера `config_imported_<env>` бутовий імпорт з `config/channels.<env>.json` створює привʼязки з `enabled=true`. Це єдиний шлях створення, що залишився.
- Розклад показується в часовому поясі `SCHEDULER_TZ` (порожній = UTC у Docker), а серії агентів — у поясі ресурсу.
- Застарілі тексти:
  - підказка паузи в `lib/labels.ts` («won't fire until you enable it»), хоча увімкнути стратегію вже не можна;
  - коментар `scheduler.service.ts` («Europe/Kyiv by default»);
  - мертвий `CreateStrategyDto`.
- «Last run = ok» не гарантує, що пост вийшов: у багатьох стратегіях помилку публікації перехоплено всередині `execute()` (див. 4.6).
- Якщо канал на паузі (`publish_paused`), крон спрацьовує далі. Стратегії з відміткою «до публікації» (`ai0-news`, `ua-news`, `facts`, `pdr-quiz`, `game-channel`) при цьому спалюють елемент контенту (див. 4.4).

**Відкриті питання до власника.** Коли виконувати spec 023 T7 фазу B: видаляти модулі стратегій, планувальник і `ContentRunwayService`? Чи прибрати кнопку Delete до того часу, щоб зберегти історію запусків?

---

### 3.2 Нова стратегія — `/app/strategies/new`

**Бізнес-мета.** Пояснити, що створювати стратегії більше не можна (spec 023 FR-013).

**Що показує.** «New strategy» / «Strategies are legacy». Порожній стан «Strategies can no longer be created» з текстом: контент планують і пишуть агенти; щоб керувати серіями й розкладом, треба дати каналу агента. Посилання «Open Agents» і «Strategies page».

**Бізнес-вимоги (as-is).**
- ~~`BR-PUB-11`~~ видалено: форму створення прибрано (spec 023 T7).
- ~~`BR-PUB-12`~~ видалено: `ext_id` більше не задається і не перейменовується (spec 023 T7). Валідація лишилась лише в мертвому `CreateStrategyDto`.
- ~~`BR-PUB-13`~~ видалено: крон-вираз більше не вводиться (spec 023 T7).
- `BR-PUB-14` Через UI чи API нову привʼязку створити не можна: `POST /api/strategies` завжди повертає 410 `strategies_legacy`.
- ~~`BR-PUB-15`~~ видалено: перевірка «тип підтримує платформу» при створенні зникла разом зі створенням (spec 023 T7).
- ~~`BR-PUB-16`~~ видалено: вибору призначення немає (spec 023 T7).
- ~~`BR-PUB-17`~~ видалено: створення немає; `config:changed` тепер публікує лише пауза (spec 023 T7).
- ~~`BR-PUB-18`~~ видалено: форми з params немає (spec 023 T7).

---

### 3.3 Деталі стратегії — `/app/strategies/$id`

**Бізнес-мета.** Показати налаштування legacy-стратегії, приклад поста й куди вона дзеркалить; дати поставити її на паузу.

**Хто користується / доступ.** Тільки після входу.

**Що показує.** Дані беруться зі списку `GET /api/strategies` (окремого ендпоінта однієї стратегії немає).
- **«Configuration»:** Type, Destination, Schedule, Status, Last run.
- **«Legacy strategy»:**
  - Callout «Strategies are read-only: you can pause this one and keep notes. To change what or when it publishes, migrate the channel to its agent on the Strategies page.» Для вилученої: «Retired <дата>: the agent's series took over.» і посилання на серії.
  - Поля лише для перегляду: «Name (id)», «Destination», «Schedule (cron)», «Params» (JSON).
  - «Notes (optional)» з кнопкою «Save notes».
  - «Status» з кнопкою «Pause» (лише для увімкненої; підказка «Stop this strategy. It cannot be enabled again from here.»).
  - Блок «Meta cross-posting» (лише для Telegram-привʼязок).
- **«Example post»:** превʼю `GET /api/strategies/:id/preview` у вигляді Telegram-бульбашки.
- **Для `recipe-carousel` — «Post Preview»:** вкладки Facebook / Instagram / Threads / Telegram з частинами підпису (`GET /api/strategies/:id/post-preview`) і callout «Read-only: strategies are legacy, so their caption overrides no longer change. Instagram omits the Telegram link.»

**Дії користувача.**

| Дія | Що відбувається |
|---|---|
| Save notes | `PATCH /api/strategies/:id {notes}` |
| Pause | `PATCH /api/strategies/:id {enabled:false}` |
| Meta cross-posting → Add / Enable / Disable / Delete | `POST/PATCH/DELETE /api/channels/:channelId/crossposts[/id]`: цілі дзеркалювання Telegram-каналу в Meta (режим `mirror` або `teaser`; для Instagram лише `mirror`) |

**Бізнес-вимоги (as-is).**
- `BR-PUB-19` `PATCH /api/strategies/:id` приймає лише `enabled:false` і `notes`. Будь-яке інше поле (тип, розклад, params, канал, поріг запасу, увімкнення) → 410 `strategies_legacy` зі списком `refused[]`. Невідомі поля відсікає глобальна валідація з 400 ще до контролера.
- ~~`BR-PUB-20`~~ видалено: часткового редагування полів більше немає (spec 023 T7).
- ~~`BR-PUB-21`~~ видалено: перейменування `ext_id` неможливе (spec 023 T7).
- ~~`BR-PUB-22`~~ видалено: params не редагуються (spec 023 T7).
- `BR-PUB-23` Пауза публікує подію `config:changed` (`strategy`), і крон знімається без рестарту.
- ~~`BR-PUB-24`~~ видалено: поріг «Low-content alert» не редагується. Збережений `low_content_threshold` і далі підсвічує запас на сторінках каналів (spec 023 T7).
- `BR-PUB-25` Для `recipe-carousel` Post Preview збирає підпис із частин: з рецепта (назва, категорія, БЖВ) і зі збереженого `params.metaCaption` (intro, cta, outro, hashtags, мітка Telegram-посилання). Усе лише для перегляду. В Instagram підпис іде без Telegram-посилання.
- `BR-PUB-26` «Example post» для типів із зразком у БД показує «Sample from the content pool», для стрічкових — останні елементи з `posted_news` («Example from recent history»). Без зразка показується плейсхолдер Lorem ipsum із поміткою.
- `BR-PUB-27` Блок «Meta cross-posting» створює й вмикає цілі в `meta_crosspost_targets` (це досі дозволено). Дзеркалювання виконується після кожного Telegram-посту каналу тими стратегіями, що викликають `CrossPostService.afterPublish`, з окремим cooldown на акаунт: Instagram 30, Facebook 15, Threads 10 хв.
- ~~`BR-PUB-28`~~ видалено: перевірок полів при редагуванні немає, бо редагування немає (spec 023 T7).

**Бізнес-правила й обмеження.** `notes` ≤ 500 символів.

**Стани.** «Loading…»; «Strategy not found — it may have been deleted.»; помилки збереження — червоний рядок.

**Фонові процеси.** Див. 3.1. Превʼю кешується клієнтом на 60 с.

**Звʼязки.** `/app/strategies`, `/app/agents/$handle` (серії після перенесення), `/app/connections*` (акаунти), `/app/channels` (канал, пауза).

**Спостереження «як фактично зараз».**
- Цілі крос-постингу Telegram-каналу досі можна змінювати зі сторінки legacy-стратегії: вони належать каналу, а не стратегії. Коментар у `CrosspostSection.tsx` ще згадує «Edit-strategy modal».
- Стратегії `network-digest`, `topic-digest` і `recipe-carousel` не викликають `afterPublish` і не дзеркалять у Meta попри налаштовані цілі.
- Лічильник запасу для дня народження ключований як `motivation-biography`, а зареєстрований тип — `birthday-strategy`. Тому запас для цих привʼязок завжди `null`.
- Превʼю — не «наступний пост»: для `quotes` / `facts` / `recipes` / `assets` / `prompts` це 3 останні записи, тоді як стратегія бере випадковий або найстаріший неопублікований. Для `recipe-carousel`, `network-digest`, `topic-digest`, `curated-prompts` превʼю немає.
- `TelegramPreview` рендерить HTML зразка через `dangerouslySetInnerHTML` без екранування.

**Відкриті питання до власника.** Немає (решту закриває T7 фаза B).

---

### 3.4 Заплановані пости — `/app/scheduled`

**Бізнес-мета.** Показати чергу одноразових Telegram-постів, складених вручну або створених для реклами, і дати їх змінити чи скасувати.

**Хто користується / доступ.** Тільки після входу; ендпоінти `/scheduled-posts*` захищені `TrackingAuthGuard`.

**Що показує.** «Scheduled» / «Scheduled posts in Telegram». Дані: `GET /scheduled-posts` (без пагінації, `ORDER BY scheduled_at DESC`, усі статуси) → таблиця `scheduled_publications`.
- **Плитки:** Scheduled (усі рядки), Pending, Sent, Failed (лише `failed`).
- **Список «Queue»:**
  - індикатор статусу;
  - дата й час у часовому поясі браузера («1 Oct 2026, 10:00»);
  - відправник (Bot / MTProto);
  - канал (назва з `/tracking/channels?filter=mine&pageSize=100`);
  - бейдж статусу, іконка помилки з підказкою;
  - текст без HTML-тегів (обрізаний).

Слоти агентів, серії й запуски стратегій тут не показуються.

**Дії користувача.**

| Дія | Що відбувається |
|---|---|
| New post | перехід на `/app/compose` |
| Edit (лише `pending`) | перехід на `/app/compose?id=<uuid>` |
| Cancel (лише `pending`, з підтвердженням) | `POST /scheduled-posts/:id/cancel` → `status='canceled'` |

**Бізнес-вимоги (as-is).**
- `BR-PUB-29` Ручні пости зберігаються в `scheduled_publications` зі статусами `pending`, `sending`, `sent`, `failed`, `canceled`, `unknown`.
- `BR-PUB-30` Edit і Cancel доступні лише для `pending`. PATCH або cancel для іншого статусу → 400 «post not found or not editable (must be pending)» / «… not pending».
- `BR-PUB-31` Cancel не видаляє рядок: пост лишається в списку зі статусом `canceled`. API видалення немає.
- `BR-PUB-32` Плитка «Scheduled» показує загальну кількість рядків (з `sent`, `failed`, `canceled`), а не кількість тих, що чекають.
- `BR-PUB-33` Рядок, що «завис» у `sending` понад 5 хв після збою процесу, отримує статус `unknown` і жовту позначку. Такий пост **повторно не відправляється**. Власник отримує DM-алерт і має сам перевірити канал і за потреби перепланувати пост.
- `BR-PUB-34` Список сам не оновлюється (немає `refetchInterval`). Дані оновлюються при поверненні у вкладку, після мутацій або перезавантаження.
- `BR-PUB-35` Час показується в часовому поясі браузера, а не в Kyiv.
- `BR-PUB-63` Бейдж пункту меню «Scheduled» рахує ручні пости зі статусом `failed` або `unknown`, оновлені з київської півночі.
- `BR-PUB-64` Окрім Compose, рядки `scheduled_publications` створює лише `AgentScheduleExecutor`: після апруву власником дії `schedule_post` у DM inbox, зокрема для оплачених рекламних замовлень. Якщо `EDITOR_ENABLED=true` і канал має картку редактора, оплачене замовлення натомість резервує слот агента. Такі рядки обходять `validateComposedPost` і перевірки каналу/бота.

**Бізнес-правила й обмеження.** Список охоплює лише Telegram. Назви каналів беруться з перших 100 «моїх».

**Стани.** Скелетони під час завантаження. Порожньо: «Nothing scheduled — Compose a post and pick a send time — it will queue up here.» Помилка API — текст помилки.

**Фонові процеси.** `ScheduledPostsWorker` — `@Cron(EVERY_30_SECONDS)` без перекриття тіків:
1. переводить `sending`, старші за 5 хв, в `unknown` і шле DM-алерт;
2. у циклі `claimDue` (`FOR UPDATE SKIP LOCKED`, найстаріші першими) бере кожен `pending` з `scheduled_at <= now` і відправляє послідовно.

**Звʼязки.** `/app/compose`; `/app/logs` (події «Scheduled post»); `/app/dm` (апрув `schedule_post`); `/app/ads` (замовлення).

**Спостереження «як фактично зараз».**
- Пост, час якого минув під час простою сервісу, відправляється на першому тіку після старту без обмеження «давності».
- Список росте без обмежень: немає пагінації, видалення, архівації, retention. API підтримує `?status=`, UI — ні.
- Скасувати `sending`/`unknown` або повторити `failed` не можна: потрібно створювати новий пост.
- Діалог скасування має червону кнопку з написом «Delete», хоча рядок не видаляється.
- Рекламний рядок без бота отримає `failed` («bot not found») лише в момент відправки.

**Відкриті питання до власника.** Чи потрібні фільтр за статусом і «Retry» для `failed`? Чи об'єднувати цю сторінку зі слотами агентів у спільний календар (spec 027 відклав)?

---

### 3.5 Календар — `/app/calendar` (перенаправлення)

**Бізнес-вимоги (as-is).**
- ~~`BR-PUB-36`~~ видалено: заглушку календаря прибрано (spec 027).
- `BR-PUB-37` `/app/calendar` одразу перенаправляє на `/app/scheduled` (із заміною історії). Календарного відображення немає.

---

### 3.6 Новий / редагований пост — `/app/compose`

**Бізнес-мета.** Скласти один Telegram-пост (текст, медіа, кнопки-посилання) і поставити його на публікацію у вибраний час.

**Хто користується / доступ.** Тільки після входу. Кнопка «New post» є в шапці кожної сторінки `/app/*`.

**Що показує.**
- Режим «New post» («Compose a Telegram post and pick a future time to publish it to a channel.») або, за `?id=`, «Edit post»; у режимі редагування пост вантажиться з `GET /scheduled-posts/:id`.
- **Ліворуч — редактор:**
  - канал (мої, до 100);
  - відправник **Bot** / **MTProto-user**; бот (для Bot);
  - текст (Telegram HTML) з лічильником `довжина/ліміт`;
  - тип медіа (no media / photo / video), URL, розміщення (above / below text);
  - кнопки (url);
  - `datetime-local` з підписом «(local time)».
- **Праворуч** — превʼю бульбашки Telegram.
- Вкладки платформ: активна лише Telegram; **Meta і TikTok вимкнені з позначкою «soon»**.

**Дії користувача.**

| Дія | Що відбувається |
|---|---|
| Schedule | `POST /scheduled-posts` (новий) або `PATCH /scheduled-posts/:id` → рядок `pending`; повернення на `/app/scheduled` |
| Cancel | повернення на `/app/scheduled` без збереження |
| «+ button» / ✕ | додає або видаляє кнопку (label + https-URL); UI формує лише **один ряд** кнопок |

Публікація відбувається **не** по кнопці, а воркером у вказаний час (див. 3.4).

**Бізнес-вимоги (as-is).**
- `BR-PUB-38` Сторінка планує пост лише в Telegram; публікації в Meta, TikTok чи Telegraph із неї немає.
- `BR-PUB-39` Час публікації обовʼязковий і має бути в майбутньому. Це перевіряється в UI за годинником браузера і на сервері (`scheduledAt` > now).
- `BR-PUB-40` Ліміти довжини (видимі символи без HTML-тегів): текст без медіа — 4096; з медіа — 1024 для Bot і 2048 для MTProto-user. Підпис 1025–2048 символів з медіа над текстом без кнопок потребує MTProto-user (серверна помилка це пояснює).
- `BR-PUB-41` Для відправника Bot обовʼязково вибрати бота, і бот має існувати. Приналежність бота до каналу сервер **не** перевіряє.
- `BR-PUB-42` Кнопки доступні лише для Bot (MTProto-user їх не підтримує). Якщо є кнопки, відправник примусово перемикається на Bot. Кожна кнопка потребує непорожньої мітки (≤ 64) і URL `http(s)://` (≤ 2048).
- `BR-PUB-43` Для photo/video обовʼязковий URL `http(s)`. Медіа не завантажується на наш бік: Telegram або MTProto-клієнт сам тягне його за посиланням.
- `BR-PUB-44` MTProto-user не може ставити медіа під текстом; UI примусово ставить «above».
- `BR-PUB-45` Пост без тексту, медіа й кнопок відхиляється («post is empty»).
- `BR-PUB-46` Бот з медіа над текстом відправляє `sendPhoto`/`sendVideo` з підписом (`parse_mode=HTML`). В інших випадках іде `sendMessage` з `link_preview_options`: медіа показується як превʼю посилання над або під текстом.
- `BR-PUB-47` MTProto-user відправляє через сесію користувацького клієнта (`parseMode: html`). Якщо сесія не налаштована, пост отримує `failed` з помилкою «MTProto-user session not configured/ready». При плануванні це не перевіряється.
- `BR-PUB-48` Опублікований ручний пост записується в `published_posts` зі `strategy_type='scheduled-post'` (заголовок — перший рядок тексту до 200 символів), тож потрапляє в збір статистики й дайджести.
- `BR-PUB-49` Ручний пост **не** проходить `guardText`, ліміт `POSTING_COOLDOWN_MIN`, крос-постинг у Meta, DM «✅ опубліковано», режим апруву (spec 031) і паузи ресурсів (`resource_pauses`, spec 025).
- `BR-PUB-50` Перед відправкою воркер перевіряє канал: якщо `publish_paused=true`, пост стає `failed` («channel is paused (publish_paused)») і не відкладається.
- `BR-PUB-65` Compose не підтримує rich-повідомлення (spec 033): текст іде як Telegram HTML, а превʼю — простий компонент без rich-блоків.

**Бізнес-правила й обмеження.**
- DTO приймає лише свої поля (`forbidNonWhitelisted`); `mediaUrl` ≤ 2048.
- `text` ≤ 4096 рахується в DTO **разом з тегами**, а в UI — без тегів.
- HTML не валідується: некоректні теги дадуть помилку Telegram при відправці (`failed`).

**Стани.** «Loading post…» під час завантаження редагованого поста. Помилки валідації — червоним над кнопкою («Select a channel», «Publish time must be in the future», …). Помилка сервера показується під формою і додатково глобальним тостом. Кнопка «Saving…». Кнопка завжди «Schedule», навіть у режимі Edit.

**Фонові процеси.** Воркер із 3.4. При помилці пост одразу отримує `failed`, повторів немає. При успіху — `status='sent'` і `message_id`.

**Звʼязки.** `/app/scheduled`; довідники каналів (`/tracking/channels`) і ботів (`/app/connections?section=telegram&tab=bots`); MTProto-сесії (`/app/connections`).

**Спостереження «як фактично зараз».**
- Час вводиться через `datetime-local` у часовому поясі браузера, а не в Kyiv; у БД зберігається UTC.
- «Below text» у реальному пості — лише превʼю посилання під текстом, а превʼю в UI малює справжнє фото під текстом.
- Для Bot з медіа ліміт 1024 діє і при розміщенні «below», хоча тоді йде `sendMessage` (4096).
- Редактор кнопок створює один ряд; бекенд підтримує кілька.
- Немає вибору кількох каналів чи платформ, шаблонів і «Publish now».

**Відкриті питання до власника.** Чи потрібен «Publish now»? Чи обмежити вибір бота ботами каналу? Чи мають ручні пости проходити паузу ресурсу?

---

## 4. Наскрізні правила розділу

### 4.1 Каталог типів legacy-стратегій (зареєстровані в `ContentStrategyRegistry`)

Зареєстровано 18 типів. Прихованими в `GET /api/strategies/types` лишаються `daily-photo`, `ua-news`, `movies`. Еквіваленти в агентів: `fetch_api` (NASA APOD, Spaceflight News, TMDB, Epic, Steam, GamerPower, On this day), `query_data` / `search_library` (датасети), `fetch_feed` (RSS), `get_network_highlights` (дайджести).

| Тип | Платформи | Джерело контенту | AI | Ключ дедупу | Примітки |
|---|---|---|---|---|---|
| `quotes` | TG | датасет `quotes`, випадковий | ні | `posted[channel_key]` | `params.category`; 🎂, якщо в автора день народження (`birthdays`) |
| `facts` | TG | датасет `facts` (faktypro), випадковий | ні | `posted[channel_key]` | `params.articleTitles`; позначає **до** публікації |
| `birthday-strategy` | TG | `birthdays` + Wikipedia | Claude + ReviewAgent | `posted[channel_key]` | на дату `CURRENT_DATE` БД |
| `pdr-quiz` | TG | `pdr_questions` послідовно (білет → питання) | ні | `posted[channel_key]` | Telegram quiz-poll; позначає **до** публікації |
| `recipes` | TG, IG, FB, Threads | датасет `recipes` (найстаріший без `posted[key]`, з БЖВ) | Claude Sonnet — разовий переклад з кешем | `posted['TELEGRAM' / 'IG:<uuid>' / …]` | TG: Telegraph-сторінка + підпис; Meta: підпис + фото |
| `recipe-carousel` | TG, IG, FB, Threads, TikTok | рецепти, **вже опубліковані в TG** | ні (3 слайди Satori) | `posted[postedKey]` | слайди хостяться (Supabase) і видаляються після публікації; TikTok — 1080×1920 |
| `ai0-prompts` | TG, IG, FB, Threads | датасет `prompts` + скрейп PromptHero | ні | `posted[postedKey]` | Meta — лише категорія `fashion`; TG — випадкова категорія з `config/sources/ai0-prompts.json` |
| `curated-prompts` | TG, IG, FB, Threads | датасет `prompts` (GitHub-промпти) | ні | `posted[postedKey]` | `params.provider`, `params.mediaType`; відео — лише TG |
| `assets` | TG | датасет `assets` за `params.dataSource` | Claude | `posted[channel_key]` | `params.posterUrl`, `params.tag` |
| `ai0-news` | TG | 5 фіксованих джерел у `config/sources/ai0-news.json` (RSS + HTTP) | PostGenerationAgent + семантичний дедуп | `posted_news` (глобально за URL) | форвард у канал за AI-темою |
| `ua-news` (прихований) | TG | RSS `params.feedUrl` | як у `ai0-news` | `posted_news` | — |
| `game-channel` | TG | GamerPower, Epic, Steam, новини | AI | `posted_news` | `params.sources`; чергування giveaway та інших постів |
| `space-news` | TG | SpaceNews API | Claude | `posted_news` | загальний конвеєр runner |
| `on-this-day` | TG | Byabbe API | Claude | `posted_news` | загальний конвеєр |
| `daily-photo` (прихований) | TG | NASA APOD | Claude (переклад) | `posted_news` | загальний конвеєр |
| `movies` (прихований) | TG | TMDB trending | Claude | `posted_news` | загальний конвеєр |
| `network-digest` | TG | `published_posts` власних каналів + знімки переглядів | ні | `posted_news` (`digest://network/<канал>/<дата Kyiv>`) | 3–8 пунктів, мінімум за `minItems`; спонсорський слот |
| `topic-digest` | TG | `published_posts` за `params.strategyTypes` | Claude (переписує заголовки, з відкатом) | `posted_news` (`digest://topic/…`) | те саме |

Для 14 типів без `supportedPlatforms` дозволений лише Telegram. Дайджести не дзеркалюються в Meta. Логіка вибору для дайджестів тепер спільна з інструментом агентів (`src/common/digests/`).

### 4.2 Конвеєр запуску (кожен тік крону)

1. `SchedulerService` перевіряє «in-flight» по `strategy:<ext_id>`. Якщо попередній запуск ще триває, пише запуск `skipped` («previous run still in flight»).
2. Перечитує привʼязку (увімкнена? тип зареєстрований?). `DestinationResolver` визначає призначення:
   - Telegram — `channel_key`;
   - Meta — токен (`token_enc`, інакше env із `token_env`), акаунт має бути `active`;
   - TikTok — акаунт `active`.
3. Створює рядок `strategy_runs` (`running`) і запускає `ContentStrategyRunner.run()` з таймаутом 5 хв (`STRATEGY_RUN_TIMEOUT_MS`).
4. Runner бере блокування на ключ призначення (`PostingThrottleService.tryLock`). Якщо канал тримає інша стратегія або діє cooldown, запуск стає `skipped`.
5. Типи з `execute()` роблять усе самі. Решта (`on-this-day`, `daily-photo`, `space-news`, `movies`) іде загальним конвеєром: fetch → дедуп → generate → review (`ReviewAgent`) → завантаження картинки → публікація → відмітка в дедупі → DM «✅» → `published_posts` → крос-постинг у Meta.
6. Статус запуску:
   - `ok`;
   - `skipped` (канал на паузі `ChannelPausedError`, cooldown/lock);
   - `error` (будь-яке інше виключення, зокрема таймаут).
7. Виклики LLM пишуться в `llm_usage` і підпадають під блокувальні ліміти spec 029. Якщо ліміт перевищено, стратегія пропускає пост.

### 4.3 Часовий пояс

- **Крон стратегій** рахується в `SCHEDULER_TZ`. Якщо змінна порожня, береться пояс процесу (UTC у Docker). `.env.example` має `SCHEDULER_TZ=` порожнім; коментар «Europe/Kyiv by default» у `scheduler.service.ts` неправдивий.
- **Серії агентів** рахуються в поясі ресурсу (spec 024: картка Telegram → профіль → Kyiv). При перенесенні часи крону переводяться в пояс ресурсу за сьогоднішнім зсувом, і система попереджає про це.
- **Дайджести** рахують добу за Kyiv. Рекомендований розклад `*/10 19-20 * * *` розраховано на Kyiv; при UTC він спрацьовує о 22–23 за Kyiv (влітку).
- **Ручні пости:** `scheduledAt` вводиться в поясі браузера, зберігається в UTC і показується знову в поясі браузера.
- **Поточна дата:** `on-this-day` бере дату за поясом процесу, `birthday-strategy` і `quotes` — за `CURRENT_DATE` Postgres. Тому з 00:00 до 03:00 за Kyiv «сьогодні» може бути вчорашнім.

### 4.4 Дедуп

- **Два старі механізми:**
  - (а) JSONB `posted` у датасетах. Тепер це `data_items.posted`: стратегії пишуть його через views `recipes`, `quotes`, `facts`, `pdr_questions`, `prompts`, `assets`, `birthdays`.
    - Ключ `channel_key` — для `quotes` / `facts` / `pdr-quiz` / `assets` / `birthday-strategy`.
    - Ключі `'TELEGRAM'` / `IG:<uuid>` / `FB:<uuid>` / `TH:<uuid>` / `TT:<uuid>` — для `recipes`, `recipe-carousel`, `ai0-prompts`, `curated-prompts`. Тобто для Telegram дедуп **спільний на всі канали**.
  - (б) таблиця `posted_news` (`source_url`, `channel_id`) для стрічкових стратегій.
- `DedupService.filterUnposted` фільтрує **глобально за `source_url`**: джерело, опубліковане в одному каналі, іншими каналами вже не публікується.
- `BR-PUB-67` Публікації стратегій потрапляють у спільний журнал `content_ledger` (origin `strategy`) трьома шляхами: тригерами на `data_items.posted` і `posted_news` та записом у `published_posts`. Тож агенти не повторюють контент, який уже опублікувала стратегія. Самі стратегії обирають елементи лише за старими механізмами і `content_ledger` не читають, тож можуть повторити контент, який уже опублікував агент.
- **Непублікабельні елементи** позначаються як «помилка» (`posted_news.content_type='error'` або `posted:["error:<key>"]` / `status='ERROR'`), щоб черга не зациклювалась. У журналі контенту статус `error` блокує елемент для всіх.
- **Відмітка «до публікації».** Для `ai0-news`, `ua-news`, `facts`, `pdr-quiz`, `game-channel` запис у дедуп робиться **до** публікації: при збої публікації елемент втрачається назавжди.
- **`on-this-day`.** `sourceUrl` = `https://byabbe.se/on-this-day/<місяць>/<день>` без року, а дедуп глобальний. Тому кожна дата публікується **один раз за всю історію системи** і лише в одному каналі.
- **Дайджести:** один на канал на добу Kyiv (сентинел `digest://…/<дата>`).
- **Ручні пости** дедупу не мають.

### 4.5 Паузи та обмеження частоти

- **Привʼязка** з `enabled=false` — крон не реєструється.
- **Канал** з `publish_paused=true`:
  - Публікація Telegram-стратегії кидає `ChannelPausedError`. У загальному конвеєрі запуск стає `skipped`, у стратегіях, що самі ловлять помилку, — `ok` (див. 4.6).
  - Форварди в цей канал мовчки пропускаються.
  - Ручні пости стають `failed`.
- **Паузи ресурсів від MANAGER** (`resource_pauses`, spec 025) діють лише на агентів. Стратегії й ручні пости їх не перевіряють.
- **Posting-cooldown для Telegram:** `POSTING_COOLDOWN_MIN` (за замовчуванням 20 хв, змінюється в Settings без рестарту) — мінімальний проміжок між публікаціями в один канал плюс взаємне блокування стратегій одного каналу.
  - Стан живе **лише в памʼяті процесу**: після рестарту cooldown обнуляється.
  - Блокування, що зависло, живе максимум 10 хв (`LOCK_TTL_MS`).
  - Другий екземпляр сервісу призведе до подвійних публікацій.
- **Meta-привʼязки** не мають cooldown у runner. Cooldown `INSTAGRAM_COOLDOWN_MIN`=30, `FACEBOOK_COOLDOWN_MIN`=15, `THREADS_COOLDOWN_MIN`=10 діє лише для крос-постингу з Telegram.
- **Ручні пости** cooldown не враховують і не запускають.

### 4.6 Збої, повтори, сповіщення

- **Автоматичних повторів на рівні публікаторів немає.** Повтор — це наступне спрацювання крону; тому дайджести мають розклад «кожні 10 хв 19:00–20:50».
- **Помилка публікації і статус запуску.**
  - Статус `error` дають загальний конвеєр і стратегії, що перекидають виключення: Meta/TikTok-гілки `recipes`, `recipe-carousel`, `ai0-prompts`, `curated-prompts`; Telegram-гілка `recipe-carousel`.
  - У Telegram-гілках `recipes`, `quotes`, `ai0-news`, `ua-news`, `facts`, `pdr-quiz`, `game-channel`, `assets`, `curated-prompts`, `ai0-prompts`, `birthday-strategy`, `network-digest`, `topic-digest` виключення перехоплюється й лише логується; запуск лишається `ok`.
- **Сповіщення власнику** (Telegram DM; потрібні `TELEGRAM_BOT_TOKEN` і `TELEGRAM_OWNER_ID`):
  - «✅ опубліковано», «❌ збій» (у частині стратегій), «ℹ️ пропущено» (`ai0-news`);
  - алерти `AlertingService` і ручних постів, що зависли в `sending`.
  - Без токена чи ID сповіщення мовчки вимкнені.
- **Збій одного з Meta-дзеркал** ізольований: Telegram-публікацію й сусідні цілі він не зачіпає. Постійні помилки медіа Meta позначають рядок як виконаний для цього призначення.
- **Пауза каналу + відмітка «до публікації».** Кожен тік на паузованому каналі спалює один елемент контенту в `ai0-news`, `ua-news`, `facts`, `pdr-quiz`, `game-channel`, а в журналі стоїть `ok`.
- **Постійні помилки Telegram** (неправильний HTML, `PHOTO_INVALID`, `Publish blocked:`…) позначаються в дедупі як «error». Тимчасові (chat not found, flood, 5xx) — ні: елемент повториться на наступному тіку.
- **Перезапуск сервісу.** Запуски, що лишились `running`, стають `error` («interrupted: service restarted mid-run»); ручні пости в `sending` довше 5 хв — `unknown`. Таймаут запуску 5 хв **не скасовує** роботу: публікація може відбутися вже після запису `error`.
- **Retention.** Журнал `strategy_runs` чиститься через 90 днів (`STRATEGY_RUNS_RETENTION_DAYS`).

## 5. Шар публікаторів — що реально працює (`apps/automation/src/publishers`)

| Публікатор | Файл | Що робить | Статус |
|---|---|---|---|
| Telegram (стратегії) | `telegram.publisher.ts` | Bot API, вибір за довжиною тексту: текст — `sendMessage`; фото + підпис ≤1024; 1025–2048 — через MTProto-користувача (з відкатом на «фото + reply»); >2048 — фото + reply. Також `publishPrompt`, `publishVideo`, `forward`. `guardText` блокує текст <20 символів і AI-сміття (`SKIP_POST`, «as an ai», «"error":»…). Перевірка `publish_paused` | працює |
| Telegram (агенти) | `editor/publish/telegram-editor.publisher.ts`, `editor/post/render-telegram.ts` | рендер PostSpec; rich-повідомлення `sendRichMessage` з HTML-запасом (spec 033); `edit()` є, але продукт його не викликає | працює для агентських постів |
| Telegram (ручні пости) | `composed-sender.service.ts` | Bot API (`sendPhoto`/`sendVideo`/`sendMessage` + inline-кнопки-URL) або MTProto-користувач; без throttle і `guardText` | працює |
| Telegram-сповіщення | `telegram-notifier.service.ts` | DM власнику | працює, якщо є токен і ID |
| Instagram | `instagram.publisher.ts` | Graph API: контейнер → `media_publish`; одне зображення або карусель 2–10; підпис ≤2200, ≤30 тегів; без зображення — виняток | працює; потрібен публічний URL зображення |
| Facebook | `facebook.publisher.ts` | `/photos` або `/feed`; альбом 2–10 через неопубліковані фото; підпис ≤60000 | працює |
| Threads | `threads.publisher.ts` | `graph.threads.net` (`v1.0`): TEXT/IMAGE/CAROUSEL (2–20); текст ≤500, без тегів | працює |
| TikTok | `tiktok/tiktok-carousel.publisher.ts` | фото-карусель `DIRECT_POST`: init + опитування статусу до 10×3 с; приватність за `TIKTOK_PRIVACY_LEVEL` (**за замовчуванням `SELF_ONLY`**) | частково: лише фото-каруселі |
| Telegraph | `telegraph.service.ts` | сторінка з повним рецептом або лонгрідом (токен з активного `telegraph_accounts` або env `TELEGRAPH_ACCESS_TOKEN`) | працює в `recipes` (TG) і в лонгрідах агентів |
| Диспетчер Meta | `publisher-dispatcher.service.ts` | маршрутизує `instagram`/`facebook`/`threads`; для агентів його викликає `editor/platform/resource-publisher.ts` (spec 019) | працює |
| Крос-постинг | `cross-post.service.ts` | після TG-посту повторює його в увімкнені цілі `meta_crosspost_targets` (`mirror`, `teaser`), з cooldown на акаунт; не кидає виключень | працює для стратегій з `afterPublish` і загального конвеєра; не для `network-digest`, `topic-digest`, `recipe-carousel`; для агентів — `editor-crosspost.ts` з урахуванням пауз |
| Групове дзеркалення | `common/content-strategy/group-fanout.service.ts` | якщо призначення — «джерело» групи, контент іде в усі інші акаунти групи (Meta, TikTok, Telegram). Для незалежної мережі (spec 024) не дублює | працює для `recipe-carousel`, `ai0-prompts` |
| Хостинг слайдів | `hosting/slide-hosting.service.ts` | тимчасове сховище (Supabase) для слайдів каруселі; видаляються після публікації | працює |

**Не підключено / відсутнє:**
- публікація стратегій у TikTok поза `recipe-carousel`;
- ручний пост у Meta/TikTok (вкладки «soon»);
- відео в Meta;
- повтори й черга BullMQ для публікацій стратегій і ручних постів (усе в процесі через `@nestjs/schedule`/`cron`);
- перевірка статусу контейнера Instagram перед `media_publish`;
- rich-повідомлення для стратегій і ручних постів.

**Бізнес-вимоги (as-is) до шару публікаторів.**
- `BR-PUB-51` Telegram-пости публікуються ботом каналу (`tracked_channels.bot_id`) або ботом за замовчуванням. Якщо немає жодного, публікація кидає помилку «no bot bound and no default bot is set».
- `BR-PUB-52` Токени Meta, TikTok і ботів беруться спершу з зашифрованого поля `token_enc` (AES-256-GCM), потім з env-змінної, імʼя якої зберігає `token_env`. Порожній токен → стратегія завершується помилкою призначення.
- `BR-PUB-53` Telegram-публікація стратегії обирає шлях за довжиною видимого тексту й наявністю зображення: ≤1024 — підпис; ≤2048 — MTProto-користувач; інакше — фото + reply. Збій reply після публікації фото не робить публікацію невдалою.
- `BR-PUB-54` Альбом Facebook і каруселі Instagram/Threads публікують зображення з тимчасового хостингу; після публікації копії видаляються. Фото Facebook з `published:false` лишаються на сторінці — відомий компроміс.
- `BR-PUB-55` Без зображення Instagram-публікація не виконується; крос-постинг мовчки пропускає такі пости зі статусом `skipped: no image`.
- `BR-PUB-56` TikTok-пост за замовчуванням публікується з приватністю `SELF_ONLY`, поки в env не задано інший `TIKTOK_PRIVACY_LEVEL`.
- `BR-PUB-57` Реєстр типів визначає, які платформи дозволені кожній стратегії (`supportedPlatforms`, за замовчуванням лише `telegram`). Тепер це використовують лише `GET /api/strategies/types` і перенесення в серії. Перевірки при створенні більше немає, бо створення немає.
- `BR-PUB-66` Агентські Telegram-пости форматів text, photo, video, longread, poll, quiz можуть іти через `sendRichMessage`. Підписи альбомів і каруселей лишаються HTML. Режим задає `format_prefs.rich`: `auto` / `prefer` / `never`, за замовчуванням `auto`.
  - Якщо Telegram явно відхилив rich-повідомлення (4xx), один раз відправляється збережений HTML-варіант, а в слот пишеться попередження `rich_fallback: html (<причина>)`.
  - Відповідь «unsupported» або 404 позначає канал як такий, що не підтримує rich, на 7 днів (`app_settings` `cap.tg_rich_unsupported:<channel>`).
  - Мережеві помилки, 429 і 5xx не повторюються, щоб не було дублів.

## 6. Глосарій розділу

| Термін | Значення |
|---|---|
| Привʼязка (binding) | рядок `strategy_bindings`: `ext_id`, `type`, місце призначення, `schedule`, `params`, `enabled`, `retired_at`, `migrated_to` |
| Вилучена привʼязка | вимкнена при cutover (`retired_reason='migrated'`), бо її роботу взяла серія агента |
| Migrate / Cutover / Rollback | чернетка плейбука з серіями / вимкнення стратегій і перехід агента в `approve` / повернення стратегій і агента в `shadow` |
| `ext_id` | логічна назва стратегії (унікальна), напр. `recipes:local` |
| Призначення | Telegram-канал, Meta-акаунт (IG/FB/Threads) або TikTok-акаунт |
| `postedKey` | ключ дедупу в JSONB `posted`: `TELEGRAM`, `IG:<uuid>`, `FB:<uuid>`, `TH:<uuid>`, `TT:<uuid>` |
| `content_ledger` | спільний журнал використаного контенту для агентів і стратегій |
| Cooldown / lock | пауза між постами й блокування каналу в памʼяті процесу |
| Крос-постинг | повтор Telegram-посту в Meta після публікації (`mirror` / `teaser`) |
| Fan-out групи | дублювання контенту з «джерела» групи на решту її акаунтів (не діє для незалежних мереж) |
| Ручний пост | рядок `scheduled_publications` (разовий) |
| Rich-повідомлення | пост через `sendRichMessage` (заголовки, списки, таблиці, формули) з HTML-запасом |

## 7. Джерела в коді

- **Дашборд:** `apps/dashboard/src/routes/app.strategies.tsx`, `app.strategies_.new.tsx`, `app.strategies_.$id.tsx`, `app.scheduled.tsx`, `app.calendar.tsx` (редирект), `app.compose.tsx`; `components/strategies/MigrationBanner.tsx`, `CrosspostSection.tsx`, `PlatformFilter.tsx`, `post/PostComposer.tsx`, `post/TelegramPreview.tsx`; `api/strategies.ts`, `api/scheduled-posts.ts`, `api/crossposts.ts`; `lib/labels.ts`, `lib/runway.ts`, `lib/usePlatform.ts`, `lib/strategies-legacy.test.ts`.
- **API/конфіг:** `apps/automation/src/config/api/strategies.controller.ts`, `config/api/dto/strategies.dto.ts`, `config/strategy-bindings.repository.ts`, `config/strategy-runs.repository.ts`, `config/strategy-preview.service.ts`, `config/json-importer.service.ts`.
- **Перенесення:** `apps/automation/src/editor/migration/*` (`strategy-migration.service.ts`, `strategy-migration.controller.ts`, `proposal.ts`, `cron-cadence.ts`, `type-mapping.ts`, `binding-guard.ts`, `migration-actions.ts`, `migration-upkeep.ts`), `editor/approval/approval-policy.ts`, `src/cli/migrate-strategies.ts`.
- **Планувальник:** `apps/automation/src/scheduler/scheduler.service.ts`, `scheduler/schedule-time-zone.ts`; `common/content-strategy/*`; `common/alerting/alerting.service.ts`; `common/dedup/dedup.service.ts`; `common/content-runway/content-runway.service.ts`; `common/retention/retention.service.ts`; `common/digests/*`.
- **Стратегії:** `apps/automation/src/strategies/*/*.strategy.ts` (+ репозиторії), фетчери `apps/automation/src/workflows/*/fetchers`, `config/sources/ai0-news.json`, `config/sources/ai0-prompts.json`.
- **Ручні пости:** `apps/automation/src/scheduled-posts/*` (controller, service, worker, repository, `post-validation.ts`, `dto/composed-post.dto.ts`), `publishers/composed-sender.service.ts`, `agent/agent-schedule.executor.ts`, `agent/ad-placement.ts`.
- **Публікатори:** `apps/automation/src/publishers/*` (`telegram.publisher.ts`, `posting-throttle.service.ts`, `errors.ts`, `publisher-dispatcher.service.ts`, `instagram|facebook|threads.publisher.ts`, `meta-graph.util.ts`, `cross-post.service.ts`, `telegraph.service.ts`, `telegram-notifier.service.ts`, `tiktok/`, `hosting/`); `editor/publish/telegram-editor.publisher.ts`, `editor/publish/rich-capability.ts`, `editor/post/render-telegram.ts`, `editor/platform/resource-publisher.ts`.
- **Міграції:** `database/migrations/005_config.sql`, `006_strategy_runs.sql`, `014_scheduled_publications.sql`, `019_strategy_low_content_threshold.sql`, `020_strategy_binding_destination.sql`, `024_strategy_binding_tiktok.sql`, `036_strategy_run_steps.sql`, `045_scheduled_publications_unknown.sql`, `058_data_store.sql`, `059_schedule_rules.sql`, `060_content_ledger.sql`, `063_strategy_retirement.sql`.
- **Специфікації:** `specs/002-publish-correctness/spec.md`, `specs/009-strategy-retirement/spec.md`, `specs/023-agent-owned-content/spec.md`, `specs/027-navigation-constructor/spec.md`, `specs/032-unified-data-store/spec.md`, `specs/033-telegram-rich-messages/spec.md`.
