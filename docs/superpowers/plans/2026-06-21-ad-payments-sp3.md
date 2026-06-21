# Ad Payments (SP3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Monetize ad placements: an `ad_orders` invoice, a LiqPay hosted-checkout link the owner sends to an advertiser, and a signature-verified webhook that marks the order paid. A paid order can be turned into an SP2 `schedule_post` action (owner-approved).

**Architecture:** New `apps/automation/src/payments/` module. Pure `liqpay.util.ts` (sha1/base64 sign + verify) → `LiqpayService` (checkout params + callback verify, keys via ConfigService) → `AdOrdersRepository` → `AdOrdersService` (createCheckout, schedulePost via SP2 `AgentActionsRepository`). Guarded `AdOrdersController` + a PUBLIC signature-gated `LiqpayCallbackController`. Dashboard `/app/ads`.

**Tech Stack:** NestJS, `pg`, Node `crypto`, React + TanStack. Tests: `node:test` + `tsx` from `apps/automation` (`npm test`). **No live network in tests** (LiqPay signing/verify is pure). Do not push.

**Hard payment rules (carry into every task):** hosted checkout only — NEVER handle/store card data. We do not move funds or create the merchant account. `LIQPAY_PRIVATE_KEY` is read via ConfigService, never logged, never returned by any endpoint. The callback changes state ONLY on a verified signature.

**Shared types (`apps/automation/src/payments/ad-orders.types.ts`):**
```ts
export type AdOrderStatus = 'draft' | 'awaiting_payment' | 'paid' | 'scheduled' | 'canceled';
export interface AdOrderRow {
  id: string; advertiser: string; channel_id: string | null;
  amount: string; currency: string; description: string | null;
  status: AdOrderStatus; liqpay_order_id: string | null; action_id: string | null;
  paid_at: Date | null; created_at: Date; updated_at: Date;
}
```

---

### Task 1: Migration — ad_orders

**Files:** Create `database/migrations/040_ad_orders.sql`

- [ ] **Step 1: Write the migration**
```sql
CREATE TABLE IF NOT EXISTS ad_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser       TEXT NOT NULL,
  channel_id       TEXT,
  amount           NUMERIC(12,2) NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'UAH',
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','awaiting_payment','paid','scheduled','canceled')),
  liqpay_order_id  TEXT UNIQUE,
  action_id        UUID REFERENCES agent_actions(id) ON DELETE SET NULL,
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_orders_status ON ad_orders (status, created_at DESC);
```
- [ ] **Step 2: Commit** `feat(payments): ad_orders table` (+ trailer)

---

### Task 2: liqpay.util.ts (pure sign/verify)

**Files:** Create `apps/automation/src/payments/liqpay.util.ts` + `...test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, encodeData, decodeData, verify } from './liqpay.util';

const KEY = 'test_private_key';

test('sign is deterministic for a fixed key+data', () => {
  const s1 = sign('DATA', KEY);
  const s2 = sign('DATA', KEY);
  assert.equal(s1, s2);
  assert.ok(s1.length > 0);
});

test('encodeData/decodeData round-trip JSON', () => {
  const params = { public_key: 'pk', amount: 100, order_id: 'o1' };
  const data = encodeData(params);
  assert.deepEqual(decodeData(data), params);
});

test('verify accepts a correct signature and rejects a tampered one', () => {
  const data = encodeData({ order_id: 'o1', status: 'success' });
  const good = sign(data, KEY);
  assert.equal(verify(data, good, KEY), true);
  assert.equal(verify(data, good + 'x', KEY), false);
  assert.equal(verify(data, sign(data, 'other_key'), KEY), false);
});
```
- [ ] **Step 2: Run → FAIL.** `cd apps/automation && npx tsx --test "src/payments/liqpay.util.test.ts"`
- [ ] **Step 3: Implement**
```ts
import { createHash, timingSafeEqual } from 'crypto';

/** LiqPay signature: base64(sha1(private + data + private)). */
export function sign(data: string, privateKey: string): string {
  return createHash('sha1').update(privateKey + data + privateKey).digest('base64');
}

export function encodeData(params: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(params)).toString('base64');
}

export function decodeData<T = any>(data: string): T {
  return JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as T;
}

export function verify(data: string, signature: string, privateKey: string): boolean {
  const expected = sign(data, privateKey);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}
```
- [ ] **Step 4: Run → PASS (3). Step 5: Commit** `feat(payments): pure LiqPay sign/encode/verify helpers`

