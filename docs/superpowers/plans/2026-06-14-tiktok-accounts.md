# TikTok Accounts + Token Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist TikTok creator accounts with their rotating OAuth tokens in the DB and expose `getValidAccessToken(accountId)` that auto-refreshes near expiry.

**Architecture:** A `022_tiktok_accounts` migration; a `TikTokAccountsRepository` (mirrors `MetaAccountsRepository`); a `TikTokTokenService` that exchanges auth codes and refreshes tokens against TikTok's `/v2/oauth/token/` endpoint through an overridable `post` seam (so tests need no network); a pure token-shaping helper. Registered in the `@Global` `ChannelConfigModule`. No publishing — this is the token foundation for sub-project 5b.

**Tech Stack:** NestJS 10, pg, axios, `node:test` via `cd apps/automation && npm test`.

---

## Context for the implementer

This is **sub-project 5a** of the recipe image-carousel feature (the TikTok foundation;
TikTok was decomposed into 5a–5d). Read these to match patterns exactly:

- `database/migrations/016_meta_accounts.sql` — migration style (`CREATE TABLE IF NOT EXISTS`, `gen_random_uuid()`, `TIMESTAMPTZ`, and the trailing `INSERT INTO schema_migrations (version) VALUES (...) ON CONFLICT DO NOTHING`). Migrations are plain SQL applied on boot from `database/migrations/` (repo root, sibling to `apps/`).
- `apps/automation/src/config/meta-accounts.repository.ts` — repository style (`@Inject(DB_POOL)`, `pool.query<Row>`, `RETURNING *`, `rows[0] ?? null`).
- `apps/automation/src/config/telegraph.service.ts` (in `publishers/`) — the `ConfigService` env + token-resolution pattern; and the seam pattern (`protected post()`) used in `apps/automation/src/publishers/instagram.publisher.ts`.
- `apps/automation/src/config/config.module.ts` — the `@Global ChannelConfigModule` where account repositories/clients are provided and exported (you add the two TikTok providers here).
- `apps/automation/src/database/database.module.ts` — exports the `DB_POOL` token.

Rules:
- Tests run with `cd apps/automation && npm test` (`tsx --test`, honoring `experimentalDecorators`). Never run tsx from the repo root.
- No live network / TikTok calls in tests — use the `post` seam + a fake pool. No service restart, no publishing.
- No new runtime dependency (axios is already present). One new env block in `.env.example`.

Spec: `docs/superpowers/specs/2026-06-14-tiktok-accounts-design.md`.

## File Structure

- `database/migrations/022_tiktok_accounts.sql` — table. New.
- `apps/automation/.env.example` — `TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI`. Modify.
- `apps/automation/src/config/tiktok-token.util.ts` — pure `expiryFrom` + `toTokenSet` + types. New.
- `apps/automation/src/config/tiktok-token.util.test.ts` — helper tests. New.
- `apps/automation/src/config/tiktok-accounts.repository.ts` — repo + `TikTokAccountRow`. New.
- `apps/automation/src/config/tiktok-accounts.repository.test.ts` — fake-pool tests. New.
- `apps/automation/src/config/tiktok-token.service.ts` — token service. New.
- `apps/automation/src/config/tiktok-token.service.test.ts` — fake-repo + seam tests. New.
- `apps/automation/src/config/config.module.ts` — register both providers + exports. Modify.
- `apps/automation/scripts/tiktok-seed.ts` — CLI onboarding. New.

---

## Task 1: Migration + env vars

**Files:**
- Create: `database/migrations/022_tiktok_accounts.sql`
- Modify: `apps/automation/.env.example`

- [ ] **Step 1: Create the migration**

Create `database/migrations/022_tiktok_accounts.sql`:

```sql
-- 022_tiktok_accounts.sql — TikTok creator connections for the carousel publisher.
-- UNLIKE meta_accounts, the tokens live in the DB: TikTok access tokens expire (~24h)
-- and rotate on refresh, so a static env var cannot hold them. Plaintext for v1
-- (internal DB); tokens are never logged. client_key/secret stay in env.
CREATE TABLE IF NOT EXISTS tiktok_accounts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_id                  TEXT NOT NULL UNIQUE,
  union_id                 TEXT,
  username                 TEXT,
  display_name             TEXT,
  avatar_url               TEXT,
  access_token             TEXT NOT NULL,
  refresh_token            TEXT NOT NULL,
  access_token_expires_at  TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  scope                    TEXT,
  active                   BOOLEAN NOT NULL DEFAULT true,
  last_refreshed_at        TIMESTAMPTZ,
  refresh_error            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('022_tiktok_accounts')
  ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: Add env vars**

Append to `apps/automation/.env.example`:

```bash

