# BRD (as-is) — Маркетинг: лендінг, медіакіт, реклама, ліди, white label, звіти для рекламодавців

> Статус: оновлено з коду 2026-10-10 (коміт 54dd1eb, гілка feat/editor-agent). Описує, як система ФАКТИЧНО працює зараз, а не як мала б.

## Що змінилось з 2026-10-05

- Публічна `/` перебудована навколо AI-агентів (тільки англійською): вітрина згрупована за мережами з бейджами агентів (`GET /api/landing/networks`), живий доказ автономності з `GET /api/landing/pulse` (spec 026).
- Рекламу замовляють через Telegram DM: кожна рекламна кнопка відкриває `t.me/<акаунт>?text=…` з тегом `[ai0web:<placement>[:<канал>]]`; тріаж DM за тегом ставить джерело «landing», категорію `ad` і фільтрує прайс за каналом (spec 026).
- Особисту пошту прибрано: на `/` немає `mailto:`, бейджа «Self-serve — coming soon» і жорстко прописаної адреси; CI і тест перевіряють, що вони не повернуться (spec 026).
- Нові заявки (ліди): форма «No Telegram? Leave a request» біля кожної рекламної кнопки і форма white label; `POST /api/landing/leads`, таблиця `landing_leads`, сповіщення власнику, вкладка «Leads» (spec 026).
- White label: секція `#white-label` на `/` і публічна сторінка `/white-label`, вмикаються прапором `landing.white_label_enabled` (spec 026).
- `/app/landing` має три вкладки: «Page setup» (акаунт і текст DM, white label, мережі, ресурси), «Leads», «CTA stats»; живе превʼю тепер будує сервер тим самим кодом, що й публічну сторінку (spec 026).
- Адмін-список ресурсів ховає неактивні акаунти і додає YouTube; на публіці YouTube зʼявляється лише з активним і вибраним рядком (spec 026).
- Медіакіт віддає `adDmUrl` для кожного каналу (кнопка «Order an ad in Telegram») (spec 026).
- Звіт рекламодавця `/report/$token` тепер англійською, дати `en-GB` (правило власника 2026-10-06, spec 026).
- Сторінку погодження DM перейменовано: «DM inbox» на `/app/dm`, старий `/app/agent` перенаправляє туди; там погоджують `schedule_post` і `reply` (spec 027).
- Пункти меню «Landing» і «Ads» беруться з реєстру навігації, група «Marketing» (spec 027).
- Стратегії-дайджести стали legacy і при переході на агентів мапляться на серію `network_highlights`, яка спонсора дайджесту не публікує (spec 023), див. спостереження в 3.2.

## 1. Призначення розділу

Розділ «Marketing» (група меню за замовчуванням з пунктами «Landing» і «Ads», `apps/dashboard/src/nav/registry.ts`) закриває бізнес-задачі власника мережі каналів: (1) публічна «вітрина» на `/`: мережі, якими керують AI-агенти, медіакіт, рекламні кнопки й форми, пропозиція white label; (2) продаж реклами в Telegram-каналах мережі: заявка через DM або форму → прайс → замовлення → платіжне посилання LiqPay → погодження поста власником → резервований слот редактора → публікація з позначкою `#реклама` → публічний звіт через 24 і 72 год; (3) облік заявок (лідів) і кліків з лендінгу.

Користувач розділу — один власник/оператор (вхід у `/app`). Рекламодавець і клієнт white label акаунта в системі не мають. Вони бачать лише публічні сторінки: `/` (медіакіт, кнопки, форми), `/white-label`, сторінку оплати LiqPay за посиланням від власника і звіт `/report/$token`. Звернутися можна через Telegram DM на агентський акаунт або через форму заявки.

Важливе уточнення щодо назв: медіакіт (канали з цінами, підписники, середні перегляди) будується автоматично з прайс-листа на `/app/ads`. Сторінка `/app/landing` керує акаунтом і текстом рекламного DM, white label, описами й порядком мереж, вибором ресурсів, а також показує ліди й статистику кнопок. Окремої сутності «рекламодавець» немає: це текстове поле `ad_orders.advertiser`; заявки з форм лежать окремо в `landing_leads` і з замовленнями не повʼязані.

## 2. Сторінки розділу

| Сторінка | Маршрут | Коротко |
|---|---|---|
| Landing | `/app/landing` | Вкладки «Page setup» (`?tab` немає), «Leads» (`?tab=leads`), «CTA stats» (`?tab=stats`); праворуч на «Page setup» — живе превʼю вітрини мереж |
| Ads | `/app/ads` | Прайс-лист, створення замовлення на рекламу, платіжне посилання, планування поста, посилання на звіт |
| Звіт рекламодавця | `/report/$token` | Публічна сторінка зі статистикою одного рекламного поста (24 год / 72 год), без логіну |
| Публічна головна (маркетингові блоки) | `/` | Кнопки «Order an ad in Telegram», вітрина мереж, медіакіт, форма заявки, секція white label, доказ автономності |
| White label | `/white-label` | Публічна сторінка пропозиції white label з формою заявки |

## 3. Сторінки

### 3.1 Landing — `/app/landing`

**Бізнес-мета.** Дати власнику контроль над тим, як публічна сторінка приймає рекламні замовлення, які ресурси й мережі видно і в якому порядку, а також бачити, хто натискав кнопки й залишав заявки. Усе без правок коду.

**Хто користується / доступ.** Тільки після логіну (маршрут під `/app`, guard роутера й nginx, spec 028). Усі `GET/PUT/PATCH/POST /api/landing/admin…` захищені `TrackingAuthGuard` (Bearer `TRACKING_TOKEN` або сесійна кукі `tracking_jwt`). Публічні `/api/landing/*` (див. 3.4) — без авторизації.

