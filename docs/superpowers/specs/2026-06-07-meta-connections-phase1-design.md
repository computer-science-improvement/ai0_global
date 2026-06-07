# Meta Connections (Phase 1) — Design

**Goal:** Add/verify Instagram, Facebook, and Threads accounts in the dashboard (tokens in `.env`), with account-preview cards — mirroring the existing Telegram bots/Telegraph managers. Connections only; publishing and previews are later phases.

**Non-goals (Phase 1):** publishing to Meta, strategy targeting, composer post-previews.

## Data model — `meta_accounts` (migration `016_meta_accounts.sql`)

Mirrors `my_bots` conventions. The OAuth token is **never** stored — only the name of the `.env` var that holds it.

```sql
CREATE TABLE meta_accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         TEXT NOT NULL CHECK (platform IN ('instagram','facebook','threads')),
  account_id       TEXT NOT NULL,            -- operator label
  token_env        TEXT NOT NULL,            -- name of the .env var holding the token
  target_id        TEXT NOT NULL,            -- FB Page id / IG business-acct id / Threads user id
  username         TEXT,                     -- @handle (from verify)
  display_name     TEXT,                     -- page/account name (from verify)
  followers        INTEGER,                  -- follower count (from verify, nullable)
  picture_url      TEXT,                     -- profile picture URL (from verify, nullable)
  active           BOOLEAN NOT NULL DEFAULT true,
  last_verified_at TIMESTAMPTZ,
  verify_error     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, account_id)
);
```

## Backend (lives in the config module, alongside bots/telegraph)

- `config/meta-accounts.repository.ts` — `MetaAccountsRepository`: `list()`, `findById()`, `findByPlatformAccount(platform, accountId)`, `insert({platform, account_id, token_env, target_id})`, `markVerified(id, {username, display_name, followers, picture_url})`, `markVerifyError(id, error)`, `setActive(id, active)`, `delete(id)`.
- `config/meta-graph.client.ts` — `MetaGraphClient.verify(platform, targetId, token)`: read-only Graph GET.
  - Facebook / Instagram: `GET https://graph.facebook.com/{VER}/{target_id}?fields=name,username,followers_count,profile_picture_url&access_token=…`
  - Threads: `GET https://graph.threads.net/{VER}/{target_id}?fields=username,name&access_token=…`
  - Graph version from `META_GRAPH_VERSION` env (default `v21.0`); timeout from `FETCH_TIMEOUT` (default 15000). Returns `{ username, displayName, followers, pictureUrl }`. **Redacts the access token** from any thrown error message (regex on `access_token=…` and the raw token), matching `telegram-getme.client`.
- `config/api/meta-accounts.controller.ts` — `@Controller('api/meta-accounts')`, `TrackingAuthGuard`. Never returns token values.
  - `GET` → list (mapped rows).
  - `POST` `{platform, accountId, tokenEnv, targetId}` → conflict-check on `(platform, accountId)`, insert.
  - `POST /:id/verify` → read token via `ConfigService.get(tokenEnv)`; if missing, store + 400. Else call `MetaGraphClient.verify`, store name/handle/followers/picture, return `{ok, ...}` or `{ok:false, error}`.
  - `PATCH /:id` `{active}` → toggle.
  - `DELETE /:id` → delete (no FK bindings in Phase 1).
  - DTOs in `config/api/dto/meta-accounts.dto.ts` (class-validator).
- Register repository + client + controller in `ChannelConfigModule`. No `config:changed` event (no runtime consumer until Phase 2).

## Frontend — Meta connections page

`apps/dashboard/src/routes/connections_.meta.tsx` keeps its 3 tabs (**Facebook / Instagram / Threads**); each tab renders a real manager instead of a placeholder.

- `components/connections/MetaAccountsManager.tsx` (parallel to `BotsManager`), prop `platform`. Lists that platform's accounts as **cards** (the "preview like for Telegram connected services"):
  - profile picture (or placeholder), **display name**, **@username**, **followers**, platform icon;
  - verified/unverified/error chip (error as tooltip), last-verified time;
  - `token_env` + `target_id` shown as meta;
  - actions: **Verify**, toggle **active**, **delete** (existing `useConfirm` dialog).
- `components/connections/AddMetaAccountModal.tsx` — platform locked to the active tab; fields: label (`accountId`), token env-var (`tokenEnv`), target id (`targetId`).
- `api/meta-accounts.ts` (`metaAccountsApi`: list/create/verify/patch/remove) + `MetaAccount` type in `api/types.ts`.

## Verification

`tsc --noEmit` + `npm run build` (automation), `tsc` + `vite build` (dashboard). The Verify button calls Meta's read API with the operator's token — user-initiated, no automated/Claude cost. Optional unit test for the token-redaction + URL-builder pure helper in `meta-graph.client`.
