# BRD (as-is) — Розвідка: пошук каналів, граф, рекомендації

> Статус: чернетка, згенерована з коду 2026-10-05. Описує, як система ФАКТИЧНО працює зараз (гілка feat/editor-agent), а не як мала б.

## 1. Призначення розділу

Розділ «Intelligence» у бічному меню (`AppSidebar`) — це «розвідка» рекламного ринку Telegram для власника мережі каналів. Він відповідає на три питання: (1) які ще канали зʼявляються навколо тих, що ми відстежуємо (`/app/discovery`); (2) хто на кого посилається в постах — граф перехресних згадок (`/app/graph`); (3) де варто купити рекламу для мого каналу (`/app/recommendations`, кандидати з каталогу TeleAds, ранжування за збігом тем).

Користувач — один власник/оператор, що залогінений у дашборд. Усі три сторінки — read-only щодо реальних каналів: нічого не публікується і не купується; єдині записи в БД — теми каналу та додавання каналу до відстеження (кнопка «Track»).

Важливе термінологічне попередження: у бекенді модуль `apps/automation/src/discovery` (TeleAds, теми, рекомендації) НЕ має стосунку до сторінки `/app/discovery`. Сторінка Discovery читає `GET /tracking/discovery` з модуля `tracking`. Модуль `discovery` обслуговує тільки сторінку Recommendations.

## 2. Сторінки розділу

| Сторінка | Маршрут | Коротко |
|---|---|---|
| Discovery | `/app/discovery` | Черга каналів, які знайшли в постах відстежуваних каналів, але ще не опитані (або закриті). Лише перегляд + фільтр за username + посилання на Telegram. |
| Channel graph | `/app/graph` | Інтерактивний force-graph: вузли — канали, ребра — «канал A згадав/посилається на B» з лічильником постів. Клік по ребру показує пости-джерела, клік по вузлу — картку каналу з ROI. |
| Recommendations | `/app/recommendations` | Підбір рекламних майданчиків для обраного власного каналу під бюджет: кандидати з каталогу TeleAds, ранжування за Jaccard збігом тем → оцінка підписників на рекламу → ціна. |

## 3. Сторінки

### 3.1 Discovery — `/app/discovery`

**Бізнес-мета.** Показати оператору канали, які система «побачила» в рекламних/згадкових посиланнях відстежуваних каналів, але які ще не пройшли опитування (закриті, невизначені), щоб він вручну відкрив їх у Telegram і вирішив, що з ними робити.

**Хто користується / доступ.** Тільки після логіну (шлях під `/app`, guard у `routes/app.tsx`: без `me` — редірект на `/login`). Бекенд-ендпоінт захищений `TrackingAuthGuard` (Bearer `TRACKING_TOKEN`, JWT-кукі `tracking_jwt`, або локальний обхід лише за `ALLOW_NO_AUTH=true` поза production).

**Що показує.**
- Заголовок «Discovery» і підзаголовок «Channels seen in ads on tracked channels but not yet polled (closed or unresolved).»
- Дві плитки-лічильники (показуються лише якщо черга непорожня): «Open / unresolved» і «Closed» — рахуються на клієнті з `isClosed`.
- Картка «Discovery queue» з полем «Filter by username…» і списком рядків: крапка статусу (червона — closed, акцентна — open/unresolved), `@username` або «(no username)», чип «closed», «seen <відносний час>» (з `added_at`), кнопка «Open on Telegram» (`https://t.me/<username>`) або напис «unresolved», якщо username немає.
- Дані: `GET /tracking/discovery` (`trackingApi.discovery`) → `TrackingService.discovery()` → `TrackedChannelsRepository.listDiscoveryCandidates()` → таблиця `tracked_channels`.

**Дії користувача.**
- Ввід у «Filter by username…» — фільтрація лише на клієнті (підрядок, без регістру), додаткових запитів немає.
- «Open on Telegram» — зовнішнє посилання в новій вкладці. Інших дій (додати до відстеження, відхилити, повторити resolve) на сторінці немає.