---

### Task 3: LiqpayService

**Files:** Create `apps/automation/src/payments/liqpay.service.ts` + `...test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiqpayService } from './liqpay.service';
import { decodeData, sign } from './liqpay.util';

const cfg = (env: Record<string, string | undefined>) => ({ get: (k: string) => env[k] }) as any;
const KEYS = { LIQPAY_PUBLIC_KEY: 'pub', LIQPAY_PRIVATE_KEY: 'priv', DASHBOARD_URL: 'https://x' };

test('buildCheckout encodes order params and signs them', () => {
  const svc = new LiqpayService(cfg(KEYS));
  const r = svc.buildCheckout({ orderId: 'o1', amount: '500.00', currency: 'UAH', description: 'Ad' });
  const params = decodeData(r.data);
  assert.equal(params.order_id, 'o1');
  assert.equal(params.amount, '500.00');
  assert.equal(params.public_key, 'pub');
  assert.equal(r.signature, sign(r.data, 'priv'));
  assert.match(r.actionUrl, /liqpay\.ua/);
});

test('buildCheckout throws a clear error when keys unset', () => {
  const svc = new LiqpayService(cfg({}));
  assert.throws(() => svc.buildCheckout({ orderId: 'o1', amount: '1', currency: 'UAH', description: '' }), /not configured/i);
});

test('verifyCallback returns {valid,status,orderId} for a self-signed payload', () => {
  const svc = new LiqpayService(cfg(KEYS));
  const data = Buffer.from(JSON.stringify({ order_id: 'o1', status: 'success' })).toString('base64');
  const signature = sign(data, 'priv');
  assert.deepEqual(svc.verifyCallback(data, signature), { valid: true, status: 'success', orderId: 'o1' });
});

test('verifyCallback rejects a bad signature', () => {
  const svc = new LiqpayService(cfg(KEYS));
  const data = Buffer.from(JSON.stringify({ order_id: 'o1', status: 'success' })).toString('base64');
  assert.deepEqual(svc.verifyCallback(data, 'bad'), { valid: false });
});
```
- [ ] **Step 2: Run → FAIL. Step 3: Implement**
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sign, encodeData, decodeData, verify } from './liqpay.util';

const CHECKOUT_URL = 'https://www.liqpay.ua/api/3/checkout';

@Injectable()
export class LiqpayService {
  constructor(private readonly config: ConfigService) {}

  private keys(): { pub: string; priv: string } {
    const pub = this.config.get<string>('LIQPAY_PUBLIC_KEY');
    const priv = this.config.get<string>('LIQPAY_PRIVATE_KEY');
    if (!pub || !priv) throw new Error('LiqPay not configured (LIQPAY_PUBLIC_KEY/LIQPAY_PRIVATE_KEY)');
    return { pub, priv };
  }

  buildCheckout(o: { orderId: string; amount: string; currency: string; description: string }): { data: string; signature: string; actionUrl: string } {
    const { pub, priv } = this.keys();
    const base = this.config.get<string>('DASHBOARD_URL') ?? '';
    const params = {
      public_key:  pub,
      version:     3,
      action:      'pay',
      amount:      o.amount,
      currency:    o.currency,
      description: o.description,
      order_id:    o.orderId,
      server_url:  base ? `${base}/api/payments/liqpay/callback` : undefined,
    };
    const data = encodeData(params);
    return { data, signature: sign(data, priv), actionUrl: CHECKOUT_URL };
  }