**Що показує.**
- Заголовок «Landing», підзаголовок «How the public landing page takes ad orders, which resources it shows in which order, and what visitors do.», кнопка «Open live page ↗» (відкриває `/` у новій вкладці), перемикач вкладок «Page setup» / «Leads» / «CTA stats».
- **Page setup → картка «Public page»** (`PublicPageCard`): поле «Ad DM account» (`@` + username; підказка: порожнє — агентський акаунт `@…`, якщо він є), поле «DM message» (шаблон з `{target}` і `{ref}`, лічильник «N/240», кнопка «Default text»), чекбокс «White-label offer» → «Show the white-label section and page». Бейдж стану: «Telegram DM on» або «Form only». Праворуч «Live preview»: три зразки повідомлення (hero, картка каналу, дуже довга назва з медіакіту) з довжиною «N/300» і посиланням «Test link» або «No link without an account». Дані: `GET /api/landing/admin/config`; превʼю — `POST /api/landing/admin/config/preview` (з затримкою 300 мс, нічого не зберігає).
- **Page setup → картка «Networks»** (`NetworksCard`): кожна група з `meta_account_groups`: назва, «N/M featured», чип агента («Run by AI agent {name} · live», «AI agent {name} in training (shadow)») або «No agent», позиція «#N», «Move up» / «Move down», поле опису (≤280 символів) з «Save» / «Discard». Порожньо: «No networks yet. Group resources into networks under Connections → Groups.» Дані: `GET /api/landing/admin/networks`.
- **Page setup → ресурси** по платформах у порядку Telegram, Instagram, Facebook, Threads, TikTok, YouTube; у шапці групи «N/M featured». Рядок: аватар (або іконка платформи), назва (`displayName`, інакше `@handle`, інакше назва платформи), `@handle`, підписники (K/M/B). Для featured — бейдж «#N on landing», «Move up», «Move down», «Hide from the landing»; для інших — «Feature on the landing». Дані: `GET /api/landing/admin` → `LandingResourcesService.listAdmin()` → `tracked_channels` (`is_mine = true`), активні `meta_accounts`, активні `tiktok_accounts`, `youtube_accounts` (міграції `025_landing_featured.sql`, `066_landing_ai_network.sql`).
- **Page setup → «Live preview»** праворуч: той самий компонент `NetworkShowcase`, що й на `/`, з полем `preview` відповіді `GET /api/landing/admin/networks` (сервер будує його тим самим кодом, що й публічний `GET /api/landing/networks`, без кешу).
- **Leads** (`LeadsCard`): перемикач «All» / «Ad requests» / «White label», фільтр «Status» («All but spam», New, Contacted, Qualified, Won, Lost, Spam), таблиця «Received», «Kind», «Who», «Contact», «Request», «Status»; дії «Copy contact», «Open, set status, add a note», «Mark as spam». Модалка заявки показує контакт, імʼя, компанію, запит, «From … button», UTM, ресурси, повідомлення, позначку очищення; поля «Status» і «Your note» (≤2000). Дані: `GET /api/landing/admin/leads?kind&status&limit`, `PATCH /api/landing/admin/leads/:id`.
- **CTA stats** (`CtaStatsCard`): «CTA stats · last 30 days», таблиця за розміщенням: «Telegram clicks», «Tagged DM threads», «DM rate», «Form opens», «Form leads», «White-label clicks» + рядок «Total»; під таблицею — дата початку (UTC) і кількість рекламних DM-тредів без тегу. Дані: `GET /api/landing/admin/cta-stats?days=30`.

**Дії користувача.**
- «Save» у «Public page» → `PUT /api/landing/admin/config {adTgUsername?, adMessage?, whiteLabelEnabled?}` → рядки `app_settings` `landing.ad_tg_username`, `landing.ad_message_en`, `landing.white_label_enabled`; порожнє значення або текст за замовчуванням видаляє ключ; кеш публічного конфігу скидається. Кнопка активна лише коли превʼю актуальне й валідне.
- Опис / порядок мережі → `PATCH /api/landing/admin/network/:groupId {blurb?, order?}` → `meta_account_groups.landing_blurb_en` / `landing_order`; «Move up/down» перенумеровує всі мережі послідовними `PATCH`.
- «Feature on the landing» / «Hide from the landing» → `PATCH /api/landing/admin/:platform/:id {landingVisible, landingOrder}` → `UPDATE <таблиця> SET landing_visible, landing_order`; новий featured-ресурс отримує `order = max(order серед видимих)+1` (або 0). Після зміни кеш вітрини мереж скидається.
- «Move up/down» ресурсу → клієнт міняє місцями два елементи в плоскому списку видимих і перенумеровує весь список 0..N-1; кожен змінений рядок — окремий послідовний `PATCH`, потім одне перезавантаження. Кнопки disabled, поки триває мутація.
- Статус і нотатка заявки → `PATCH /api/landing/admin/leads/:id {status?, ownerNote?}`; «Mark as spam» ставить `status='spam'`.

**Бізнес-вимоги (as-is).**
- `BR-MKT-01` Система показує на `/app/landing` кандидатів чотирьох типів: Telegram-канали з `tracked_channels.is_mine = true`, АКТИВНІ рядки `meta_accounts` (Instagram/Facebook/Threads), АКТИВНІ `tiktok_accounts` і кандидатів з `youtube_accounts`, незалежно від того, вибрані вони чи ні; неактивні Meta/TikTok-акаунти в списку не показуються (spec 026).
- `BR-MKT-02` Система зберігає вибір власника у колонках `landing_visible` (boolean, default false) і `landing_order` (int ≥ 0, default 0) відповідної таблиці ресурсу (для YouTube — з міграції 066).
- `BR-MKT-03` Публічний `GET /api/landing/resources` повертає ресурси, у яких `landing_visible = true` і (для `meta_accounts`/`tiktok_accounts`/`youtube_accounts`) `active = true`, (для Telegram) `is_mine = true`, відсортовані за `landing_order`; відповідь містить лише `platform, handle, displayName, avatarUrl, followerCount, url, order` — без токенів і внутрішніх id.
- `BR-MKT-04` Посилання профілю (`url`) формується з handle: `https://t.me/<handle>`, `https://www.instagram.com/<handle>`, `https://www.facebook.com/<handle>`, `https://www.threads.net/@<handle>`, `https://www.tiktok.com/@<handle>`, `https://www.youtube.com/@<handle>` (без handle — `youtube.com/channel/<channel_id>`); для Telegram handle береться з `channel_key` без початкового `@`, інакше з `username`.
- `BR-MKT-05` Для Telegram-каналів як кількість підписників віддається `tracked_channels.subs_count`, для Meta — `followers`, для TikTok — `null`, для YouTube — `subscribers` (поки 019b не заповнює статистику, `null`); аватар для Telegram і YouTube завжди `null` (показується іконка платформи).
- `BR-MKT-06` Порядок ресурсів — один плоский `landing_order` для всіх платформ; кнопки «Move up/down» перенумеровують усі видимі ресурси, щоб виправити стан, коли всі `landing_order` = 0. На публічній сторінці ресурси групуються за мережами (BR-MKT-48), усередині мережі — у цьому ж порядку.
- `BR-MKT-07` `PATCH /api/landing/admin/:platform/:id` валідує тіло (`landingVisible` boolean, `landingOrder` ціле ≥ 0) і відхиляє невідому платформу з 400; на неіснуючий `id` повертає `{ok:true}` без помилки (UPDATE зачіпає 0 рядків).
- `BR-MKT-08` Live-превʼю на `/app/landing` будує сервер: поле `preview` у `GET /api/landing/admin/networks` — точний публічний payload вітрини мереж, зібраний тим самим кодом без кешу; превʼю збігається з `/` (spec 026).
- `BR-MKT-39` Налаштування «Public page» зберігаються в `app_settings` під ключами `landing.*`, якими володіє `LandingConfigService` (на `/app/settings` вони не показуються як env-перевизначення). Шаблон DM: ≤240 символів (рахуються кодові точки), дозволені лише `{target}` і `{ref}`, інший текст у фігурних дужках відхиляється; шаблон без `{ref}` отримує тег у кінці. Username має відповідати `^[A-Za-z][A-Za-z0-9_]{4,31}$` (приймаються `@name` і `t.me/…`). Помилки повертаються як 400 `invalid_landing_config` з `issues[{path, message}]`.
- `BR-MKT-40` Опис мережі — один англійський рядок ≤280 символів або `null`, порядок — ціле 0–9999; невалідне — 400 `invalid_network_patch`, невідома мережа — 404. Колонка `landing_blurb_uk` існує, але не використовується (сторінка тільки англійською).
- `BR-MKT-52` `GET /api/landing/admin/leads` за замовчуванням не показує спам (його видно лише з `status=spam`) і ніколи не повертає `ip_hash`. `PATCH …/leads/:id` приймає лише `status` (new, contacted, qualified, won, lost, spam) і `ownerNote`; невалідне — 400 `invalid_lead_patch`, невідомий id — 404.
- `BR-MKT-53` `GET /api/landing/admin/cta-stats?days=N` (за замовчуванням 30) повертає для кожного розміщення кліки DM, кількість DM-тредів з тегом цього розміщення, відкриття форми, заявки з форми та кліки white label, плюс кількість рекламних DM-тредів без тегу за той самий період.