**Бізнес-вимоги (as-is).**
- `BR-INT-01` Сторінка `/app/discovery` доступна лише авторизованому користувачу; неавторизованого `AppLayout` перекидає на `/login`.
- `BR-INT-02` Сторінка завантажує перелік одним запитом `GET /tracking/discovery` і не має пагінації; бекенд повертає максимум 200 записів, відсортованих за `added_at DESC`.
- `BR-INT-03` Елемент потрапляє в чергу, якщо в `tracked_channels` `is_closed = TRUE` АБО (`last_polled_at IS NULL` І `added_at` старше 1 години).
- `BR-INT-04` Для кожного елемента UI показує `username` (або «(no username)»), прапорець закритості та час «seen» = `added_at`.
- `BR-INT-05` Для елемента з `username` кнопка «Open on Telegram» відкриває `https://t.me/<username>`; для елемента без `username` показується лише текст «unresolved».
- `BR-INT-06` Поле «Filter by username…» фільтрує завантажений список на клієнті за входженням підрядка в `username` без регістру і вимкнене, поки список порожній або триває завантаження/помилка.
- `BR-INT-07` Лічильники «Open / unresolved» і «Closed» рахуються з усього завантаженого списку, а не з відфільтрованого, і зникають, коли черга порожня.
- `BR-INT-08` Канали потрапляють у `tracked_channels` (а отже, і в чергу) автоматично: воркер `poll-posts` знаходить згадки у постах, ставить задачу в чергу BullMQ `tracking.resolve-discovery`, воркер резолвить `@username` через MTProto (`contacts.ResolveUsername`) і створює рядок з `is_mine=false`, `poll_tier='cold'`.
- `BR-INT-09` Закритий канал (`is_closed=TRUE`) виключений з планового опитування (`listForPolling` має `is_closed = FALSE`), тому лишається в черзі Discovery назавжди, доки його не змінити іншим шляхом.

**Бізнес-правила й обмеження.**
- Фактичне джерело черги — сама таблиця `tracked_channels`, а не окрема «discovery»-таблиця: «виявлений» канал — це звичайний відстежуваний канал із `is_mine=false`.
- Відкритий канал виходить із черги, щойно його вперше опитає крон `cold` (кожні 6 годин, `0 */6 * * *`) і проставить `last_polled_at`.
- Усі крони опитування (`tracking.tier-hot` кожні 5 хв, `tier-warm` кожні 30 хв, `tier-cold` кожні 6 год, `recompute-tiers` о 03:30) працюють лише коли налаштування `TRACKING_ENABLED='true'` (у дефолтах — `'false'`).
- Ліміт одночасності воркерів: `resolve-discovery` — 1, `poll-meta` — 3, `poll-posts` — 5. При FLOOD_WAIT задачі `poll-*` пропускаються й повторяться наступним циклом.

**Стани.**
- Завантаження: 4 скелетні рядки.
- Помилка: картка «Couldn't load the discovery queue» з текстом помилки.
- Порожньо: «Nothing in the queue right now» + пояснення.
- Фільтр без збігів: «No matches» з текстом запиту.

**Фонові процеси.** `PollPostsWorker` (витяг посилань через `extractAdRefs`, `upsertSeen` ребер, постановка resolve), `ResolveDiscoveryWorker` (MTProto `ResolveUsername` для `@username`; `CheckChatInvite` для `t.me/+hash` без вступу в канал), `TrackingScheduler`. Усе через MTProto-сесію користувача (gramjs) і Redis/BullMQ.

**Звʼязки.** Дані спільні з `/app/tracked`, `/app/channels` (ті самі рядки `tracked_channels`) і з графом (`tracked_ad_edges.target_channel_id` проставляється після resolve). Інтеграція: Telegram MTProto.

**Спостереження «як фактично зараз».**
- Підзаголовок («seen in ads … not yet polled») обіцяє більше, ніж є: черга — це «закриті або ще ні разу не опитані за >1 год»; реклами як такої код не розрізняє (див. 3.2: «ad» = будь-яка згадка/посилання).
- Нерезолвлені `@username` (USERNAME_NOT_OCCUPIED, помилка MTProto, сесія не готова) НЕ створюють рядка в `tracked_channels` і тому в черзі Discovery не зʼявляються взагалі; «unresolved» у UI позначає лише канали без username (напр. створені з invite-посилань).
- У черзі немає жодної дії, крім «Open on Telegram»: не можна додати канал до відстеження вручну, відхилити або ініціювати повторний resolve; закриті канали накопичуються без виходу.
- Позначка «closed» ставиться, якщо `ch.restricted` або `ch.access_hash === null`; gramjs зазвичай віддає camelCase `accessHash`, тому друга умова, ймовірно, ніколи не спрацьовує — реально «closed» = restricted або `CHANNEL_PRIVATE`.
- Клієнтський тип `trackingApi.discovery` описує `username: string`, хоча бекенд може повертати `null` (UI це обробляє окремим приведенням типу).