  verifyCallback(data: string, signature: string): { valid: boolean; status?: string; orderId?: string } {
    let priv: string;
    try { priv = this.keys().priv; } catch { return { valid: false }; }
    if (!verify(data, signature, priv)) return { valid: false };
    try {
      const p = decodeData<{ status?: string; order_id?: string }>(data);
      return { valid: true, status: p.status, orderId: p.order_id };
    } catch { return { valid: false }; }
  }
}
```
- [ ] **Step 4: Run → PASS (4). Step 5: Commit** `feat(payments): LiqpayService checkout + callback verify`

---

### Task 4: AdOrdersRepository

**Files:** Create `apps/automation/src/payments/ad-orders.repository.ts` + `...test.ts` + `ad-orders.types.ts` (the shared types block).

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdOrdersRepository } from './ad-orders.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let rows: any[] = [];
  return { calls, setRows: (r: any[]) => { rows = r; },
    pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } } as any };
}

test('create inserts advertiser/amount/currency and returns the row', async () => {
  const { pool, calls, setRows } = fakePool();
  setRows([{ id: 'o1' }]);
  const repo = new AdOrdersRepository(pool);
  const r = await repo.create({ advertiser: 'Acme', channelId: 'c1', amount: '500.00', currency: 'UAH', description: 'Ad' });
  assert.match(calls[0].sql, /INSERT INTO ad_orders/);
  assert.equal(calls[0].params[0], 'Acme');
  assert.equal(r.id, 'o1');
});

test('setCheckout sets liqpay_order_id + awaiting_payment', async () => {
  const { pool, calls } = fakePool();
  const repo = new AdOrdersRepository(pool);
  await repo.setCheckout('o1');
  assert.match(calls[0].sql, /status = 'awaiting_payment'/);
  assert.match(calls[0].sql, /liqpay_order_id = \$1/);
  assert.deepEqual(calls[0].params, ['o1']);
});

test('markPaid only flips non-paid orders (idempotent)', async () => {
  const { pool, calls } = fakePool();
  const repo = new AdOrdersRepository(pool);
  await repo.markPaid('o1');
  assert.match(calls[0].sql, /SET status = 'paid'/);
  assert.match(calls[0].sql, /status IN \('awaiting_payment','draft'\)/);
  assert.deepEqual(calls[0].params, ['o1']);
});

test('list filters by status', async () => {
  const { pool, calls } = fakePool();
  const repo = new AdOrdersRepository(pool);
  await repo.list('paid');
  assert.match(calls[0].sql, /status = \$1/);
  assert.deepEqual(calls[0].params, ['paid']);
});
```
- [ ] **Step 2: Run → FAIL. Step 3: Implement**
```ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { AdOrderRow, AdOrderStatus } from './ad-orders.types';

@Injectable()
export class AdOrdersRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async create(input: { advertiser: string; channelId?: string | null; amount: string; currency: string; description?: string | null }): Promise<AdOrderRow> {
    const { rows } = await this.pool.query<AdOrderRow>(
      `INSERT INTO ad_orders (advertiser, channel_id, amount, currency, description)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [input.advertiser, input.channelId ?? null, input.amount, input.currency, input.description ?? null],
    );
    return rows[0];
  }

  async list(status?: AdOrderStatus): Promise<AdOrderRow[]> {
    if (status) {
      const { rows } = await this.pool.query<AdOrderRow>(`SELECT * FROM ad_orders WHERE status = $1 ORDER BY created_at DESC`, [status]);
      return rows;
    }
    const { rows } = await this.pool.query<AdOrderRow>(`SELECT * FROM ad_orders ORDER BY created_at DESC`);
    return rows;
  }

  async findById(id: string): Promise<AdOrderRow | null> {
    const { rows } = await this.pool.query<AdOrderRow>(`SELECT * FROM ad_orders WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Record that checkout was generated: liqpay_order_id = id, status awaiting_payment. */
  async setCheckout(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE ad_orders SET liqpay_order_id = $1, status = 'awaiting_payment', updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  /** Idempotent: only a not-yet-paid order flips to paid. */
  async markPaid(liqpayOrderId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ad_orders SET status = 'paid', paid_at = now(), updated_at = now()
       WHERE liqpay_order_id = $1 AND status IN ('awaiting_payment','draft')`,
      [liqpayOrderId],
    );
  }

  async attachAction(id: string, actionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ad_orders SET action_id = $2, status = 'scheduled', updated_at = now() WHERE id = $1`,
      [id, actionId],
    );
  }
}
```
- [ ] **Step 4: Run → PASS (4). Step 5: Commit** `feat(payments): AdOrdersRepository (create/list/checkout/markPaid)`

---

### Task 5: AdOrdersService (createCheckout + schedulePost via SP2)

**Files:** Create `apps/automation/src/payments/ad-orders.service.ts` + `...test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdOrdersService } from './ad-orders.service';

function harness(order: any) {
  const calls: any[] = [];
  const repo = {
    findById: async () => order,
    setCheckout: async (id: string) => { calls.push(['setCheckout', id]); },
    attachAction: async (id: string, aid: string) => { calls.push(['attach', id, aid]); },
  } as any;
  const liqpay = { buildCheckout: (o: any) => { calls.push(['build', o]); return { data: 'D', signature: 'S', actionUrl: 'U' }; } } as any;
  const actions = { create: async (a: any) => { calls.push(['action', a]); return { id: 'act1' }; } } as any;
  return { svc: new AdOrdersService(repo, liqpay, actions), calls };
}

test('createCheckout sets liqpay_order_id=id and returns signed params', async () => {
  const { svc, calls } = harness({ id: 'o1', amount: '500.00', currency: 'UAH', description: 'Ad', status: 'draft' });
  const r = await svc.createCheckout('o1');
  assert.equal(r.data, 'D');
  assert.ok(calls.some(c => c[0] === 'setCheckout' && c[1] === 'o1'));
  const build = calls.find(c => c[0] === 'build');
  assert.equal(build[1].orderId, 'o1');
});

test('schedulePost creates a schedule_post action only when paid + attaches it', async () => {
  const { svc, calls } = harness({ id: 'o1', status: 'paid' });
  const r = await svc.schedulePost('o1', { channelId: 'c1', text: 'Ad post', scheduledAt: '2030-01-01T00:00:00Z' });
  assert.equal(r.actionId, 'act1');
  const action = calls.find(c => c[0] === 'action');
  assert.equal(action[1].type, 'schedule_post');
  assert.equal(action[1].payload.channelId, 'c1');
  assert.ok(calls.some(c => c[0] === 'attach' && c[2] === 'act1'));
});

test('schedulePost refuses when the order is not paid', async () => {
  const { svc } = harness({ id: 'o1', status: 'awaiting_payment' });
  await assert.rejects(() => svc.schedulePost('o1', { channelId: 'c1', text: 'x', scheduledAt: '2030-01-01T00:00:00Z' }), /not paid/i);
});
```
- [ ] **Step 2: Run → FAIL. Step 3: Implement**
```ts
import { Injectable } from '@nestjs/common';
import { AdOrdersRepository } from './ad-orders.repository';
import { LiqpayService } from './liqpay.service';
import { AgentActionsRepository } from '../agent/agent-actions.repository';

@Injectable()
export class AdOrdersService {
  constructor(
    private readonly repo:    AdOrdersRepository,
    private readonly liqpay:  LiqpayService,
    private readonly actions: AgentActionsRepository,
  ) {}

  async createCheckout(id: string): Promise<{ data: string; signature: string; actionUrl: string }> {
    const o = await this.repo.findById(id);
    if (!o) throw new Error('order not found');
    await this.repo.setCheckout(id);
    return this.liqpay.buildCheckout({ orderId: id, amount: String(o.amount), currency: o.currency, description: o.description ?? `Ad order ${id}` });
  }

  async schedulePost(id: string, input: { channelId: string; text: string; scheduledAt: string }): Promise<{ actionId: string }> {
    const o = await this.repo.findById(id);
    if (!o) throw new Error('order not found');
    if (o.status !== 'paid') throw new Error('order is not paid');
    const action = await this.actions.create({ type: 'schedule_post', payload: { text: input.text, channelId: input.channelId, scheduledAt: input.scheduledAt } });
    await this.repo.attachAction(id, action.id);
    return { actionId: action.id };
  }
}
```
- [ ] **Step 4: Run → PASS (3). Step 5: Commit** `feat(payments): AdOrdersService (checkout + paid→SP2 schedule action)`

---

### Task 6: AdOrdersController (guarded)

**Files:** Create `apps/automation/src/payments/ad-orders.controller.ts` + `dto/create-order.dto.ts` + `dto/schedule-order.dto.ts` + `ad-orders.controller.test.ts`

- [ ] **Step 1: Write the failing test** (construct controller directly, stub repo + service)
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdOrdersController } from './ad-orders.controller';

