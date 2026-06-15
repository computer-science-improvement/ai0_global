# TikTok OAuth Round-Trip + Accounts API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect TikTok accounts via the browser OAuth code flow (signed-state CSRF) and list/manage them through a token-free API.

**Architecture:** A pure HMAC signed-state helper; a `TikTokOAuthService` (authorize-URL + state verify); a guarded `TikTokAccountsController` (token-free list/delete/setActive); and a `TikTokOAuthController` with a guarded `start` and a public `callback` (verifies state, calls 5a's `exchangeCode`, 302s to the dashboard). Registered in `ChannelConfigModule`. Tests mock the exchange — no network.

**Tech Stack:** NestJS 10, `@nestjs/config`, `node:crypto`, `node:test` via `cd apps/automation && npm test`.

---

## Context for the implementer

This is **sub-project 5d-1** of the TikTok integration. 5a/5b/5c are on the branch chain.
Read these:

- `apps/automation/src/config/api/meta-accounts.controller.ts` — the controller pattern: `@Controller('api/meta-accounts') @UseGuards(TrackingAuthGuard)`, token-free `list()` projection, `@Delete(':id')`, `@Patch(':id')`.
- `apps/automation/src/tracking/api/tracking-auth.guard.ts` — `TrackingAuthGuard` (X-API-Key).
- `apps/automation/src/config/tiktok-accounts.repository.ts` — `TikTokAccountsRepository` (5a): has `list()`, `findById`, `setActive`; you add `delete`.
- `apps/automation/src/config/tiktok-token.service.ts` — `TikTokTokenService.exchangeCode(code): Promise<TikTokAccountRow>` (5a).
- `apps/automation/src/config/config.module.ts` — `@Global ChannelConfigModule`; `controllers: [...]`, `providers: [...]`. `TikTokAccountsRepository` + `TikTokTokenService` are already provided here.
- `apps/automation/.env.example` — env style. `JWT_SECRET` already exists (reused for state HMAC). `TIKTOK_CLIENT_KEY`/`TIKTOK_REDIRECT_URI` exist (5a).

Rules:
- Tests run with `cd apps/automation && npm test` (`tsx --test`). Never run tsx from the repo root.
- No live network in tests — mock `exchangeCode`. No service restart. Tokens never appear in API responses, logs, or redirect URLs.
- No new dependency (`node:crypto` is built in).

Spec: `docs/superpowers/specs/2026-06-15-tiktok-oauth-accounts-api-design.md`.

## File Structure

- `apps/automation/src/config/tiktok-oauth-state.util.ts` — pure `signState`/`verifyState`. New.
- `apps/automation/src/config/tiktok-oauth-state.util.test.ts` — tests. New.
- `apps/automation/src/config/tiktok-oauth.service.ts` — `TikTokOAuthService`. New.
- `apps/automation/src/config/tiktok-oauth.service.test.ts` — tests. New.
- `apps/automation/src/config/tiktok-accounts.repository.ts` — add `delete()`. Modify.
- `apps/automation/src/config/tiktok-accounts.repository.delete.test.ts` — test. New.
- `apps/automation/src/config/api/tiktok-accounts.controller.ts` — accounts CRUD. New.
- `apps/automation/src/config/api/tiktok-accounts.controller.test.ts` — tests. New.
- `apps/automation/src/config/api/tiktok-oauth.controller.ts` — start + callback. New.
- `apps/automation/src/config/api/tiktok-oauth.controller.test.ts` — tests. New.
- `apps/automation/src/config/config.module.ts` — register controllers + service. Modify.
- `apps/automation/.env.example` — `TIKTOK_SCOPES`, `DASHBOARD_URL`. Modify.

---

## Task 1: Signed-state helper

**Files:**
- Create: `apps/automation/src/config/tiktok-oauth-state.util.ts`
- Test: `apps/automation/src/config/tiktok-oauth-state.util.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/tiktok-oauth-state.util.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signState, verifyState } from './tiktok-oauth-state.util';

const SECRET = 'test-secret-32-characters-minimum!';

test('a freshly signed state verifies', () => {
  const token = signState(SECRET, 1000, 5000); // exp = 6000
  assert.equal(verifyState(SECRET, token, 1000), true);
  assert.equal(verifyState(SECRET, token, 5999), true);
});

test('an expired state does not verify', () => {
  const token = signState(SECRET, 1000, 5000); // exp = 6000
  assert.equal(verifyState(SECRET, token, 6000), false); // exp <= now
  assert.equal(verifyState(SECRET, token, 9999), false);
});

test('a tampered or wrong-secret state does not verify', () => {
  const token = signState(SECRET, 1000, 5000);
  assert.equal(verifyState(SECRET, token + 'x', 1000), false);
  assert.equal(verifyState('other-secret', token, 1000), false);
});

test('garbage never throws and returns false', () => {
  assert.equal(verifyState(SECRET, '', 1000), false);
  assert.equal(verifyState(SECRET, 'a.b', 1000), false);
  assert.equal(verifyState(SECRET, 'a.b.c', 1000), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`): `npx tsx --test src/config/tiktok-oauth-state.util.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/config/tiktok-oauth-state.util.ts`:

