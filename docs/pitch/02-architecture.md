# 02 · Архітектура

## 2.1 Монорепо: 3 застосунки

| App | Що це | Стек | Роль |
|---|---|---|---|
| **apps/automation** | «мозок» системи | NestJS 10, `pg`, ioredis, BullMQ, `@nestjs/schedule` | вся бізнес-логіка: стратегії, публікація, scheduler, tracking, agent, payments |
| **apps/dashboard** | пульт власника | React 18, TanStack Router, Vite, nginx | SPA, ходить у REST automation (cookie-session) |
| **apps/pipeline** | офлайн ETL | standalone Node (ESM, `--env-file`) | scrape/parse/load статичних датасетів у Postgres; **не** довгоживучий сервіс, поза runtime |

```plantuml
@startuml
skinparam backgroundColor transparent
skinparam componentStyle rectangle

actor "Власник" as owner
cloud "Зовнішні API" as ext {
  [Claude / OpenAI / Grok / Perplexity]
  [Telegram Bot API + MTProto/GramJS]
  [Meta Graph API]
  [TikTok API]
  [Supabase Storage]
  [LiqPay]
  [TMDB / NASA / RSS]
}

owner --> [dashboard\n(React SPA)] : cookie-session
[dashboard\n(React SPA)] --> [automation\n(NestJS)] : REST /api/*
[automation\n(NestJS)] --> [Postgres] : pg Pool
[automation\n(NestJS)] --> [Redis] : BullMQ + pub/sub
[automation\n(NestJS)] --> ext
[pipeline\n(ETL scripts)] --> [Postgres] : offline batch\n(no automation dep)

@enduml
```

## 2.2 Композиційний корінь і модулі

`app.module.ts` реєструє ~30 модулів. Інфраструктурні: `ConfigModule.forRoot` (envFilePath `../../.env`), `ScheduleModule.forRoot`, `DatabaseModule`, `ChannelConfigModule`, `LoggingModule`, `CryptoModule`. Фічеві модулі:

| Модуль | Відповідальність |
|---|---|
| `common/content-strategy` | `ContentStrategy` interface + registry + runner (ядро генерації) |
| `publishers` | `PublisherDispatcher` + `TelegramPublisher`/Facebook/Instagram/Threads/TikTok, `CrossPostService`, `PostingThrottleService` |
| `scheduler` | один `CronJob` на кожен `strategy_bindings` рядок; hot-reload; `RunTracer` |
| `tracking` | MTProto-трекінг конкурентів: `TrackingQueueService` + 4 BullMQ-воркери |
| `discovery` | рекомендації каналів (`RecommendationsService`), `TeleadsIngestionWorker` |
| `stats` | збір метрик Telegram (MTProto) + Meta (Graph API) |
| `scheduled-posts` | ручні пости з дашборду/агента → `ScheduledPostsWorker` (@Cron 30s) |
| `agent` | монетизаційний оператор SP1–SP4 (DM-інбокс, дії, chat-intel) |
| `payments` | LiqPay ad-orders (`AdOrdersService`, `LiqpayService`, публічний callback) |
| `config` | config-in-DB репозиторії + `ConfigCacheService` + Redis hot-reload |
| `settings` | `SettingsService` — DB-override невеликого набору env-налаштувань |
| `auth` | cookie/JWT сесія власника (Telegram-widget або токен) |
| `common/ai` | провайдер-агностичний `ClaudeAgent`/Grok/OpenAI/Perplexity + skills |
| `common/dedup` | `DedupService` (+ `SemanticDedupService`) |
| `database` | єдиний `pg` Pool + `MigrationRunnerService` |

## 2.3 Ключові абстракції (це варто знати команді)

