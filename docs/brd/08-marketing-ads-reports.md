# BRD (as-is) — Маркетинг: медіакіт, реклама, звіти для рекламодавців

> Статус: чернетка, згенерована з коду 2026-10-05. Описує, як система ФАКТИЧНО працює зараз (гілка feat/editor-agent), а не як мала б.

## 1. Призначення розділу

Розділ «Marketing» у бічному меню дашборда (`AppSidebar.tsx`: пункти `Landing` і `Ads`) закриває дві бізнес-задачі власника мережі каналів: (1) показати публічну «вітрину» мережі на головній сторінці `/` (які саме канали й профілі показувати і в якому порядку) та (2) продавати рекламу в Telegram-каналах мережі: прайс → замовлення → платіжне посилання LiqPay → погодження поста власником → резервований слот редактора → публікація з позначкою `#реклама` → публічний звіт для рекламодавця через 24 і 72 год.

Користувач розділу — один власник/оператор (вхід у `/app`). Рекламодавець у системі користувача-акаунта не має: він бачить лише (а) публічну головну сторінку з медіакітом, (б) сторінку оплати LiqPay за посиланням, яке власник йому пересилає вручну, (в) публічний звіт `/report/$token`.

Важливе уточнення щодо назв: сторінка `/app/landing` — це НЕ редактор медіакіту. Вона керує лише списком «featured» ресурсів (канали/акаунти) на публічній головній. Медіакіт (канали з цінами, підписники, середні перегляди) будується автоматично з прайс-листа, який редагується на `/app/ads`. Окремої сутності «рекламодавець» немає — це текстове поле `ad_orders.advertiser`.

## 2. Сторінки розділу

| Сторінка | Маршрут | Коротко |
|---|---|---|
| Landing | `/app/landing` | Вибір і впорядкування ресурсів (TG-канали, Instagram/Facebook/Threads, TikTok), що показуються на публічній `/`; праворуч live-превʼю |
| Ads | `/app/ads` | Прайс-лист, створення замовлення на рекламу, платіжне посилання, планування поста, посилання на звіт |
| Звіт рекламодавця | `/report/$token` | Публічна сторінка зі статистикою одного рекламного поста (24 год / 72 год), без логіну |

Повʼязана публічна сторінка поза розділом: `/` (`routes/index.tsx`) — містить блок «Advertise with us» з компонентом `MediaKit` (див. 3.2).

## 3. Сторінки

### 3.1 Landing — `/app/landing`

**Бізнес-мета.** Дати власнику контроль над тим, які ресурси мережі видно на публічній головній сторінці і в якій послідовності, без правок коду.

**Хто користується / доступ.** Тільки після логіну (маршрут під `/app`). API `GET/PATCH /api/landing/admin…` захищені `TrackingAuthGuard` (Bearer `TRACKING_TOKEN` або JWT-кукі `tracking_jwt`). Публічний `GET /api/landing/resources` — без авторизації.

**Що показує.**
- Заголовок «Landing», підзаголовок «Choose which resources appear on the public landing page and their order.», кнопка «Open live page ↗» (відкриває `/` в новій вкладці).
- Ліва колонка: ресурси, згруповані за платформою у порядку Telegram, Instagram, Facebook, Threads, TikTok; у шапці групи лічильник «N/M featured». Рядок ресурсу: аватар (або іконка платформи), назва (`displayName`, інакше `@handle`, інакше назва платформи), `@handle`, кількість підписників (скорочено K/M/B).
- Для featured-ресурсу: бейдж «#N on landing», кнопки «Move up», «Move down», «Hide from the landing»; для нефічерених — «Feature on the landing».
- Права колонка «Live preview»: той самий компонент `ResourceShowcase`, що й на публічній `/`, з поточним featured-набором у порядку `order`.
- Дані: `GET /api/landing/admin` → `LandingResourcesService.listAdmin()` → таблиці `tracked_channels` (лише `is_mine = true`), `meta_accounts`, `tiktok_accounts`; поля `landing_visible`, `landing_order` додані міграцією `025_landing_featured.sql`.

**Дії користувача.**
- «Feature on the landing» / «Hide from the landing» → `PATCH /api/landing/admin/:platform/:id` з `{landingVisible, landingOrder}` → `UPDATE <таблиця> SET landing_visible, landing_order`. Новий featured-ресурс отримує `order = max(order серед видимих)+1` (або 0, якщо видимих немає).
- «Move up/down» → клієнт міняє місцями два елементи у плоскому списку видимих і перенумеровує весь список 0..N-1; для кожного рядка, у якого змінився `order`, робить окремий `PATCH` послідовно (цикл у `useMutation`), потім один раз перезавантажує дані. Усі кнопки disabled, поки триває мутація.
- «Open live page» — лише посилання на `/`.

