---
agent: database-agent
---

## Invocation

@`database-agent` (або Task `database-agent`).

## Вхід

- Результат кроку 01 (`## Source Spec` + рекомендації для DB).
- Цільова таблиця: `articles` у `database/init.sql` (поля: title, slug, url, excerpt, content, image_url, category, tags, posted).

## Завдання

1. Підтвердити, що поточна схема `articles` покриває записи TreatField (унікальність по `slug`, префікс `treatfield-` у лоадері).
2. Якщо розриву немає — **не змінюй** `init.sql`; опиши коротко verification.
3. Якщо потрібні колонки/індекси — мінімальний idempotent DDL у `database/init.sql` і поясни вплив на `apps/pipeline/src/loaders/treatfield.js`.

## Очікуваний результат

Короткий звіт + або відсутність змін у SQL, або точний опис патчу.

## Repo

`/Users/tupotavalentyn/CS/ai0_global`, slug: `treatfield-psihoterapia`.

Прочитай `.cursor/agents/database-agent.md`.

## Step result

**DONE** / **BLOCKED:**; **files changed** (якщо є).
