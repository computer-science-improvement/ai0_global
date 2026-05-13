# Channel Tracker Dashboard

React SPA consuming the Phase 1 tracking API.

## Dev

```bash
# 1. Start backend
docker compose up -d postgres redis
pnpm run dev:automation        # http://localhost:3000

# 2. Start dashboard
cp apps/dashboard/.env.example apps/dashboard/.env
# Edit .env — set VITE_TG_BOT_USERNAME
pnpm --filter dashboard run dev
# → http://localhost:5173
```

Vite proxies `/api` and `/auth` to `localhost:3000`, so the SPA and Nest run on the same origin from the browser's perspective (cookies work without CORS quirks).

## Auth

Production uses Telegram Login Widget. Configure the bot via BotFather:
- `/setdomain` → your dashboard's public hostname
- Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, and `TRACKING_ALLOWED_TG_USER_IDS` on the backend
- Set `VITE_TG_BOT_USERNAME` on the frontend

For curl / debugging keep the `TRACKING_TOKEN` Bearer in `.env`; the guard accepts both.

## Build & deploy

```bash
pnpm --filter dashboard run build       # outputs apps/dashboard/dist
docker compose --profile prod up -d dashboard
```