**Бізнес-вимоги (as-is).**
- `BR-MKT-01` Система показує на `/app/landing` усі кандидати-ресурси трьох типів: Telegram-канали з `tracked_channels.is_mine = true`, усі рядки `meta_accounts` (Instagram/Facebook/Threads) і всі рядки `tiktok_accounts`, незалежно від того, вибрані вони чи ні.
- `BR-MKT-02` Система зберігає вибір власника у колонках `landing_visible` (boolean, default false) і `landing_order` (int ≥ 0, default 0) відповідної таблиці ресурсу.
- `BR-MKT-03` Публічний `GET /api/landing/resources` повертає ресурси, у яких `landing_visible = true` і (для `meta_accounts`/`tiktok_accounts`) `active = true`, (для Telegram) `is_mine = true`, відсортовані за `landing_order`; відповідь містить лише `platform, handle, displayName, avatarUrl, followerCount, url, order` — без токенів і внутрішніх id.
- `BR-MKT-04` Посилання профілю (`url`) формується з handle за фіксованим шаблоном: `t.me/<handle>`, `instagram.com/<handle>`, `facebook.com/<handle>`, `threads.net/@<handle>`, `tiktok.com/@<handle>`; для Telegram handle береться з `channel_key` без початкового `@`, інакше з `username`.
- `BR-MKT-05` Для Telegram-каналів як кількість підписників віддається `tracked_channels.subs_count`, для Meta — `followers`, для TikTok — `null` (картка без лічильника); аватар для Telegram завжди `null` (показується іконка платформи).
- `BR-MKT-06` Порядок на публічній сторінці — один плоский список для всіх платформ (не по групах); кнопки «Move up/down» перенумеровують усі видимі ресурси, щоб виправити стан, коли всі `landing_order` = 0.
- `BR-MKT-07` `PATCH /api/landing/admin/:platform/:id` валідує тіло (`landingVisible` boolean, `landingOrder` ціле ≥ 0) і відхиляє невідому платформу з 400; на неіснуючий `id` повертає `{ok:true}` без помилки (UPDATE зачіпає 0 рядків).
- `BR-MKT-08` Live-превʼю на `/app/landing` будується на клієнті з даних `GET /api/landing/admin` (відфільтровані `landingVisible`), а не з публічного ендпоінта.

**Бізнес-правила й обмеження.** Немає ліміту кількості featured-ресурсів. Немає перевірки, що ресурс має публічний профіль (handle може бути `null` → картка без посилання). Немає ручних назв/описів: відображається те, що лежить у таблицях ресурсів.

**Стани.** Завантаження — 5 skeleton-рядків; помилка — картка «Couldn’t load landing resources» + текст помилки; порожньо — «No candidate resources yet / Connect channels and accounts under Connections…». Порожнє превʼю — «No resources yet».

**Фонові процеси.** Немає.

**Звʼязки.** Дані ресурсів надходять зі сторінок Connections / Tracked (`is_mine`), Meta- і TikTok-акаунтів. Публічно результат видно на `/`. Використовує `ResourceShowcase` (`components/landing/ResourceShowcase.tsx`).

**Спостереження «як фактично зараз».**
- Назва/опис у запиті («медіакіт / landing editor») ширші за реальність: сторінка лише перемикає видимість і порядок, жодного контенту (тексти, ціни, CTA) тут не редагується.
- Невідповідність адмін-списку і публіки: адмін показує всі `meta_accounts`/`tiktok_accounts`, навіть `active = false`; публічно такі не з’являться, хоча на сторінці вони матимуть бейдж «#N on landing». Preview теж показує їх (він бере адмін-дані), тобто превʼю може розходитися з реальною `/`.
- Перенумерація — це N окремих послідовних `PATCH` без транзакції; при збої посередині порядок може лишитися частково зміненим.
- Індекси `idx_*_landing` у міграції 025 побудовані під фільтр `landing_visible AND active`, але для `tracked_channels` умова інша (`is_mine`) — це лише оптимізація, на поведінку не впливає.
- Ключ React для картки на публічній сторінці — `platform:handle` (або `order`); два ресурси з однаковим handle в одній платформі дадуть колізію ключів.