# ─── TikTok (Content Posting API) ────────────────────────────────────────────
# App credentials from the TikTok developer portal. Tokens themselves are stored
# in the tiktok_accounts table (they rotate on refresh), NOT here.
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=
```

- [ ] **Step 3: Sanity-check the SQL parses**

Run (from repo root):
```bash
grep -c "tiktok_accounts" database/migrations/022_tiktok_accounts.sql
```
Expected: prints `2` (the CREATE TABLE and nothing relies on a real DB here — the migration runs on the user's next boot).

- [ ] **Step 4: Commit**

```bash
git add database/migrations/022_tiktok_accounts.sql apps/automation/.env.example
git commit -m "feat(tiktok): 022_tiktok_accounts migration + client env vars"
```

---

## Task 2: Pure token-shaping helper

**Files:**
- Create: `apps/automation/src/config/tiktok-token.util.ts`
- Test: `apps/automation/src/config/tiktok-token.util.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/tiktok-token.util.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiryFrom, toTokenSet } from './tiktok-token.util';

test('expiryFrom adds seconds to a base epoch (ms)', () => {
  assert.deepEqual(expiryFrom(1_000_000, 86400), new Date(1_000_000 + 86400_000));
});

test('toTokenSet maps a TikTok token response to absolute expiries', () => {
  const res = { access_token: 'AT', refresh_token: 'RT', expires_in: 86400, refresh_expires_in: 31536000 };
  const set = toTokenSet(res, 1_000_000);
  assert.equal(set.accessToken, 'AT');
  assert.equal(set.refreshToken, 'RT');
  assert.deepEqual(set.accessTokenExpiresAt, new Date(1_000_000 + 86400_000));
  assert.deepEqual(set.refreshTokenExpiresAt, new Date(1_000_000 + 31536000_000));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`):
```bash
npx tsx --test src/config/tiktok-token.util.test.ts
```
Expected: FAIL — cannot find module `./tiktok-token.util`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/config/tiktok-token.util.ts`:

```ts
// Pure helpers for TikTok OAuth token shaping. No I/O — `nowMs` is passed in so
// these are deterministic and unit-testable.

export interface TikTokTokenSet {
  accessToken:           string;
  refreshToken:          string;
  accessTokenExpiresAt:  Date;
  refreshTokenExpiresAt: Date;
}

/** Raw fields from TikTok's /v2/oauth/token/ response that we consume. */
export interface TikTokTokenResponse {
  access_token:        string;
  refresh_token:       string;
  expires_in:          number;  // access-token lifetime, seconds
  refresh_expires_in:  number;  // refresh-token lifetime, seconds
  open_id?:            string;
  scope?:              string;
}

/** Absolute expiry = base epoch (ms) + lifetime (seconds). */
export function expiryFrom(nowMs: number, seconds: number): Date {
  return new Date(nowMs + seconds * 1000);
}

/** Shape a token response into a TikTokTokenSet with absolute expiries. */
export function toTokenSet(res: TikTokTokenResponse, nowMs: number): TikTokTokenSet {
  return {
    accessToken:           res.access_token,
    refreshToken:          res.refresh_token,
    accessTokenExpiresAt:  expiryFrom(nowMs, res.expires_in),
    refreshTokenExpiresAt: expiryFrom(nowMs, res.refresh_expires_in),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`):
```bash
npx tsx --test src/config/tiktok-token.util.test.ts
```
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/config/tiktok-token.util.ts apps/automation/src/config/tiktok-token.util.test.ts
git commit -m "feat(tiktok): pure token-shaping helpers (expiryFrom/toTokenSet)"
```

---

## Task 3: `TikTokAccountsRepository`

**Files:**
- Create: `apps/automation/src/config/tiktok-accounts.repository.ts`
- Test: `apps/automation/src/config/tiktok-accounts.repository.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/tiktok-accounts.repository.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokAccountsRepository } from './tiktok-accounts.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let next: any[] = [];
  const pool = {
    query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: next, rowCount: next.length }; },
    __setRows: (rows: any[]) => { next = rows; },
  };
  return { pool, calls };
}

const TOKENS = {
  accessToken: 'AT', refreshToken: 'RT',
  accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
  refreshTokenExpiresAt: new Date('2031-01-01T00:00:00Z'),
};