**Бізнес-правила й обмеження.** Немає ліміту кількості featured-ресурсів. Немає перевірки, що ресурс має публічний профіль (handle може бути `null` → картка без посилання). Назви й аватари ресурсів не редагуються: відображається те, що лежить у таблицях ресурсів. Мережа зʼявляється на публіці лише тоді, коли хоча б один її ресурс вибраний. Кеш публічного конфігу й вітрини — 300 с; зміни адмінки скидають кеш процесу, але браузери можуть тримати відповідь до 300 с (`Cache-Control`).

**Стани.** «Page setup»: завантаження — skeleton-рядки; помилка ресурсів — картка «Couldn’t load landing resources» + текст; порожньо — «No candidate resources yet / Connect channels and accounts under Connections — anything with a public profile becomes a landing candidate.»; помилка конфігу — «Couldn’t load the public page settings…»; помилка мереж — «Couldn’t load the networks…»; помилка превʼю — «Couldn’t load the preview: …». «Leads»: «Loading…», «Couldn’t load leads: …», порожньо «No leads here». «CTA stats»: «Loading…», «Couldn’t load CTA stats: …», порожньо «No clicks yet».

**Фонові процеси.** `RetentionService` очищає старі заявки (BR-MKT-46). Інших немає.

**Звʼязки.** Ресурси надходять із Connections (`is_mine`, Meta, TikTok), мережі — зі сторінки Groups (`/app/connections/groups`), агентський акаунт — з MTProto-сесії `role='agent'`. Публічно результат видно на `/` і `/white-label`. Нова заявка зʼявляється також у `/app/agents/inbox` (посилання на вкладку Leads). Тегнуті DM видно в `/app/dm`.

**Спостереження «як фактично зараз».**
- Перенумерація ресурсів і мереж — N окремих послідовних `PATCH` без транзакції; при збої посередині порядок може лишитися частково зміненим.
- Індекси `idx_*_landing` у міграції 025 побудовані під фільтр `landing_visible AND active`, але для `tracked_channels` умова інша (`is_mine`) — це лише оптимізація, на поведінку не впливає.
- Порядок ресурсів у меню «#N on landing» — плоский по всіх платформах, а на публічній сторінці ресурси розкладено по мережах; номер «#N» не відповідає позиції всередині блоку мережі.
- Кліки рахуються лише на публічних сторінках: лічильник сидить у React-контексті, якого немає в адмінському превʼю, тож кліки власника в превʼю статистику не псують.

