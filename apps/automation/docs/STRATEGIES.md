# Контент-стратегії

Кожна стратегія — незалежний модуль, що реалізує інтерфейс `ContentStrategy`. Стратегія отримує `params` з `channels.json` і може бути підключена до будь-якої кількості каналів.

Стратегії реєструються за рядком `type`. Саме цей рядок треба вказувати в полі `"type"` у `channels.json → strategies[]`.

---

## Конвеєр виконання

Для більшості стратегій запускається стандартний конвеєр:

```
fetch() → dedup → generate() → review (AI) → publish → mark posted
```

Стратегії, що реалізують `execute()`, повністю контролюють конвеєр самостійно.

---

## Стратегії

### `ai0-news`
**Файл**: `src/strategies/ai0-news/ai0-news.strategy.ts`

Агрегує новини з кількох RSS- та HTTP-джерел. Для коротких матеріалів збагачує контент через Perplexity API. Форматує та рецензує пост через Claude.

**Джерела**: `config/sources/ai0-news.json` (редагується без rebuild).

**Params**: немає.

**Приклад конфігурації в `channels.json`**:
```json
{
  "id": "ai0-news:main",
  "type": "ai0-news",
  "channelId": "@my_news_channel",
  "schedule": "0 8-22/2 * * *"
}
```

**Додавання нового RSS-джерела** — редагуємо `config/sources/ai0-news.json`, перезапускаємо контейнер:
```json
{
  "sources": [
    { "type": "rss", "url": "https://example.com/feed.xml", "tags": ["tech"] }
  ]
}
```

---

### `ua-news`
**Файл**: `src/strategies/ua-news/ua-news.strategy.ts`

Агрегатор україномовних tech-новин з RSS-стрічок. Той самий конвеєр, що й `ai0-news`, але з українськими скілами.