test('findByOpenId returns rows[0] ?? null', async () => {
  const { pool } = fakePool();
  const repo = new TikTokAccountsRepository(pool as any);
  assert.equal(await repo.findByOpenId('open1'), null);
  (pool as any).__setRows([{ id: 'a1' }]);
  assert.deepEqual(await repo.findByOpenId('open1'), { id: 'a1' });
});

test('upsertFromTokens inserts with open_id, tokens, expiries, scope', async () => {
  const { pool, calls } = fakePool();
  (pool as any).__setRows([{ id: 'a1' }]);
  const repo = new TikTokAccountsRepository(pool as any);
  const row = await repo.upsertFromTokens({ ...TOKENS, openId: 'open1', scope: 'user.info.basic,video.publish' });
  assert.deepEqual(row, { id: 'a1' });
  const { sql, params } = calls[0];
  assert.match(sql, /INSERT INTO tiktok_accounts/);
  assert.match(sql, /ON CONFLICT \(open_id\) DO UPDATE/);
  assert.equal(params[0], 'open1');
  assert.ok(params.includes('AT'));
  assert.ok(params.includes('RT'));
});

test('updateTokens sets tokens + clears refresh_error', async () => {
  const { pool, calls } = fakePool();
  const repo = new TikTokAccountsRepository(pool as any);
  await repo.updateTokens('a1', TOKENS);
  const { sql, params } = calls[0];
  assert.match(sql, /UPDATE tiktok_accounts/);
  assert.match(sql, /refresh_error\s*=\s*NULL/);
  assert.match(sql, /last_refreshed_at\s*=\s*now\(\)/);
  assert.equal(params[0], 'a1');
});

