# Dashboard → English Translation — Design

**Goal:** Make the entire dashboard UI English. Replace every hardcoded Ukrainian string in `apps/dashboard/src` (and the few backend strings that surface in the dashboard) with natural English, **in place** — no i18n library, no language toggle.

## Approach

**In-place English-only** (chosen). Edit the string literals directly in the JSX/TS. No `i18next`/`react-intl`, no `t()` indirection, no locale files. Rationale: the requirement is "translate everything to English," not "support multiple languages." This is the smallest, lowest-risk change and adds zero dependencies. (If multi-language is ever wanted, that's a separate future project.)

## Scope

### Dashboard (31 files with Cyrillic)
By area (line counts are Cyrillic-bearing lines, for batching):

- **Navigation / shell:** `components/AppSidebar.tsx` (18), `components/AppShell.tsx` (3), `components/PlatformFilter.tsx` (2), `components/ui/Placeholder.tsx` (1).
- **Route pages:** `routes/index.tsx` (10), `settings.tsx` (25), `logs.tsx` (16), `scheduled.tsx` (7), `analytics.tsx` (6), `login.tsx` (6), `connections.tsx` (6), `tracked.tsx` (5), `channels.tsx` (3), `compose.tsx` (3), `connections.$platform.tsx` (2), `calendar.tsx` (2), `channels_.$id.tsx` (2), `bots.tsx` (1), `telegraph.tsx` (1), `connections_.meta.tsx` (1).
- **Components:** `components/post/PostComposer.tsx` (23), `components/connections/SessionsPanel.tsx` (22), `components/connections/MetaAccountsManager.tsx` (15), `components/CrosspostSection.tsx` (11), `components/connections/AddMetaAccountModal.tsx` (8), `components/AddChannelModal.tsx` (2), `components/ChannelRow.tsx` (2), `components/connections/BotsManager.tsx` (2), `components/connections/TelegraphManager.tsx` (1), `components/post/TelegramPreview.tsx` (1).
- **API layer:** `api/settings.ts` (1).
- **Locale:** `routes/index.tsx` uses `toLocaleString('uk-UA')` → change to `'en-US'`. Date/relative helpers (`lib/format.ts`) already use the browser locale — leave them.

`lib/labels.ts` (strategy descriptions / status help tooltips) contains **no** Cyrillic — already English. No change.

### Backend strings that surface in the dashboard (3 spots — translate)
1. `apps/automation/src/activity/activity.repository.ts:78` — `'Запланований пост'` → `'Scheduled post'` (Logs page strategy label).
2. `apps/automation/src/scheduled-posts/post-validation.ts:44` — `'MTProto-user не підтримує медіа під текстом — оберіть «над текстом» або бота'` → English (shown as a compose error). **Also update its assertion in `scheduled-posts/post-validation.test.ts`.**
3. `apps/automation/src/tracking/api/tracking.service.ts:51` — session labels `'Спільна сесія (публікатор)'` / `'Трекерська сесія'` → `'Shared session (publisher)'` / `'Tracker session'` (rendered in SessionsPanel).

### Out of scope (stays Ukrainian)
- **AI-generated channel content** — the Telegram posts themselves are Ukrainian by product design (strategies, prompts, channel content templates, `channel-*` skills).
- **Admin-bot Telegram DM messages** (`publishers/admin-bot.service.ts`) — operator-facing chat messages, not the dashboard.
- Channel names / keys / handles.
- Any intentional Ukrainian **sample-post preview** literal in the dashboard that demonstrates real post output (judge per string during implementation; flag rather than blindly translate).

## Translation glossary (consistency contract)

All files must use these exact renderings so the UI reads consistently. Implementers translate everything else naturally in this register (concise, sentence-case, product-UI tone).

| Ukrainian | English |
|---|---|
| Огляд | Overview |
| Стратегії | Strategies |
| Заплановані | Scheduled |
| Мої канали / Канали | My channels / Channels |
| Статистика | Analytics |
| Логи | Logs |
| Налаштування | Settings |
| Підключення | Connections |
| Календар | Calendar |
| Створити / Новий пост | Compose / New post |
| Зберегти | Save |
| Скасувати | Cancel |
| Видалити | Delete |
| Редагувати / Ред. | Edit |
| Додати | Add |
| Увімкнено / Вимкнено | Enabled / Disabled |
| Завантаження… | Loading… |
| Немає даних / Немає … | No data / No … |
| задано / не задано | set / not set |
| перевизначено | overridden |
| Публікація / Публікації | Posted / Posts |
| Помилка / Помилки | Error / Errors |
| Пропущено / Пропущені | Skipped |
| Виконується | Running |
| Час · Канал · Стратегія · Деталі | Time · Channel · Strategy · Details |
| Відправник | Sender |
| Статус | Status |
| З'єднано | Connected |
| Налаштовано, не зʼєднано | Configured, not connected |
| Порожня | Empty |
| Спільна сесія (публікатор) | Shared session (publisher) |
| Трекерська сесія | Tracker session |
| Бот / Боти | Bot / Bots |
| Крос-постинг у Meta | Meta cross-posting |
| Підпишіться, щоб відстежувати | Subscribe to track |

**Sidebar section headers** (`AppSidebar.tsx`): Головне → **Home**, Публікація → **Publishing**, Аналітика → **Analytics**, Інтелідженс → **Intelligence**, Підключення → **Connections**, Система → **System**.

## Architecture / units

No structural change. Each file is edited independently; the glossary is the only shared contract. The work is grouped into batches (by area, see plan) purely for review granularity — there are no inter-file dependencies, so batches are order-independent.

## Verification

The dashboard has **no test runner**. Per batch and at the end:
- `cd apps/dashboard && npx tsc --noEmit && npm run build` (tsc + vite) — must pass.
- **Cyrillic sweep:** `grep -rlP '[\x{0400}-\x{04FF}]' apps/dashboard/src --include='*.ts' --include='*.tsx'` should return **no files** at completion (or only files holding documented sample-content exceptions, which must be listed). This is the objective done-check.
- Backend: `cd apps/automation && npx tsx --test 'src/**/*.test.ts'` (the updated `post-validation.test.ts` must pass) + `tsc --noEmit` + `nest build`.

## Cost / safety

Pure string edits + a backend constant/message change. No DB, no posting, no Claude calls, no scheduler/automation restart needed for correctness (a restart only refreshes the 3 backend strings live). Honors the standing cost guard.