**Params** (обов'язкові):

| Ключ | Тип | Опис |
|------|-----|------|
| `feedUrl` | `string` | URL RSS-стрічки |
| `sourceName` | `string` | Назва джерела для підпису |
| `tags` | `string[]` | Хештеги для поста |

**Приклад**:
```json
{
  "id": "ua-news:dev-ua",
  "type": "ua-news",
  "channelId": "@ua_tech_channel",
  "schedule": "0 9-21/3 * * *",
  "params": {
    "feedUrl": "https://dev.ua/rss",
    "sourceName": "dev.ua",
    "tags": ["dev_ua", "tech", "ua"]
  }
}
```

Одну стратегію `ua-news` можна додати кілька разів для різних стрічок одного каналу.

---

### `daily-photo`
**Файл**: `src/strategies/daily-photo/daily-photo.strategy.ts`

Публікує знімок дня від NASA (APOD — Astronomy Picture of the Day). Claude перекладає опис українською.

**Params**: немає.

**Приклад**:
```json
{
  "id": "daily-photo:apod",
  "type": "daily-photo",
  "channelId": "@space_photo_channel",
  "schedule": "0 10 * * *"
}
```

---

### `movies`
**Файл**: `src/strategies/movies/movies.strategy.ts`

Публікує рекомендацію фільму з TMDB (trending movies). Claude генерує опис українською.

**Params**: немає.

**Приклад**:
```json
{
  "id": "movies:main",
  "type": "movies",
  "channelId": "@movie_channel",
  "schedule": "0 20 * * *"
}
```

---

### `space-news`
**Файл**: `src/strategies/space/space.strategy.ts`

Новини про космос (Spaceflight News API або аналогічне джерело). Claude генерує пост українською.

**Params**: немає.

**Приклад**:
```json
{
  "id": "space-news:main",
  "type": "space-news",
  "channelId": "@space_channel",
  "schedule": "0 11,18 * * *"
}
```

---

### `game-channel`
**Файл**: `src/strategies/game-channel/game-channel.strategy.ts`

Ігрові новини та безкоштовні роздачі (Epic Games, Steam та ін.).

**Params**: немає.

**Приклад**:
```json
{
  "id": "game-channel:main",
  "type": "game-channel",
  "channelId": "@game_deals_channel",
  "schedule": "0 12,19 * * *"
}
```

---

### `on-this-day`
**Файл**: `src/strategies/on-this-day/on-this-day.strategy.ts`

Цей день в історії — події за поточну дату (byabbe.se API).

**Params**: немає.

**Приклад**:
```json
{
  "id": "on-this-day:main",
  "type": "on-this-day",
  "channelId": "@history_channel",
  "schedule": "0 9 * * *"
}
```

---

### `quotes`
**Файл**: `src/strategies/quotes/quotes.strategy.ts`

Випадкова цитата з таблиці `quotes` у БД. Автоматично виявляє дні народження авторів і адаптує пост.

**Params**: немає.

**Приклад**:
```json
{
  "id": "quotes:morning",
  "type": "quotes",
  "channelId": "@quotes_channel",
  "schedule": "0 8 * * *"
}
```

---

### `recipes`
**Файл**: `src/strategies/recipes/recipes.strategy.ts`

Рецепти з TheMealDB API. Публікує назву, інгредієнти та інструкцію.

**Params**: немає.

**Приклад**:
```json
{
  "id": "recipes:main",
  "type": "recipes",
  "channelId": "@recipes_channel",
  "schedule": "0 12 * * *"
}
```

---

### `facts`
**Файл**: `src/strategies/facts/facts.strategy.ts`

Цікаві факти з таблиці `facts` у БД (джерело: faktypro.com.ua).

**Params**: немає.

**Приклад**:
```json
{
  "id": "facts:main",
  "type": "facts",
  "channelId": "@facts_channel",
  "schedule": "0 10,17 * * *"
}
```

---

### `ai0-prompts`
**Файл**: `src/strategies/ai0-prompts/ai0-prompts.strategy.ts`

Публікує AI-промпт з PromptHero: зображення + текст промпту. Категорії визначаються в `config/sources/ai0-prompts.json`.

**Params**: немає.

**Приклад**:
```json
{
  "id": "ai0-prompts:main",
  "type": "ai0-prompts",
  "channelId": "@prompts_channel",
  "schedule": "0 9,15,21 * * *"
}
```

**Додавання нової категорії** — редагуємо `config/sources/ai0-prompts.json`:
```json
{
  "baseUrl": "https://prompthero.com",
  "categories": ["flux", "midjourney", "my-new-category"]
}
```

---

### `pdr-quiz`
**Файл**: `src/strategies/pdr-quiz/pdr-quiz.strategy.ts`

Публікує питання ПДР для квізу (таблиця `pdr_questions` у БД). Одне питання за тригер.

**Params**: немає.

**Приклад**:
```json
{
  "id": "pdr-quiz:main",
  "type": "pdr-quiz",
  "channelId": "@pdr_channel",
  "schedule": "0 8,12,18 * * *"
}
```

---

### `birthday-strategy`
**Файл**: `src/strategies/motivation-biography/motivation-biography.strategy.ts`

Мотиваційні пости та біографії відомих людей. Використовує таблиці `birthdays` та `quotes` у БД.

**Params**: немає.

**Приклад**:
```json
{
  "id": "birthday-strategy:main",
  "type": "birthday-strategy",
  "channelId": "@motivation_channel",
  "schedule": "0 9 * * *"
}
```

---

## Додавання нової стратегії-інстанції

Нові інстанції додаються виключно в `channels.json` (або `channels-dev.json` для dev) — без жодних змін у TypeScript-коді:

```json
{
  "strategies": [
    {
      "id": "ua-news:nv-ua",
      "type": "ua-news",
      "channelId": "@my_channel",
      "schedule": "0 10,16 * * *",
      "postDelayMinutes": 60,
      "params": {
        "feedUrl": "https://nv.ua/rss/all.xml",
        "sourceName": "nv.ua",
        "tags": ["nv_ua", "news"]
      }
    }
  ]
}
```

Після зміни `channels.json` потрібно перезапустити сервіс (або контейнер).

---

## Додавання нового типу стратегії

1. Створити `src/strategies/<name>/<name>.strategy.ts` — реалізація `ContentStrategy`
2. Зареєструвати в `onModuleInit`: `this.registry.register(this)`
3. Додати модуль до `app.module.ts → imports[]`
4. Додати інстанцію в `channels.json`