function make() {
  const calls: any[] = [];
  const repo = { list: async (s: any) => { calls.push(['list', s]); return [{ id: 'o1' }]; },
                 create: async (i: any) => { calls.push(['create', i]); return { id: 'o1' }; } } as any;
  const svc = { createCheckout: async (id: string) => { calls.push(['checkout', id]); return { data: 'D', signature: 'S', actionUrl: 'U' }; },
                schedulePost: async (id: string, i: any) => { calls.push(['schedule', id, i]); return { actionId: 'a1' }; } } as any;
  return { ctrl: new AdOrdersController(repo, svc), calls };
}

test('GET lists orders by status', async () => {
  const { ctrl, calls } = make();
  const r = await ctrl.list('paid');
  assert.deepEqual(calls[0], ['list', 'paid']);
  assert.equal(r.length, 1);
});
test('POST create passes the dto through', async () => {
  const { ctrl, calls } = make();
  await ctrl.create({ advertiser: 'Acme', amount: '500.00', currency: 'UAH' } as any);
  assert.equal(calls[0][0], 'create');
});
test('POST checkout returns signed params', async () => {
  const { ctrl } = make();
  const r = await ctrl.checkout('o1');
  assert.equal(r.data, 'D');
});
test('POST schedule calls service', async () => {
  const { ctrl, calls } = make();
  const r = await ctrl.schedule('o1', { channelId: 'c1', text: 'x', scheduledAt: '2030-01-01T00:00:00Z' } as any);
  assert.equal(r.actionId, 'a1');
});
```
- [ ] **Step 2: Run → FAIL. Step 3: Implement** DTOs + controller:

`dto/create-order.dto.ts`:
```ts
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
export class CreateOrderDto {
  @IsString() @MaxLength(200) advertiser!: string;
  @IsOptional() @IsString() channelId?: string;
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'amount must be a decimal string' }) amount!: string;
  @IsString() @MaxLength(8) currency!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}