**Відкриті питання до власника.** Чи потрібна статистика CTA за довший період або експорт заявок? Чи показувати в списку заявок звʼязок із замовленням `ad_orders` (зараз їх нічого не повʼязує)?

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
- **Get payment link** (для `draft` / `awaiting_payment`) → `POST /api/ad-orders/:id/checkout` → статус `awaiting_payment`, `liqpay_order_id = id`; повертає `data`, `signature`, `actionUrl` (`https://www.liqpay.ua/api/3/checkout`). Дашборд складає URL `actionUrl?data=…&signature=…`, показує в readonly-полі «Payment link — send this to the advertiser» з кнопкою «Copy». Власник пересилає його рекламодавцю вручну.
- **Schedule post** (для `paid`, крім `digest_sponsor`) → розкривається форма (Channel, Schedule at, Post text, якщо в замовлення немає creative) → `POST /api/ad-orders/:id/schedule` → створюється `agent_actions` типу `schedule_post` у статусі `pending`, до замовлення привʼязується `action_id`, статус стає `scheduled`. Далі UI лише підказує «approve the action on /app/agent»; цей шлях перенаправляє на «DM inbox» `/app/dm`, де дію погоджують.
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
- `BR-MKT-19` Успішне планування створює `agent_actions` (`schedule_post`, статус `pending`, payload: `text`-превʼю з рядком `#реклама`, `channelId`, `scheduledAt`, `orderId`) і ставить замовлення в `scheduled`; пост НЕ публікується, поки власник не погодить дію в «DM inbox» `/app/dm` (старий `/app/agent` перенаправляє туди, spec 027).
- `BR-MKT-20` Після погодження дії (`AdPlacement`): якщо `EDITOR_ENABLED=true` і для каналу є картка редактора (будь-який режим) — резервується слот редактора (`editor_slots`, `kind=reserved`, `source_hints: ad_order:<id>`, `post_spec` = creative) і в замовлення записуються `editor_slot_id`, `publish_at`; інакше пост кладеться в чергу `scheduled_posts` (замовлення лишається `scheduled`, `editor_slot_id = NULL`).
- `BR-MKT-21` Резервований слот публікується детерміновано, без LLM, окремим потоком планувальника, незалежно від режиму редактора (`off`/`shadow`/`approve`/`live`); режим погодження (spec 031) і пауза ресурсу директивою `pause_resource` (spec 025) платну рекламу не зупиняють. `SponsoredPublisher` рендерить creative з кодовим футером `#реклама` (останній рядок; за наявності `sponsorLabel` — перед ним «Реклама. Замовник: …»), надсилає в канал, пише `published_posts` (`strategy_type='ad'`, `source_url=ad://order/<id>`, тег `реклама`), ставить слот `published`, а замовлення — `published` з `published_post_id` і випуском `report_token`.
- `BR-MKT-22` Резервований слот, що запізнився більше ніж на 6 годин (`RESERVED_MAX_LATE_MS`), не публікується: слот `failed`, власник отримує алерт «Реклама … не вийшла … Перенеси замовлення на /app/ads»; будь-яка помилка публікації фінальна (повторної відправки немає, щоб не дублювати пост).
- `BR-MKT-23` Для формату `pin_24h` система лише надсилає власнику повідомлення «закріпи цей пост на 24 год і відкріпи після»; фактичного закріплення/відкріплення вона не виконує.
- `BR-MKT-24` Замовлення формату `digest_sponsor` не планується кнопкою; його підхоплюють лише legacy-стратегії network-digest / topic-digest у день `publish_at` (за київською датою) для відповідного каналу, якщо статус `paid` або `scheduled` і в creative є URL (`cta.url` або першої кнопки); після виходу дайджесту замовлення стає `published`. Агентська серія `network_highlights`, на яку мапляться дайджести при переході (spec 023), спонсорський рядок не публікує.
- `BR-MKT-25` Посилання спонсора в дайджесті отримує UTM: `utm_source=ai0`, `utm_medium=telegram`, `utm_campaign=<перші 8 hex id замовлення>` (для статичного спонсора зі стратегії — `digest`).
- `BR-MKT-26` Щогодини (cron `17 * * * *`) `AdReportsService` будує звіти для замовлень `published`, чий пост старший за 24 год (перший звіт) або 72 год (фінальний), до 50 за запуск; фінальний звіт переводить замовлення в `reported` і ставить `reported_at`.
- `BR-MKT-27` При першому звіті, якщо замовлення має `thread_id` (DM-тред), система створює `pending` дію `reply` із текстом-запрошенням і публічним посиланням (власник погоджує відправку в `/app/dm` — автоматично нічого не йде); без треду власник отримує повідомлення в admin-боті з посиланням «надішли рекламодавцю вручну».
- `BR-MKT-28` Сторінка показує бейдж «reserved slot» лише для замовлень зі статусом `scheduled` і заповненим `editor_slot_id`.
- `BR-MKT-29` На запит про рекламу в DM triage-агент готує чернетку відповіді (`reply`, `kind: price_list`) з детермінованим шаблоном прайсу (ціни в грн), якщо є активні ціни. Якщо в полях треду є канал (`fields.channel`: з тегу лендінгу або названий у переписці), прайс звужується до цього каналу; немає збігу — показуються всі ціни. Відправка потребує погодження власника, одна чернетка на тред.

**Бізнес-правила й обмеження.** Єдиний платіжний провайдер — LiqPay (hosted checkout), картки не зберігаються. Усі ціни — цілі гривні. Часові зони: день дайджесту — `Europe/Kyiv`; `Publish at` у формі — локальний час браузера, передається як ISO; дохід у KPI-дайджесті MANAGER рахується за днем `paid_at` у часовому поясі ресурсу (`resource_tz`, spec 024). Редагування замовлення (`PATCH /api/ad-orders/:id`) дозволене до публікації (статуси draft…scheduled), але в UI відсутнє. Перегляд списку може фільтруватися `?status=`, UI фільтра не має. Щоденний кап відповідей (`AGENT_REPLY_DAILY_CAP`) діє при погодженні `reply`.

**Стани.** Завантаження замовлень — 3 skeleton-картки; порожньо — «No ad orders yet / Create an order above to generate a payment link for an advertiser.»; «No active prices yet.»; помилки мутацій показуються червоним текстом поруч із кнопкою. Помилка «LiqPay not configured» відображається так само (текст помилки з API).

**Фонові процеси.**
- Cron `ad-reports` (`17 * * * *`) — звіти 24/72 год.
- Hourly `StatsCollector` (`EVERY_HOUR`) — знімки `post_stats_snapshots` і `channel_stats_snapshots` для постів не старших за `STATS_POST_AGE_DAYS` (30 за замовчуванням); потребує увімкненого `TelegramStatsClient`.
- Планувальник editor-слотів — публікація reserved-слотів (`ReservedDispatcher`/`SponsoredPublisher`) на кожному тіку, окремо від основного тіку й тіку погоджень.
- Legacy дайджест-стратегії — публікація спонсорського рядка.

**Звʼязки.** `/app/dm` («DM inbox») — погодження `schedule_post` і `reply`; `/app/editor` — слоти; LiqPay (`server_url` на `DASHBOARD_URL`); Telegram (публікація й статистика, admin-бот для алертів); `/` (медіакіт з цін, кнопки DM); `/report/$token`; `kpi-digest.service.ts` рахує дохід із `ad_orders` за `paid_at`.

**Спостереження «як фактично зараз».**
- Немає шляху до статусу `canceled`: жоден ендпоінт чи UI-кнопка його не ставить (хоча `SponsoredPublisher` його перевіряє). Скасувати/повернути гроші/позначити «оплачено вручну» неможливо; статусів `refunded`/`failed` немає (хоча `kpi-digest` їх виключає у запиті).
- Callback не звіряє суму й валюту з замовленням і не обробляє невдалі/повернені платежі (будь-який статус, окрім `success`, мовчки ігнорується). Якщо `DASHBOARD_URL` порожній, `server_url` не передається у LiqPay і замовлення ніколи не стане `paid` автоматично.
- `createCheckout` не перевіряє поточний статус: повторний виклик через API на вже `paid`/`published` замовлення перезапише статус на `awaiting_payment`. UI ховає кнопку, але захисту в бекенді немає.
- Fallback-шлях (`EDITOR_ENABLED=false` або немає картки редактора): пост іде через `scheduled_posts`, замовлення назавжди лишається `scheduled` — без `published_post_id`, без звіту, без токена; на сторінці це виглядає як «завислий» заказ.
- Формат ідентифікатора каналу в `ad_orders.channel_id` змішаний: з ціною — `channel_key` (`@name`), з форми — `tracked_channels.id` (uuid). Через це запит доходу в `kpi-digest` (`'telegram:' || channel_id`) для uuid-замовлень не збігається з ресурсом, а дайджест-спонсор окремо обробляє обидва формати.
- Для `digest_sponsor` кнопка «Schedule post» схована в UI, але бекенд `schedulePost` не забороняє його; формат `digest_sponsor` також не виконує жодного резервування слота — публікація залежить від того, що legacy-стратегія дайджесту для цього каналу ще ввімкнена й справді запущена в день `publish_at`. Після переходу каналу на агентів (spec 023: привʼязки дайджестів виводяться, серія `network_highlights` спонсора не знає) оплачене замовлення `digest_sponsor` не вийде і лишиться `paid`/`scheduled` без алерту.
- Для замовлення дайджесту звіт можливий лише якщо `published_posts` знайдено за каналом і `message_id` (підзапит у `markPublished`); якщо ні, `published_post_id` = NULL, замовлення `published`, але звіт не будується.
- Рекламодавця як сутності немає: ні контактів, ні історії, ні каталогу; ключ — вільний текст `advertiser`. Заявки з форм (`landing_leads`) і DM-треди з замовленням не повʼязані.
- Інтерфейс англійською, рекламний текст і повідомлення власнику в admin-боті — українською (це контент). Формат чисел змішаний: таблиця цін і звіт — `en-GB`, публічний медіакіт — `en-US`.
- `AD_ORDER_CURRENCY=UAH` є у `.env.example`, але код його не читає — валюта хардкодиться `UAH` у дашборді та сервісі.
- URL звіту на сторінці будується з `window.location.origin`, а в DM/алерті — з `DASHBOARD_URL`; при різних доменах посилання відрізнятимуться.
- Підказки на сторінці («approve the action on /app/agent», «Approving the action on /app/agent reserves the slot») досі називають старий шлях; він працює лише як редирект на `/app/dm`, а конкретну дію сторінка не посилає.

