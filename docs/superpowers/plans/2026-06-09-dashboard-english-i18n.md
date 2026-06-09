# Dashboard English Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the entire dashboard UI English by replacing every hardcoded Ukrainian string in `apps/dashboard/src` (and the 3 backend strings that surface in the dashboard) with natural English, in place.

**Architecture:** Pure string edits — no i18n library, no `t()` indirection. Each file is edited independently; the only shared contract is the glossary below (for cross-file consistency). Work is batched by UI area purely for review granularity; batches are order-independent.

**Tech Stack:** React 19 + TanStack Router/Query + Tailwind v4 (dashboard, no test runner → verify with `tsc` + `vite build` + a Cyrillic grep). NestJS (backend, 3 strings; verify with `tsc` + `nest build` + `node:test`).

---

## GLOSSARY (every task MUST follow these exact renderings)

| Ukrainian | English | | Ukrainian | English |
|---|---|---|---|---|
| Огляд | Overview | | Зберегти | Save |
| Стратегії | Strategies | | Скасувати | Cancel |
| Заплановані | Scheduled | | Видалити | Delete |
| Мої канали | My channels | | Редагувати / Ред. | Edit |
| Канали | Channels | | Додати | Add |
| Статистика | Analytics | | Закрити | Close |
| Логи | Logs | | Увімкнено | Enabled |
| Налаштування | Settings | | Вимкнено | Disabled |
| Підключення | Connections | | Завантаження… | Loading… |
| Календар | Calendar | | Немає … | No … |
| Створити | Compose | | задано / не задано | set / not set |
| Новий пост | New post | | перевизначено | overridden |
| Публікація / Публікації | Posted / Posts | | Час | Time |
| Помилка / Помилки | Error / Errors | | Канал | Channel |
| Пропущено / Пропущені | Skipped | | Стратегія | Strategy |
| Виконується | Running | | Деталі | Details |
| Відправник | Sender | | Статус | Status |
| Текст | Text | | Дії | Actions |
| Бот / Боти | Bot / Bots | | Всі | All |
| З'єднано | Connected | | скоро | soon |
| Налаштовано, не зʼєднано | Configured, not connected | | Порожня | Empty |
| Спільна сесія (публікатор) | Shared session (publisher) | | Трекерська сесія | Tracker session |
| Крос-постинг у Meta | Meta cross-posting | | Підпишіться, щоб відстежувати | Subscribe to track |
| Невірний токен | Invalid token | | відсутні / є | missing / present |

**Sidebar section headers** (`AppSidebar.tsx`): Головне → **Home** · Публікація → **Publishing** · Аналітика → **Analytics** · Інтелідженс → **Intelligence** · Підключення → **Connections** · Система → **System**.

**Rules for every task:**
- Translate **all** Ukrainian (Cyrillic) strings in the listed files to natural, concise, sentence-case product-UI English.
- Keep all code identical: variable names, JSX structure, `className`, CSS vars, `<code>…</code>` contents like `.env`/`TELEGRAM_*`, props, keys, comments may stay or be translated (prefer translating user-facing comment text only if trivial — do not rewrite logic comments).
- **Do NOT translate**: channel names/handles, env-var names, and any literal that is an intentional **sample Telegram post body** (Ukrainian example content). If you hit such a literal, leave it and note it in your report.
- Preserve interpolation (`${…}`, `{var}`), pluralization intent, punctuation/ellipsis (`…`), and emoji.
- After editing, the listed files must contain no Cyrillic except any noted sample-content exception.

---

## Task 1: Navigation & shell

**Files:**
- Modify: `apps/dashboard/src/components/AppSidebar.tsx`
- Modify: `apps/dashboard/src/components/AppShell.tsx`
- Modify: `apps/dashboard/src/components/PlatformFilter.tsx`
- Modify: `apps/dashboard/src/components/ui/Placeholder.tsx`

- [ ] **Step 1: Translate the files**

Open each file and translate every Cyrillic string to English following the GLOSSARY and rules. `AppSidebar.tsx` includes the section headers (Home/Publishing/Analytics/Intelligence/Connections/System) and the nav item labels (Overview, Strategies, Scheduled, My channels, Analytics, Logs, Settings, Connections, Calendar, Compose, Bots, etc. — match each Ukrainian label to its glossary English).

- [ ] **Step 2: Verify no Cyrillic remains in these files**

