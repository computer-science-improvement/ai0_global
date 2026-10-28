# ai0 — редизайн: хендоф для Claude Code

Цей пакет переносить прототип із канваса «ai0 — редизайн» у код `apps/dashboard`.
Його склали на основі двох документів із репозиторію: `docs/ui-inventory.md` (знімок `ef525a02`) і `docs/ui-data-contract.md` (`5f8eeedb`).

**Як класти в репозиторій:** розпакуй архів у `docs/redesign/`. Вийде так:

```
docs/redesign/
  HANDOFF.md            ← цей файл
  prototypes/
    Main.dc.html        ← лендинг (motion)
    App-Today.dc.html   ← /app (колишній Overview)
    App-Inbox.dc.html   ← /app/agents/inbox
    App-Agent.dc.html   ← /app/agents/$handle
    App-Calendar.dc.html← /app/calendar
```

**Правила для того, хто впроваджує:**

- Прототипи — це **референс розкладки, ієрархії та поведінки**, не код для копіювання. Їхні hex-кольори, шрифт Geist і розмітку `<x-dc>` не переносимо. Беремо токени з `src/index.css` і наявні компоненти з `docs/ui-inventory.md` §3.
- Файли `.dc.html` читаються як текст: розмітка, CSS у `<helmet>`, дані й обробники в `<script type="text/x-dc">`. Окремо в браузері вони не рендеряться, бо їм потрібен рантайм канваса. Живий інтерактивний прототип є лише на канвасі в Claude.
- Дотримуйся `apps/dashboard/CLAUDE.md`: CSS-змінні замість hex, `Badge` у кожній клітинці статусу, `SectionCard`, `CompactCard`, один патерн таблиць.
- Один розділ цього документа — один PR. Порядок PR дано в §9, готові промпти — у §10.
- Тексти, які прототип вигадав для ілюстрації, позначені `[…]`. Це плейсхолдери, а не дані.

---

## 1. Токени: прототип → наші змінні

| У прототипі | Токен у коді | Примітка |
|---|---|---|
| `#0A0C0B` фон лендингу | `--color-canvas` (`#1b1b1b`) | Лендинг може мати локальний темніший фон `--lp-canvas`, якщо світіння кільця на `#1b1b1b` слабке. Це рішення дизайну, не обов'язкове |
| `#0C0F0E` сайдбар | `--color-surface-1` | |
| `#101413`, `#111513` панелі | `--color-surface-2` | |
| `#0F1312`, `#0B0E0D` інпути та сегменти | `--color-surface-1` / `--color-canvas` | |
| `#1A2320`, `#1E2B25` активний сегмент | `--color-surface-3` або `--color-success-soft` | |
| `rgba(255,255,255,.06–.1)` лінії | `--color-hairline` / `--color-hairline-soft` | |
| `#EDEFEE` | `--color-ink` | |
| `#A3ABA7` | `--color-ink-muted` | |
| `#97A09B`, `#828C87` | `--color-ink-dim` | Після фіксу контрасту, див. §1.1 |
| `#3DDC97` | `--color-accent` | |
| `#03170D` | `--color-on-accent` | |
| `#F2B24C` | `--color-warning` | Колір людини: approve, missed, «потрібна дія» |
| `#FF9F95` | `--color-danger` | |
| Geist / Geist Mono | InterVariable / `--font-mono` | `--font-mono` ще треба визначити, див. §1.1 |
| радіуси 10–20px | `--radius-md` … `--radius-xl` | Кнопки лишаються `--radius-sm` |

### 1.1 Що виправити в токенах (PR 1)