**Відкриті питання до власника.** Потрібен ручний «Mark as paid» / скасування / повернення? Чи треба звіряти суму в callback? Чи має fallback-шлях теж закривати замовлення та будувати звіт? Чи потрібна окрема сутність рекламодавця, що обʼєднає заявку, DM-тред і замовлення? Чи переносити спонсора дайджесту в агентську серію `network_highlights` перед виведенням стратегій-дайджестів?

---

### 3.3 Звіт рекламодавця — `/report/$token`

**Бізнес-мета.** Дати рекламодавцю прозору статистику його розміщення без доступу в дашборд; підвищити довіру і повторні замовлення.

**Хто користується / доступ.** Публічна сторінка, поза `/app`-гардом і поза nginx `auth_request`; доступ лише за непередбачуваним токеном у URL. Рекламодавець отримує посилання від власника (через погоджену DM-відповідь або вручну).

**Що показує.** (тексти англійською, дати й числа `en-GB`)
- Шапка: wordmark «ai0» і «Advertiser report».
- Заголовок: назва рекламодавця, бейдж «first day · 24 h» або «final · 72 h»; рядок: канал (посилання на `t.me/<handle>`), «published <дата>», посилання «open the post» (`t.me/<handle>/<message_id>`).
- Чотири плитки: «Views», «Forwards», «Reactions», «Reach» (`reachRate` у % з підписом «of N subscribers»).
- Графік «Views by hours since publication» (SVG-полілінія; вісь X — години «N h», до 96 точок; якщо менше двох замірів — «Not enough measurements for a chart yet.»).
- Блок «Link in the post» (якщо в creative є CTA): URL і пояснення — з UTM («The link has UTM tags — clicks show up in your analytics (utm_source / utm_campaign).») або без («Telegram does not report link clicks; add UTM tags to the link to see them in your analytics.»).
- Підвал: «Data as of …» і для 24-годинного звіту — «The final report appears at this same link 72 hours after publication.»
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
- `BR-MKT-37` Невідомий/хибний токен на сторінці дає жовтий callout «Report not found. Check the link or contact us.»; усі тексти сторінки англійською (правило власника 2026-10-06; тест `no-cyrillic-ui` стежить за кирилицею в UI).
- `BR-MKT-38` Звіт не містить кліків: Telegram їх не дає; єдиний «CTR-проксі» — UTM-мітки в аналітиці рекламодавця.

**Бізнес-правила й обмеження.** Токен є єдиним ключем доступу; терміну дії та відкликання немає. Метрики «forwards», «reactions», «replies» залежать від `TelegramStatsClient`; `replies` збирається, але на сторінці не показується.

**Стани.** Завантаження — сіра картка-заглушка; помилка/не знайдено — callout; дані без замірів — «—» у плитках і повідомлення про брак точок для графіка.

**Фонові процеси.** Cron `ad-reports` (щогодини) створює/оновлює JSON звіту; `StatsCollector` (щогодини) наповнює знімки. Якщо знімків немає, звіт усе одно створюється з порожніми метриками.

**Звʼязки.** Звідки приходять: посилання з DM-відповіді (погоджена власником дія `reply`), алерт власнику в admin-боті або кнопка «Report (24h|72h)» на `/app/ads`. Інтеграції: Telegram (метрики), Postgres.

**Спостереження «як фактично зараз».**
- Звіт повертається навіть якщо метрик немає (всі `null`): рекламодавець побачить порожню сторінку, а замовлення вже вважатиметься `reported`.
- Один токен покриває і 24h, і 72h звіт: після оновлення старий стан перезаписується, історії версій нема.
- У `apps/dashboard/index.html` немає `noindex` (є лише в `public/auth-unavailable.html`); захист звіту — лише непередбачуваність токена.
- Плитка «Reach» названа як охоплення, але це `views/subscribers` — проксі, не унікальне охоплення.
- Callout «contact us» не дає жодного контакту; самообслуговування (замовлення й оплата рекламодавцем) не реалізовано, оплата лишається ручним посиланням від власника (spec 015 — майбутнє).

**Відкриті питання до власника.** Чи потрібен термін дії токена, перегенерація, PDF/експорт? Чи показувати `replies`? Чи слід не віддавати «порожній» звіт, коли немає жодної знімки?

---

### 3.4 Публічна головна: маркетингові блоки — `/`

**Бізнес-мета.** Показати мережу, якою керують AI-агенти, і зібрати рекламні замовлення та заявки white label без ручних контактів власника. Hero, тексти й діаграму агентів описує BRD 01; тут — те, що стосується продажу.

**Хто користується / доступ.** Будь-хто, без логіну. Усі ендпоінти нижче публічні (контролери без `@UseGuards`) і віддають лише публічні проєкції.

