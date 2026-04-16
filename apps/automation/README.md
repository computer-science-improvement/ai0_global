# automation

NestJS-сервіс для автоматичної публікації контенту у Telegram (та інших каналах) через незалежні контент-стратегії.

---

## Як це працює

1. При старті сервіс читає `config/channels.json` (або `channels-dev.json` у dev)
2. Для кожного запису у `strategies[]` реєструється cron-задача
3. Cron запускає стратегію → вона отримує контент, генерує пост через AI, публікує

```
channels.json
    └── strategies[]
            └── cron schedule
                    └── ContentStrategyRunner
                            ├── strategy.fetch()
                            ├── DedupService      ← перевірка "вже постили?"
                            ├── strategy.generate() ← Claude/Perplexity
                            ├── ReviewAgent       ← перевірка якості
                            └── TelegramPublisher ← публікація
```

---

## Конфігурація каналів

Весь зв'язок стратегій із каналами — у JSON-файлах, без зміни коду.

### `config/channels.json` (production) / `config/channels-dev.json` (dev)

```jsonc
{
  "bots": {
    "my_bot": {
      "platform": "telegram",
      "tokenEnv": "TELEGRAM_BOT_TOKEN"   // назва env-змінної з токеном
    }
  },

  "channels": {
    "@my_channel": {
      "platform": "telegram",
      "chatId": "@my_channel",
      "botId": "my_bot"                  // або масив ["bot1", "bot2"] для round-robin
    }
  },

  "strategies": [
    {
      "id": "ua-news:dev-ua",            // унікальний id, довільний рядок
      "type": "ua-news",                 // тип стратегії (див. нижче)
      "channelId": "@my_channel",
      "schedule": "0 9-21/3 * * *",     // cron-вираз
      "postDelayMinutes": 30,            // затримка між постами (за замовч. 30)
      "params": {                        // параметри, специфічні для стратегії
        "feedUrl": "https://dev.ua/rss",
        "sourceName": "dev.ua",
        "tags": ["dev_ua", "tech"]
      }
    }
  ]
}
```

---

## Стратегії

| type | Джерело контенту | Потрібні `params` |
|------|-----------------|-------------------|
| `ai0-news` | RSS + HTTP (tech, health, energy, sport) — список у `config/sources/ai0-news.json` | — |
| `ua-news` | Будь-яка RSS-стрічка | `feedUrl`, `sourceName`, `tags` |
| `daily-photo` | NASA APOD (знімок дня) | — |
| `movies` | TMDB trending movies | — |
| `space-news` | Spaceflight News API | — |
| `game-channel` | Epic Games, Steam та ін. | — |
| `on-this-day` | byabbe.se (цей день в історії) | — |
| `quotes` | БД → таблиця `quotes` | — |
| `recipes` | TheMealDB API | — |
| `facts` | БД → таблиця `facts` | — |
| `ai0-prompts` | PromptHero — категорії у `config/sources/ai0-prompts.json` | — |
| `pdr-quiz` | БД → таблиця `pdr_questions` | — |
| `birthday-strategy` | БД → таблиці `birthdays` + `quotes` | — |

### Деталі стратегій → [docs/STRATEGIES.md](docs/STRATEGIES.md)

---

## Розклад публікацій

| Вираз | Коли |
|-------|------|
| `0 9 * * *` | Щодня о 09:00 |
| `0 8,12,18 * * *` | Тричі на день |
| `0 8-22/2 * * *` | Кожні 2 год, 08:00–22:00 |
| `0 10 * * 1-5` | Щопн–пт о 10:00 |

**За замовчуванням** (якщо `schedule` не вказано): `0 8-23/2 * * *`

### Повний довідник → [docs/SCHEDULING.md](docs/SCHEDULING.md)

---

## Конфіги, що редагуються без rebuild

| Файл | Що містить | Коли редагувати |
|------|-----------|-----------------|
| `config/channels.json` | Боти, канали, розклади | Додати/змінити канал або розклад |
| `config/channels-dev.json` | Те саме для dev | Dev-середовище |
| `config/sources/ai0-news.json` | RSS/HTTP джерела для `ai0-news` | Додати/видалити джерело новин |
| `config/sources/ai0-prompts.json` | Категорії PromptHero | Змінити категорії промптів |

Після зміни будь-якого з цих файлів — **лише перезапуск**, rebuild не потрібен.

---

## Змінні середовища (`.env`)

```bash
# PostgreSQL
POSTGRES_HOST=postgres      # всередині Docker; localhost — локально
POSTGRES_PORT=5432          # 5432 — в Docker; 5433 — host-порт
POSTGRES_DB=ai0global
POSTGRES_USER=ai0
POSTGRES_PASSWORD=changeme

# Telegram
TELEGRAM_BOT_TOKEN=         # назва має збігатися з tokenEnv у channels.json

# AI
ANTHROPIC_API_KEY=          # Claude (обов'язково)
PERPLEXITY_API_KEY=         # збагачення коротких текстів
OPENAI_API_KEY=             # опційно
GROK_API_KEY=               # опційно

# Інші
AUTOMATION_PORT=3001
FETCH_TIMEOUT=15000
```

---

## Запуск

### Локально (dev)

```bash
# з кореня монорепо
pnpm install
pnpm run db:up          # PostgreSQL в Docker
pnpm run dev:automation # NestJS з hot-reload
```

### Production (Docker)

```bash
docker compose --profile prod up -d        # старт
docker compose --profile prod logs -f automation   # логи
docker compose --profile prod restart automation   # перезапуск після зміни JSON
docker compose --profile prod down        # зупинка
```

### Ручний тригер стратегії (dev only)

```bash
curl http://localhost:3001/trigger/ai0-news
curl http://localhost:3001/trigger/ua-news
curl http://localhost:3001/trigger/daily-photo
```

---

## Структура коду

```
src/
├── main.ts                      # bootstrap
├── app.module.ts                # кореневий модуль
├── config/
│   └── channel-config.service.ts  # читає channels.json
├── scheduler/
│   └── scheduler.service.ts    # реєструє cron-задачі
├── strategies/                  # 13 стратегій
│   ├── ai0-news/
│   ├── ua-news/
│   └── ...
├── publishers/
│   ├── telegram.publisher.ts
│   ├── instagram.publisher.ts
│   └── ...
└── common/
    ├── content-strategy/        # інтерфейс, registry, runner
    ├── ai/                      # agents, skills, prompts, validators
    ├── dedup/                   # дедуплікація
    ├── fetchers/                # RSS, HTTP
    └── processors/              # cleaner, image-resolver, article-extractor
```

---

## Додати нову стратегію-інстанцію (без коду)

Відкрити `config/channels.json`, додати у масив `strategies[]`:

```json
{
  "id": "ua-news:nv-ua",
  "type": "ua-news",
  "channelId": "@my_channel",
  "schedule": "0 10,16 * * *",
  "params": {
    "feedUrl": "https://nv.ua/rss/all.xml",
    "sourceName": "nv.ua",
    "tags": ["nv_ua", "news"]
  }
}
```

Перезапустити сервіс. Готово.

## Додати новий тип стратегії (з кодом)

1. `src/strategies/<name>/<name>.strategy.ts` — реалізувати `ContentStrategy`
2. У `onModuleInit()` викликати `this.registry.register(this)`
3. Додати модуль до `app.module.ts → imports[]`
4. Додати інстанцію у `channels.json`