```
`dto/schedule-order.dto.ts`:
```ts
import { IsString } from 'class-validator';
export class ScheduleOrderDto {
  @IsString() channelId!: string;
  @IsString() text!: string;
  @IsString() scheduledAt!: string; // ISO
}
```
`ad-orders.controller.ts`:
```ts
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { AdOrdersRepository } from './ad-orders.repository';
import { AdOrdersService } from './ad-orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ScheduleOrderDto } from './dto/schedule-order.dto';
import type { AdOrderStatus } from './ad-orders.types';

@Controller('api/ad-orders')
@UseGuards(TrackingAuthGuard)
export class AdOrdersController {
  constructor(private readonly repo: AdOrdersRepository, private readonly svc: AdOrdersService) {}

  @Get() list(@Query('status') status?: AdOrderStatus) { return this.repo.list(status); }
  @Post() create(@Body() dto: CreateOrderDto) {
    return this.repo.create({ advertiser: dto.advertiser, channelId: dto.channelId ?? null, amount: dto.amount, currency: dto.currency, description: dto.description ?? null });
  }
  @Post(':id/checkout') checkout(@Param('id') id: string) { return this.svc.createCheckout(id); }
  @Post(':id/schedule') schedule(@Param('id') id: string, @Body() dto: ScheduleOrderDto) { return this.svc.schedulePost(id, dto); }
}
```
- [ ] **Step 4: Run → PASS (4). Step 5: Commit** `feat(payments): guarded ad-orders REST API`

---

### Task 7: LiqpayCallbackController (public, signature-gated)

**Files:** Create `apps/automation/src/payments/liqpay-callback.controller.ts` + `...test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiqpayCallbackController } from './liqpay-callback.controller';