**Що показує (маркетингові блоки).**
- Верхня панель: «Advertise» (DM-посилання, розміщення `topbar`; без DM-акаунта — якір `#advertise`).
- Hero: «See the network ↓», «Order an ad in Telegram» (`hero`) і під ними «No Telegram? Leave a request»; без DM-акаунта — «Advertise with us» (→ `#advertise`). Посилання «White label for your own resources →», якщо white label увімкнено. Смуга доказу (`ProofStrip`): «posts by agents in 7 days», «agents live», «of content created by agents», «last agent post»; плитки з нулем ховаються, уся смуга ховається при помилці `/pulse`; «?» показує визначення.
- «Networks run by AI» (`#networks`, `NetworkShowcase`): блок мережі — назва, опис власника, чип агента, підписники, іконки платформ, «Advertise in this network» (`network`, якщо хоча б один канал має активну ціну); картки ресурсів з бейджем «Run by an AI agent» / «Agent in shadow · classic pipeline publishes» / «Automated pipeline» і «Ads here» (`resource`, лише канал з активною ціною); окремі ресурси останніми під «Standalone channels».
- «How it works» (`#how-it-works`): рядок 2 «як замовити рекламу» (`#order-an-ad`) з поясненням, що відповідь готує AI-асистент, а власник перевіряє, і кнопкою (`howitworks`).
- «Advertise with us» (`#advertise`): медіакіт (`MediaKit`, у кожній картці каналу «Order an ad in Telegram» (`mediakit`) і «No Telegram? Leave a request») і пара кнопок (`advertise`).
- Секція white label (`#white-label`, якщо увімкнено): три картки можливостей, заява про single-tenant, посилання на `/white-label`.
- Підвал: «Advertise» (`footer`), посилання на white label (якщо увімкнено).
- Форма заявки на рекламу — модалка «Request an ad placement» («No Telegram? Leave your contact and we will get back to you.») з наперед заповненою ціллю; без DM-акаунта пари кнопок стають кнопками «Request an ad placement».
- Дані: `GET /api/landing/config`, `GET /api/landing/networks`, `GET /api/landing/pulse`, `GET /api/landing/media-kit`; запис — `POST /api/landing/cta` (beacon), `POST /api/landing/leads`.

**Дії користувача.**
- Клік по рекламній кнопці → новий таб `https://t.me/<username>?text=<повідомлення з тегом>` і `navigator.sendBeacon('/api/landing/cta', {cta: 'ad_dm', placement, lang})`.
- «No Telegram? Leave a request» → модалка форми (`cta: 'ad_form'` у beacon); «Send request» → `POST /api/landing/leads {kind: 'ad', …}`.
- Клік на white label → beacon `white_label`; форма на `/white-label` → `POST /api/landing/leads {kind: 'white_label', …}`.