1. **Контраст `--color-ink-dim`.** Зараз `#6f6f6f` дає приблизно 3.4:1 на `#1b1b1b` і ще менше на `surface-2/3`. Це не проходить WCAG AA для дрібного тексту, а ним набрані назви груп, підписи плиток і час. Пропоную `#949494`: ≥ 4.5:1 на всіх чотирьох поверхнях.
2. **Визначити `--font-mono`** у `@theme`, щоб моно-шрифт перестав бути дефолтом Tailwind. Він потрібен для хендлів, часу і технічних деталей в Inbox.
3. **`.text-heading-md`** використовується в коді, але не визначена. Визначити її або замінити на `.text-headline`.
4. **`var(--shadow-2)`** у `SchemaEditor.tsx:181` не існує. Додати токен або прибрати використання.
5. **Єдина мапа статусів.** Зараз тони розходяться: Overview показує `skipped` як warning, Editor — як neutral (контракт §11.2). Зробити `src/lib/status-tone.ts` з однією мапою (§2) і використовувати її скрізь.
6. **Reduced motion:** `compose-rise`, `modal-*`, `la-shimmer`, `logs-spin` і recharts (`isAnimationActive`) зараз ігнорують `prefers-reduced-motion`.

---

## 2. Статуси: одна система (колір + форма)

`--color-accent` і `--color-success` — це один і той самий колір `#3ecf8e`. Тому статуси розрізняємо **формою мітки, а не лише кольором**. Новий компонент `StatusMark` малює мітку для таймлайнів і календаря, а `Badge` лишається для таблиць.

| Статус | Джерело | Тон Badge | Форма `StatusMark` |
|---|---|---|---|
| `planned` | `editor_slots` | neutral | порожнє коло з обводкою accent |
| `running` | `editor_slots` | accent | коло, що пульсує |
| `awaiting_approval` | `editor_slots` | warning | порожнє коло з обводкою warning |
| `approved` | `editor_slots` | accent | коло з галочкою |
| `shadowed` | `editor_slots` | neutral | пунктирне коло |
| `published` | `editor_slots` | success | заповнене коло accent |
| `skipped` | `editor_slots` | neutral | порожнє сіре коло, текст перекреслений |
| `failed` | `editor_slots` | danger | заповнений квадрат danger |
| `expired` | `editor_slots` | warning | сірий ромб |
| **missed** (обчислюється) | серія або пін зі статусом `skipped` / `failed` / `expired` | warning | заповнений ромб warning |
| **not planned** (обчислюється) | `upcoming.status === null` | warning | пунктирна обводка warning |
| `pending` / `sending` / `sent` / `failed` / `canceled` / `unknown` | `scheduled_publications` | neutral / accent / success / danger / neutral / warning | біла заповнена мітка «yours» |