Run: `grep -nP '[\x{0400}-\x{04FF}]' apps/dashboard/src/components/AppSidebar.tsx apps/dashboard/src/components/AppShell.tsx apps/dashboard/src/components/PlatformFilter.tsx apps/dashboard/src/components/ui/Placeholder.tsx`
Expected: no output (exit 1).

- [ ] **Step 3: Type-check + build**

Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`
Expected: no errors; vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/AppSidebar.tsx apps/dashboard/src/components/AppShell.tsx apps/dashboard/src/components/PlatformFilter.tsx apps/dashboard/src/components/ui/Placeholder.tsx
git commit -m "i18n: translate navigation & shell to English"
```

---

## Task 2: Connections area (panels + modals)

**Files:**
- Modify: `apps/dashboard/src/components/connections/SessionsPanel.tsx`
- Modify: `apps/dashboard/src/components/connections/MetaAccountsManager.tsx`
- Modify: `apps/dashboard/src/components/connections/AddMetaAccountModal.tsx`
- Modify: `apps/dashboard/src/components/connections/BotsManager.tsx`
- Modify: `apps/dashboard/src/components/connections/TelegraphManager.tsx`
- Modify: `apps/dashboard/src/routes/connections.tsx`
- Modify: `apps/dashboard/src/routes/connections.$platform.tsx`
- Modify: `apps/dashboard/src/routes/connections_.meta.tsx`

- [ ] **Step 1: Translate the files**