**Відкриті питання до власника.**
- Чи має Discovery бути «inbox» із діями (Track / Ignore / Retry)? Зараз це журнал.
- Чи потрібно показувати нерезолвлені згадки (без рядка в `tracked_channels`)?
- Що робити із закритими каналами — дозволити «Видалити з черги»?

### 3.2 Channel graph — `/app/graph`

**Бізнес-мета.** Візуалізувати, хто на кого посилається в постах відстежуваних каналів («рекламна мережа»): виявити, хто кого рекламує, які канали-конкуренти/партнери часто згадуються, і швидко перейти до постів-доказів.

**Хто користується / доступ.** Лише після логіну (`/app`); бекенд `GET /tracking/graph` під `TrackingAuthGuard`.

**Що показує.**
- Панель фільтрів `GraphFilters`: «From» / «To» (date), слайдер «Min weight» (1–10, дефолт 1), чипи видів цілі `tg_channel`, `tg_invite`, `tg_user`, `instagram`, `web`, чекбокс «Include mine» (дефолт увімкнено).
- Лічильники «nodes» і «edges» та перемикач «Layout»: «Force» / «Tree ↓» / «Tree →».
- Полотно `GraphCanvas` (бібліотека `force-graph`, один `<canvas>`, висота 80vh): вузли-канали (радіус `4 + min(9, log10(subs+1)·2.4)`, свої канали зафарбовані акцентом), «примарні» пунктирні вузли для зовнішніх цілей (instagram/web/нерезолвлені Telegram), спрямовані ребра зі стрілкою, товщина `min(1+log2(count+1), 6)·0.5`, підпис кількості на ребрі з масштабу ≥1.4, назви вузлів з масштабу >0.9.
- Колір ребра за кількістю постів `ad_post_count`: ≥10 — червоний, ≥2 — помаранчевий, інакше зелений.
- Дані: `GET /tracking/graph?from&to&min_edge_weight&kind&include_mine` → `TrackingService.graph()` → `TrackedEdgesRepository.graph()` (таблиця `tracked_ad_edges`) + `TrackedChannelsRepository.getByIds()` (вузли).

**Дії користувача.**
- Зміна фільтрів — новий запит (React Query ключ `['graph', filters]`).
- Перемикання Layout — перебудова розкладки; якщо у дерев-режимі виявлено цикл (`onDagError`), канвас сам повертається в «Force».
- Перетягування вузлів, зум, пан — локально.
- Клік по вузлу-каналу — модальне вікно `ChannelDialog` (назва, `@username ↗`, кількість підписників і `pollTier`, панель ROI з кнопкою «Recompute», графік підписників, кнопка «Open full channel page →»). Клік по зовнішньому вузлу нічого не робить.
- Клік по ребру — бічна панель `EdgePanel` («Posts referencing @<ціль>»): до 100 постів каналу-джерела, що містять цю ціль, із текстом, автолінками, переглядами/пересиланнями/реакціями/коментарями та посиланням «Open in Telegram ↗».

