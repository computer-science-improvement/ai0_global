# TreatField психотерапія — статті, БД, стратегія

## Мета

Зібрати статті з [TreatField — категорія психотерапія](https://www.treatfield.com/category/psihoterapia), завантажити їх у таблицю `articles`, додати **content strategy** в `apps/automation` для публікації неопублікованих рядків у Telegram (через `posted` jsonb).

## Обмеження

- Без секретів у репозиторії; `.env` лише локально.
- Мінімальні зміни схеми: пріоритет існуючої таблиці `articles` (`database/init.sql`).
- У репо вже є `pnpm --filter pipeline run scrape:treatfield` та `load:treatfield` — перевірити й доповнити лише за потреби.

## Ризики

- Зміна верстки TreatField може зламати селектори в `scrape-treatfield-articles.js`.
- Для прод-каналу потрібно окремо узгодити `channelId` у `channels.json`.

## Таблиця задач

| ID | Owner | Summary |
|----|-------|---------|
| T1 | source-researcher | Source Spec: HTML, пагінація, відповідність поточному скрейперу |
| T2 | database-agent | Підтвердити, що `articles` достатня; DDL лише якщо є розрив |
| T3 | monorepo-developer | Стратегія `treatfield-articles`, реєстрація, конфіг, перевірка scrape/load |
| T4 | code-reviewer | Рев’ю після T3 |

## Execution order

1. T1 — `source-researcher`
2. T2 — `database-agent`
3. T3 — `monorepo-developer`
4. T4 — `code-reviewer`

## Paths on disk

- `tasks/treatfield-psihoterapia/MANIFEST.md`
- `tasks/treatfield-psihoterapia/agents/*.md`
- `tasks/_active`