**Відкриті питання до власника.** Чи має сторінка колись редагувати медіакіт (описи, ціни) чи цього достатньо через `/app/ads`? Чи має адмін-список ховати неактивні акаунти?

---

### 3.2 Ads — `/app/ads`

**Бізнес-мета.** Продавати рекламні розміщення в Telegram-каналах власника: вести прайс-лист, створювати замовлення, отримувати оплату через LiqPay, ставити пост у розклад (через погодження власником) і віддавати рекламодавцю звіт.

**Хто користується / доступ.** Тільки власник після логіну. Усі ендпоінти `/api/ad-orders…` і `/api/ad-prices…` за `TrackingAuthGuard`. Публічні (без авторизації): `GET /api/landing/prices`, `GET /api/landing/media-kit`, `GET /api/ads/report/:token`, `POST /api/payments/liqpay/callback` (останній автентифікується підписом LiqPay).

**Що показує.** Заголовок «Ads», підзаголовок «Price list, ad orders, payment links, placement and advertiser reports». Три блоки:
1. «Price list» — форма (Channel, Format, Price (UAH), Note) і таблиця активних цін (Channel / Format / Price, UAH / Note) з кнопкою «Deactivate».
2. «New order» — форма створення замовлення.
3. «Orders» — картки замовлень (за `created_at DESC`): advertiser, канал, формат, дата `publish_at`, сума + валюта, бейдж статусу, бейдж «reserved slot», опис, кнопки дій.

Дані: `GET /api/ad-orders`, `GET /api/ad-prices`, список «своїх» каналів з tracking API (`filter: 'mine'`, до 100). Замовлення автооновлюються кожні 30 с.

Формати прайсу (`ad_prices.format`): `post` («Post»), `pin_24h` («Post + 24h pin»), `digest_sponsor` («Digest sponsor» — партнер щоденного дайджесту). Валюта цін — тільки гривня (`price_uah`).

**Дії користувача.**
- **Save (прайс)** → `PUT /api/ad-prices`: транзакція — попередній активний запис цього `channel_key`+`format` ставиться `active=false` (історія лишається), вставляється новий рядок у `ad_prices`. `channelKey` нормалізується до `@…`. Ціна — ціле ≥ 1 (грн), нотатка до 200 символів, публічна.
- **Deactivate** (після підтвердження) → `DELETE /api/ad-prices/:id` → `active=false`; 404, якщо вже неактивна.
- **Create order** → `POST /api/ad-orders` (деталі нижче) → рядок у `ad_orders` зі статусом `draft`.
- **Get payment link** (для `draft` / `awaiting_payment`) → `POST /api/ad-orders/:id/checkout` → статус `awaiting_payment`, `liqpay_order_id = id`; повертає `data`, `signature`, `actionUrl` (`https://www.liqpay.ua/api/3/checkout`). Дашборд складає URL `actionUrl?data=…&signature=…`, показує у readonly-полі з кнопкою «Copy». Власник пересилає його рекламодавцю вручну.
- **Schedule post** (для `paid`, крім `digest_sponsor`) → розкривається форма (Channel, Schedule at, Post text, якщо в замовлення немає creative) → `POST /api/ad-orders/:id/schedule` → створюється `agent_actions` типу `schedule_post` у статусі `pending`, до замовлення привʼязується `action_id`, статус стає `scheduled`. Далі UI лише підказує «approve the action on /app/agent».
- **Report (24h/72h)** — посилання `…/report/<token>` зʼявляється, коли в замовлення є і `report_token`, і `report`.

**Створення замовлення (форма «New order»).** Поля: Advertiser (обовʼязкове, ≤200), Price (вибір із активних цін або «— custom amount —»), Amount (UAH; лише якщо не обрано ціну; формат `^\d+(\.\d{1,2})?$`), Channel (необовʼязково), Publish at (datetime-local → ISO), Customer line (`sponsorLabel`, ≤120; додає рядок «Реклама. Замовник: …»), Ad text (абзаци через порожній рядок; `**bold**`, `[link](https://…)`), Image URL (робить пост фото-постом), Button label + Button URL (CTA), Description (внутрішній, ≤500). Текст перетворюється на `AdCreative`: блоки `p`, `format: photo|text`, `media`, `cta`.
Якщо обрано `priceId`, сервер ігнорує клієнтську суму: `amount = price_uah` з 2 знаками, `currency = 'UAH'`, канал = обраний або `channel_key` ціни. Без `priceId` сума обовʼязкова, валюта з форми завжди `UAH` (дашборд хардкодить).