function make(verifyResult: any) {
  const calls: any[] = [];
  const liqpay = { verifyCallback: (d: string, s: string) => { calls.push(['verify', d, s]); return verifyResult; } } as any;
  const repo = { markPaid: async (oid: string) => { calls.push(['markPaid', oid]); } } as any;
  return { ctrl: new LiqpayCallbackController(liqpay, repo), calls };
}

test('valid success callback marks the order paid', async () => {
  const { ctrl, calls } = make({ valid: true, status: 'success', orderId: 'o1' });
  const r = await ctrl.callback({ data: 'D', signature: 'S' });
  assert.deepEqual(r, { ok: true });
  assert.ok(calls.some(c => c[0] === 'markPaid' && c[1] === 'o1'));
});

test('invalid signature does NOT mark paid and reports 400', async () => {
  const { ctrl, calls } = make({ valid: false });
  await assert.rejects(() => ctrl.callback({ data: 'D', signature: 'bad' }), /invalid/i);
  assert.ok(!calls.some(c => c[0] === 'markPaid'));
});

test('valid but non-success status does not mark paid', async () => {
  const { ctrl, calls } = make({ valid: true, status: 'failure', orderId: 'o1' });
  const r = await ctrl.callback({ data: 'D', signature: 'S' });
  assert.deepEqual(r, { ok: true });
  assert.ok(!calls.some(c => c[0] === 'markPaid'));
});
```
- [ ] **Step 2: Run → FAIL. Step 3: Implement**
```ts
import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { LiqpayService } from './liqpay.service';
import { AdOrdersRepository } from './ad-orders.repository';

const PAID_STATUSES = new Set(['success', 'sandbox', 'wait_accept']);

@Controller('api/payments/liqpay')
export class LiqpayCallbackController {
  constructor(private readonly liqpay: LiqpayService, private readonly repo: AdOrdersRepository) {}

  // Public endpoint — authenticated by LiqPay signature, NOT by the auth guard.
  @Post('callback')
  async callback(@Body() body: { data?: string; signature?: string }) {
    const res = this.liqpay.verifyCallback(body?.data ?? '', body?.signature ?? '');
    if (!res.valid) throw new BadRequestException('invalid signature');
    if (res.orderId && res.status && PAID_STATUSES.has(res.status)) {
      await this.repo.markPaid(res.orderId);
    }
    return { ok: true };
  }
}
```
- [ ] **Step 4: Run → PASS (3). Step 5: Commit** `feat(payments): public signature-gated LiqPay callback`

---

### Task 8: PaymentsModule wiring + env

**Files:** Create `apps/automation/src/payments/payments.module.ts`; modify `apps/automation/src/app.module.ts`, `.env.example`

- [ ] **Step 1: Module**
```ts
import { Module } from '@nestjs/common';
import { LiqpayService } from './liqpay.service';
import { AdOrdersRepository } from './ad-orders.repository';
import { AdOrdersService } from './ad-orders.service';
import { AdOrdersController } from './ad-orders.controller';
import { LiqpayCallbackController } from './liqpay-callback.controller';

