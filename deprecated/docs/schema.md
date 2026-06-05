# Структура БД (PostgreSQL)

Ініціалізація: `database/init.sql`

---

## Контентні таблиці

| Таблиця | Стратегія | Dedup ключ | Опис |
|---------|-----------|------------|------|
| `assets` | — | `(data_source, title)` | Промпти, ресурси, MCP-сервери з різних джерел |
| `prompts` | `ai0-prompts` | `(id)` | Зображення з PromptHero |
| `on_this_day` | `on-this-day` | `(month, day, slug)` | Свята та події по датам (daytoday.ua) |
| `articles` | — | `(slug)` | Статті з daytoday.ua |
| `jokes` | — | `(content_hash)` | Жарти |
| `quotes` | `quotes` | `(text_hash)` | Цитати з автором та категорією |

## Інфраструктурні таблиці

| Таблиця | Опис |
|---------|------|
| `posted_news` | Дедублікація публікацій: `(source_url, channel_id)` |
| `bot_logs` | Логи success/error по source + channel |
| `ai_logs` | Аудит AI-запитів (agent, model, input/output, duration) |

## Скрипти

```bash
# Ініціалізація (idempotent)
pnpm run init-db

# Повний скид + ініціалізація
pnpm run init-db:reset

# Повний скид + завантаження всіх даних
pnpm run db:seed
```