**Бізнес-вимоги (as-is).**
- `BR-MKT-09` Система зберігає прайс у `ad_prices` (`channel_key`, `format` ∈ {`post`,`pin_24h`,`digest_sponsor`}, `price_uah` INT > 0, `active`, `note`); унікальний індекс гарантує одну активну ціну на пару канал+формат.
- `BR-MKT-10` Збереження ціни для вже існуючої пари канал+формат деактивує попередній запис і створює новий (історія зберігається), у межах однієї транзакції.
- `BR-MKT-11` Створення замовлення з `priceId` бере суму й валюту виключно з активної ціни (клієнтські `amount`/`currency` ігноруються); неіснуюча чи неактивна ціна → 400 «price not found or inactive».
- `BR-MKT-12` Створення замовлення без `priceId` вимагає `amount` у форматі десяткового рядка з ≤2 знаками, інакше 400.
- `BR-MKT-13` Рекламний creative (`ad_orders.creative`) валідується zod-схемою `SponsoredCreativeSchema`: 1–30 блоків тіла, не більше одного зображення (http/https), CTA з підписом ≤40 символів, до 3×3 кнопок, без хештегів і без `source`/`library_ref`; невалідний → 400 «invalid creative».
- `BR-MKT-14` Статуси замовлення — `draft`, `awaiting_payment`, `paid`, `scheduled`, `published`, `reported`, `canceled` (CHECK у БД); новий запис починається з `draft`.
- `BR-MKT-15` `POST /api/ad-orders/:id/checkout` формує підписаний запит LiqPay (`action: pay`, `version: 3`, `order_id` = id замовлення, `amount`, `currency`, `description` або «Ad order <id>», `server_url` = `${DASHBOARD_URL}/api/payments/liqpay/callback`) і переводить замовлення в `awaiting_payment`; без `LIQPAY_PUBLIC_KEY`/`LIQPAY_PRIVATE_KEY` кидає помилку «LiqPay not configured».
- `BR-MKT-16` Callback LiqPay приймається лише з валідним підписом (`base64(sha1(private+data+private))`, порівняння `timingSafeEqual`); оплаченим вважається статус `success`, а `sandbox` — тільки коли `LIQPAY_SANDBOX=true`; статус `wait_accept` і всі інші ігноруються.
- `BR-MKT-17` Позначення оплати (`markPaid`) ідемпотентне: лише `awaiting_payment`/`draft` → `paid`, ставиться `paid_at = now()`.
- `BR-MKT-18` `POST /api/ad-orders/:id/schedule` дозволено лише для статусу `paid`; вимагає канал, час (з тіла або `publish_at` замовлення) і creative (власний або з тексту); creative проходить `lintSponsored` (послаблені правила: `banned_term`, `not_ukrainian`, `emoji_policy` — лише попередження), інакше 400.
- `BR-MKT-19` Успішне планування створює `agent_actions` (`schedule_post`, статус `pending`, payload: `text`-превʼю з рядком `#реклама`, `channelId`, `scheduledAt`, `orderId`) і ставить замовлення в `scheduled`; пост НЕ публікується, поки власник не погодить дію на `/app/agent`.
- `BR-MKT-20` Після погодження дії (`AdPlacement`): якщо `EDITOR_ENABLED=true` і для каналу є картка редактора (будь-який режим) — резервується слот редактора (`editor_slots`, `kind=reserved`, `source_hints: ad_order:<id>`, `post_spec` = creative) і в замовлення записуються `editor_slot_id`, `publish_at`; інакше пост кладеться в чергу `scheduled_posts` (замовлення лишається `scheduled`, `editor_slot_id = NULL`).
- `BR-MKT-21` Резервований слот публікується детерміновано, без LLM, незалежно від режиму редактора (`off`/`shadow`/`live`): `SponsoredPublisher` рендерить creative з кодовим футером `#реклама` (останній рядок; за наявності `sponsorLabel` — перед ним «Реклама. Замовник: …»), надсилає в канал, пише `published_posts` (`strategy_type='ad'`, `source_url=ad://order/<id>`, тег `реклама`), ставить слот `published`, а замовлення — `published` з `published_post_id` і випуском `report_token`.
- `BR-MKT-22` Резервований слот, що запізнився більше ніж на 6 годин (`RESERVED_MAX_LATE_MS`), не публікується: слот `failed`, власник отримує алерт «Реклама … не вийшла … Перенеси замовлення на /app/ads»; будь-яка помилка публікації фінальна (повторної відправки немає, щоб не дублювати пост).
- `BR-MKT-23` Для формату `pin_24h` система лише надсилає власнику повідомлення «закріпи цей пост на 24 год і відкріпи після»; фактичного закріплення/відкріплення вона не виконує.
- `BR-MKT-24` Замовлення формату `digest_sponsor` не планується кнопкою; його підхоплюють стратегії network-digest / topic-digest у день `publish_at` (за київською датою) для відповідного каналу, якщо статус `paid` або `scheduled` і в creative є URL (`cta.url` або першої кнопки); після виходу дайджесту замовлення стає `published`.
- `BR-MKT-25` Посилання спонсора в дайджесті отримує UTM: `utm_source=ai0`, `utm_medium=telegram`, `utm_campaign=<перші 8 hex id замовлення>` (для статичного спонсора зі стратегії — `digest`).
- `BR-MKT-26` Щогодини (cron `17 * * * *`) `AdReportsService` будує звіти для замовлень `published`, чий пост старший за 24 год (перший звіт) або 72 год (фінальний), до 50 за запуск; фінальний звіт переводить замовлення в `reported` і ставить `reported_at`.
- `BR-MKT-27` При першому звіті, якщо замовлення має `thread_id` (DM-тред), система створює `pending` дію `reply` із текстом-запрошенням і публічним посиланням (власник погоджує відправку — автоматично нічого не йде); без треду власник отримує повідомлення в admin-боті з посиланням «надішли рекламодавцю вручну».
- `BR-MKT-28` Сторінка показує бейдж «reserved slot» лише для замовлень зі статусом `scheduled` і заповненим `editor_slot_id`.
- `BR-MKT-29` На запит про рекламу в DM triage-агент готує чернетку відповіді (`reply`, `kind: price_list`) з детермінованим шаблоном прайсу (ціни в грн), якщо є активні ціни; відправка потребує погодження власника, одна чернетка на тред.

