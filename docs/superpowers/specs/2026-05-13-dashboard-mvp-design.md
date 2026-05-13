# Channel Tracking Dashboard MVP (Phase 2) — Design

**Date:** 2026-05-13
**Status:** approved (continuation of Phase 1)
**Parent spec:** `2026-05-13-channel-tracking-platform-design.md`
**Implementation branch:** `feat/dashboard-mvp`

## Goal

Ship a React SPA that consumes the Phase 1 tracking API and provides the operator with
self-serve channel monitoring: see all tracked channels, drill into per-channel metrics
with charts, add new channels manually, review discovery candidates. Graph view + AI ROI
analyzer are out of scope (Phase 3).

## Stack

- **Build**: Vite 5 (TypeScript template)
- **Framework**: React 18
- **Router**: TanStack Router (file-based, type-safe — better than React Router for this scale)
- **Data**: TanStack Query v5 (fetch + cache + retries)
- **Charts**: Recharts (only Line + Bar charts needed)
- **Styling**: Tailwind v4
- **Date formatting**: `date-fns` (lighter than dayjs for our usage)
- **Auth**: Telegram Login Widget → backend verifies hash → issues JWT in HttpOnly cookie

## Repo layout

```
apps/dashboard/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
├── postcss.config.js
├── index.html
├── nginx.conf                       # production static + API proxy
├── Dockerfile                       # multi-stage: builder → nginx
├── public/
│   └── favicon.svg
└── src/
    ├── main.tsx
    ├── routes/
    │   ├── __root.tsx               # layout (header, nav, auth gate)
    │   ├── index.tsx                # → redirects to /channels
    │   ├── login.tsx                # Telegram Login Widget
    │   ├── channels.tsx             # list + add-modal
    │   ├── channels.$id.tsx         # detail + charts
    │   └── discovery.tsx
    ├── api/
    │   ├── client.ts                # fetch wrapper (credentials: 'include')
    │   ├── tracking.ts              # typed endpoints
    │   └── types.ts                 # mirrors backend DTOs
    ├── auth/
    │   ├── auth-context.tsx         # current user state
    │   └── use-auth.ts
    ├── components/
    │   ├── ChannelCard.tsx
    │   ├── SubsHistoryChart.tsx
    │   ├── PostsList.tsx
    │   ├── AddChannelModal.tsx
    │   └── Pagination.tsx
    └── lib/
        ├── format.ts                # K-/M-formatting for big numbers
        └── env.ts                   # API_BASE_URL from import.meta.env
```

## Backend changes (Phase 2 addition)

The Phase 1 backend uses a static `TRACKING_TOKEN`. Phase 2 introduces **proper auth** —
a new `AuthModule` in `apps/automation/src/auth/` with:

- `POST /auth/telegram-login` — verifies the Telegram Widget payload hash per the
  [official protocol](https://core.telegram.org/widgets/login#checking-authorization),
  checks the user's `id` against an allowlist env var (`TRACKING_ALLOWED_TG_USER_IDS`,
  comma-separated), issues an HttpOnly cookie containing a signed JWT.
- `GET /auth/me` — returns the current user (decoded from JWT cookie).
- `POST /auth/logout` — clears the cookie.

`TrackingAuthGuard` is replaced (or augmented) to accept either the old Bearer token OR a
valid JWT cookie. Bearer remains for curl / debugging; JWT is the production path.

JWT: HS256, secret in `JWT_SECRET` env, 30-day expiry, HttpOnly + Secure + SameSite=Lax
cookie named `tracking_jwt`.

## Pages

### `/login`
Renders the Telegram Login Widget (`<script async src="https://telegram.org/js/telegram-widget.js?22"
data-telegram-login="<botname>" data-size="large" data-onauth="onTelegramAuth(user)">`).
On widget callback, POST to `/auth/telegram-login`. On 200 → redirect to `/channels`.
On 401 → "Not authorised" message.

### `/channels`
Paginated table:
- Columns: avatar (initials), username, title, subs, posts/24h, pollTier badge, lastPolledAt
- Filters: `mine | all | external` segmented control, search box (debounced 300ms)
- Top-right: "Add channel" button → opens `AddChannelModal`
- Row click → `/channels/:id`

Pagination: `pageSize=50`, query string `?page=2&filter=all&q=durov`.

### `/channels/:id`
- Header: title, username, subs, pollTier
- 3 charts (Recharts):
  1. **Subscribers over time** (LineChart) — from `/tracking/channels/:id/subs-history`
  2. **Views per post (last 30)** (BarChart) — derive from `/tracking/channels/:id/posts?limit=30`
  3. **Engagement rate** (LineChart) — derived: (reactions+forwards+comments)/views per post
- Below: top-5 posts by views (cards with text snippet + metrics)
- Below: recent posts table (paginated)
- Top-right: "Refresh now" button → POST `/tracking/channels/:id/refresh` (new endpoint, optional)

### `/discovery`
List of channels where `is_closed=TRUE` or polling never succeeded. Columns:
username, when first seen, source channel that mentioned them, reason.
Optional action: "Try resolving again" (re-enqueues discovery worker).

### `__root.tsx` (layout)
- Top bar: app name, channel-search shortcut (cmd-k later), user avatar + logout
- Sidebar (collapsed by default on mobile): /channels, /discovery
- Auth gate: redirect to /login if no valid JWT (TanStack Router beforeLoad guard calling /auth/me)

## API client design

```ts
// src/api/client.ts
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',  // send cookie
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('unauthorised');
  }
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<T>;
}
```

Per-endpoint wrappers in `src/api/tracking.ts` keep types tight (e.g. `listChannels()`,
`addChannel()`, `getChannelPosts()`).

## Deployment

Build to `apps/dashboard/dist`, served by nginx alongside automation in production:

```
docker-compose.yml (additions)
  dashboard:
    profiles: ["prod"]
    build: { context: ., dockerfile: apps/dashboard/Dockerfile }
    ports: ["${DASHBOARD_PORT:-8080}:80"]
    depends_on:
      automation: { condition: service_started }
    environment:
      AUTOMATION_URL: http://automation:3000
```

`nginx.conf` serves SPA + proxies `/api/*` and `/auth/*` to the automation service.

For dev: `pnpm --filter dashboard run dev` → Vite at `localhost:5173`, Vite's dev proxy
forwards `/api` and `/auth` to `localhost:3000`.

## Out of scope

- Graph page (Phase 3)
- AI ROI rewrite (Phase 3)
- Real-time updates / push (revisit if needed)
- Mobile-first design (desktop only for v1)
- Multi-language UI (Ukrainian + English; v1 is English only; can localise later)

## Risks

| Risk | Mitigation |
|------|------------|
| Telegram Login Widget requires public HTTPS domain to work in production | Local dev works on localhost. Configure widget after first deploy with a real domain. |
| JWT secret leak via env logs | Mask `JWT_SECRET` in any log output; `.env.example` placeholder only. |
| Recharts bundle size (~80 KB gzipped) | Acceptable for an internal dashboard. Phase 3 may swap for `visx` if graph view needs custom rendering. |
| Cookie-based auth in cross-origin dev (Vite vs Nest on different ports) | Vite proxy keeps same-origin from the browser's perspective; no CORS quirks. |

## Success criteria

- Operator can log in via Telegram, see ≥ 50 channels, click into one, view 3 charts
- Adding a channel by username queues it and it appears in the list within 5 s
- Discovery page lists at least 1 closed/unresolved channel after some time
- p95 page load < 2 s with 500 channels in DB