Translate all Cyrillic per GLOSSARY/rules. Note specifics:
- `SessionsPanel.tsx`: status chip labels (Connected / Configured, not connected / Empty), the "shared" tooltip, field labels (Account / Name / Phone / User id / ENV variable / API keys), the empty-state callout (keep `<code>` env-var names like `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `.env`), and "account data unavailable" fallback text.
- `MetaAccountsManager.tsx` / `AddMetaAccountModal.tsx`: verify/active/delete actions, verified/unverified/error chips, field labels, "Invalid token" etc.

- [ ] **Step 2: Verify no Cyrillic remains**

Run: `grep -rlP '[\x{0400}-\x{04FF}]' apps/dashboard/src/components/connections apps/dashboard/src/routes/connections.tsx 'apps/dashboard/src/routes/connections.$platform.tsx' 'apps/dashboard/src/routes/connections_.meta.tsx'`
Expected: no output.

- [ ] **Step 3: Type-check + build**

Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/connections 'apps/dashboard/src/routes/connections.tsx' 'apps/dashboard/src/routes/connections.$platform.tsx' 'apps/dashboard/src/routes/connections_.meta.tsx'
git commit -m "i18n: translate Connections panels & modals to English"
```

---

## Task 3: Compose / post composer

**Files:**
- Modify: `apps/dashboard/src/components/post/PostComposer.tsx`
- Modify: `apps/dashboard/src/components/post/TelegramPreview.tsx`
- Modify: `apps/dashboard/src/routes/compose.tsx`
- Modify: `apps/dashboard/src/routes/calendar.tsx`

- [ ] **Step 1: Translate the files**

Translate all Cyrillic per GLOSSARY/rules. `PostComposer.tsx`: sender options (Bot / MTProto), media placement ("above text" / "below text"), the platform-tab "soon" hints, field labels/placeholders, buttons. `TelegramPreview.tsx`: any placeholder label. **Watch for sample post content** — if a literal is a Ukrainian example message body shown as a preview demo, leave it and report it.

- [ ] **Step 2: Verify no Cyrillic remains (excluding any reported sample content)**

Run: `grep -nP '[\x{0400}-\x{04FF}]' apps/dashboard/src/components/post/PostComposer.tsx apps/dashboard/src/components/post/TelegramPreview.tsx apps/dashboard/src/routes/compose.tsx apps/dashboard/src/routes/calendar.tsx`
Expected: no output, OR only a line you explicitly flag as intentional sample content.

- [ ] **Step 3: Type-check + build**

Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/post apps/dashboard/src/routes/compose.tsx apps/dashboard/src/routes/calendar.tsx
git commit -m "i18n: translate compose/post composer to English"
```

---

## Task 4: Settings + Logs pages

**Files:**
- Modify: `apps/dashboard/src/routes/settings.tsx`
- Modify: `apps/dashboard/src/routes/logs.tsx`
- Modify: `apps/dashboard/src/api/settings.ts`

- [ ] **Step 1: Translate the files**

Translate all Cyrillic per GLOSSARY/rules.
- `settings.tsx`: the confirm-dialog copy (old→new value diff text, confirm button), toggle labels (Enabled/Disabled), the field descriptions, "set / not set / overridden" status text. **Keep the ENV-key field names** (`TRACKING_ENABLED`, etc.) — those are uppercase identifiers, not Ukrainian.
- `logs.tsx`: platform filter chips, type-filter tabs (All / Posted / Errors / Skipped / Running), table headers (Time · Type · Channel · Strategy · Details), the "Load more" / empty states.
- `api/settings.ts`: the single Cyrillic string (likely a label/description).

- [ ] **Step 2: Verify no Cyrillic remains**

Run: `grep -nP '[\x{0400}-\x{04FF}]' apps/dashboard/src/routes/settings.tsx apps/dashboard/src/routes/logs.tsx apps/dashboard/src/api/settings.ts`
Expected: no output.

- [ ] **Step 3: Type-check + build**

Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/settings.tsx apps/dashboard/src/routes/logs.tsx apps/dashboard/src/api/settings.ts
git commit -m "i18n: translate Settings & Logs pages to English"
```

---

## Task 5: Remaining route pages + components (+ locale fix)

**Files:**
- Modify: `apps/dashboard/src/routes/index.tsx`
- Modify: `apps/dashboard/src/routes/scheduled.tsx`
- Modify: `apps/dashboard/src/routes/analytics.tsx`
- Modify: `apps/dashboard/src/routes/login.tsx`
- Modify: `apps/dashboard/src/routes/tracked.tsx`
- Modify: `apps/dashboard/src/routes/channels.tsx`
- Modify: `apps/dashboard/src/routes/channels_.$id.tsx`
- Modify: `apps/dashboard/src/routes/bots.tsx`
- Modify: `apps/dashboard/src/routes/telegraph.tsx`
- Modify: `apps/dashboard/src/components/CrosspostSection.tsx`
- Modify: `apps/dashboard/src/components/AddChannelModal.tsx`
- Modify: `apps/dashboard/src/components/ChannelRow.tsx`

- [ ] **Step 1: Translate the files**

Translate all Cyrillic per GLOSSARY/rules across all listed files (page headers, buttons, table headers, chips, empty/loading states, tooltips). `ChannelRow.tsx` includes the "Subscribe to track" badge and the low-content note added earlier. `CrosspostSection.tsx`: "Meta cross-posting", mirror/teaser mode copy, confirm dialogs.

- [ ] **Step 2: Locale fix in `routes/index.tsx`**

Find `toLocaleString('uk-UA')` and change the locale argument to `'en-US'`:
```tsx
// before: (c.subsCount).toLocaleString('uk-UA')
// after:
(c.subsCount).toLocaleString('en-US')
```

- [ ] **Step 3: Verify no Cyrillic remains**

Run: `grep -nP '[\x{0400}-\x{04FF}]' apps/dashboard/src/routes/index.tsx apps/dashboard/src/routes/scheduled.tsx apps/dashboard/src/routes/analytics.tsx apps/dashboard/src/routes/login.tsx apps/dashboard/src/routes/tracked.tsx apps/dashboard/src/routes/channels.tsx 'apps/dashboard/src/routes/channels_.$id.tsx' apps/dashboard/src/routes/bots.tsx apps/dashboard/src/routes/telegraph.tsx apps/dashboard/src/components/CrosspostSection.tsx apps/dashboard/src/components/AddChannelModal.tsx apps/dashboard/src/components/ChannelRow.tsx`
Expected: no output.

- [ ] **Step 4: Type-check + build**

Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/routes/index.tsx apps/dashboard/src/routes/scheduled.tsx apps/dashboard/src/routes/analytics.tsx apps/dashboard/src/routes/login.tsx apps/dashboard/src/routes/tracked.tsx apps/dashboard/src/routes/channels.tsx 'apps/dashboard/src/routes/channels_.$id.tsx' apps/dashboard/src/routes/bots.tsx apps/dashboard/src/routes/telegraph.tsx apps/dashboard/src/components/CrosspostSection.tsx apps/dashboard/src/components/AddChannelModal.tsx apps/dashboard/src/components/ChannelRow.tsx
git commit -m "i18n: translate remaining route pages & components to English; en-US locale"
```

---

## Task 6: Backend strings that surface in the dashboard

**Files:**
- Modify: `apps/automation/src/activity/activity.repository.ts:78`
- Modify: `apps/automation/src/tracking/api/tracking.service.ts:51`
- Modify: `apps/automation/src/scheduled-posts/post-validation.ts:44`
- Modify: `apps/automation/src/scheduled-posts/post-validation.test.ts` (assertion)

- [ ] **Step 1: Translate the activity label**

In `activity/activity.repository.ts:78`, change the SQL literal:
```sql
'Запланований пост'                               AS strategy,
```
to:
```sql
'Scheduled post'                                  AS strategy,
```

- [ ] **Step 2: Translate the session labels**

In `tracking/api/tracking.service.ts:51`, change:
```typescript
label:       s.shared ? 'Спільна сесія (публікатор)' : 'Трекерська сесія',
```
to:
```typescript
label:       s.shared ? 'Shared session (publisher)' : 'Tracker session',
```

- [ ] **Step 3: Translate the validation message**

In `scheduled-posts/post-validation.ts:44`, change:
```typescript
errors.push('MTProto-user не підтримує медіа під текстом — оберіть «над текстом» або бота');
```
to:
```typescript
errors.push('MTProto user does not support media below text — choose "above text" or a bot');
```

- [ ] **Step 4: Update the test assertion**

In `scheduled-posts/post-validation.test.ts`, find the assertion that matches the old Ukrainian message (search for `медіа` or the pushed error) and update it to match the new English message (use the same substring style the test already uses, e.g. `/media below text/` or the exact string). Read the test first to mirror its assertion style.

- [ ] **Step 5: Verify**

Run: `cd apps/automation && npx tsx --test src/scheduled-posts/post-validation.test.ts && npx tsc --noEmit && npm run build`
Expected: test passes, tsc clean, nest build OK.

- [ ] **Step 6: Confirm no remaining dashboard-surfaced backend Cyrillic**

Run: `grep -nP '[\x{0400}-\x{04FF}]' apps/automation/src/activity/activity.repository.ts apps/automation/src/tracking/api/tracking.service.ts apps/automation/src/scheduled-posts/post-validation.ts`
Expected: no output. (Admin-bot DM strings in `publishers/admin-bot.service.ts` are intentionally left Ukrainian — out of scope.)

- [ ] **Step 7: Commit**

```bash
git add apps/automation/src/activity/activity.repository.ts apps/automation/src/tracking/api/tracking.service.ts apps/automation/src/scheduled-posts/post-validation.ts apps/automation/src/scheduled-posts/post-validation.test.ts
git commit -m "i18n: translate dashboard-surfaced backend strings to English"
```

---

## Task 7: Final verification (whole-UI sweep)

**Files:** none (verification only)

- [ ] **Step 1: Dashboard-wide Cyrillic sweep**

Run: `grep -rlP '[\x{0400}-\x{04FF}]' apps/dashboard/src --include='*.ts' --include='*.tsx'`
Expected: **no files** listed, OR only files explicitly flagged in earlier tasks as holding intentional sample Telegram-post content. If any unexpected file appears, translate the remaining strings (add a follow-up commit) — the sweep must be clean of UI chrome.

- [ ] **Step 2: Dashboard tsc + build**

Run: `cd apps/dashboard && npx tsc --noEmit && npm run build`
Expected: no errors; vite build succeeds.

- [ ] **Step 3: Backend tests + build**

Run: `cd apps/automation && npx tsx --test 'src/**/*.test.ts' && npx tsc --noEmit && npm run build`
Expected: all tests pass; tsc clean; nest build OK.

- [ ] **Step 4: Report any sample-content exceptions**

List any literals deliberately left Ukrainian (sample post bodies, channel names) so the reviewer can confirm they were the right call.

---

## Notes for the implementer

- **Cost-safe:** pure string edits. No DB, no posting, no Claude calls, no automation restart needed (a restart only refreshes the 3 backend strings live). The user runs any restart.
- **Consistency is the main risk** in a multi-file/multi-agent sweep — always apply the GLOSSARY exactly; for terms not in it, pick the natural English and reuse it everywhere.
- **Never translate** identifiers: env-var names (`TRACKING_ENABLED`, `TELEGRAM_*`), CSS variables, `className` values, route paths, `data-*`, keys.
- The dashboard has no unit tests; `tsc` + `vite build` + the Cyrillic grep are the verification.