test('setRefreshError and setActive issue the right params', async () => {
  const { pool, calls } = fakePool();
  const repo = new TikTokAccountsRepository(pool as any);
  await repo.setRefreshError('a1', 'boom');
  assert.deepEqual(calls[0].params, ['a1', 'boom']);
  await repo.setActive('a1', false);
  assert.deepEqual(calls[1].params, ['a1', false]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`):
```bash
npx tsx --test src/config/tiktok-accounts.repository.test.ts
```
Expected: FAIL — cannot find module `./tiktok-accounts.repository`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/config/tiktok-accounts.repository.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { TikTokTokenSet } from './tiktok-token.util';

export interface TikTokAccountRow {
  id:                        string;
  open_id:                   string;
  union_id:                  string | null;
  username:                  string | null;
  display_name:              string | null;
  avatar_url:                string | null;
  access_token:              string;
  refresh_token:             string;
  access_token_expires_at:   Date;
  refresh_token_expires_at:  Date;
  scope:                     string | null;
  active:                    boolean;
  last_refreshed_at:         Date | null;
  refresh_error:             string | null;
  created_at:                Date;
}

export interface TikTokUpsertInput extends TikTokTokenSet {
  openId: string;
  scope:  string | null;
}

@Injectable()
export class TikTokAccountsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<TikTokAccountRow[]> {
    const { rows } = await this.pool.query<TikTokAccountRow>(
      `SELECT * FROM tiktok_accounts ORDER BY created_at`,
    );
    return rows;
  }

  async findById(id: string): Promise<TikTokAccountRow | null> {
    const { rows } = await this.pool.query<TikTokAccountRow>(
      `SELECT * FROM tiktok_accounts WHERE id = $1`, [id],
    );
    return rows[0] ?? null;
  }

  async findByOpenId(openId: string): Promise<TikTokAccountRow | null> {
    const { rows } = await this.pool.query<TikTokAccountRow>(
      `SELECT * FROM tiktok_accounts WHERE open_id = $1`, [openId],
    );
    return rows[0] ?? null;
  }

  /** Insert or, on open_id conflict, re-auth an existing account. Clears errors, re-activates. */
  async upsertFromTokens(input: TikTokUpsertInput): Promise<TikTokAccountRow> {
    const { rows } = await this.pool.query<TikTokAccountRow>(
      `INSERT INTO tiktok_accounts
         (open_id, access_token, refresh_token, access_token_expires_at, refresh_token_expires_at, scope, last_refreshed_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (open_id) DO UPDATE SET
         access_token             = EXCLUDED.access_token,
         refresh_token            = EXCLUDED.refresh_token,
         access_token_expires_at  = EXCLUDED.access_token_expires_at,
         refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
         scope                    = EXCLUDED.scope,
         active                   = true,
         refresh_error            = NULL,
         last_refreshed_at        = now()
       RETURNING *`,
      [input.openId, input.accessToken, input.refreshToken,
       input.accessTokenExpiresAt, input.refreshTokenExpiresAt, input.scope],
    );
    return rows[0];
  }

  /** Persist rotated tokens after a successful refresh. */
  async updateTokens(id: string, t: TikTokTokenSet): Promise<void> {
    await this.pool.query(
      `UPDATE tiktok_accounts SET
         access_token             = $2,
         refresh_token            = $3,
         access_token_expires_at  = $4,
         refresh_token_expires_at = $5,
         refresh_error            = NULL,
         last_refreshed_at        = now()
       WHERE id = $1`,
      [id, t.accessToken, t.refreshToken, t.accessTokenExpiresAt, t.refreshTokenExpiresAt],
    );
  }

  async setRefreshError(id: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE tiktok_accounts SET refresh_error = $2::text WHERE id = $1`, [id, message],
    );
  }

  async setActive(id: string, active: boolean): Promise<void> {
    await this.pool.query(`UPDATE tiktok_accounts SET active = $2 WHERE id = $1`, [id, active]);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`):
```bash
npx tsx --test src/config/tiktok-accounts.repository.test.ts
```
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/config/tiktok-accounts.repository.ts apps/automation/src/config/tiktok-accounts.repository.test.ts
git commit -m "feat(tiktok): TikTokAccountsRepository"
```

---

## Task 4: `TikTokTokenService`

**Files:**
- Create: `apps/automation/src/config/tiktok-token.service.ts`
- Test: `apps/automation/src/config/tiktok-token.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/tiktok-token.service.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokTokenService } from './tiktok-token.service';

function fakeConfig(over: Record<string, string | undefined> = {}) {
  const vars: Record<string, string | undefined> = {
    TIKTOK_CLIENT_KEY: 'ck', TIKTOK_CLIENT_SECRET: 'cs', TIKTOK_REDIRECT_URI: 'https://cb', ...over,
  };
  return { get: (k: string) => vars[k] } as any;
}

const FAR_FUTURE = new Date('2999-01-01T00:00:00Z');
const FAR_PAST   = new Date('2000-01-01T00:00:00Z');

function acct(over: any = {}) {
  return {
    id: 'a1', open_id: 'open1', access_token: 'OLD_AT', refresh_token: 'RT',
    access_token_expires_at: FAR_FUTURE, refresh_token_expires_at: FAR_FUTURE,
    active: true, ...over,
  };
}

function build(over: any = {}) {
  const calls: any = { posts: [], updated: null, upserted: null, refreshErr: null, deactivated: null };
  const repo = {
    findById: async () => over.account === undefined ? acct() : over.account,
    updateTokens: async (id: string, t: any) => { calls.updated = { id, t }; },
    upsertFromTokens: async (i: any) => { calls.upserted = i; return { id: 'a1', ...i }; },
    setRefreshError: async (id: string, m: string) => { calls.refreshErr = { id, m }; },
    setActive: async (id: string, a: boolean) => { calls.deactivated = { id, a }; },
  };
  class TestSvc extends TikTokTokenService {
    constructor() { super(fakeConfig(over.env), repo as any); }
    protected post(url: string, form: Record<string, string>) {
      calls.posts.push({ url, form });
      if (over.postError) throw new Error(over.postError);
      return Promise.resolve(over.postResponse ?? {
        access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 86400, refresh_expires_in: 31536000,
        open_id: 'open1', scope: 'video.publish',
      });
    }
  }
  return { svc: new TestSvc(), calls };
}

test('getValidAccessToken returns the stored token when not near expiry (no network)', async () => {
  const { svc, calls } = build();
  const token = await svc.getValidAccessToken('a1');
  assert.equal(token, 'OLD_AT');
  assert.equal(calls.posts.length, 0);
});

test('getValidAccessToken refreshes when expired and returns the new token', async () => {
  const { svc, calls } = build({ account: acct({ access_token_expires_at: FAR_PAST }) });
  const token = await svc.getValidAccessToken('a1');
  assert.equal(token, 'NEW_AT');
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].form.grant_type, 'refresh_token');
  assert.equal(calls.posts[0].form.refresh_token, 'RT');
  assert.equal(calls.updated.t.accessToken, 'NEW_AT');
});

test('getValidAccessToken throws for a missing account', async () => {
  const { svc } = build({ account: null });
  await assert.rejects(() => svc.getValidAccessToken('a1'), /not found/i);
});

test('getValidAccessToken throws for an inactive account', async () => {
  const { svc } = build({ account: acct({ active: false }) });
  await assert.rejects(() => svc.getValidAccessToken('a1'), /inactive/i);
});

test('exchangeCode posts authorization_code and upserts parsed tokens', async () => {
  const { svc, calls } = build();
  const row = await svc.exchangeCode('AUTHCODE');
  assert.equal(calls.posts[0].form.grant_type, 'authorization_code');
  assert.equal(calls.posts[0].form.code, 'AUTHCODE');
  assert.equal(calls.posts[0].form.redirect_uri, 'https://cb');
  assert.equal(calls.upserted.openId, 'open1');
  assert.equal(calls.upserted.accessToken, 'NEW_AT');
  assert.equal(row.openId, 'open1');
});

test('refresh failure records the error and rejects (no token in message)', async () => {
  const { svc, calls } = build({ account: acct({ access_token_expires_at: FAR_PAST }), postError: 'invalid_grant' });
  await assert.rejects(() => svc.getValidAccessToken('a1'), (e: any) => {
    assert.match(e.message, /refresh failed/i);
    assert.doesNotMatch(e.message, /RT|OLD_AT/);
    return true;
  });
  assert.equal(calls.refreshErr.id, 'a1');
});

test('missing client credentials throws a config error', async () => {
  // Use an expired account so the code path reaches refresh() → creds().
  const { svc } = build({ account: acct({ access_token_expires_at: FAR_PAST }), env: { TIKTOK_CLIENT_KEY: undefined } });
  await assert.rejects(() => svc.getValidAccessToken('a1'), /credentials/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`):
```bash
npx tsx --test src/config/tiktok-token.service.test.ts
```
Expected: FAIL — cannot find module `./tiktok-token.service`.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/config/tiktok-token.service.ts`:

```ts
// TikTok OAuth token service: exchange auth codes and refresh rotating tokens
// against /v2/oauth/token/. The `post` seam is overridable in tests so no live
// network is hit. Tokens and the client secret are never logged.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { TikTokAccountsRepository, TikTokAccountRow } from './tiktok-accounts.repository';
import { toTokenSet } from './tiktok-token.util';

const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const SKEW_MS = 60_000; // refresh this long before the real expiry

@Injectable()
export class TikTokTokenService {
  private readonly logger = new Logger(TikTokTokenService.name);

  constructor(
    private readonly env:  ConfigService,
    private readonly repo: TikTokAccountsRepository,
  ) {}

  private creds(): { key: string; secret: string; redirect?: string } {
    const key = this.env.get<string>('TIKTOK_CLIENT_KEY');
    const secret = this.env.get<string>('TIKTOK_CLIENT_SECRET');
    if (!key || !secret) throw new Error('TikTok client credentials not configured');
    return { key, secret, redirect: this.env.get<string>('TIKTOK_REDIRECT_URI') };
  }

  /** HTTP seam — overridable in tests. Returns the parsed JSON body. */
  protected async post(url: string, form: Record<string, string>): Promise<any> {
    const res = await axios.post(url, new URLSearchParams(form), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15_000,
    });
    return res.data;
  }

  /** Exchange an authorization code for tokens and upsert the account. */
  async exchangeCode(code: string): Promise<ReturnType<TikTokAccountsRepository['upsertFromTokens']>> {
    const { key, secret, redirect } = this.creds();
    if (!redirect) throw new Error('TIKTOK_REDIRECT_URI not configured');
    const res = await this.post(TOKEN_URL, {
      client_key: key, client_secret: secret,
      grant_type: 'authorization_code', code, redirect_uri: redirect,
    });
    if (res?.error) throw new Error(`TikTok token exchange failed: ${res.error_description ?? res.error}`);
    const tokens = toTokenSet(res, Date.now());
    return this.repo.upsertFromTokens({ ...tokens, openId: res.open_id, scope: res.scope ?? null });
  }

  /** A valid access token for the account, refreshing first if near expiry. */
  async getValidAccessToken(accountId: string): Promise<string> {
    const acct = await this.repo.findById(accountId);
    if (!acct) throw new Error(`TikTok account ${accountId} not found`);
    if (!acct.active) throw new Error(`TikTok account ${accountId} is inactive`);
    if (acct.access_token_expires_at.getTime() <= Date.now() + SKEW_MS) {
      return this.refresh(acct);
    }
    return acct.access_token;
  }

  /** Force-refresh one account's tokens. */
  async refresh(acct: TikTokAccountRow): Promise<string> {
    const { key, secret } = this.creds();
    try {
      const res = await this.post(TOKEN_URL, {
        client_key: key, client_secret: secret,
        grant_type: 'refresh_token', refresh_token: acct.refresh_token,
      });
      if (res?.error) throw new Error(res.error_description ?? res.error);
      const tokens = toTokenSet(res, Date.now());
      await this.repo.updateTokens(acct.id, tokens);
      return tokens.accessToken;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      await this.repo.setRefreshError(acct.id, msg);
      if (acct.refresh_token_expires_at.getTime() <= Date.now()) {
        await this.repo.setActive(acct.id, false);
      }
      throw new Error(`TikTok token refresh failed (${acct.id}): ${msg}`);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`):
```bash
npx tsx --test src/config/tiktok-token.service.test.ts
```
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/config/tiktok-token.service.ts apps/automation/src/config/tiktok-token.service.test.ts
git commit -m "feat(tiktok): TikTokTokenService — exchange + auto-refresh"
```

---

## Task 5: Wiring + CLI seed + full verification

**Files:**
- Modify: `apps/automation/src/config/config.module.ts`
- Create: `apps/automation/scripts/tiktok-seed.ts`

- [ ] **Step 1: Register the providers**

Edit `apps/automation/src/config/config.module.ts`. Add imports after the existing Meta imports:

```ts
import { TikTokAccountsRepository } from './tiktok-accounts.repository';
import { TikTokTokenService } from './tiktok-token.service';
```

Add both to the `providers` array (after `MetaCrosspostTargetsRepository`) and to the `exports` array (after `MetaCrosspostTargetsRepository`):

```ts
    TikTokAccountsRepository,
    TikTokTokenService,
```

(Place the same two lines in both the `providers` and `exports` arrays.)

- [ ] **Step 2: Create the CLI seed script**

Create `apps/automation/scripts/tiktok-seed.ts`:

```ts
// One-off TikTok onboarding: exchange an authorization code (obtained out-of-band
// via TikTok's OAuth consent screen) for tokens and persist the account.
//   Usage: npx tsx scripts/tiktok-seed.ts <authorization_code>
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { TikTokAccountsRepository } from '../src/config/tiktok-accounts.repository';
import { TikTokTokenService } from '../src/config/tiktok-token.service';

async function main() {
  const code = process.argv[2];
  if (!code) { console.error('Usage: npx tsx scripts/tiktok-seed.ts <authorization_code>'); process.exit(1); }

  const config = new ConfigService(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const repo = new TikTokAccountsRepository(pool);
  const svc = new TikTokTokenService(config, repo);

  try {
    const row = await svc.exchangeCode(code);
    console.log(`TikTok account onboarded: open_id=${row.open_id} (id=${row.id})`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
```

(`scripts/` is excluded from `tsconfig`, so it doesn't affect the build/typecheck. It needs real env creds + a `code` to run — not exercised in CI.)

- [ ] **Step 3: Typecheck the app**

Run (from `apps/automation`):
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `tiktok` or `config.module`.

- [ ] **Step 4: Run the full suite**

Run (from `apps/automation`):
```bash
npm test
```
Expected: all pass, including the new TikTok tests (util 2, repo 4, service 7). No failures.

- [ ] **Step 5: Build to confirm the module graph compiles**

Run (from `apps/automation`):
```bash
npm run build
```
Expected: `nest build` completes with no errors (confirms `TikTokTokenService` resolves its `ConfigService` + `TikTokAccountsRepository` deps inside `ChannelConfigModule`).

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src/config/config.module.ts apps/automation/scripts/tiktok-seed.ts
git commit -m "feat(tiktok): register repo + token service in ChannelConfigModule; CLI seed"
```

---

## Done criteria

- `tiktok_accounts` migration is present; the table stores rotating tokens with expiries.
- `TikTokTokenService.getValidAccessToken(id)` returns a stored token when fresh and auto-refreshes when near/after expiry, persisting rotated tokens; refresh failures record `refresh_error` and deactivate on refresh-token expiry; tokens/secret never logged.
- `exchangeCode` onboards an account from an authorization code; the CLI seed script drives it.
- Both providers are injectable app-wide (`@Global ChannelConfigModule`), ready for sub-project 5b (the Content Posting API client + publisher).
- All tests pass via `cd apps/automation && npm test`; `npm run build` succeeds; no live network in tests; no new dependency.