**Бізнес-правила й обмеження.** Єдиний платіжний провайдер — LiqPay (hosted checkout), картки не зберігаються. Усі ціни — цілі гривні. Часові зони: день дайджесту — `Europe/Kyiv`; `Publish at` у формі — локальний час браузера, передається як ISO. Редагування замовлення (`PATCH /api/ad-orders/:id`) дозволене до публікації (статуси draft…scheduled), але в UI відсутнє. Перегляд списку може фільтруватися `?status=`, UI фільтра не має. Щоденний кап відповідей (`AGENT_REPLY_DAILY_CAP`) діє при погодженні `reply`.

**Стани.** Завантаження замовлень — 3 skeleton-картки; порожньо — «No ad orders yet / Create an order above to generate a payment link for an advertiser.»; «No active prices yet.»; помилки мутацій показуються червоним текстом поруч із кнопкою. Помилка «LiqPay not configured» відображається так само (текст помилки з API).

**Фонові процеси.**
- Cron `ad-reports` (`17 * * * *`) — звіти 24/72 год.
- Hourly `StatsCollector` (`EVERY_HOUR`) — знімки `post_stats_snapshots` і `channel_stats_snapshots` для постів не старших за `STATS_POST_AGE_DAYS` (30 за замовчуванням); потребує увімкненого `TelegramStatsClient`.
- Планувальник editor-слотів — публікація reserved-слотів (`ReservedDispatcher`/`SponsoredPublisher`) на кожному тіку.
- Дайджест-стратегії — публікація спонсорського рядка.

**Звʼязки.** `/app/agent` — погодження `schedule_post` і `reply`; `/app/editor` — слоти; LiqPay (`server_url` на `DASHBOARD_URL`); Telegram (публікація й статистика, admin-бот для алертів); `/` (медіакіт з цін); `/report/$token`; `kpi-digest.service.ts` рахує дохід із `ad_orders` за `paid_at`.