// DB_POOL + ConfigService are global; AgentActionsRepository is provided by
// AgentModule. VERIFY AgentModule exports AgentActionsRepository — if not, add it
// to AgentModule.exports (additive) so AdOrdersService can inject it.
@Module({
  controllers: [AdOrdersController, LiqpayCallbackController],
  providers:   [LiqpayService, AdOrdersRepository, AdOrdersService],
})
export class PaymentsModule {}
```
- [ ] **Step 2:** In `agent.module.ts`, ensure `AgentActionsRepository` is in `exports` (add if missing). In `app.module.ts`, import `PaymentsModule` and add it to `imports` (after `AgentModule`). Read both modules first.
- [ ] **Step 3:** `.env.example` — new "Payments (LiqPay)" section:
```bash
# ─── Payments (LiqPay hosted checkout; ad placements) ────────────────────────
# Merchant keys from the LiqPay dashboard. PRIVATE key is a secret — never commit
# a real value. The webhook posts to ${DASHBOARD_URL}/api/payments/liqpay/callback
# and is authenticated by LiqPay's signature (not our auth guard).
LIQPAY_PUBLIC_KEY=
LIQPAY_PRIVATE_KEY=
AD_ORDER_CURRENCY=UAH
```
- [ ] **Step 4:** `cd apps/automation && npm run build && npm test` — green. **Step 5: Commit** `feat(payments): wire PaymentsModule + LiqPay env`

---

### Task 9: Dashboard API client (ads)

**Files:** Create `apps/dashboard/src/api/ads.ts`; modify `api/types.ts`

- [ ] **Step 1:** Add `AdOrderStatus` + `AdOrder` types (mirror the row, amount as string).
- [ ] **Step 2:** Hooks (match the SP1/SP2 `api<T>` fetch-helper style): `useAdOrders(status?)`, `useCreateAdOrder()`, `useAdOrderCheckout()` (POST `:id/checkout` → `{data,signature,actionUrl}`), `useScheduleAdOrder()`. Invalidate `['ads']`.
- [ ] **Step 3:** `pnpm --filter dashboard build` clean. **Step 4: Commit** `feat(payments): dashboard API client for ad orders`

---

### Task 10: Dashboard /app/ads page + nav

**Files:** Create `apps/dashboard/src/routes/app.ads.tsx`; modify `components/AppSidebar.tsx`

- [ ] **Step 1:** Page (follow `app.scheduled.tsx` card-row + form patterns):
  - Create-order form (advertiser, channel, amount, description) → `useCreateAdOrder`.
  - Orders list (card-rows): advertiser, amount+currency, status Badge (`paid`=success, `scheduled`=accent, `awaiting_payment`/`draft`=neutral, `canceled`=warning).
  - Per row: "Get payment link" → `useAdOrderCheckout` → build the LiqPay URL `${actionUrl}?data=${data}&signature=${signature}` and show a copyable field (owner sends it to the advertiser). On `paid`: a "Schedule post" form (channel + text + datetime) → `useScheduleAdOrder`.
- [ ] **Step 2:** Sidebar nav item "Ads" (icon `connections` or `calendar`, route `/app/ads`), near Agent.
- [ ] **Step 3:** `pnpm --filter dashboard build` clean. **Step 4: Commit** `feat(payments): /app/ads page + nav`

---

### Task 11: Full verification

- [ ] **Step 1:** `cd apps/automation && npm run build && npm test` green incl. all `src/payments/*.test.ts`.
- [ ] **Step 2:** Dashboard `pnpm --filter dashboard build` clean.
- [ ] **Step 3: Secret-safety grep** — `grep -rn "LIQPAY_PRIVATE_KEY" apps/automation/src/` should appear ONLY in `liqpay.service.ts` (read via ConfigService); confirm it is never passed to a logger or returned in a controller response.
- [ ] **Step 4: Signature-gate proof** — the callback test proves an invalid signature can't mark an order paid.
- [ ] **Step 5:** Feature complete; merge only on the owner's explicit go-ahead.

## Notes for the implementer
- NEVER accept/handle card data — LiqPay's hosted page does. We only build signed checkout params + verify callbacks.
- `amount` flows from the server-side order row into the checkout — never trust a client-sent amount.
- The callback endpoint is the ONLY public (unguarded) route; it is signature-gated and idempotent.
- Scheduling a paid order still goes through the SP2 action (owner-approved) — payment never auto-publishes.