```ts
// Signed, stateless OAuth `state` for CSRF — HMAC-SHA256, no storage. `nowMs` is
// passed in so expiry is deterministic and unit-testable.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Token `exp.nonce.sig` where sig = HMAC-SHA256(secret, `exp.nonce`). */
export function signState(secret: string, nowMs: number, ttlMs: number = DEFAULT_TTL_MS): string {
  const exp = nowMs + ttlMs;
  const nonce = randomBytes(9).toString('base64url');
  const payload = `${exp}.${nonce}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** True iff the signature verifies AND exp > nowMs. Never throws. */
export function verifyState(secret: string, token: string, nowMs: number): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= nowMs) return false;
  const expected = sign(secret, `${expStr}.${nonce}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`): `npx tsx --test src/config/tiktok-oauth-state.util.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/config/tiktok-oauth-state.util.ts apps/automation/src/config/tiktok-oauth-state.util.test.ts
git commit -m "feat(tiktok): signed-state CSRF helper for OAuth"
```

---

## Task 2: `TikTokOAuthService`

**Files:**
- Create: `apps/automation/src/config/tiktok-oauth.service.ts`
- Test: `apps/automation/src/config/tiktok-oauth.service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/tiktok-oauth.service.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokOAuthService } from './tiktok-oauth.service';

function cfg(over: Record<string, string | undefined> = {}) {
  const vars: Record<string, string | undefined> = {
    TIKTOK_CLIENT_KEY: 'ck', TIKTOK_REDIRECT_URI: 'https://api.x/cb',
    TIKTOK_SCOPES: 'user.info.basic,video.publish', JWT_SECRET: 'secret-secret-secret', ...over,
  };
  return { get: (k: string) => vars[k] } as any;
}

test('buildAuthorizeUrl includes client_key, scope, redirect, response_type, and a valid state', () => {
  const svc = new TikTokOAuthService(cfg());
  const url = svc.buildAuthorizeUrl(1000);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(u.searchParams.get('client_key'), 'ck');
  assert.equal(u.searchParams.get('scope'), 'user.info.basic,video.publish');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://api.x/cb');
  const state = u.searchParams.get('state')!;
  assert.equal(svc.verifyState(state, 1000), true);
});

test('buildAuthorizeUrl throws when client key or redirect is unset', () => {
  assert.throws(() => new TikTokOAuthService(cfg({ TIKTOK_CLIENT_KEY: undefined })).buildAuthorizeUrl(1000), /not configured/i);
  assert.throws(() => new TikTokOAuthService(cfg({ TIKTOK_REDIRECT_URI: undefined })).buildAuthorizeUrl(1000), /not configured/i);
});

test('verifyState rejects a forged token', () => {
  const svc = new TikTokOAuthService(cfg());
  assert.equal(svc.verifyState('not-a-real-state', 1000), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`): `npx tsx --test src/config/tiktok-oauth.service.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/config/tiktok-oauth.service.ts`:

```ts
// Builds the TikTok authorize URL (with a signed state) and verifies returned
// states. The code→token exchange itself lives in TikTokTokenService (5a).
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signState, verifyState } from './tiktok-oauth-state.util';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const DEFAULT_SCOPES = 'user.info.basic,video.publish';

@Injectable()
export class TikTokOAuthService {
  constructor(private readonly env: ConfigService) {}

  private secret(): string {
    return this.env.get<string>('JWT_SECRET') ?? '';
  }

  /** TikTok authorize URL with a fresh signed state. Throws if unconfigured. */
  buildAuthorizeUrl(nowMs: number): string {
    const clientKey = this.env.get<string>('TIKTOK_CLIENT_KEY');
    const redirect  = this.env.get<string>('TIKTOK_REDIRECT_URI');
    if (!clientKey || !redirect) throw new Error('TikTok OAuth not configured (client key / redirect URI)');
    const scope = this.env.get<string>('TIKTOK_SCOPES') ?? DEFAULT_SCOPES;
    const params = new URLSearchParams({
      client_key:    clientKey,
      scope,
      response_type: 'code',
      redirect_uri:  redirect,
      state:         signState(this.secret(), nowMs),
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Verify a returned state token. */
  verifyState(token: string, nowMs: number): boolean {
    return verifyState(this.secret(), token, nowMs);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`): `npx tsx --test src/config/tiktok-oauth.service.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/config/tiktok-oauth.service.ts apps/automation/src/config/tiktok-oauth.service.test.ts
git commit -m "feat(tiktok): TikTokOAuthService — authorize URL + state verify"
```

---

## Task 3: `TikTokAccountsRepository.delete`

**Files:**
- Modify: `apps/automation/src/config/tiktok-accounts.repository.ts`
- Test: `apps/automation/src/config/tiktok-accounts.repository.delete.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/tiktok-accounts.repository.delete.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokAccountsRepository } from './tiktok-accounts.repository';

function fakePool(rowCount: number) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [], rowCount }; } };
  return { pool, calls };
}

test('delete issues DELETE with the id and returns true when a row was removed', async () => {
  const { pool, calls } = fakePool(1);
  const repo = new TikTokAccountsRepository(pool as any);
  assert.equal(await repo.delete('a1'), true);
  assert.match(calls[0].sql, /DELETE FROM tiktok_accounts WHERE id = \$1/);
  assert.deepEqual(calls[0].params, ['a1']);
});

test('delete returns false when no row matched', async () => {
  const { pool } = fakePool(0);
  const repo = new TikTokAccountsRepository(pool as any);
  assert.equal(await repo.delete('missing'), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`): `npx tsx --test src/config/tiktok-accounts.repository.delete.test.ts`
Expected: FAIL — `repo.delete is not a function`.

- [ ] **Step 3: Add the method**

In `apps/automation/src/config/tiktok-accounts.repository.ts`, add to the class (after `setActive`):

```ts
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM tiktok_accounts WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`): `npx tsx --test src/config/tiktok-accounts.repository.delete.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/config/tiktok-accounts.repository.ts apps/automation/src/config/tiktok-accounts.repository.delete.test.ts
git commit -m "feat(tiktok): TikTokAccountsRepository.delete"
```

---

## Task 4: `TikTokAccountsController`

**Files:**
- Create: `apps/automation/src/config/api/tiktok-accounts.controller.ts`
- Test: `apps/automation/src/config/api/tiktok-accounts.controller.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/api/tiktok-accounts.controller.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokAccountsController } from './tiktok-accounts.controller';

function row(over = {}) {
  return {
    id: 'a1', open_id: 'open1', union_id: null, username: 'chef', display_name: 'Chef',
    avatar_url: 'https://x/a.png', access_token: 'SECRET_AT', refresh_token: 'SECRET_RT',
    access_token_expires_at: new Date(), refresh_token_expires_at: new Date(),
    scope: 'video.publish', active: true, last_refreshed_at: null, refresh_error: null, created_at: new Date(),
    ...over,
  };
}

function build(over: any = {}) {
  const calls: any = { deleted: null, setActive: null };
  const repo = {
    list: async () => [row()],
    delete: async (id: string) => { calls.deleted = id; return over.deleteResult ?? true; },
    setActive: async (id: string, a: boolean) => { calls.setActive = { id, a }; },
  };
  return { ctrl: new TikTokAccountsController(repo as any), calls };
}

test('GET / returns a token-free projection', async () => {
  const { ctrl } = build();
  const out = await ctrl.list();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a1');
  assert.equal(out[0].username, 'chef');
  assert.equal('access_token' in out[0], false);
  assert.equal('refresh_token' in out[0], false);
});

test('DELETE /:id calls repo.delete; 404 when missing', async () => {
  const { ctrl, calls } = build();
  await ctrl.remove('a1');
  assert.equal(calls.deleted, 'a1');
  const missing = build({ deleteResult: false });
  await assert.rejects(() => missing.ctrl.remove('nope'), /not found/i);
});

test('PATCH /:id sets active; rejects a non-boolean', async () => {
  const { ctrl, calls } = build();
  await ctrl.patch('a1', { active: false });
  assert.deepEqual(calls.setActive, { id: 'a1', a: false });
  await assert.rejects(() => ctrl.patch('a1', {} as any), /active/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`): `npx tsx --test src/config/api/tiktok-accounts.controller.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/config/api/tiktok-accounts.controller.ts`:

```ts
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, UseGuards,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { TikTokAccountsRepository } from '../tiktok-accounts.repository';

@Controller('api/tiktok-accounts')
@UseGuards(TrackingAuthGuard)
export class TikTokAccountsController {
  constructor(private readonly accounts: TikTokAccountsRepository) {}

  /** Token-free projection — never return access/refresh tokens. */
  @Get()
  async list() {
    const rows = await this.accounts.list();
    return rows.map(r => ({
      id: r.id, open_id: r.open_id, username: r.username, display_name: r.display_name,
      avatar_url: r.avatar_url, active: r.active, last_refreshed_at: r.last_refreshed_at,
      refresh_error: r.refresh_error, created_at: r.created_at,
    }));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    const ok = await this.accounts.delete(id);
    if (!ok) throw new NotFoundException(`tiktok account ${id} not found`);
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: { active?: boolean }): Promise<{ ok: true }> {
    if (typeof body?.active !== 'boolean') throw new BadRequestException('active (boolean) is required');
    await this.accounts.setActive(id, body.active);
    return { ok: true };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`): `npx tsx --test src/config/api/tiktok-accounts.controller.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/config/api/tiktok-accounts.controller.ts apps/automation/src/config/api/tiktok-accounts.controller.test.ts
git commit -m "feat(tiktok): TikTokAccountsController — token-free list/delete/setActive"
```

---

## Task 5: `TikTokOAuthController`

**Files:**
- Create: `apps/automation/src/config/api/tiktok-oauth.controller.ts`
- Test: `apps/automation/src/config/api/tiktok-oauth.controller.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/api/tiktok-oauth.controller.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokOAuthController } from './tiktok-oauth.controller';

function build(over: any = {}) {
  const calls: any = { exchanged: null };
  const oauth = {
    buildAuthorizeUrl: () => 'https://www.tiktok.com/v2/auth/authorize/?x=1',
    verifyState: (_t: string) => over.stateValid ?? true,
  };
  const tokens = {
    exchangeCode: async (code: string) => { calls.exchanged = code; if (over.exchangeThrow) throw new Error(over.exchangeThrow); return { id: 'a1' }; },
  };
  const env = { get: (k: string) => (k === 'DASHBOARD_URL' ? 'https://dash.x' : undefined) };
  return { ctrl: new TikTokOAuthController(oauth as any, tokens as any, env as any), calls };
}

test('start returns the authorize url', () => {
  const { ctrl } = build();
  assert.deepEqual(ctrl.start(), { url: 'https://www.tiktok.com/v2/auth/authorize/?x=1' });
});

test('callback with a valid state exchanges the code and redirects to connected', async () => {
  const { ctrl, calls } = build();
  const out = await ctrl.callback('CODE', 'STATE', undefined);
  assert.equal(calls.exchanged, 'CODE');
  assert.equal(out.url, 'https://dash.x/connections/tiktok?tiktok=connected');
});

test('callback with an invalid state does NOT exchange and redirects to error', async () => {
  const { ctrl, calls } = build({ stateValid: false });
  const out = await ctrl.callback('CODE', 'STATE', undefined);
  assert.equal(calls.exchanged, null);
  assert.equal(out.url, 'https://dash.x/connections/tiktok?tiktok=error');
});

test('callback with a TikTok error param redirects to error', async () => {
  const { ctrl, calls } = build();
  const out = await ctrl.callback(undefined, undefined, 'access_denied');
  assert.equal(calls.exchanged, null);
  assert.match(out.url, /tiktok=error$/);
});

test('callback where exchange throws redirects to error', async () => {
  const { ctrl } = build({ exchangeThrow: 'boom' });
  const out = await ctrl.callback('CODE', 'STATE', undefined);
  assert.match(out.url, /tiktok=error$/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `apps/automation`): `npx tsx --test src/config/api/tiktok-oauth.controller.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write the implementation**

Create `apps/automation/src/config/api/tiktok-oauth.controller.ts`:

```ts
import { Controller, Get, Query, Redirect, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { TikTokOAuthService } from '../tiktok-oauth.service';
import { TikTokTokenService } from '../tiktok-token.service';

// Method-level guards: `start` is dashboard-authed; `callback` is public (the
// browser arrives via TikTok redirect with no session — trust comes from the
// signed `state` we issued at `start`).
@Controller('api/tiktok/oauth')
export class TikTokOAuthController {
  constructor(
    private readonly oauth:  TikTokOAuthService,
    private readonly tokens: TikTokTokenService,
    private readonly env:    ConfigService,
  ) {}

  @Get('start')
  @UseGuards(TrackingAuthGuard)
  start(): { url: string } {
    return { url: this.oauth.buildAuthorizeUrl(Date.now()) };
  }

  @Get('callback')
  @Redirect()
  async callback(
    @Query('code')  code?:  string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<{ url: string }> {
    const base = `${this.env.get<string>('DASHBOARD_URL') ?? ''}/connections/tiktok`;
    if (error || !code || !state || !this.oauth.verifyState(state, Date.now())) {
      return { url: `${base}?tiktok=error` };
    }
    try {
      await this.tokens.exchangeCode(code);
      return { url: `${base}?tiktok=connected` };
    } catch {
      return { url: `${base}?tiktok=error` };
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `apps/automation`): `npx tsx --test src/config/api/tiktok-oauth.controller.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/config/api/tiktok-oauth.controller.ts apps/automation/src/config/api/tiktok-oauth.controller.test.ts
git commit -m "feat(tiktok): TikTokOAuthController — start (authed) + public callback"
```

---

## Task 6: Wiring + env + full verification

**Files:**
- Modify: `apps/automation/src/config/config.module.ts`
- Modify: `apps/automation/.env.example`

- [ ] **Step 1: Register the controllers + service**

Edit `apps/automation/src/config/config.module.ts`. Add imports near the other config imports:

```ts
import { TikTokOAuthService } from './tiktok-oauth.service';
import { TikTokAccountsController } from './api/tiktok-accounts.controller';
import { TikTokOAuthController } from './api/tiktok-oauth.controller';
```

Add both controllers to the `controllers: [...]` array, and add `TikTokOAuthService` to the
`providers: [...]` array. (`TikTokAccountsRepository` and `TikTokTokenService` are already
providers here from 5a; no change needed for them.)

- [ ] **Step 2: Add env vars**

Append to `apps/automation/.env.example`:

```bash

# TikTok OAuth scopes (comma-separated) requested at connect time.
TIKTOK_SCOPES=user.info.basic,video.publish
# Dashboard origin the OAuth callback redirects the browser back to.
DASHBOARD_URL=
```

- [ ] **Step 3: Typecheck**

Run (from `apps/automation`): `npx tsc --noEmit -p tsconfig.json`
Expected: no errors referencing `tiktok-oauth`, `tiktok-accounts.controller`, or `config.module`.

- [ ] **Step 4: Full suite**

Run (from `apps/automation`): `npm test`
Expected: all pass, including the new tests (state util 4, oauth service 3, repo delete 2, accounts controller 3, oauth controller 5). No failures.

- [ ] **Step 5: Build**

Run (from `apps/automation`): `npm run build`
Expected: `nest build` completes with no errors (confirms both controllers' DI resolves: `TikTokOAuthService`, `TikTokTokenService`, `TikTokAccountsRepository`, `ConfigService` are all in `ChannelConfigModule`).

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src/config/config.module.ts apps/automation/.env.example
git commit -m "feat(tiktok): register OAuth + accounts controllers in ChannelConfigModule"
```

---

## Done criteria

- `GET /api/tiktok/oauth/start` (authed) returns a TikTok authorize URL carrying a signed state; `GET /api/tiktok/oauth/callback` (public) verifies the state, exchanges the code via 5a, and 302s to `<DASHBOARD_URL>/connections/tiktok?tiktok=connected|error`, never 500-ing on a bad callback.
- `GET /api/tiktok-accounts` returns a token-free projection; `DELETE`/`PATCH` manage accounts.
- Tokens never appear in responses, logs, or redirect URLs; state is HMAC-signed with a TTL.
- All tests pass via `cd apps/automation && npm test`; `npm run build` succeeds; no live network; no new dependency.
- Sub-project 5d-2 (dashboard) can now build the accounts page + Connect button + binding-form rework against these endpoints.