**Бізнес-вимоги (as-is).**
- `BR-INT-10` Граф будується з таблиці `tracked_ad_edges`, де ключ ребра — (`source_channel_id`, `LOWER(target_username)`, `target_kind`), а вага — `ad_post_count`.
- `BR-INT-11` Ребро створюється/збільшується (`ad_post_count + 1`) воркером `poll-posts` для кожного нового допису відстежуваного каналу, що містить посилання/згадку; в межах одного допису однакові цілі дедупліковуються.
- `BR-INT-12` `extractAdRefs` розпізнає: пересилання (`forwardFromUsername`), `@mention`, `t.me/<username>[/<post>]`, інвайти `t.me/+hash` і `t.me/joinchat/hash`, `instagram.com/<handle>`, будь-який інший http(s)-домен як `web`.
- `BR-INT-13` Кольоровий тир ребра обчислюється на бекенді: `count ≥ 10` — `red`, `count ≥ 2` — `orange`, інакше `green`.
- `BR-INT-14` Бекенд повертає не більше 2000 ребер (`GRAPH_MAX_EDGES`), відсортованих за `ad_post_count DESC`, після фільтрів `min_edge_weight` (`ad_post_count ≥`), `from` (`last_seen_at ≥`) та `to` (`first_seen_at ≤`).
- `BR-INT-15` Фільтр за `kind` і перемикач «Include mine» застосовуються вже ПІСЛЯ вибірки топ-2000 ребер; вимкнений «Include mine» відкидає ребра, де ДЖЕРЕЛО — свій канал (цілі-свої залишаються).
- `BR-INT-16` Вузол додається лише для каналів, що є в `tracked_channels`; цілі без `target_channel_id` показуються як пунктирні зовнішні вузли, обʼєднані за (`kind`, `target_username`).
- `BR-INT-17` Після успішного resolve (`ResolveDiscoveryWorker`) для вже існуючих ребер `target_channel_id` заповнюється задним числом (`linkResolvedTarget`), і ребро «підʼєднується» до реального вузла.
- `BR-INT-18` Для великих графів (вузли+ребра > 600) розкладка прораховується наперед (120 тіків) і малюється статично; зум автоматично підганяється під вміст (`zoomToFit`).
- `BR-INT-19` `GET /tracking/edges/:sourceId/:targetUsername/posts` повертає до 100 постів джерела, де `ad_refs` містить ціль за ключем `username`, `domain` або `handle` (без регістру), від новіших до старіших.
- `BR-INT-20` На DEV-збірці `/app/graph?synthetic=N` підставляє згенерований граф без API; у production-збірці цей код вилучений.

**Бізнес-правила й обмеження.**
- Ціль-канал матчиться з відстежуваним за `LOWER(username)`; приватні канали ідентифікуються як `invite:<hash>` у `channel_key`.
- Кожен poll бере максимум 50 повідомлень із `minId = макс. відомий tg_message_id`; якщо між опитуваннями зʼявилося >50 нових, старіші не потраплять ні в пости, ні в ребра.
- Метадані вузла (`subs`, `title`) — з `tracked_channels` (оновлює `poll-meta`); `category` у вузлі завжди `null`, бо жоден код не заповнює `tracked_channels.category`.

**Стани.**
- Завантаження: картка «Building the channel graph…».
- Помилка: «Couldn’t load the graph» з текстом.
- Порожньо: «No connections yet» з порадою послабити мін. вагу / розширити діапазон дат.
- Панелі EdgePanel/ChannelDialog мають власні «Loading…» / «No posts found referencing this target.»

**Фонові процеси.** Ті самі, що у 3.1: `poll-posts` (наповнення ребер), `resolve-discovery`, `poll-meta`; крон-розклад за тирами `hot/warm/cold`; щоденний перерахунок тира (`classifyTier`: ≥3 постів/день — hot, ≥0.5 — warm, інакше cold; нові <3 днів — завжди warm).

**Звʼязки.** З `/app/channels/$id` (деталі каналу), `/app/discovery` (нові вузли зʼявляються через resolve), ROI-панель використовує `GET /tracking/roi/:id` (евристика або Claude Haiku, див. 3.3). Інтеграції: Telegram MTProto, Anthropic (лише для ROI-панелі у ChannelDialog).

**Спостереження «як фактично зараз».**
- «Ad» у назвах (`tracked_ad_edges`, «N ad posts →») — це будь-яка згадка: `@mention`, посилання, пересилання. Реклама від звичайної згадки не відрізняється, посилання на власний сайт/канал також рахуються; самопосилання (канал → він сам) не виключені.
- Фільтр-чип `tg_user` мертвий: `extractAdRefs` ніколи не генерує `tg_user` (усі `@mention` стають `tg_channel`); `mention_name` ігнорується.
- Для пересилань береться `fwdFrom.fromName` — це відображуване імʼя прихованого відправника, а не username; воно потрапляє в ребра як «username» (з пробілами/кирилицею) і не резолвиться.
- Ліміт 2000 ребер діє до фільтрів `kind` та «Include mine»: при вузькому фільтрі можна отримати менше ребер, ніж реально існує (відсічка слабких ребер — мовчки).
- Кнопка «Open full channel page →» у `ChannelDialog` веде на `/channels/<id>`, а реальний маршрут — `/app/channels/<id>`; такого маршруту без префіксу `/app` в `routeTree.gen.ts` немає (посилання, найімовірніше, мертве; `<a href>` ще й перезавантажує SPA).
- Колір «red» для ≥10 згадок — лише порогова шкала частоти, не оцінка «поганості»; легенди кольорів на сторінці немає.
- Режим Tree ↓/→ при циклах (а в рекламних графах вони типові) автоматично повертається у Force; пояснення користувачу не показується, лише перемикається сегмент.
- Фільтри дат — за `first_seen_at/last_seen_at` ребра в цілому, а не за датою кожного допису; лічильник ребра НЕ перераховується під діапазон (вага завжди загальна).
- Вхідні дані залежать від того, що MTProto-сесія бачить і чи `TRACKING_ENABLED=true`; без цього граф порожній.