Як обчислити **missed** на клієнті, поки бекенд його не віддає (gap #7):

```
slot.seriesName != null || slot.scheduleRuleId != null
  && ['skipped','failed','expired'].includes(slot.status)
  && slot.error не починається з 'superseded' / 'mode_changed'
```

---

## 3. Навігація (IA)

Прототип скорочує меню з 26 пунктів до 11. Решта сторінок лишається доступною через ⌘K і розкривний блок «More tools».

**Це зміна дефолтів у `src/nav/registry.ts`, а не переписування сайдбару:**

| Група | Пункти (id з registry) |
|---|---|
| Home | `overview` (label «Today») · `agentsInbox` (unhide, label «Inbox») · `chat` |
| Network | `agents` · **`calendar`** (новий, §7) · `channels` · `map` |
| Insights | `analytics` · `spend` · `health` |
| System | `settings` (FORCED) |

- `hiddenByDefault: true` отримують: `approvals` (злився з Inbox), `dm`, `models`, `artifacts`, `compose`, `scheduled`, `editor`, `logs`, `data`, `tracked`, `discovery`, `graph`, `recommendations`, `connections`, `groups`, `landing`, `ads`.
- Лічильник «17» переїжджає з Agents на Inbox. `badge` для `agentsInbox` = `agentInboxUnread + approvals.waiting`. В `agents` лишається лише `directivesAwaitingOwner` (або без бейджа).
- **Важливо:** у власника вже збережене меню (на це вказують бейджі «new»). Нові дефолти його **не перезапишуть**. Після деплою потрібно в Settings → Navigation натиснути «Reset to default». Як варіант — разова міграція `ui.nav`.
- Блок «More tools» у сайдбарі: кнопка-розкривачка, усередині — посилання на всі приховані пункти, без групових заголовків.

---

## 4. Today — `/app` (`app.index.tsx`)

**Мета.** Перший екран відповідає на питання «що від мене потрібно» і «як іде день». Цифри стоять на другому плані.

| Блок прототипу | Дані | Компоненти |
|---|---|---|
| Заголовок «Good evening. N things need you» | кількість з `GET /api/nav/attention` + `GET /api/editor/approvals/count` | `PageHeader` |
| **Needs you** (до 4 пунктів + «Open inbox · N») | `GET /api/nav/attention`: топ-8 непрочитаних, спершу `critical` | нова `NeedsYouList`. Можна розширити наявний `nav/NeedsYou.tsx` |
| Дії в пунктах | мапа `kind → дія`, §5.2 | `Button` |
| Dismiss | `POST /api/agents/inbox/read { ids:[id] }` | |
| **Today at a glance**: кільце N/M слотів | Σ `channels[].today.slots` з `GET /api/editor/channels` | нове `SlotRing` (SVG) |
| AI spend / budget | `GET /api/spend/summary?range=7d` → `periods.today`, `budgets[]` | наявний `BudgetBar` |
| **Today’s schedule** (таймлайн 06–24) | `GET /api/editor/plans?date=<today>` → `plans[status=active].slots` + лінія «now» | нове `DayTimeline`, `StatusMark`. Сирий таймлайн уже є в `agents/AgentPlan.tsx:290-313`, його можна узагальнити |
| **Agents** з інлайн-режимом | `GET /api/editor/channels` (mode, `today.runs`, `today.spendUsd`) + `GET /api/agents` (ім'я та емодзі оркестратора через `scopeId ↔ channelKey`) | `AgentModeSwitch` (перехід у live — через `AutonomyDialog`) |
| **Live activity** | джерело панелі «Activity · last 24h» на `/app/map` **(знайти в `components/map/*`)** або `GET /api/editor/runs?limit=10` | `CompactCard` |
| KPI-смуга | наявні плитки: Telegram subs, Meta followers, `posts.d7`, spend 7d зі спарклайном | `StatTile` |

**Що прибрати з Overview:**
- плитку **Errors**: вона рахує помилки *legacy strategies*, а не агентів;
- плитку Meta Δ 24h;
- блок **Legacy strategy runs** (перенести в `/app/logs`);
- секцію Meta accounts (перенести в `/app/connections`);
- порожній блок Network health. Замість нього — рядок-посилання «Network health · N problems» з `GET /api/kpi/digest`.

**Критерії готовності:**
- Без нотаток показується порожній стан «All clear».
- Dismiss прибирає пункт і оновлює лічильник без перезавантаження.
- Таймлайн коректний для 0 слотів, для 15+ слотів і після replan (`superseded` плани не показуються).

---

## 5. Inbox — `/app/agents/inbox`

URL лишається тим самим, щоб старі посилання з Telegram-алертів працювали. Можна додати alias `/app/inbox`.

### 5.1 Розкладка

- **Вкладки:** `To approve` (наявний `ApprovalList`) · `All` · `Critical` · `Action` · `FYI`. Останні три — клієнтський фільтр за `severity` у `GET /api/agents/inbox`. Окремо перемикач «Unread only».
- **Дві колонки:** зліва список, справа деталі. Нижче 860px деталі відкриваються в `Modal` або bottom-sheet.
- **Деталі:**
  - severity `Badge` і чип `kind` (mono);
  - агент і час;
  - заголовок;
  - **What happened** = `body`;
  - **Why it matters** = текст із фронтенд-мапи `src/lib/inbox-kinds.ts`;
  - головна дія, другорядна дія і «Mark as done»;
  - спойлер **Technical details**: `kind`, `severity`, `refType`, `refId`, `createdAt`.
- **Mark as done** = `POST /api/agents/inbox/read { ids:[id] }`. «Mark all as done» = `{ ids:'all' }`.
- **Групування дублікатів** (дві нотатки Threads → одна з «2 accounts») потребує поля `subject`, тобто gap #1. До того показуємо окремо.

### 5.2 Мапа `kind → дія` (`src/lib/inbox-kinds.ts`)

| kind | Головна дія | Ендпоінт | Стан |
|---|---|---|---|
| `resource_health`, `resource_health_daily`, `connection_broken` | Refresh token / Verify | Threads: `POST /api/meta-accounts/:id/refresh-threads-token`; бот: `POST /api/my-bots/:id/verify`; MTProto: `POST /api/mtproto-sessions/:id/verify`; TikTok: `GET /api/tiktok/oauth/start` | є, але `ref → accountId` треба зіставити **(не певно)**. Перевірка одним кроком — gap #4 |
| `series_paused` | Resume / Keep paused | `POST /api/agents/:handle/series-pauses { action:'resume', id: refId }`; keep — gap #2 | resume є |
| `series_missed`, `dark_day` | Replan tomorrow · Pause series | `POST /api/editor/channels/:key/replan?date=tomorrow`; pause — gap #3 | replan є |
| `critic_reject_streak` | Open channel · Pause series | посилання; pause — gap #3 | частково |
| `manager_escalation` | Ask @manager | `/app/chat` з префілом `@manager …` **(перевірити, чи є параметр префілу)** | є |
| `directive_structural` | Approve / Decline | `POST /api/directives/:id/approve` \| `/decline` | є |
| `directive_contested` | Accept refusal / Uphold | `POST /api/directives/:id/accept-refusal` \| `/uphold` | є |
| `directive_ignored`, `directive_failed` | Open directive | посилання на `@manager?tab=directives` | є |
| `playbook_pending` | Approve / Reject | `POST /api/playbooks/:id/approve` \| `/reject` | є |
| `skill_self_edit`, `skill_rolled_back`, `skill_probe` | Open skill · Roll back | `POST /api/skills/:id/rollback` | є |
| `ready_for_autonomy` | Go live | `AutonomyDialog` → `POST /api/editor/approvals/autonomy` | є |
| `shadow_ended` | Choose mode | `PATCH /api/agents/:handle { mode }` | є |
| `network_independent_offer` | Keep | `POST /api/network-offers/:groupId/keep` | є |
| `budget_blocked` | Edit caps | `/app/spend?tab=budgets` | є |
| `landing_lead` | Open lead | `/app/landing?tab=leads` | є |
| `ad_orders_stuck`, `ad_order_unfulfilled` | Open ads | `/app/ads` | є |
| `low_runway`, `series_source_empty` | Open data | `/app/data/$key` | є |
| `critic_failed`, `derived_post_failed`, `approval_dedup`, `evergreen_fallback` | Open slot | `/app/editor/slot/:refId` | є |
| `loadout_suggestions` | Open loadout | вкладка Loadout | є |
| `audit_report` | Open report | `/app/artifacts` | є |
| інші `info` | Got it | mark read | є |

«Why it matters» пишемо коротко, англійською, по одному реченню на `kind`. Тексти беремо з описів тригерів у контракті §7.2.

---

## 6. Agent detail — `/app/agents/$handle`

### 6.1 Вкладки: 15 → 5 груп

| Група | Вкладки (наявні значення `?tab=`) |
|---|---|
| **Overview** | `overview` |
| **Content** | `plan` · `schedule` · `ideas` · `approvals` |
| **Brain** | `playbook` · `skills` · `loadout` · `memory` · `artifacts` |
| **Activity** | `history` · `inbox` · (для `@manager`: `reviews`, `directives`) |
| **Settings** | профіль (Edit), ресурс, форматування, `promo` |

- **`?tab=` лишається листковим ключем.** Групу виводимо з нього, тож усі старі посилання з Inbox працюють.
- Група з кількома вкладками рендерить другий рівень `SegmentedTabs`. Клік по групі веде на її першу вкладку.
- Ресурс і форматування переїжджають з Overview у Settings. В Overview лишаються компактні зведення з посиланням «Edit».

### 6.2 Шапка та Overview

- **Шапка:**
  - аватар, ім'я, kind-чип, `description`, рядок `@handle → scopeId`;
  - **`AgentModeSwitch` великий** (4 сегменти) з одним рядком пояснення режиму під ним. Тексти беремо з контракту §9.3;
  - дії: Run now, Chat with <name> (`/app/chat` з префілом), More (Set up channel, Pause/Resume, Edit).
- **Банер паузи:** `GET /api/agents/:handle/series-pauses` → `open[]`.
  - `key` починається з `resource:` → заголовок «Planning paused»;
  - `series:` → «Series “<label>” paused»;
  - кнопка Resume → `POST … { action:'resume', id }`.
- **KPI-ряд:**
  - `activity.spentTodayUsd` / `dailyBudgetUsd`;
  - `activity.runsToday`;
  - `postsPerDayMin–Max` з `GET /api/editor/channels/:key`;
  - відповіді `@manager` за 30 днів (followed / declined). Джерело — той самий запит, що таблиця «Answers to @manager» на Overview **(знайти)**.
- **Today, step by step:** злиття `GET /api/editor/plans?date=&channel=` (слоти) і `GET /api/editor/runs?channel=&limit=` (запуски), відсортоване за часом, з `StatusMark`. Причина пропуску береться з `skipReason()` (`lib/slot-plan.ts`).
- **Channel:** зведення `ResourceSection` (topic, language, time zone, goals) і health-чип.
- **How posts look:** наявний `FormattingSection` (`hashtagMin/Max`, `linkStyle`, `emojiPolicy`, `formats`) з кнопками Lock. У прототипі значення-заглушки `[linkStyle]` тощо.

---

## 7. Calendar — `/app/calendar`

Зараз `/app/calendar` лише редіректить на `/app/scheduled`. Робимо його справжньою сторінкою: вона об'єднує **слоти агентів** (`editor_slots`), **проєкції серій і пінів** (upcoming) та **пости власника** (`scheduled_publications`).

| Шар | Дані | Примітка |
|---|---|---|
| Слоти по днях | `GET /api/editor/plans?date=` × 5 днів | Краще додати діапазон `?from=&to=` (новий gap C1) |
| «Series, not planned yet» | `GET /api/schedule/upcoming?hours=120` → `status === null` | Піни матеріалізуються лише на сьогодні й завтра (контракт §8.2) |
| Пости власника («yours») | `GET /scheduled-posts` | `channelId → channelKey` через `GET /tracking/channels?filter=mine` |

**Розкладка:**
- рядки — оркестратори, плюс рядок «Pipelines»;
- колонки — 5 днів, поточний день підсвічено;
- у клітинці — чипи `час · назва · статус` (форма й тон з §2);
- клік по чипу слота веде на `/app/editor/slot/$id`, по чипу посту — на редагування.

**Composer-шухляда** (клік «+ Add» у порожній клітинці або «New post»):
- **«I’ll write it»** — наявний `PostComposer` + `post/TelegramPreview` у варіанті drawer. Канал і день префілені. Відправка: `POST /scheduled-posts`.
- **Валідація лише після submit або blur.** Зараз Compose показує помилки до першої дії.
- **«Ask the agent»** — чат-чернетки, які стають слотами (`drafts.service.ts:304-308`). HTTP-вхід у контракті не описаний, тож це **фаза 2: знайти ендпоінт**.
- Після збереження чип з'являється в клітинці, а внизу виникає toast «Scheduled for … Undo».

`/app/scheduled` і `/app/compose` лишаються робочими. Пізніше `/app/scheduled` можна перевести на `/app/calendar?view=list`.

---

## 8. Лендинг — `/` (`routes/index.tsx`, `components/landing/*`)

`motion` (`motion/react`) уже встановлений, `<MotionConfig reducedMotion="user">` уже є. Нові залежності не потрібні.

| Секція прототипу | Компонент | Що замінює | Техніка |
|---|---|---|---|
| Hero: поява заголовка по словах | `HeroHeadline` | поточний fade-in | `motion` stagger ≤ 0.07 с на слово, весь вхід ≤ 900 мс. **Зараз підзаголовок через 2 с ще прозорий** |
| Hero: орбіта MANAGER → 5 агентів → платформи | `HeroOrbit` | — | CSS `@keyframes` rotate. Мітки агентів контр-обертаються, щоб лишатись рівними. Лише `transform`/`opacity` |
| Hero: `agent.log` | `AgentLog` | — | безкінечний CSS-скрол дубльованого списку. Дані: фаза 1 — статичні 10 рядків, фаза 2 — новий публічний ендпоінт (gap L1) |
| Стрічка каналів + контурні слова | `ChannelMarquee` | `ProofStrip` | CSS marquee, дані з наявного landing-view |
| Інтерактивні ролі | `RoleExplorer` | `AgentHierarchy` | `useState`, кнопки-ролі + картка опису. `ah-travel` пакети лишаються |
| Петля Plan→Learn + трек 5 guards | `LoopRing`, `GuardTrack` | `HowItWorks` | CSS keyframes, синхронізовані затримки |
| Колода «Approved» | `ApprovalDeck` | — | CSS keyframes (3 картки з від'ємними delay) |
| Сітка каналів з hover | `NetworkShowcase` | без змін даних | hover-lift + spotlight |
| Кроки реклами + лінія | `AdSteps` | `MediaKit` (частина) | `useScroll` / `whileInView` |
| Перемикач Shadow/Live | `ShadowLiveDemo` | `WhiteLabel` (частина) | `useState` |
| Лічильники | наявний `CountUp` | | у no-JS стані показувати фінальне число |

**Правила моушну:**
- Безкінечні петлі ставимо на паузу поза екраном (`IntersectionObserver` → клас `is-offscreen` → `animation-play-state: paused`).
- При `prefers-reduced-motion` вимикаємо всі петлі. Контент лишається видимим у фінальному стані.
- Прибрати «| DEV» з назв каналів на публічній сторінці (через `lib/landing-view.ts`) або показувати prod-канали.
- Шрифт лишається Inter. Geist у прототипі опційний.

---

## 9. Порядок робіт (PR)

| # | PR | Зачіпає | Ризик |
|---|---|---|---|
| 1 | Токени й статуси (§1.1, §2): `ink-dim`, `--font-mono`, `status-tone.ts`, `StatusMark`, reduced motion | `index.css`, `lib/`, `components/ui/` | низький |
| 2 | Навігація (§3): дефолти registry, Inbox у Home, бейдж, «More tools» | `nav/registry.ts`, `nav/badges.ts`, `AppSidebar.tsx` | низький |
| 3 | Today (§4) | `app.index.tsx`, `components/overview/*` | середній |
| 4 | Inbox: розкладка й мапа kind→дія (§5), лише фронтенд | `app.agents_.inbox.tsx`, `lib/inbox-kinds.ts` | середній |
| 4b | Бекенд-gap #1, #2 (+ #3): `actions`/`subject` в API і `POST /api/agents/inbox/:id/actions` | `owner-inbox.ts`, `agents.controller.ts` | середній |
| 5 | Agent: групи вкладок і шапка (§6) | `app.agents_.$handle.tsx`, `components/agents/*` | середній |
| 6 | Calendar, лише читання (§7) | новий `app.calendar.tsx`, прибрати редірект | середній |
| 6b | Calendar: composer-drawer + валідація | `post/PostComposer.tsx` | середній |
| 7 | Лендинг моушн (§8) | `routes/index.tsx`, `components/landing/*` | низький для `/app` |
| — | Окремо: баг §11.1 контракту (слоти вимкненого каналу стають `failed`) | `editor-plans.repository.ts` `claimDue` | — |

**Бекенд-прогалини за пріоритетом:**
- #1 і #2 — кнопки нотаток у дашборді;
- #7 — missed у plans/upcoming;
- #8 — причина «not planned»;
- #4 — перевірка з'єднання одним кроком;
- C1 — діапазон дат для plans;
- L1 — публічний feed активності для лендингу.

---

## 10. Промпти для Claude Code (по одному на сесію)

Перед кожним промптом переконайся, що `docs/redesign/` лежить у репозиторії.

### PR 1 — токени й статуси

```
Прочитай docs/redesign/HANDOFF.md (§1.1 і §2) та apps/dashboard/CLAUDE.md.
Зроби PR «design tokens & status system»:
1) у src/index.css: --color-ink-dim → #949494 (перевір контраст ≥4.5:1 на canvas і surface-1/2/3), визнач --font-mono, визнач .text-heading-md (або заміни використання на .text-headline), прибери/визнач var(--shadow-2);
2) створи src/lib/status-tone.ts з однією мапою статусів editor_slots і scheduled_publications (таблиця §2) + функцію isMissed(slot);
3) створи components/ui/StatusMark.tsx (форма + тон, aria-label зі статусом) і заміни локальні мапи тонів у routes/app.index.tsx:35-38 та components/editor/EditorUi.tsx:25-28 на спільну;
4) додай reduced-motion для compose-rise, modal-*, la-shimmer, logs-spin, а recharts-компонентам — isAnimationActive={!prefersReducedMotion}.
Без змін бекенду. Запусти npm run build і тести.
```

### PR 2 — навігація

```
Прочитай docs/redesign/HANDOFF.md §3 і docs/ui-inventory.md §5.
Зміни лише дефолти меню в src/nav/registry.ts: групи Home / Network / Insights / System, як у таблиці §3; agentsInbox — видимий, label «Inbox», у Home; решту позначених пунктів — hiddenByDefault.
У src/nav/badges.ts лічильник Inbox = agentInboxUnread + approvals waiting; в Agents лишається лише directivesAwaitingOwner.
Додай у сайдбар розкривачку «More tools» зі списком прихованих пунктів (посилання, без заголовків груп).
Онови src/nav/legacy-redirects.test.ts і тести resolve/badges. Опиши в PR, що власнику потрібно натиснути Settings → Navigation → Reset.
```

### PR 3 — Today

```
Прочитай docs/redesign/HANDOFF.md §4 і подивись прототип docs/redesign/prototypes/App-Today.dc.html (лише як референс розкладки; кольори/шрифт — з наших токенів).
Перероби /app (routes/app.index.tsx) у «Today»:
- Needs you з GET /api/nav/attention (+ approvals count), дії за мапою з §5.2 (створи src/lib/inbox-kinds.ts, якщо ще нема), Dismiss = mark read;
- Today at a glance (кільце з channels[].today.slots, бюджет з spend summary);
- DayTimeline з GET /api/editor/plans?date=today (лише active плани) + StatusMark + лінія «now», missed — через isMissed();
- таблиця агентів з AgentModeSwitch (live → AutonomyDialog);
- Live activity: знайди джерело панелі «Activity · last 24h» у components/map/* і перевикористай;
- прибери плитки Errors і Meta Δ 24h, блоки Legacy strategy runs і Meta accounts (перенеси в /app/logs і /app/connections відповідно).
Пустий стан «All clear». Мобільна розкладка ≤860px. Без змін бекенду.
```

### PR 4 — Inbox

```
Прочитай docs/redesign/HANDOFF.md §5 і прототип docs/redesign/prototypes/App-Inbox.dc.html.
Перероби /app/agents/inbox: вкладки To approve (наявний ApprovalList) / All / Critical / Action / FYI (+ Unread only), дві колонки список/деталі (≤860px — Modal), деталі з What happened (body), Why it matters (з src/lib/inbox-kinds.ts), головною й другорядною дією за мапою §5.2, Mark as done і спойлером Technical details (kind, severity, refType, refId, createdAt).
Для дій, яким бракує бекенду (gap #1–#4), показуй лише посилання на відповідну сторінку й TODO з номером gap.
Збережи всі наявні deep links (InboxLinks) і параметр ?tab=.
```

### PR 4b — бекенд для кнопок нотаток

```
Прочитай docs/redesign/HANDOFF.md §5.2 і docs/ui-data-contract.md §10.2 (#1, #2, #3).
1) OwnerInbox.list повертає також subject і actions; онови тип InboxItem у дашборді.
2) Додай POST /api/agents/inbox/:id/actions { key } → SeriesPauseActions.run(noteId, key), з тими ж перевірками, що в Telegram-callback; відповідь — оновлена нотатка.
3) Розшир POST /api/agents/:handle/series-pauses на { action:'pause', key, label }.
Тести на контролер і сервіс. Після цього підключи кнопки actions у Inbox і Today.
```

### PR 5 — Agent detail

```
Прочитай docs/redesign/HANDOFF.md §6 і прототип docs/redesign/prototypes/App-Agent.dc.html.
У routes/app.agents_.$handle.tsx згрупуй 15 вкладок у 5 груп (таблиця §6.1). ?tab= лишається листковим ключем, групу виводимо з нього; група з кількома вкладками рендерить другий рівень SegmentedTabs.
Шапка: великий AgentModeSwitch з рядком пояснення режиму, дії Run now / Chat / More.
Банер паузи з series-pauses open[] (resource: → «Planning paused», series: → «Series … paused») з Resume.
Overview: KPI-ряд, «Today, step by step» (plans + runs, StatusMark, skipReason), компактні зведення Channel і Formatting з посиланням у Settings.
Усі наявні посилання на ?tab=… мають працювати.
```

### PR 6 — Calendar

```
Прочитай docs/redesign/HANDOFF.md §7 і прототип docs/redesign/prototypes/App-Calendar.dc.html.
Заміни редірект routes/app.calendar.tsx на сторінку тижня: рядки — оркестратори (+ Pipelines), колонки — 5 днів; шари: editor plans по днях, upcoming?hours=120 (status null → «series, not planned»), scheduled-posts («yours», channelId → channelKey через tracking channels). Чипи з StatusMark, клік → сторінка слота / редагування посту.
Друга частина (окремий коміт): drawer «New post» на базі PostComposer + post/TelegramPreview з префілом каналу й дня; валідацію показувати лише після submit/blur. Режим «Ask the agent» — знайди HTTP-вхід для чат-чернеток (drafts.service.ts) і, якщо його немає, залиш кнопку disabled з поясненням.
Додай пункт calendar у nav registry (група Network).
```

### PR 7 — лендинг

```
Прочитай docs/redesign/HANDOFF.md §8 і прототип docs/redesign/prototypes/Main.dc.html — бери з нього структуру секцій і CSS @keyframes (таймінги, затримки); сам файл без рантайму канваса в браузері не відкривається, живу анімацію я дивлюсь на канвасі.
Перероби / (routes/index.tsx, components/landing/*) за таблицею §8: HeroHeadline, HeroOrbit, AgentLog (статичні рядки), ChannelMarquee, RoleExplorer (замість AgentHierarchy), LoopRing + GuardTrack, ApprovalDeck, AdSteps, ShadowLiveDemo.
Безкінечні петлі — CSS keyframes лише transform/opacity, пауза поза екраном через IntersectionObserver; входи — motion whileInView once; prefers-reduced-motion вимикає петлі. Вхід hero ≤900 мс.
Не додавай нових залежностей. Перевір Lighthouse (CLS ≈ 0, без long tasks від анімацій) і мобільну ширину 375px.
```