- **`ContentStrategy`** (`content-strategy.interface.ts`) — контракт стратегії: `type`, `supportedPlatforms` (дефолт `['telegram']`), `getSkills(params)`, і головний `execute()`. Реєстр + runner уніфікують запуск.
- **`PublishDestination`** — value object резолвленої цілі: `{ platform, targetId, token?, metaAccountId, postedKey }`. Саме `postedKey` дає **per-destination дедуп** (той самий контент іде і в Telegram, і в IG без колізій).
- **`PublisherDispatcher`** — маршрутизує `publish()`/`publishCarousel()` до потрібного `BasePublisher`.
- **`CrossPostService`** — після Telegram-публікації дзеркалить у `meta_crosspost_targets` (per-account, ізольовано, не кидає помилку нагору).
- **`RunTracer`** — ambient-обсервабіліті на `AsyncLocalStorage`: будь-який сервіс углибині стеку викликає `span()`/`event()` без прокидання аргументів; кроки зберігаються в `strategy_runs.steps` і показуються в дашборді (`/app/logs`).
- **Config-in-DB + Redis hot-reload** — конфіг (боти, канали, binding-и, meta/tiktok акаунти) живе в Postgres, кешується в памʼяті `ConfigCacheService`, інвалідиться через Redis-канал `config:changed`, який публікує `ConfigEventsPublisher` при кожному редагуванні з дашборду. **Редагування конфігу застосовується без рестарту.**

## 2.4 Потік однієї публікації (компонентний вид)

```plantuml
@startuml
skinparam backgroundColor transparent
skinparam componentStyle rectangle

[SchedulerService\n(CronJob per binding)] --> [ContentStrategyRegistry] : get(type)
[ContentStrategyRegistry] --> [ContentStrategyRunner] : run(strategy, dest)
[ContentStrategyRunner] --> [DedupService] : filterUnposted
[ContentStrategyRunner] --> [ClaudeAgent (+Skills)] : generate
[ContentStrategyRunner] --> [ReviewAgent] : review
[ContentStrategyRunner] --> [ImageResolverService] : download (опц.)
[ContentStrategyRunner] --> [PublisherDispatcher] : publish
[PublisherDispatcher] --> [TelegramPublisher]
[TelegramPublisher] --> [CrossPostService] : fan-out у Meta
[ContentStrategyRunner] ..> [RunTracer] : span/event
[RunTracer] --> [strategy_runs] : кроки + статус
[CrossPostService] --> [published_posts] : анкор для метрик
@enduml
```

## 2.5 Sequence: один cron-тік стратегії (з усіма гардами)

Це найважливіша діаграма для розуміння **надійності й одноінстансності**:

```plantuml
@startuml
skinparam backgroundColor transparent
participant Cron
participant Scheduler as "SchedulerService"
participant Throttle as "PostingThrottleService"
participant Runner as "StrategyRunner"
participant AI as "ClaudeAgent"
participant Pub as "TelegramPublisher"
participant Cross as "CrossPostService"
database PG as "Postgres"

Cron -> Scheduler : тік
Scheduler -> Scheduler : inFlight.has(name)?
note right: Set у памʼяті → якщо є,\nзаписати 'skipped' і вийти
Scheduler -> Scheduler : inFlight.add(name)
Scheduler -> PG : runsRepo.start ('running')
Scheduler -> Runner : withTimeout(run, STRATEGY_RUN_TIMEOUT_MS)
Runner -> Throttle : tryLock(channelId)
note right: in-flight lock + cooldown\n(теж у памʼяті)
Runner -> AI : generate (виклик 1)
Runner -> AI : review (виклик 2)
Runner -> Pub : publish
Pub -> Cross : afterPublish (Meta mirror)
Runner -> PG : dedup.markPosted + published_posts
Scheduler -> PG : runsRepo.finishOk
Scheduler -> Scheduler : inFlight.delete (finally)
@enduml
```

**Що тут критично:** усі гарди (`inFlight`, `Throttle.locks`, cooldown) — **обʼєкти в памʼяті процесу**. Немає Redis-локу. Тому це працює правильно **лише в одному інстансі** (див. [03](03-data-and-queues.md#стеля-один-інстанс)).

## 2.6 Дашборд ↔ бекенд

Файлові маршрути `apps/dashboard/src/routes/` дзеркалять продуктові поверхні automation 1:1: `app.strategies`, `app.channels`, `app.connections`, `app.logs`, `app.analytics`, `app.scheduled`, `app.compose`, `app.agent`, `app.ads`, `app.settings`. Спілкування — REST через `api/client.ts` (`api<T>()`), сесія — httpOnly-cookie JWT, захищена `TrackingAuthGuard`.