**Спостереження «як фактично зараз».**
- Немає шляху до статусу `canceled`: жоден ендпоінт чи UI-кнопка його не ставить (хоча `SponsoredPublisher` його перевіряє). Скасувати/повернути гроші/позначити «оплачено вручну» неможливо; статусів `refunded`/`failed` немає (хоча `kpi-digest` їх виключає у запиті).
- Callback не звіряє суму й валюту з замовленням і не обробляє невдалі/повернені платежі (будь-який статус, окрім `success`, мовчки ігнорується). Якщо `DASHBOARD_URL` порожній, `server_url` не передається у LiqPay і замовлення ніколи не стане `paid` автоматично.
- `createCheckout` не перевіряє поточний статус: повторний виклик через API на вже `paid`/`published` замовлення перезапише статус на `awaiting_payment`. UI ховає кнопку, але захисту в бекенді немає.
- Fallback-шлях (`EDITOR_ENABLED=false` або немає картки редактора): пост іде через `scheduled_posts`, замовлення назавжди лишається `scheduled` — без `published_post_id`, без звіту, без токена; на сторінці це виглядає як «завислий» заказ.
- Формат ідентифікатора каналу в `ad_orders.channel_id` змішаний: з ціною — `channel_key` (`@name`), з форми — `tracked_channels.id` (uuid). Через це запит доходу в `kpi-digest` (`'telegram:' || channel_id`) для uuid-замовлень не збігається з ресурсом, а дайджест-спонсор окремо обробляє обидва формати.
- Для `digest_sponsor` кнопка «Schedule post» сховано в UI, але бекенд `schedulePost` не забороняє його; формат `digest_sponsor` також не виконує жодного резервування слота — публікація залежить від того, що дайджест-стратегія для цього каналу справді запущена в день `publish_at`.
- Для замовлення дайджесту звіт можливий лише якщо `published_posts` знайдено за каналом і `message_id` (підзапит у `markPublished`); якщо ні, `published_post_id` = NULL, замовлення `published`, але звіт не будується.
- Рекламодавця як сутності немає: ні контактів, ні історії, ні каталогу; ключ — вільний текст `advertiser`. Згадана в запиті вкладка «advertisers» на сторінці відсутня.
- UI-повідомлення англійською, тоді як рекламний текст, повідомлення власнику й звіт — українською; формат дати/валюти змішаний (`uk-UA` у таблиці, `en-US` у публічному медіакіті).
- `AD_ORDER_CURRENCY=UAH` є у `.env.example`, але код його не читає — валюта хардкодиться `UAH` у дашборді та сервісі.
- URL звіту на сторінці будується з `window.location.origin`, а в DM/алерті — з `DASHBOARD_URL`; при різних доменах посилання відрізнятимуться.
- Погодження `schedule_post` на `/app/agent` — обовʼязковий ручний крок; сторінка Ads лише підказує про нього, не посилається на конкретну дію.

**Відкриті питання до власника.** Потрібен ручний «Mark as paid» / скасування / повернення? Чи треба звіряти суму в callback? Чи має fallback-шлях теж закривати замовлення та будувати звіт? Чи потрібна окрема сутність рекламодавця?

---

### 3.3 Звіт рекламодавця — `/report/$token`

**Бізнес-мета.** Дати рекламодавцю прозору статистику його розміщення без доступу в дашборд; підвищити довіру і повторні замовлення.

**Хто користується / доступ.** Публічна сторінка, поза `/app`-гардом; доступ лише за непередбачуваним токеном у URL. Рекламодавець отримує посилання від власника (через погоджену DM-відповідь або вручну).

**Що показує.**
- Шапка: wordmark «ai0» і «Звіт для рекламодавця».
- Заголовок: назва рекламодавця, бейдж «перша доба · 24 год» або «фінальний · 72 год»; рядок: канал (посилання на `t.me/<handle>`), час публікації, посилання «відкрити пост» (`t.me/<handle>/<message_id>`).
- Чотири плитки: «Перегляди», «Пересилання», «Реакції», «Охоплення» (`reachRate` у % з підписом «від N підписників»).
- Графік «Перегляди за годинами після публікації» (SVG-полілінія; вісь X — години, до 96 точок; якщо менше двох замірів — «Замало замірів для графіка.»).
- Блок «Посилання в пості» (якщо в creative є CTA): URL і пояснення — з UTM («переходи видно у вашій аналітиці») або без («Telegram не показує кількість переходів; додайте UTM-мітки…»).
- Підвал: «Дані станом на …» і для 24-годинного звіту — «Фінальний звіт зʼявиться за цим же посиланням через 72 години після публікації.»
- Дані: `GET /api/ads/report/:token` → `AdOrdersRepository.reportByToken` → `SELECT report FROM ad_orders WHERE report_token=$1 AND report IS NOT NULL`. Сторінка не авторефрешиться (`retry: false`, без `refetchInterval`).