**Відкриті питання до власника.**
- Чи потрібно відрізняти справжню рекламу (інтеграції, «#реклама», пересилання) від звичайних згадок?
- Чи виключати самопосилання та посилання на власні домени?
- Чи показувати легенду кольорів/ваг і ліміт 2000 у UI?

### 3.3 Recommendations — `/app/recommendations`

**Бізнес-мета.** Допомогти обрати, у яких каналах купити рекламу для власного каналу: для вибраного «цільового» каналу і бюджету повернути перелік каналів із каталогу TeleAds, що збігаються за темами та вміщаються в бюджет.

**Хто користується / доступ.** Лише після логіну; ендпоінти `POST /api/recommendations`, `GET /api/themes`, `GET|PUT /api/tracked-channels/:id/themes` під `TrackingAuthGuard`.

**Що показує.**
- Заголовок «Recommendations», підзаголовок «Channels worth buying ads on, sorted by theme overlap → ROI → price.»
- Картка «Find placements»: випадаючий список «Target channel» (`TargetChannelPicker`; `GET /tracking/channels?filter=mine&pageSize=100`, тобто лише СВОЇ канали, до 100), кнопка «Edit themes (N)» (зʼявляється після вибору каналу), поле «Budget» у гривнях (дефолт 500 UAH = 50 000 копійок, крок 10, мін. 1), інформаційний блок «Sort: theme match → ROI → price» (не інтерактивний), чипи «Target themes».
- Лічильник «N channel(s) match your budget & themes».
- Таблиця `RecommendationsTable`: «#», «Channel» (аватар, назва, `@username` або «invite link»), «Themes» (до 5 чипів; збіг із темами цілі підсвічено; «+N»), «Score» (`score·100` у %), «Price (UAH)» (`priceMin/100`), «Subs/ad», «F/M» (`sexRatio/(100−sexRatio)`), кнопки «Track», «TeleAds ↗», «TG ↗».
- Дані: `POST /api/recommendations` {`targetChannelId`, `budget`, `limit` = 20} → `RecommendationsService.recommend()` → `CandidateChannelsRepository.candidatesForBudgetAndThemes()` → таблиці `candidate_channels`, `tracked_channels`, `tracked_roi_cache`.

**Дії користувача.**
- Вибір «Target channel» / зміна «Budget» — автоматичний перерахунок (запит виконується, лише коли обрано канал і бюджет > 0).
- «Edit themes (N)» — модалка `EditThemesModal`: чекбокс-список тем із фільтром «Filter themes…», «Save (N)» → `PUT /api/tracked-channels/:id/themes` (запис у `tracked_channels.themes`), після чого кеш рекомендацій інвалідується.
- «Track» (рядок) — `POST /tracking/channels` {`username`} → створює рядок `tracked_channels` (`is_mine=false`, тир `warm`), ставить `poll-meta` і `poll-posts`, відкриває сторінку `/app/channels/<id>`. Недоступна для приватних інвайтів.
- «TeleAds ↗» — `https://teleads.com.ua/promo/products/<slug>`; «TG ↗» — посилання каналу з каталогу. Купівлі реклами на сторінці немає.

**Бізнес-вимоги (as-is).**
- `BR-INT-21` Кандидати надходять з таблиці `candidate_channels`, що наповнюється лише з TeleAds (`source='teleads'`) кроном `0 4 * * *` (04:00 UTC) або ручним `POST /api/admin/ingest-teleads`; кнопки для ручного запуску в UI немає.
- `BR-INT-22` Інгест ітерує `GET https://teleads.com.ua/api/promo/products/` (`status=enabled`, 100 на сторінку, пауза 200 мс між сторінками, 3 спроби з експоненційною затримкою на 429/5xx), робить upsert за (`source`, `external_id`) і зберігає повний `raw_payload`.
- `BR-INT-23` Теми кандидата = `slug` категорій TeleAds; `price_min`/`price_max` = мін./макс. серед цін тарифів (у копійках); `sex_ratio` береться лише якщо `sex='enabled'`; аватар — перший доступний розмір з пріоритету 320x320, 600x600, 800x550, 150x150, base.
- `BR-INT-24` Якщо цільовий канал не існує, API повертає 404; якщо в нього порожні `themes`, відповідь — порожній список із `warning: "Set themes on the target channel first"` (UI показує жовту панель з цим текстом).
- `BR-INT-25` Попередній відбір кандидатів: `price_min IS NOT NULL`, `price_min ≤ budget` (бюджет у копійках), перетин тем (`themes && targetThemes`), максимум 500 рядків без явного `ORDER BY`.
- `BR-INT-26` Кандидати, чий `slug` збігається (без регістру) з `username` власного каналу (`is_mine=true`), виключаються (за замовчуванням; параметр `excludeAlreadyTracked=false` дашборд не передає).
- `BR-INT-27` Оцінка `score` = коефіцієнт Жаккара між множиною тем цілі та кандидата: |перетин| / |обʼєднання| (0..1); UI показує як відсоток без десяткових. Регістр важливий.
- `BR-INT-28` Сортування: `score` ↓, потім `estimatedSubsPerAd` ↓ (відсутнє значення = −1), потім `priceMin` ↑; повертається перші `limit` (за замовчуванням 20, максимум 100).
- `BR-INT-29` `estimatedSubsPerAd` і `roiConfidence` підтягуються лише якщо канал-кандидат одночасно відстежується в `tracked_channels` (збіг `LOWER(username)=LOWER(slug)`) і для нього є рядок у `tracked_roi_cache`; інакше в колонці «Subs/ad» стоїть «—».
- `BR-INT-30` `tracked_roi_cache` заповнюється лише коли хтось викликає `GET /tracking/roi/:id` (панель ROI в `ChannelDialog` або на сторінці каналу): TTL 7 днів, `fresh=true` примушує перерахунок.
- `BR-INT-31` Оцінка ROI: евристика `round(avgViews30d × viewToSubRate × mult)`, де `viewToSubRate` = `TRACKING_VIEW_TO_SUB_RATE` (дефолт 0.02), `mult` = 0.5 при engagement <1%, 1.5 при >5%, інакше 1.0; впевненість: high — ≥30 днів історії і ≥50 постів, medium — ≥14 і ≥20, інакше low.
- `BR-INT-32` Якщо доступний `ANTHROPIC_API_KEY`, ROI уточнює Claude (`claude-haiku-4-5`, до 600 токенів, 10 останніх постів): результат обрізається до діапазону [50%; 200%] від евристики; при помилці — відкат на евристику (`source: heuristic | claude`). Це єдиний платний LLM-виклик розділу; сам `POST /api/recommendations` LLM не викликає.
- `BR-INT-33` Перелік тем (`GET /api/themes`) — це живий список категорій TeleAds (`/categories/`, `type=product`, `status=enabled`), що кешується в памʼяті процесу на 24 години; збереження тем (`PUT`) приймає ≤20 slug-ів формату `^[a-z0-9-]+$` і відхиляє невідомі (400).
- `BR-INT-34` Збереження тем канал-цілі дедуплікує масив і перезаписує `tracked_channels.themes`; кнопка «Save» закриває модалку після успіху.

**Бізнес-правила й обмеження.**
- Бюджет: у UI — гривні, на бекенді — копійки (ціле, >0). Рекомендація враховує лише МІНІМАЛЬНУ ціну тарифу (`price_min`); тип тарифу (`1day`, `24h`, `always`) не розрізняється.
- Теми цілі можна змінювати і через `PATCH /tracking/channels/:id` (поле `themes`) без перевірки на словник TeleAds; валідація відбувається лише на `PUT /api/tracked-channels/:id/themes`.
- Рекомендується лише TeleAds-каталог; жодних скрейперів з `apps/pipeline` або MTProto у розрахунку немає.

**Стани.**
- Канал не вибрано: порожній блок «Pick a target channel» (показується лише після того, як зʼявилась відповідь API; до вибору каналу запит не виконується, тож фактично на старті блоку немає).
- Завантаження: «Computing recommendations…» (4 скелетні рядки).
- Помилка: «Failed to load recommendations» (текст помилки не показується).
- Порожній результат: «No matching channels» з порадою розширити бюджет/теми.
- Без тем: жовте попередження з бекенду.

**Фонові процеси.** `TeleAdsIngestionWorker` (`@Cron('0 4 * * *')`, не під `TRACKING_ENABLED`) — щоденне оновлення каталогу. Для «Subs/ad» — опосередковано `RoiAnalyzerService` (лише за запитом).

**Звʼязки.** З `/app/channels/$id` (теж редагує теми через `EditThemesModal`), з `/app/channels` (кнопка «Track»). Зовнішні: TeleAds public API (`teleads.com.ua/api/promo`), Anthropic (ROI).

**Спостереження «як фактично зараз».**
- Опис «sorted by theme overlap → ROI → price» вірний, але ROI майже завжди порожній: він є лише для кандидатів, які ми вже відстежуємо та для яких хтось відкрив ROI-панель. Для типового каталогу ранжування фактично зводиться до Jaccard → ціна.
- Заявлена «відповідність бюджету» — лише `price_min ≤ budget`; оцінки ефективності (ціна за підписника) немає. Колонка «Subs/ad» показує очікуваний приріст, а не вартість.
- Параметр `excludeAlreadyTracked` за назвою виключає вже ВІДСТЕЖУВАНІ, але фактично виключає лише канали з `is_mine=true`; вже відстежувані чужі канали в рекомендаціях лишаються.
- SQL `LEFT JOIN tracked_channels ON LOWER(username)=LOWER(slug)` без `DISTINCT`; `LIMIT 500` без `ORDER BY` — при великому каталозі відбір 500 рядків випадковий, і якісніші кандидати можуть не потрапити в скоринг.
- Топ-20 після скорингу не пагінується і жодного фільтра за мовою/`sexRatio`/ціною максимум у UI немає, хоча `language`, `priceMax`, `description` повертаються API.
- Блок «Pick a target channel» у стані порожнього результату практично недосяжний (запит вимкнений без каналу), на початку сторінка показує лише форму.
- Бекенд-ендпоінти модуля (`/api/...`) і tracking (`/tracking/...`) використовують різні префікси; дашборд-проксі й nginx мають обидва, тому працює, але це ще одне місце для розсинхронізації.
- Тип `RecommendationItem.priceMin` показується як `priceMin / 100` з `toFixed(0)` — копійки/дробові гривні відкидаються.
- TeleAds ingestion при збої першої сторінки лише логує помилку (повертає нулі), помилки наступних сторінок пропускаються мовчки; в UI немає індикатора «коли оновлено каталог» (`last_seen_at` не показується) і жодних видалень застарілих кандидатів: канали, що зникли з TeleAds, лишаються в `candidate_channels` назавжди.
- Ручний тригер `POST /api/admin/ingest-teleads` дозволений будь-якому авторизованому користувачу (guard — той самий `TrackingAuthGuard`), окремої ролі «адмін» немає.

**Відкриті питання до власника.**
- Чи потрібно розширювати джерела кандидатів (інші біржі/каталоги, власний граф), чи TeleAds — єдине джерело?
- Чи треба рахувати «вартість підписника» (ціна / очікуваний приріст) замість чистого Jaccard?
- Чи має ROI для кандидатів рахуватися автоматично (наприклад, фоново для топ-N), щоб колонка «Subs/ad» не була порожньою?
- Чи виключати з рекомендацій усі відстежувані канали або показувати їх із позначкою?

## 4. Наскрізні правила розділу

- Усі три сторінки працюють із даними, які готує підсистема tracking: MTProto-сесія користувача (gramjs) читає історію каналів; без `TRACKING_ENABLED=true` та працюючої сесії Discovery і Graph не наповнюються. Recommendations залежить від TeleAds-інгесту (крон 04:00 UTC) і не потребує MTProto.
- Аутентифікація: `TrackingAuthGuard` на всіх ендпоінтах розділу; на фронті — guard `/app`.
- Бекенд змонтований у двох групах: bare-root `/tracking/*` (Discovery, Graph) і `/api/*` (Recommendations, Themes). Dev-проксі Vite та `nginx.conf` мають обидва набори префіксів.
- Дані «граф ↔ рекомендації» не повʼязані: ребра графа (`tracked_ad_edges`) не використовуються у скорингу Recommendations; жодна схожість між каналами за графом не рахується — «схожість» існує лише як Jaccard за темами.
- Теми (`tracked_channels.themes`) — єдиний звʼязок власних каналів із каталогом TeleAds; розставляються вручну (`EditThemesModal` на Recommendations та на сторінці каналу). Автоматичної класифікації (LLM або евристики) немає.
- Реальних дій із зовнішнім світом розділ не виконує: не публікує, не купує рекламу, не вступає в канали (інвайти лише «peek» через `CheckChatInvite`).
- Тексти інтерфейсу розділу англійською; мови перемикача немає.

## 5. Глосарій розділу

| Термін | Значення в коді |
|---|---|
| Edge / ребро | Рядок `tracked_ad_edges`: джерело (відстежуваний канал) → ціль (username, invite-hash, instagram-handle або домен). |
| `ad_post_count` | Кількість постів джерела, у яких зустрілась ціль (не обовʼязково реклама). |
| Kind | `tg_channel`, `tg_invite`, `tg_user` (не генерується), `instagram`, `web`. |
| Poll tier | `hot` / `warm` / `cold` — частота опитування каналу (5 хв / 30 хв / 6 год). |
| Candidate | Рядок `candidate_channels` із каталогу TeleAds — потенційний рекламний майданчик. |
| Theme | `slug` категорії TeleAds (напр. у `tracked_channels.themes` і `candidate_channels.themes`). |
| Score | Коефіцієнт Жаккара між темами цілі та кандидата. |
| ROI (estimated subs/ad) | Оцінка приросту підписників з одного рекламного розміщення (евристика або Claude Haiku), кеш 7 днів. |

## 6. Джерела в коді

Дашборд:
- `apps/dashboard/src/routes/app.discovery.tsx`, `app.graph.tsx`, `app.recommendations.tsx`, `app.tsx` (guard)
- `apps/dashboard/src/components/GraphCanvas.tsx`, `GraphFilters.tsx`, `EdgePanel.tsx`, `ChannelDialog.tsx`, `RoiPanel.tsx`, `RecommendationsTable.tsx`, `EditThemesModal.tsx`, `TargetChannelPicker.tsx`, `BudgetInput.tsx`, `AppSidebar.tsx`
- `apps/dashboard/src/api/tracking.ts`, `api/discovery.ts`, `api/types.ts`, `api/client.ts`, `lib/graph-synthetic.ts`, `vite.config.ts`, `nginx.conf`

Бекенд, модуль `discovery` (TeleAds, рекомендації):
- `apps/automation/src/discovery/api/discovery.controller.ts`, `api/dto/recommendations.dto.ts`, `api/dto/themes.dto.ts`
- `apps/automation/src/discovery/recommendations/recommendations.service.ts`, `recommendations.types.ts`
- `apps/automation/src/discovery/repositories/candidate-channels.repository.ts`, `channel-themes.repository.ts`
- `apps/automation/src/discovery/teleads/teleads.client.ts`, `teleads-ingestion.worker.ts`, `teleads-mapper.ts`

Бекенд, модуль `tracking` (Discovery-черга, граф, ROI):
- `apps/automation/src/tracking/api/tracking.controller.ts`, `tracking.service.ts`, `tracking-auth.guard.ts`
- `apps/automation/src/tracking/workers/poll-posts.worker.ts`, `poll-meta.worker.ts`, `resolve-discovery.worker.ts`
- `apps/automation/src/tracking/processors/ad-ref-extractor.ts`, `tier-classifier.ts`, `roi-analyzer.service.ts`, `roi-heuristic.ts`
- `apps/automation/src/tracking/repositories/tracked-edges.repository.ts`, `tracked-channels.repository.ts`, `tracked-posts.repository.ts`, `tracked-roi-cache.repository.ts`
- `apps/automation/src/tracking/mtproto/tracking-mtproto.client.ts`, `tracking.scheduler.ts`, `types.ts`

БД:
- `database/migrations/002_tracking.sql` (`tracked_channels`, `tracked_ad_edges`), `003_roi_cache.sql`, `004_discovery.sql` (`candidate_channels`, `tracked_channels.themes`), `013_tracking_status.sql`
