---
agent: source-researcher
---

## Invocation

`/research-source` (або Task `source-researcher`).

## Контекст

- Цільова сторінка: `https://www.treatfield.com/category/psihoterapia`
- Статті: `https://www.treatfield.com/field/{slug}`
- У репозиторії вже є скрейпер: `apps/pipeline/src/tools/additional-data/scripts/scrape-treatfield-articles.js` (axios + cheerio, пагінація `?page=&per-page=21`).

## Завдання

1. Перевірити (fetch або браузер), чи структура лістингу та сторінки статті відповідає логіці скрейпера: посилання `/field/…`, `article p` / `itemprop="articleBody"`, `og:image`, canonical, meta description.
2. Видати повний блок **`## Source Spec`** за шаблоном з `.cursor/agents/source-researcher.md`.
3. Явно вказати: **рекомендований стек** (`http+cheerio` vs зміни), **pagination**, **record_shape** узгоджений з `articles` (title, slug, url, excerpt, content, image_url, category, tags).
4. **`## Recommendations for database-agent`**: чи достатньо таблиці `articles` з `database/init.sql` без змін.
5. **`## Commands to parse and load (pipeline)`**: `pnpm --filter pipeline run scrape:treatfield`, `pnpm --filter pipeline run load:treatfield` / `load:treatfield:test`.

## Очікуваний результат

Markdown-відповідь з `## Source Spec` + двома closing-секціями. Без правок коду.

## Repo

Корінь: `/Users/tupotavalentyn/CS/ai0_global`. Slug плану: `treatfield-psihoterapia`.

Прочитай і дотримуйся `.cursor/agents/source-researcher.md`.

## Step result

Поверни: **DONE** або **BLOCKED:** + причина; короткий список висновків (селектори OK / що зламано).
