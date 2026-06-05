# Dashboard Redesign — Multi-Platform IA + Supabase-Dark Visual System

**Date:** 2026-06-05
**App:** `apps/dashboard` (Vite + React 18 + TanStack Router/Query + Tailwind v4)
**Status:** Design approved (brainstorm), pending spec review → implementation plan.

## Problem

The dashboard grew organically into a flat, Telegram-only nav (Channels, Discovery,
Graph, Recommendations, Bots, Telegraph, Strategies). It mixes two distinct jobs —
**publishing automation** (post my content) and **competitive intelligence** (track
others) — on a single level, and statistics are buried inside channel detail. The
operator now wants the app to grow into a **multi-platform command center**
(Telegram today; Instagram, TikTok, Threads, Facebook next) doing **both publishing
and analytics equally** on each platform, with a clearer, more scalable UX and a
fresh visual identity.

## Decisions (locked during brainstorm)

1. **Navigation model: function-first.** Menu organized by task, not by platform.
   Platform is a **global filter** in the top bar. (Industry pattern — Buffer /
   Metricool / Hootsuite. Scales to N platforms; enables cross-platform roll-ups.)
2. **Split owned vs tracked channels.** "Мої канали" (`is_mine` publish targets)
   lives under Publishing; tracked/competitor channels stay under Intelligence
   (Discovery / Graph). Today's single "Channels" page conflates them.
3. **Full visual refresh** using the **Supabase design language, dark variant.**
4. **Empty/future areas ship as placeholders**, not hidden — so the IA is complete
   and the growth path is visible.

## Visual System — Supabase-Dark

Single accent (emerald), monochrome grey ladder, hairlines, Inter @ 500 with tight
tracking, square-ish 6px buttons. Adapted from Supabase's white marketing brand to a
dark product canvas (what the Supabase dashboard itself uses).

### Color tokens (CSS variables in `index.css`)
| Token | Value | Use |
|---|---|---|
| `--canvas` | `#1b1b1b` | App background |
| `--canvas-soft` | `#202020` | Sidebar / alt bands |
| `--surface` | `#242424` | Cards, panels |
| `--surface-2` | `#2a2a2a` | Nested chrome, active nav |
| `--hairline` | `#2e2e2e` | 1px borders |
| `--hairline-strong` | `#3a3a3a` | Emphasis borders |
| `--ink` | `#ededed` | Primary text on dark |
| `--ink-mute` | `#a0a0a0` | Secondary text |
| `--ink-faint` | `#6f6f6f` | Tertiary / disabled |
| `--primary` | `#3ecf8e` | Emerald — CTA, active, success |
| `--primary-deep` | `#24b47e` | Pressed state |
| `--on-primary` | `#10231a` | Near-black text **on** emerald (never white) |
| `--warning` | `#ffb224` (amber) | Scheduled / paused status |
| `--danger` | `#e5704b` (tomato) | Errors |

**Emerald is scarce:** filled CTAs, active nav/filter, brand dot, and semantic
*success* only. Warning/danger are functional status colors (chips, deltas), not
decoration. No atmospheric gradients.

### Typography
- **Inter** (Google Fonts), weights 400 / 500 / 600. (Closest open analogue to
  Circular; Geist Sans acceptable fallback.) System mono (`ui-monospace`, Menlo…)
  for code, ids, and numeric data where alignment matters.
- Display @ **500** with negative tracking (`-0.03em`…`-0.01em`). Body @ 400.
- Scale: display 24–32px (page titles), heading 13–18px, body 13–16px, caption 12px,
  micro 10–11px (pills, eyebrows).

### Shape / elevation
- Radii: input 4px, **button/code 6px**, card 8px, large container 12px, pill full.
- Elevation: flat + 1px hairline default; subtle `0 8px 24px rgba(0,0,0,.3)` for
  overlays/modals only.

### Component primitives (shared, in `components/ui/`)
`Button` (primary emerald / secondary outline / ghost), `Card`, `Panel`,
`Badge`/`Pill` (neutral + status variants), `StatCard` (KPI), `PageHeader`
(title + subtitle + actions), `Placeholder` (coming-soon), `DataTable` wrapper,
`Input`, reuse existing `Modal`. Icons: **Lucide** line set (replaces the ad-hoc
inline `Icon` + emoji). *(Note: a prior comment in `Icon.tsx` avoided lucide; this
spec adopts `lucide-react` for breadth — feature + platform glyphs. Flag if you'd
rather extend the inline set.)*

## Information Architecture

Top bar (global): **brand · platform filter chips · search · primary CTA ("+ Новий пост")**.
Platform filter: `Всі · Telegram (active) · Instagram · TikTok · Threads · Facebook`.
Only Telegram has data today; other chips render disabled ("soon"). Selection lives
in a `usePlatform()` store (URL search param `?platform=` so it's shareable and
survives reload); every data page reads it to scope queries. With only Telegram
live, `Всі` == Telegram data.