**Бізнес-вимоги (as-is).**
- `BR-MKT-41` Кожне рекламне посилання будує сервер (`config/landing-dm.ts`, `buildAdDmUrl`): `https://t.me/<username>?text=<encodeURIComponent(msg)>`. Повідомлення — шаблон `landing.ad_message_en` (за замовчуванням «Hi! I'd like to order an ad in {target}. {ref}»), де `{target}` — назва каналу або «the ai0 network», а `{ref}` — `[ai0web:<placement>]` або `[ai0web:<placement>:<channel_key>]`. Повідомлення ≤300 символів: обрізається назва цілі, тег не обрізається ніколи.
- `BR-MKT-42` Username для DM береться в порядку: `landing.ad_tg_username` → `username` активної MTProto-сесії `role='agent'` → немає. Без username `adDm.available=false`: DM-кнопок у картках мереж, каналів і медіакіту немає; hero («Advertise with us»), верхня панель і підвал ведуть на `#advertise`, де пара кнопок стає кнопкою форми «Request an ad placement». Публічний конфіг кешується 300 с.
- `BR-MKT-43` Розміщення: `hero`, `topbar`, `network`, `resource`, `mediakit`, `advertise`, `footer`, `howitworks` (в DM-тегу) і `whitelabel` (лише кліки й ліди, ніколи в DM-тегу). Посилання рівня мережі (`hero`, `topbar`, `advertise`, `footer`, `howitworks`) приходять у `GET /api/landing/config` → `adDm.urls`; посилання каналів — у `GET /api/landing/networks` (лише для каналу з активною ціною) і `GET /api/landing/media-kit` (кожен рядок; `null` без DM-акаунта).
- `BR-MKT-44` Beacon `POST /api/landing/cta {cta ∈ ad_dm|ad_form|white_label, placement, lang}` додає 1 до `landing_cta_daily` за UTC-день (`lang` завжди `'en'`); невідомі `cta`/`placement` ігноруються з 204. Про відвідувача нічого не пишеться. Ліміт 60/хв на клієнта (у памʼяті процесу, ключ — sha256 від солі й IP; сіль з `PROMO_HASH_SALT`, інакше з `TOKEN_ENCRYPTION_KEY`), понад ліміт — 429.
- `BR-MKT-45` Атрибуція DM: `parseLandingRef` шукає в тексті `\[ai0web:([a-z_]{2,16})(?::@?([A-Za-z0-9_]{3,64}))?\]`. Знайдений тег до виклику моделі записує в `agent_dm_threads.fields` `source='landing'`, `placement` і `channel`; категорії `other`/`question` для такого треду стають `ad` (`spam` і `vp` лишаються). Поля зливаються (`old || new`), тож наступне повідомлення без тегу зберігає джерело. `/app/dm` показує чип «From landing · {placement} · @channel». Підроблений тег впливає лише на атрибуцію й категорію: ціни, оплата чи відправка від нього не залежать (spec 026 FR-016).
- `BR-MKT-46` `POST /api/landing/leads` (`kind`: `ad` | `white_label`) обробляється в порядку: ліміт 5/год на клієнта (429) → `white_label` з вимкненим прапором (403, нічого не зберігається) → zod-валідація (400 `{error: 'invalid_lead', issues}`) → спам → дедуп → запис і сповіщення. Збережена, продубльована і спамна заявка однаково отримують 201 `{ok: true}`; недоступна БД — 503 з DM-посиланням. Повідомлення й ресурси заявок зі статусом `lost`/`spam` очищаються через 180 днів після `updated_at` (`LANDING_LEAD_PURGE_DAYS`), ставиться `purged_at`.
- `BR-MKT-47` Правила заявки: `contact` ≤200 і має бути Telegram `@username`/`t.me` (нормалізується до `@name`), email або телефон (`contact_kind`); `message` ≤2000; `resources` ≤10 посилань http(s) (лише white label); `consent: true`; заявка white label потребує імені; невідомі `utm_*` відкидаються. Спам — заповнене приховане поле `website` або форма надіслана швидше ніж за 2,5 с від відкриття: зберігається зі статусом `spam` без сповіщення. Дубль (той самий `ip_hash` + контакт без регістру + `kind` за 24 год) оновлює наявний рядок без нового сповіщення. Єдиний слід клієнта — `ip_hash`; `landing_leads` не має гранту для `editor_ro`.
- `BR-MKT-48` Нова заявка створює один пункт `agent_inbox` (`kind='landing_lead'`, `severity='action'`) через `OwnerInbox`, що також надсилає алерт в admin-бот; не більше 20 сповіщень на день (за `notified_at`), решта заявок зберігається без сповіщення. Пункт Inbox не містить імені й контакту; контакт є лише в Telegram-алерті власнику та на вкладці «Leads».
- `BR-MKT-49` `GET /api/landing/networks` повертає `[{name, blurb, order, agent{name, emoji, mode}|null, followers, platforms[], adDmUrl, resources[]}]`, останньою — група `name: null` з окремими ресурсами. `aiRun` ресурсу: агент у `live` або `approve` → `live`, `shadow` → `shadow`, `off`, пауза або немає агента → `none`. Назовні не йдуть id, `@handle` агентів, вартість і персональні дані. Кеш 300 с у процесі + `Cache-Control: public, max-age=300`; невдале оновлення віддає останнє вдале значення.
- `BR-MKT-50` `GET /api/landing/pulse` повертає агреговані лічильники роботи агентів за 7 днів (пости агентів, частка автономності, запуски, рішення власника тощо) без id, handle, вартості й персональних даних. Пости, погоджені власником у режимі погодження, рахуються як пости агентів; реклама, legacy-стратегії й чат-чернетки — лише в загальній кількості. Кеш 300 с, таймаут запиту 2 с; при помилці до 1 год віддається застаріле значення, далі 503 з `Cache-Control: no-store`.
- `BR-MKT-51` На публічних сторінках немає особистих контактів власника: у `apps/dashboard/src`, `index.html` і `public/` заборонені `mailto:` і адреси Gmail; це перевіряють CI (`ci-feature.yml`) і тест `lib/no-personal-contact.test.ts` (spec 026).

**Бізнес-правила й обмеження.** Сторінка тільки англійською. Кукі, сторонньої аналітики й пікселів немає. Ліміти beacon і заявок живуть у памʼяті одного процесу (single-instance). YouTube зʼявляється на сторінці лише з активним і вибраним рядком `youtube_accounts` (зараз підключень YouTube немає, spec 030).

**Стани.** Без DM-акаунта — лише форми. Помилка `/pulse` ховає смугу доказу. Вітрина має власні стани завантаження, помилки й «No resources yet». Форма: інлайн-помилки, зведення помилок з фокусом, «Sending…», панель успіху; окремі тексти для 429, 403 і 503 (503 пропонує посилання на Telegram).

**Фонові процеси.** Немає; очищення заявок — `RetentionService`.

**Звʼязки.** `/app/landing` (налаштування, ліди, статистика), `/app/dm` (тегнуті DM), `/app/agents/inbox` (нові заявки), admin-бот (алерти), Connections → Groups і MTProto-сесія агента (джерела даних).

**Спостереження «як фактично зараз».**
- Атрибуція DM залежить від того, що клієнт Telegram підставив `?text=` і людина не стерла тег; інакше тред лишається без джерела (видно як «untagged» у CTA stats).
- Зміна агентського акаунта або його вимкнення переводить кнопки на форму лише після закінчення кешу (до 300 с).
- Ліміти й дедуп використовують сіль: без `PROMO_HASH_SALT` і `TOKEN_ENCRYPTION_KEY` сіль випадкова на процес, і після рестарту ті самі клієнти рахуються наново.
- Самостійного оформлення й оплати рекламодавцем на лендінгу немає (не входить у spec 026, це spec 015).

**Відкриті питання до власника.** Чи показувати публічно вартість AI (spec 026 пропонує ні)? Які строки зберігання заявок `won`/`qualified` (зараз безстроково)?

---

### 3.5 White label — `/white-label`

**Бізнес-мета.** Продавати окреме розгортання ai0 під ресурси інших власників і збирати заявки.

**Хто користується / доступ.** Публічна сторінка без логіну.

**Що показує.** Заголовок «The ai0 agents, for your own channels», смуга живого доказу (`/pulse`), «What you get» (шість можливостей), «How it is delivered» (чотири кроки і заява про single-tenant з `lib/white-label-copy.ts`), «Questions» (власність даних, AI-розкриття в DM, період shadow, підтримувані платформи, ціни; згорнуто — що знадобиться для спільної мультиклієнтської платформи), форма «Request a white-label setup». З вимкненим прапором — «The white-label offer is temporarily unavailable».

**Дії користувача.** Надіслати заявку white label: імʼя, контакт, компанія, посилання на ресурси, платформи, розмір аудиторії, формат послуги (dedicated / consultation / unsure), повідомлення, згода → `POST /api/landing/leads {kind: 'white_label'}` (правила BR-MKT-46…48).

**Бізнес-вимоги (as-is).**
- `BR-MKT-54` Прапор `landing.white_label_enabled` (за замовчуванням увімкнено) керує пропозицією: вимкнений (або поки конфіг не завантажився) — не рендеряться секція `#white-label`, посилання в hero й підвалі; `/white-label` показує «The white-label offer is temporarily unavailable»; API відхиляє заявки `white_label` з 403.
- `BR-MKT-55` Сторінка прямо каже, що ai0 сьогодні single-tenant: white label — окреме розгортання зі своєю БД, ключами, ботом і акаунтами, яке налаштовує й веде власник; спільного кабінету для кількох клієнтів немає.

**Стани.** Ті самі, що у формі в 3.4; без даних `/pulse` смуга ховається.

**Звʼязки.** Заявки — вкладка «Leads» на `/app/landing` і `/app/agents/inbox`; кліки — розміщення `whitelabel` у CTA stats.

**Спостереження «як фактично зараз».** Мультитенантності немає: кожен клієнт — окреме розгортання, яке власник налаштовує вручну; цін на сторінці немає.

## 4. Наскрізні правила розділу

1. **Життєвий цикл замовлення:** `draft` → (checkout) `awaiting_payment` → (LiqPay `success`) `paid` → (Schedule post) `scheduled` → (публікація слота/дайджесту) `published` → (72h-звіт) `reported`. `canceled` існує лише як значення CHECK.
2. **Ручні точки:** відповідь рекламодавцю в DM (чернетку з прайсом погоджує власник), створення замовлення, передача платіжного посилання, натискання «Schedule post», погодження дії в `/app/dm`, відправка DM зі звітом, закріплення поста для `pin_24h`, обробка заявок із форм. Автоматичні: атрибуція DM з лендінгу, callback оплати, публікація reserved-слота, збір статистики, побудова звіту, сповіщення про заявку.
3. **Маркування реклами:** `#реклама` додається кодом як останній рядок (не моделлю й не рекламодавцем); необовʼязковий рядок «Реклама. Замовник: …».
4. **Грошові значення детерміновані:** ціни в повідомленнях беруться з БД шаблоном, не генеруються LLM; сума при замовленні з прайсу береться сервером.
5. **Публічні ендпоінти** (`/api/landing/resources`, `/config`, `/networks`, `/pulse`, `/prices`, `/media-kit`, `POST /cta`, `POST /leads`, `/api/ads/report/:token`, LiqPay callback) не мають гарду; захист — проєкція даних, токен, підпис, ліміти в памʼяті. Ендпоінт `/api/landing/prices` у дашборді не використовується (лише `media-kit`).
6. **Медіакіт** (`/api/landing/media-kit`): канали, що мають хоча б одну активну ціну; підписники — останній знімок; середні перегляди — `AVG(views)` постів за 30 днів з `editor_v_post_performance`, без рекламних (`strategy_type <> 'ad'`); кожен рядок має `adDmUrl`.
7. **Прод-проксі:** nginx дашборда пересилає `/api/*` без зміни шляху (включно з LiqPay callback і публічними ендпоінтами); `/app` закритий `auth_request`, `/`, `/white-label` і `/report/*` — відкриті.
8. **Мова:** увесь інтерфейс, лендінг і звіт — англійською; українською лишається контент (рекламний текст, прайс у DM, алерти власнику).
9. **Персональні дані:** контакти заявок видно лише на вкладці «Leads» і в Telegram-алерті власнику; кліки не містять даних відвідувача; особистої пошти власника на сторінках немає.

## 5. Глосарій розділу

| Термін | Значення |
|---|---|
| Featured | Ресурс із `landing_visible = true`, показаний на публічній `/` |
| Мережа (на лендінгу) | Група `meta_account_groups` з вибраними ресурсами, описом `landing_blurb_en` і порядком `landing_order` |
| Медіакіт | Публічний блок на `/`: канал + підписники + середні перегляди за 30 днів + ціни (₴) + кнопка DM |
| Розміщення (placement) | Місце рекламної кнопки на лендінгу (`hero`, `topbar`, `network`, `resource`, `mediakit`, `advertise`, `footer`, `howitworks`, `whitelabel`) |
| Тег атрибуції | `[ai0web:<placement>[:<channel_key>]]` у тексті DM |
| Лід / заявка | Рядок `landing_leads` (`ad` або `white_label`) |
| Reserved slot | Слот редактора `kind=reserved`, що публікується без LLM у погоджений час |
| `schedule_post` | Тип дії в `agent_actions`, що чекає на погодження власника |
| Digest sponsor | Формат реклами — спонсорський рядок у щоденному дайджесті каналу (лише legacy-стратегії) |
| Report token | 192-бітний публічний ключ звіту |

## 6. Джерела в коді

Дашборд:
- `apps/dashboard/src/routes/app.landing.tsx`, `apps/dashboard/src/api/landing.ts`, `components/landing/PublicPageCard.tsx`, `NetworksCard.tsx`, `LeadsCard.tsx`, `CtaStatsCard.tsx`, `lib/landing-config-draft.ts`
- `apps/dashboard/src/routes/app.ads.tsx`, `apps/dashboard/src/api/ads.ts`, типи `AdOrder`/`AdReport`/`MediaKitChannel` у `apps/dashboard/src/api/types.ts`
- `apps/dashboard/src/routes/report.$token.tsx`
- `apps/dashboard/src/routes/index.tsx`, `routes/white-label.tsx`, `components/landing/NetworkShowcase.tsx`, `MediaKit.tsx`, `ProofStrip.tsx`, `HowItWorks.tsx`, `AgentHierarchy.tsx`, `LeadForms.tsx`, `WhiteLabel.tsx`, `cta.tsx`, `lib/landing-view.ts`, `lib/lead-form.ts`, `lib/white-label-copy.ts`, `lib/no-personal-contact.test.ts`
- `apps/dashboard/src/routes/app.dm.tsx` (чип «From landing»), `apps/dashboard/src/nav/registry.ts`, `apps/dashboard/nginx.conf`

Backend:
- `apps/automation/src/config/landing-resources.service.ts`, `landing-config.service.ts`, `landing-dm.ts`, `landing-networks.service.ts`, `landing-pulse.service.ts`, `landing-cta.service.ts`, `landing-leads.ts`, `landing-leads.service.ts`, `landing-client-key.ts`, `youtube-landing.repository.ts`, `config/api/landing.controller.ts`, `config/api/landing-admin.controller.ts`, `config/api/dto/landing.dto.ts`; `tracked-channels.repository.ts`, `meta-accounts.repository.ts`, `tiktok-accounts.repository.ts`
- `apps/automation/src/common/rate-limit/sliding-window-limiter.ts`, `common/retention/retention.service.ts`
- `apps/automation/src/payments/*` (`ad-orders.controller.ts`, `ad-orders.service.ts`, `ad-orders.repository.ts`, `ad-prices.repository.ts`, `ads-public.controller.ts`, `liqpay*.ts`, `ad-reports.service.ts`, `ad-report.ts`, `ad-price-list.ts`, `digest-sponsors.repository.ts`, `dto/*`)
- `apps/automation/src/agent/ad-placement.ts`, `agent/agent-actions.service.ts`, `agent/agent-schedule.executor.ts`, `agent/agent-inbox.poller.ts`, `agent/agent-triage.helpers.ts` (`parseLandingRef`, `applyLandingAttribution`)
- `apps/automation/src/editor/publish/sponsored.publisher.ts`, `editor/publish/reserved-dispatcher.ts`, `editor/post/sponsored.ts`, `editor/manager/kpi-digest.service.ts`, `editor/agents/owner-inbox.ts`
- `apps/automation/src/strategies/network-digest/digest-sponsor.ts`, `network-digest.strategy.ts`, `topic-digest.strategy.ts`
- `apps/automation/src/stats/stats-collector.service.ts`

БД: `database/migrations/025_landing_featured.sql`, `040_ad_orders.sql`, `044_ad_revenue.sql`, `066_landing_ai_network.sql` (`landing_leads`, `landing_cta_daily`, YouTube і мережеві колонки); таблиці `ad_orders`, `ad_prices`, `agent_actions`, `agent_dm_threads`, `agent_inbox`, `editor_slots`, `published_posts`, `post_stats_snapshots`, `channel_stats_snapshots`, `tracked_channels`, `meta_accounts`, `tiktok_accounts`, `youtube_accounts`, `meta_account_groups`, `landing_leads`, `landing_cta_daily`, `app_settings` (`landing.*`).