**Дії користувача.** Лише читання; інтерактив — посилання на канал/пост. Кнопок, експорту, друку чи PDF немає.

**Бізнес-вимоги (as-is).**
- `BR-MKT-30` Звіт доступний без авторизації за маршрутом `/report/$token`; бекенд-ендпоінт `GET /api/ads/report/:token` відхиляє токен, що не відповідає `^[A-Za-z0-9_-]{20,64}$`, і неіснуючий токен однаково відповіддю 404 «report not found».
- `BR-MKT-31` Токен — 24 випадкові байти у base64url (192 біти), унікальний (`ad_orders.report_token UNIQUE`), випускається при публікації поста і не змінюється при оновленні звіту.
- `BR-MKT-32` Публічна відповідь містить лише JSON `ad_orders.report` (stage, generatedAt, advertiser, channel, post, metrics, reachRate, link, curve); сума, статус оплати, контакти, creative та id замовлення назовні не віддаються.
- `BR-MKT-33` Звіт будується з `post_stats_snapshots` (остання знімка — метрики; кожна знімка — точка кривої, по одній на розпочату годину після публікації, остання за годину виграє) і останнього `channel_stats_snapshots.subscribers`.
- `BR-MKT-34` `reachRate = views / subscribers`, округлено до 3 знаків; якщо будь-що невідоме — `null`, і плитка показує «—».
- `BR-MKT-35` Етап визначається віком поста: ≥72 год → `72h`, ≥24 год → `24h`, раніше — звіту немає; 72-годинний звіт перезаписує 24-годинний під тим самим токеном.
- `BR-MKT-36` Поле `link` заповнюється з `creative.cta.url` або першої кнопки; `utm = true`, якщо URL містить `utm_*`; UTM автоматично додається лише для `digest_sponsor` (`withUtm`), для звичайного поста — URL як є.
- `BR-MKT-37` Невідомий/хибний токен на сторінці дає жовтий callout «Звіт не знайдено. Перевірте посилання або напишіть нам.»; тексти сторінки українською.
- `BR-MKT-38` Звіт не містить кліків: Telegram їх не дає; єдиний «CTR-проксі» — UTM-мітки в аналітиці рекламодавця.

**Бізнес-правила й обмеження.** Токен є єдиним ключем доступу; терміну дії та відкликання немає. Метрики «forwards», «reactions», «replies» залежать від `TelegramStatsClient`; `replies` збирається, але на сторінці не показується.

**Стани.** Завантаження — сіра картка-заглушка; помилка/не знайдено — callout; дані без замірів — «—» у плитках і повідомлення про брак точок для графіка.

**Фонові процеси.** Cron `ad-reports` (щогодини) створює/оновлює JSON звіту; `StatsCollector` (щогодини) наповнює знімки. Якщо знімків немає, звіт усе одно створюється з порожніми метриками.

**Звʼязки.** Звідки приходять: посилання з DM-відповіді (погоджена власником дія `reply`), алерт власнику в admin-боті або кнопка «Report (24h|72h)» на `/app/ads`. Інтеграції: Telegram (метрики), Postgres.

**Спостереження «як фактично зараз».**
- Звіт повертається навіть якщо метрик немає (всі `null`): рекламодавець побачить порожню сторінку, а замовлення вже вважатиметься `reported`.
- Один токен покриває і 24h, і 72h звіт: після оновлення старий стан перезаписується, історії версій нема.
- У `apps/dashboard/index.html` і `public/` немає `noindex` (перевірено пошуком); захист звіту — лише непередбачуваність токена.
- Плитка «Охоплення» названа як reach, але це `views/subscribers` — проксі, не унікальне охоплення.
- Публічна медіакіт-секція на `/` має бейдж «Self-serve — coming soon» і кнопку «Contact us» з `mailto:` на жорстко прописану адресу власника; самообслуговування (замовлення і оплата рекламодавцем) не реалізовано — весь процес ручний.

**Відкриті питання до власника.** Чи потрібен термін дії токена, перегенерація, PDF/експорт? Чи показувати `replies`? Чи слід не віддавати «порожній» звіт, коли немає жодної знімки?

---

## 4. Наскрізні правила розділу