Sidebar groups:

| Group | Item | Route | State |
|---|---|---|---|
| Головне | Огляд (Overview) | `/` | **NEW** |
| Публікація | Стратегії | `/strategies` | live → restyle |
| Публікація | Календар / черга | `/calendar` | **placeholder** |
| Публікація | Мої канали | `/channels` (is_mine) | live → restyle + split |
| Аналітика | Статистика | `/analytics` | **NEW** (consolidates per-channel charts) |
| Інтелідженс | Discovery | `/discovery` | live → restyle |
| Інтелідженс | Граф | `/graph` | live → restyle |
| Інтелідженс | Рекомендації | `/recommendations` | live → restyle |
| Підключення | TG-боти | `/bots` | live → restyle |
| Підключення | Telegraph | `/telegraph` | live → restyle |
| Підключення | Instagram / TikTok / Threads / Facebook | `/connections/:platform` | **placeholder** |
| — | Налаштування | `/settings` | **placeholder** |

**Channel-detail** (`/channels/$id`) stays as the per-channel deep-dive (stats +
publishing config); reachable from Мої канали and from Analytics.

## Pages

- **Overview (`/`)** — NEW home. KPI tiles (published today, views 24h, subscribers,
  strategy errors), a week chart, "Найближчі заплановані", "Останні пости", and an
  alerts strip for failing strategies. Data: compose from existing endpoints
  (`/api/strategies` for next-run/errors, publications/stats for KPIs). Add a small
  read-only `/api/overview` aggregate only if client-side composition proves clumsy.
- **Стратегії** — existing page + Add/Edit modals; restyle to tokens only (no logic
  change).
- **Мої канали** — existing channels list filtered to `is_mine = true`; tracked
  channels removed from here (they live under Discovery). Restyle.
- **Статистика** — NEW. Consolidates existing chart components (`SubsHistoryChart`,
  `ViewsBarChart`, `EngagementChart`, `RoiPanel`) into a cross-channel analytics
  view scoped by the platform filter. v1 aggregates owned Telegram channels.
- **Discovery / Граф / Рекомендації** — existing pages, restyle; the "tracked" side.
- **TG-боти / Telegraph** — existing pages, restyle.
- **Calendar, Connections/:platform, Settings** — `Placeholder` component
  ("Скоро — публікація в чергу / підключення IG…") with consistent empty-state art.

## Architecture / Components

- **`AppShell`** — replaces current `Layout` + `Sidebar`. Renders grouped sidebar,
  top bar (`PlatformFilter`, search, CTA), and `<Outlet/>`. Collapsible sidebar
  preserved.
- **`PlatformFilter` + `usePlatform()`** — reads/writes `?platform=` search param;
  default `all`. Non-Telegram options disabled until those platforms exist.
- **Design tokens** — overhaul `index.css` `:root` variables to the table above;
  Tailwind v4 `@theme` maps tokens to utilities. All pages inherit the refresh via
  tokens + shared primitives (minimal per-page churn).
- **`components/ui/`** — the primitives listed above; migrate ad-hoc styles
  (`.btn-primary`, `.chip`, `.card`, `.table`…) onto them.

### Backend
Frontend-only redesign. No schema changes. A future `platform` column on
`tracked_channels` is **out of scope** (placeholders cover the growth path). Optional
tiny `/api/overview` aggregate if Overview composition needs it.

## Phasing (incremental; each phase ships independently)

1. **Foundation** — design tokens in `index.css` + Tailwind theme; `components/ui/`
   primitives; Lucide. No page behavior change.
2. **Shell** — `AppShell` (grouped sidebar + top bar + `PlatformFilter`/`usePlatform`);
   route additions; sidebar regroup.
3. **Restyle live pages** — Strategies, Мої канали (with is_mine split), Discovery,
   Граф, Рекомендації, TG-боти, Telegraph → new shell + primitives.
4. **Overview** — new `/` home.
5. **Analytics** — new `/analytics` consolidating existing charts.
6. **Placeholders** — Calendar, Connections/:platform, Settings; finalize platform
   filter disabled-state wiring.

## Testing / Verification
- `tsc --noEmit` clean per phase; existing `node --test` suites stay green.
- Manual smoke per phase via the dashboard dev server (no backend writes / no
  publishing / no Claude calls — pure UI).
- Visual check against the approved `supabase-dark.html` mockup.

## Out of Scope
- Real IG/TikTok/Threads/Facebook integrations (placeholders only).
- `platform` data column + multi-platform ingestion.
- Calendar/queue scheduling engine (placeholder only).
- Any change to publishing/automation backend behavior.

## Non-Negotiables (Supabase doctrine, dark)
- Emerald scarce; near-black text on emerald (never white).
- Display weight 500 max; negative tracking.
- 6px square-ish buttons; never pill-shaped buttons.
- Hairline-bordered cards; no atmospheric gradients.