1. **Життєвий цикл замовлення:** `draft` → (checkout) `awaiting_payment` → (LiqPay `success`) `paid` → (Schedule post) `scheduled` → (публікація слота/дайджесту) `published` → (72h-звіт) `reported`. `canceled` існує лише як значення CHECK.
2. **Ручні точки:** створення замовлення, передача платіжного посилання, натискання «Schedule post», погодження дії на `/app/agent`, відправка DM зі звітом, закріплення поста для `pin_24h`. Автоматичні: callback оплати, публікація reserved-слота, збір статистики, побудова звіту.
3. **Маркування реклами:** `#реклама` додається кодом як останній рядок (не моделлю й не рекламодавцем); необовʼязковий рядок «Реклама. Замовник: …».
4. **Грошові значення детерміновані:** ціни в повідомленнях беруться з БД шаблоном, не генеруються LLM; сума при замовленні з прайсу береться сервером.
5. **Публічні ендпоінти** (`/api/landing/resources`, `/api/landing/prices`, `/api/landing/media-kit`, `/api/ads/report/:token`, LiqPay callback) не мають гарду; захист — проєкція даних, токен і підпис. Ендпоінт `/api/landing/prices` у дашборді не використовується (лише `media-kit`).
6. **Медіакіт** (`/api/landing/media-kit`): канали, що мають хоча б одну активну ціну; підписники — останній знімок; середні перегляди — `AVG(views)` постів за 30 днів з `editor_v_post_performance`, без рекламних (`strategy_type <> 'ad'`).
7. **Прод-проксі:** nginx дашборда пересилає `/api/*` без зміни шляху (включно з LiqPay callback і публічними ендпоінтами).

## 5. Глосарій розділу

| Термін | Значення |
|---|---|
| Featured | Ресурс із `landing_visible = true`, показаний на публічній `/` |
| Медіакіт | Публічний блок на `/`: канал + підписники + середні перегляди за 30 днів + ціни (₴) |
| Reserved slot | Слот редактора `kind=reserved`, що публікується без LLM у погоджений час |
| `schedule_post` | Тип дії в `agent_actions`, що чекає на погодження власника |
| Digest sponsor | Формат реклами — спонсорський рядок у щоденному дайджесті каналу |
| Report token | 192-бітний публічний ключ звіту |

## 6. Джерела в коді

Дашборд:
- `apps/dashboard/src/routes/app.landing.tsx`, `apps/dashboard/src/api/landing.ts`
- `apps/dashboard/src/routes/app.ads.tsx`, `apps/dashboard/src/api/ads.ts`, типи `AdOrder`/`AdReport`/`MediaKitChannel` у `apps/dashboard/src/api/types.ts`
- `apps/dashboard/src/routes/report.$token.tsx`
- `apps/dashboard/src/routes/index.tsx`, `apps/dashboard/src/components/landing/MediaKit.tsx`, `apps/dashboard/src/components/landing/ResourceShowcase.tsx`
- `apps/dashboard/src/components/AppSidebar.tsx`, `apps/dashboard/nginx.conf`

Backend:
- `apps/automation/src/config/landing-resources.service.ts`, `config/api/landing.controller.ts`, `config/api/landing-admin.controller.ts`, `config/api/dto/landing.dto.ts`; `tracked-channels.repository.ts`, `meta-accounts.repository.ts`, `tiktok-accounts.repository.ts`
- `apps/automation/src/payments/*` (`ad-orders.controller.ts`, `ad-orders.service.ts`, `ad-orders.repository.ts`, `ad-prices.repository.ts`, `ads-public.controller.ts`, `liqpay*.ts`, `ad-reports.service.ts`, `ad-report.ts`, `ad-price-list.ts`, `digest-sponsors.repository.ts`, `dto/*`)
- `apps/automation/src/agent/ad-placement.ts`, `agent/agent-actions.service.ts`, `agent/agent-schedule.executor.ts`, `agent/agent-inbox.poller.ts`
- `apps/automation/src/editor/publish/sponsored.publisher.ts`, `editor/publish/reserved-dispatcher.ts`, `editor/post/sponsored.ts`, `editor/manager/kpi-digest.service.ts`
- `apps/automation/src/strategies/network-digest/digest-sponsor.ts`, `network-digest.strategy.ts`, `topic-digest.strategy.ts`
- `apps/automation/src/stats/stats-collector.service.ts`

БД: `database/migrations/025_landing_featured.sql`, `040_ad_orders.sql`, `044_ad_revenue.sql`; таблиці `ad_orders`, `ad_prices`, `agent_actions`, `editor_slots`, `published_posts`, `post_stats_snapshots`, `channel_stats_snapshots`, `tracked_channels`, `meta_accounts`, `tiktok_accounts`.
