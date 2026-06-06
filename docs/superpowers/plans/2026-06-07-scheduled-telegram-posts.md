# Scheduled Telegram Posts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator compose a Telegram post (rich text + media-by-URL + inline buttons), schedule it, and have a background poller publish it at the chosen time — bypassing strategy cooldown but respecting the per-channel Pause switch.

**Architecture:** A `scheduled_publications` DB row is created by a composer modal; a 30s `@nestjs/schedule` cron claims due rows and publishes them through a new `TelegramComposedSender` (bot via Bot API, or MTProto-user via the existing gramjs client). A «Заплановані» list manages pending posts.

**Tech Stack:** NestJS 10 + `pg` (raw SQL, `DB_POOL` token), gramjs (MTProto), React 19 + TanStack Router/Query, Tailwind v4. Backend pure-function tests use `node:test`; NestJS wiring verified by `tsc` + manual smoke (repo convention — no jest).

**Spec:** `docs/superpowers/specs/2026-06-07-scheduled-telegram-posts-design.md`

---

## File structure

**Backend (new module `apps/automation/src/scheduled-posts/`):**
- `post-validation.ts` — pure functions: `visibleLength`, `captionLimitFor`, `validateComposedPost`. (unit-tested)
- `post-validation.test.ts` — node:test for the above.
- `scheduled-posts.types.ts` — shared TS types (`Sender`, `MediaType`, `Placement`, `ButtonRow`, `ScheduledPost`).
- `scheduled-posts.repository.ts` — raw-SQL CRUD + `claimDue`.
- `scheduled-posts.service.ts` — create/list/get/update/cancel/`publishDue`.
- `scheduled-posts.worker.ts` — `@Cron` poller.
- `scheduled-posts.controller.ts` + `dto/*.ts` — HTTP API.
- `scheduled-posts.module.ts` — wiring; imported by `app.module.ts`.

**Backend (publisher extension):**
- `apps/automation/src/publishers/composed-sender.service.ts` — low-level Telegram send (bot + mtproto-user), no cooldown.
- `apps/automation/src/stats/telegram-stats.client.ts` — add `sendMessage` + `sendVideoWithCaption`.

**DB:** `database/migrations/014_scheduled_publications.sql`.

**Frontend:**
- `apps/dashboard/src/api/scheduled-posts.ts` + types in `api/types.ts`.
- `apps/dashboard/src/components/post/TelegramPreview.tsx` — preview bubble.
- `apps/dashboard/src/components/post/NewPostModal.tsx` — composer.
- `apps/dashboard/src/routes/scheduled.tsx` — «Заплановані» list.
- Wire button in `components/AppShell.tsx`; nav in `components/AppSidebar.tsx`.

---

## Task 1: DB migration

**Files:**
- Create: `database/migrations/014_scheduled_publications.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 014_scheduled_publications.sql — operator-composed one-off scheduled posts.
CREATE TABLE IF NOT EXISTS scheduled_publications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  sender          TEXT NOT NULL CHECK (sender IN ('bot','mtproto_user')),
  bot_id          UUID REFERENCES my_bots(id),
  text            TEXT NOT NULL DEFAULT '',
  media_type      TEXT NOT NULL DEFAULT 'none' CHECK (media_type IN ('none','photo','video')),
  media_url       TEXT,
  media_placement TEXT NOT NULL DEFAULT 'above' CHECK (media_placement IN ('above','below')),
  buttons         JSONB NOT NULL DEFAULT '[]',
  scheduled_at    TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','canceled')),
  message_id      BIGINT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sched_pub_due     ON scheduled_publications (scheduled_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sched_pub_channel ON scheduled_publications (channel_id);

INSERT INTO schema_migrations (version) VALUES ('014_scheduled_publications')
  ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: Apply locally**

Run: `bash database/migrate.sh`
Expected: `apply 014_scheduled_publications` then `migrate: done`.

- [ ] **Step 3: Verify table**

Run: `docker exec -i ai0_global-postgres-1 psql -U ai0 -d ai0global -c "\d scheduled_publications"`
Expected: table with the 14 columns above.

- [ ] **Step 4: Commit**

```bash
git add database/migrations/014_scheduled_publications.sql
git commit -m "feat(sched): migration 014 scheduled_publications"
```

---

## Task 2: Pure validation logic (TDD)

**Files:**
- Create: `apps/automation/src/scheduled-posts/scheduled-posts.types.ts`
- Create: `apps/automation/src/scheduled-posts/post-validation.ts`
- Test: `apps/automation/src/scheduled-posts/post-validation.test.ts`

- [ ] **Step 1: Write the shared types**

```ts
// scheduled-posts.types.ts
export type Sender    = 'bot' | 'mtproto_user';
export type MediaType = 'none' | 'photo' | 'video';
export type Placement = 'above' | 'below';
export interface ButtonRow { buttons: { label: string; url: string }[]; }

export interface ComposedPost {
  channelId:      string;
  sender:         Sender;
  botId:          string | null;
  text:           string;        // Telegram HTML
  mediaType:      MediaType;
  mediaUrl:       string | null;
  mediaPlacement: Placement;
  buttons:        ButtonRow[];
  scheduledAt:    string;        // ISO
}

export interface ScheduledPost extends ComposedPost {
  id:        string;
  status:    'pending' | 'sent' | 'failed' | 'canceled';
  messageId: number | null;
  error:     string | null;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// post-validation.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleLength, captionLimitFor, validateComposedPost } from './post-validation';
import type { ComposedPost } from './scheduled-posts.types';

const base: ComposedPost = {
  channelId: 'c1', sender: 'bot', botId: 'b1', text: 'hi',
  mediaType: 'none', mediaUrl: null, mediaPlacement: 'above',
  buttons: [], scheduledAt: '2099-01-01T00:00:00.000Z',
};

test('visibleLength strips HTML tags', () => {
  assert.equal(visibleLength('<b>ab</b><a href="x">cd</a>'), 4);
});

test('captionLimitFor: bot photo=1024, mtproto photo=2048, text=4096', () => {
  assert.equal(captionLimitFor('bot', 'photo'), 1024);
  assert.equal(captionLimitFor('mtproto_user', 'photo'), 2048);
  assert.equal(captionLimitFor('bot', 'none'), 4096);
});

test('buttons force bot: mtproto_user + buttons → error', () => {
  const r = validateComposedPost({ ...base, sender: 'mtproto_user',
    buttons: [{ buttons: [{ label: 'x', url: 'https://a' }] }] });
  assert.ok(r.errors.some(e => e.includes('buttons')));
});

test('bot photo caption >1024 above → error (needs mtproto_user)', () => {
  const r = validateComposedPost({ ...base, mediaType: 'photo', mediaUrl: 'https://i',
    mediaPlacement: 'above', text: 'x'.repeat(1025) });
  assert.ok(r.errors.some(e => e.includes('1024')));
});

test('valid bot text post passes', () => {
  assert.deepEqual(validateComposedPost(base).errors, []);
});

test('photo requires mediaUrl', () => {
  const r = validateComposedPost({ ...base, mediaType: 'photo', mediaUrl: null });
  assert.ok(r.errors.some(e => e.includes('media URL')));
});

test('button url must be http(s)', () => {
  const r = validateComposedPost({ ...base, buttons: [{ buttons: [{ label: 'x', url: 'ftp://a' }] }] });
  assert.ok(r.errors.some(e => e.includes('url')));
});
```

- [ ] **Step 3: Run it — verify it fails**

Run: `cd apps/automation && node --import tsx --test src/scheduled-posts/post-validation.test.ts`
Expected: FAIL — `Cannot find module './post-validation'`.

- [ ] **Step 4: Implement `post-validation.ts`**

```ts
// post-validation.ts — pure, dependency-free; safe to unit-test.
import type { ComposedPost, Sender, MediaType } from './scheduled-posts.types';

/** Visible length = text with HTML tags stripped (matches Telegram caption counting). */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, '').length;
}

/** Telegram length ceiling for the active (sender, media) combination. */
export function captionLimitFor(sender: Sender, mediaType: MediaType): number {
  if (mediaType === 'none') return 4096;          // text message
  return sender === 'mtproto_user' ? 2048 : 1024; // premium caption vs bot caption
}

const hasButtons = (p: ComposedPost) => p.buttons.some(r => r.buttons.length > 0);

/** Returns `{ errors }`; empty array = valid. Encodes the spec's hard guardrails. */
export function validateComposedPost(p: ComposedPost): { errors: string[] } {
  const errors: string[] = [];

  if (!p.channelId) errors.push('channel is required');
  if (!p.scheduledAt || Number.isNaN(Date.parse(p.scheduledAt))) errors.push('valid scheduled time is required');

  const buttons = hasButtons(p);
  const len = visibleLength(p.text);

  if ((p.mediaType === 'photo' || p.mediaType === 'video')) {
    if (!p.mediaUrl || !/^https?:\/\//i.test(p.mediaUrl)) errors.push('media URL must be http(s)');
  }
  if (p.mediaType === 'none' && len === 0 && !buttons) errors.push('post is empty');

  if (buttons) {
    if (p.sender !== 'bot') errors.push('inline buttons require the bot sender (MTProto-user cannot send buttons)');
    for (const row of p.buttons) for (const b of row.buttons) {
      if (!b.label?.trim()) errors.push('button label is required');
      if (!/^https?:\/\//i.test(b.url ?? '')) errors.push('button url must be http(s)');
    }
  }
  if (p.sender === 'bot') {
    if (p.botId == null) errors.push('bot must be selected for the bot sender');
  }

  const limit = captionLimitFor(p.sender, p.mediaType);
  if (len > limit) {
    if (p.mediaType !== 'none' && p.mediaPlacement === 'above' && p.sender === 'bot' && len <= 2048 && !buttons) {
      errors.push(`caption ${len} > 1024 with a photo/video needs the MTProto-user sender`);
    } else {
      errors.push(`text ${len} exceeds the ${limit}-char limit for this sender/media`);
    }
  }
  return { errors };
}
```

- [ ] **Step 5: Run tests — verify pass**

Run: `cd apps/automation && node --import tsx --test src/scheduled-posts/post-validation.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/automation/src/scheduled-posts/scheduled-posts.types.ts apps/automation/src/scheduled-posts/post-validation.ts apps/automation/src/scheduled-posts/post-validation.test.ts
git commit -m "feat(sched): post types + validation guardrails (tested)"
```

---

## Task 3: Repository

**Files:**
- Create: `apps/automation/src/scheduled-posts/scheduled-posts.repository.ts`

- [ ] **Step 1: Write the repository** (raw SQL, `DB_POOL` pattern from `tracked-channels.repository.ts`)

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.tokens';
import type { ComposedPost, ScheduledPost } from './scheduled-posts.types';

function toEntity(r: any): ScheduledPost {
  return {
    id: r.id, channelId: r.channel_id, sender: r.sender, botId: r.bot_id,
    text: r.text, mediaType: r.media_type, mediaUrl: r.media_url,
    mediaPlacement: r.media_placement, buttons: r.buttons ?? [],
    scheduledAt: r.scheduled_at.toISOString(),
    status: r.status, messageId: r.message_id != null ? Number(r.message_id) : null,
    error: r.error, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

@Injectable()
export class ScheduledPostsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async create(p: ComposedPost): Promise<ScheduledPost> {
    const { rows } = await this.pool.query(
      `INSERT INTO scheduled_publications
         (channel_id, sender, bot_id, text, media_type, media_url, media_placement, buttons, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
      [p.channelId, p.sender, p.botId, p.text, p.mediaType, p.mediaUrl,
       p.mediaPlacement, JSON.stringify(p.buttons), p.scheduledAt],
    );
    return toEntity(rows[0]);
  }

  async list(status?: string): Promise<ScheduledPost[]> {
    const { rows } = status
      ? await this.pool.query('SELECT * FROM scheduled_publications WHERE status=$1 ORDER BY scheduled_at DESC', [status])
      : await this.pool.query('SELECT * FROM scheduled_publications ORDER BY scheduled_at DESC');
    return rows.map(toEntity);
  }

  async getById(id: string): Promise<ScheduledPost | null> {
    const { rows } = await this.pool.query('SELECT * FROM scheduled_publications WHERE id=$1', [id]);
    return rows[0] ? toEntity(rows[0]) : null;
  }

  async update(id: string, p: ComposedPost): Promise<ScheduledPost | null> {
    const { rows } = await this.pool.query(
      `UPDATE scheduled_publications SET
         channel_id=$2, sender=$3, bot_id=$4, text=$5, media_type=$6, media_url=$7,
         media_placement=$8, buttons=$9::jsonb, scheduled_at=$10, updated_at=now()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [id, p.channelId, p.sender, p.botId, p.text, p.mediaType, p.mediaUrl,
       p.mediaPlacement, JSON.stringify(p.buttons), p.scheduledAt],
    );
    return rows[0] ? toEntity(rows[0]) : null;
  }

  async cancel(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE scheduled_publications SET status='canceled', updated_at=now()
       WHERE id=$1 AND status='pending'`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /** Atomically claim one due pending post (prevents double-send across ticks). */
  async claimDue(now: Date): Promise<ScheduledPost | null> {
    const { rows } = await this.pool.query(
      `UPDATE scheduled_publications SET status='sending', updated_at=now()
       WHERE id = (
         SELECT id FROM scheduled_publications
         WHERE status='pending' AND scheduled_at <= $1
         ORDER BY scheduled_at ASC FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`, [now]);
    return rows[0] ? toEntity(rows[0]) : null;
  }

  async markSent(id: string, messageId: number): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_publications SET status='sent', message_id=$2, error=NULL, updated_at=now() WHERE id=$1`,
      [id, messageId]);
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_publications SET status='failed', error=$2, updated_at=now() WHERE id=$1`,
      [id, error.slice(0, 500)]);
  }
}
```

- [ ] **Step 2: Add `'sending'` to the status CHECK** — update Task 1's migration file AND the running DB. Edit `database/migrations/014_scheduled_publications.sql`: change the status CHECK to `IN ('pending','sending','sent','failed','canceled')`. Then apply the column change to the live DB:

Run:
```bash
docker exec -i ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
"ALTER TABLE scheduled_publications DROP CONSTRAINT scheduled_publications_status_check,
 ADD CONSTRAINT scheduled_publications_status_check CHECK (status IN ('pending','sending','sent','failed','canceled'));"
```
Expected: `ALTER TABLE`.

- [ ] **Step 3: tsc**

Run: `cd apps/automation && npx tsc --noEmit`
Expected: no errors (the repo file compiles; `ScheduledPost.status` type also needs `'sending'` — update `scheduled-posts.types.ts` `status` union to include `'sending'`).

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/scheduled-posts/scheduled-posts.repository.ts apps/automation/src/scheduled-posts/scheduled-posts.types.ts database/migrations/014_scheduled_publications.sql
git commit -m "feat(sched): repository + claimDue (skip-locked)"
```

---

## Task 4: MTProto-user send methods

**Files:**
- Modify: `apps/automation/src/stats/telegram-stats.client.ts` (add two methods next to `sendPhotoWithCaption`)

- [ ] **Step 1: Add `sendMessage` and `sendVideoWithCaption`**

Insert after the existing `sendPhotoWithCaption(...)` method:

```ts
  /** Send a plain text (HTML) message as the user account. Returns message id. */
  async sendMessage(channelId: string, html: string): Promise<number> {
    if (!this.client || !this.ready) throw new Error('TelegramStatsClient not connected');
    const entity = await this.client.getEntity(channelId);
    const sent: any = await this.client.sendMessage(entity as any, { message: html, parseMode: 'html' });
    const id = sent?.id;
    if (typeof id !== 'number') throw new Error('sendMessage did not return numeric message id');
    return id;
  }

  /** Send a video (from a URL) with an HTML caption as the user account. */
  async sendVideoWithCaption(channelId: string, videoUrl: string, caption: string): Promise<number> {
    if (!this.client || !this.ready) throw new Error('TelegramStatsClient not connected');
    const entity = await this.client.getEntity(channelId);
    const sent: any = await this.client.sendFile(entity as any, {
      file: videoUrl, caption, parseMode: 'html', forceDocument: false, silent: false,
    });
    const id = Array.isArray(sent) ? sent[0]?.id : sent?.id;
    if (typeof id !== 'number') throw new Error('sendVideoWithCaption did not return numeric message id');
    return id;
  }
```

- [ ] **Step 2: tsc**

Run: `cd apps/automation && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/stats/telegram-stats.client.ts
git commit -m "feat(sched): MTProto-user sendMessage + sendVideoWithCaption"
```

---

## Task 5: Composed sender (bot + mtproto, no cooldown)

**Files:**
- Create: `apps/automation/src/publishers/composed-sender.service.ts`
- Modify: `apps/automation/src/publishers/publishers.module.ts` (add provider + export)

- [ ] **Step 1: Write `ComposedSenderService`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { TelegramStatsClient } from '../stats/telegram-stats.client';
import type { ButtonRow, MediaType, Placement, Sender } from '../scheduled-posts/scheduled-posts.types';

export interface ComposedSend {
  chatId:    string;
  botToken:  string | null;   // required for sender='bot'
  sender:    Sender;
  text:      string;
  mediaType: MediaType;
  mediaUrl:  string | null;
  placement: Placement;
  buttons:   ButtonRow[];
}

@Injectable()
export class ComposedSenderService {
  private readonly logger = new Logger(ComposedSenderService.name);
  constructor(private readonly userClient: TelegramStatsClient) {}

  /** Publish a composed post. Does NOT touch cooldown/throttle. Returns message id. */
  async send(i: ComposedSend): Promise<number> {
    return i.sender === 'mtproto_user' ? this.sendViaUser(i) : this.sendViaBot(i);
  }

  // ── Bot API ────────────────────────────────────────────────────────────────
  private async sendViaBot(i: ComposedSend): Promise<number> {
    if (!i.botToken) throw new Error('bot token missing for composed bot send');
    const base = `https://api.telegram.org/bot${i.botToken}`;
    const replyMarkup = this.botReplyMarkup(i.buttons);

    // Native media + caption (media ABOVE text). Caption ≤1024 enforced upstream.
    if (i.mediaType !== 'none' && i.placement === 'above') {
      const method = i.mediaType === 'photo' ? 'sendPhoto' : 'sendVideo';
      const field  = i.mediaType === 'photo' ? 'photo' : 'video';
      const { data } = await axios.post(`${base}/${method}`, {
        chat_id: i.chatId, [field]: i.mediaUrl, caption: i.text, parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      return this.botMessageId(data);
    }

    // Text message; media (if any) rendered as a link-preview ABOVE/BELOW text.
    const linkPreview = i.mediaType !== 'none' && i.mediaUrl
      ? { url: i.mediaUrl, show_above_text: i.placement === 'above', prefer_large_media: true }
      : { is_disabled: true };
    const { data } = await axios.post(`${base}/sendMessage`, {
      chat_id: i.chatId, text: i.text, parse_mode: 'HTML',
      link_preview_options: linkPreview,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return this.botMessageId(data);
  }

  private botReplyMarkup(rows: ButtonRow[]): { inline_keyboard: { text: string; url: string }[][] } | null {
    const kb = rows.map(r => r.buttons.map(b => ({ text: b.label, url: b.url }))).filter(r => r.length);
    return kb.length ? { inline_keyboard: kb } : null;
  }

  private botMessageId(data: any): number {
    if (!data?.ok) throw new Error(`Telegram API: ${data?.description ?? 'unknown error'}`);
    return data.result.message_id as number;
  }

  // ── MTProto user ─────────────────────────────────────────────────────────────
  private async sendViaUser(i: ComposedSend): Promise<number> {
    if (!this.userClient.isEnabled()) throw new Error('MTProto-user session not configured/ready');
    if (i.mediaType === 'photo' && i.mediaUrl) {
      // gramjs sendFile accepts a URL string for photo/video alike.
      return this.userClient.sendVideoWithCaption(i.chatId, i.mediaUrl, i.text); // sendFile handles photo URLs too
    }
    if (i.mediaType === 'video' && i.mediaUrl) {
      return this.userClient.sendVideoWithCaption(i.chatId, i.mediaUrl, i.text);
    }
    return this.userClient.sendMessage(i.chatId, i.text);
  }
}
```

> Note: `sendPhotoWithCaption` in the stats client takes a `Buffer`; for URL photos via the user account we reuse `sendVideoWithCaption` (gramjs `sendFile` accepts a URL for both). Keeping one URL-based path avoids fetching the image server-side.

- [ ] **Step 2: Register in `publishers.module.ts`**

Add `ComposedSenderService` to the module's `providers` and `exports`. (Open the file, add the import and both array entries.)

- [ ] **Step 3: tsc**

Run: `cd apps/automation && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/publishers/composed-sender.service.ts apps/automation/src/publishers/publishers.module.ts
git commit -m "feat(sched): ComposedSenderService (bot + mtproto, no cooldown)"
```

---

## Task 6: Service (create/list/edit/cancel/publishDue)

**Files:**
- Create: `apps/automation/src/scheduled-posts/scheduled-posts.service.ts`

- [ ] **Step 1: Write the service**

```ts
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduledPostsRepository } from './scheduled-posts.repository';
import { validateComposedPost } from './post-validation';
import type { ComposedPost, ScheduledPost } from './scheduled-posts.types';
import { ConfigCacheService } from '../config/config-cache.service';
import { ComposedSenderService } from '../publishers/composed-sender.service';

@Injectable()
export class ScheduledPostsService {
  private readonly logger = new Logger(ScheduledPostsService.name);
  constructor(
    private readonly repo:        ScheduledPostsRepository,
    private readonly configCache: ConfigCacheService,
    private readonly config:      ConfigService,
    private readonly sender:      ComposedSenderService,
  ) {}

  private validate(p: ComposedPost): void {
    const { errors } = validateComposedPost(p);
    if (errors.length) throw new BadRequestException(errors.join('; '));
    if (!this.configCache.getChannelById(p.channelId)) throw new BadRequestException('unknown channel');
    if (p.sender === 'bot' && p.botId && !this.configCache.getBotById(p.botId)) throw new BadRequestException('unknown bot');
  }

  async create(p: ComposedPost): Promise<ScheduledPost> { this.validate(p); return this.repo.create(p); }
  list(status?: string) { return this.repo.list(status); }
  async get(id: string) { const r = await this.repo.getById(id); if (!r) throw new NotFoundException(); return r; }
  async update(id: string, p: ComposedPost) { this.validate(p); const r = await this.repo.update(id, p); if (!r) throw new BadRequestException('post not found or not editable (must be pending)'); return r; }
  async cancel(id: string) { if (!(await this.repo.cancel(id))) throw new BadRequestException('post not found or not pending'); return { ok: true }; }

  /** Called by the worker: claim + publish every due post this tick. */
  async publishDue(): Promise<void> {
    const now = new Date();
    // claim loop — claimDue returns one at a time (skip-locked), null when drained.
    for (let post = await this.repo.claimDue(now); post; post = await this.repo.claimDue(now)) {
      await this.publishOne(post);
    }
  }

  private async publishOne(post: ScheduledPost): Promise<void> {
    try {
      const ch = this.configCache.getChannelById(post.channelId);
      if (!ch) throw new Error('channel no longer exists');
      if (ch.publish_paused) throw new Error('channel is paused (publish_paused)');

      const chatId = ch.tg_chat_id ?? ch.channel_key;
      if (!chatId) throw new Error('channel has no chat id / key');

      let botToken: string | null = null;
      if (post.sender === 'bot') {
        const bot = post.botId ? this.configCache.getBotById(post.botId) : null;
        if (!bot) throw new Error('bot not found');
        botToken = this.config.get<string>(bot.token_env) ?? null;
        if (!botToken) throw new Error(`bot token env ${bot.token_env} is empty`);
      }

      const messageId = await this.sender.send({
        chatId: String(chatId), botToken, sender: post.sender, text: post.text,
        mediaType: post.mediaType, mediaUrl: post.mediaUrl, placement: post.mediaPlacement,
        buttons: post.buttons,
      });
      await this.repo.markSent(post.id, messageId);
      this.logger.log(`scheduled post ${post.id} sent → msg ${messageId}`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      await this.repo.markFailed(post.id, msg);
      this.logger.warn(`scheduled post ${post.id} failed: ${msg}`);
    }
  }
}
```

- [ ] **Step 2: Confirm `ConfigCacheService` accessors exist**

Run: `grep -nE "getChannelById|getBotById" apps/automation/src/config/config-cache.service.ts`
Expected: both methods exist. If `getChannelById` is absent, add it mirroring `getBotById` (return `this.channelsById.get(id) ?? null`). Channel row fields used: `tg_chat_id`, `channel_key`, `publish_paused`, `token_env` (on bot row).

- [ ] **Step 3: tsc**

Run: `cd apps/automation && npx tsc --noEmit`
Expected: no errors. (Fix accessor/field names to match the actual `ConfigCacheService` row types if tsc complains.)

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/scheduled-posts/scheduled-posts.service.ts apps/automation/src/config/config-cache.service.ts
git commit -m "feat(sched): service — create/list/edit/cancel/publishDue"
```

---

## Task 7: Cron worker

**Files:**
- Create: `apps/automation/src/scheduled-posts/scheduled-posts.worker.ts`

- [ ] **Step 1: Write the worker**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScheduledPostsService } from './scheduled-posts.service';

@Injectable()
export class ScheduledPostsWorker {
  private readonly logger = new Logger(ScheduledPostsWorker.name);
  private running = false;
  constructor(private readonly service: ScheduledPostsService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick(): Promise<void> {
    if (this.running) return;           // never overlap ticks
    this.running = true;
    try { await this.service.publishDue(); }
    catch (e: any) { this.logger.warn(`publishDue tick error: ${e?.message ?? e}`); }
    finally { this.running = false; }
  }
}
```

- [ ] **Step 2: tsc**

Run: `cd apps/automation && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/scheduled-posts/scheduled-posts.worker.ts
git commit -m "feat(sched): 30s cron worker (non-overlapping)"
```

---

## Task 8: DTOs, controller, module wiring

**Files:**
- Create: `apps/automation/src/scheduled-posts/dto/composed-post.dto.ts`
- Create: `apps/automation/src/scheduled-posts/scheduled-posts.controller.ts`
- Create: `apps/automation/src/scheduled-posts/scheduled-posts.module.ts`
- Modify: `apps/automation/src/app.module.ts` (import the module)

- [ ] **Step 1: DTO**

```ts
import { IsArray, IsBoolean, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ButtonDto { @IsString() @MaxLength(64) label!: string; @IsString() @MaxLength(2048) url!: string; }
class ButtonRowDto { @IsArray() @ValidateNested({ each: true }) @Type(() => ButtonDto) buttons!: ButtonDto[]; }

export class ComposedPostDto {
  @IsUUID() channelId!: string;
  @IsIn(['bot','mtproto_user']) sender!: 'bot' | 'mtproto_user';
  @IsOptional() @IsUUID() botId?: string | null;
  @IsString() @MaxLength(4096) text!: string;
  @IsIn(['none','photo','video']) mediaType!: 'none' | 'photo' | 'video';
  @IsOptional() @IsString() @MaxLength(2048) mediaUrl?: string | null;
  @IsIn(['above','below']) mediaPlacement!: 'above' | 'below';
  @IsArray() @ValidateNested({ each: true }) @Type(() => ButtonRowDto) buttons!: ButtonRowDto[];
  @IsISO8601() scheduledAt!: string;
}
```

- [ ] **Step 2: Controller**

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ScheduledPostsService } from './scheduled-posts.service';
import { ComposedPostDto } from './dto/composed-post.dto';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import type { ComposedPost } from './scheduled-posts.types';

@Controller('scheduled-posts')
@UseGuards(TrackingAuthGuard)
export class ScheduledPostsController {
  constructor(private readonly service: ScheduledPostsService) {}

  @Post()                create(@Body() dto: ComposedPostDto)            { return this.service.create(dto as ComposedPost); }
  @Get()                 list(@Query('status') status?: string)         { return this.service.list(status); }
  @Get(':id')            one(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.get(id); }
  @Patch(':id')          update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ComposedPostDto) { return this.service.update(id, dto as ComposedPost); }
  @Post(':id/cancel')    cancel(@Param('id', new ParseUUIDPipe()) id: string) { return this.service.cancel(id); }
}
```

- [ ] **Step 3: Module**

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ConfigCacheModule } from '../config/config-cache.module'; // adjust to actual config module name
import { PublishersModule } from '../publishers/publishers.module';
import { ScheduledPostsController } from './scheduled-posts.controller';
import { ScheduledPostsService } from './scheduled-posts.service';
import { ScheduledPostsRepository } from './scheduled-posts.repository';
import { ScheduledPostsWorker } from './scheduled-posts.worker';

@Module({
  imports: [ConfigModule, DatabaseModule, AuthModule, ConfigCacheModule, PublishersModule],
  controllers: [ScheduledPostsController],
  providers: [ScheduledPostsRepository, ScheduledPostsService, ScheduledPostsWorker],
})
export class ScheduledPostsModule {}
```

- [ ] **Step 4: Resolve real module names** — verify the imports above match actual exports:

Run: `grep -rnE "export class (ConfigCache|Publishers|Database|Auth)Module|providers:|exports:" apps/automation/src/config apps/automation/src/publishers/publishers.module.ts apps/automation/src/database/database.module.ts apps/automation/src/auth/auth.module.ts | head -30`
Expected: confirm which module exports `ConfigCacheService`, `ComposedSenderService`, `DB_POOL`, `TrackingAuthGuard`/`AuthService`. Fix the `imports:` array to import those modules. (`ComposedSenderService` must be exported by `PublishersModule`; `ConfigCacheService` by its module; `DB_POOL` by `DatabaseModule`.)

- [ ] **Step 5: Register in `app.module.ts`** — add `ScheduledPostsModule` to the `imports` array (next to `TrackingModule`).

- [ ] **Step 6: Build**

Run: `cd apps/automation && npx tsc --noEmit && npm run build`
Expected: no errors; `nest build` succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/automation/src/scheduled-posts/ apps/automation/src/app.module.ts
git commit -m "feat(sched): DTO + controller + module wiring"
```

---

## Task 9: Backend smoke (manual, cost-safe)

- [ ] **Step 1: Start automation** (user does restart per cost rule, or local `pnpm dev:automation`). Confirm boot logs show no errors and the cron registers.

- [ ] **Step 2: Create a post via API** (token-authed; replace IDs):

```bash
curl -s -X POST localhost:3000/scheduled-posts -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TRACKING_TOKEN" \
  -d '{"channelId":"<uuid>","sender":"bot","botId":"<uuid>","text":"smoke <b>test</b>","mediaType":"none","mediaPlacement":"above","buttons":[],"scheduledAt":"'"$(date -u -v+1M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+1 min' +%Y-%m-%dT%H:%M:%SZ)"'"}'
```
Expected: JSON row, `status:"pending"`.

- [ ] **Step 3: Verify guardrail rejection** — POST with `sender:"mtproto_user"` + a button → expect HTTP 400 "inline buttons require the bot sender".

- [ ] **Step 4: Wait ~1 min, confirm it published** to the test channel and the row flipped to `sent` with a `message_id`:

```bash
docker exec -i ai0_global-postgres-1 psql -U ai0 -d ai0global -c "SELECT id,status,message_id,error FROM scheduled_publications ORDER BY created_at DESC LIMIT 3;"
```

- [ ] **Step 5: Cooldown bypass check** — confirm it fired even if the channel was in strategy cooldown (no cooldown error). **Pause check** — set the channel `publish_paused=true`, schedule one, confirm it lands in `failed` with "channel is paused".

---

## Task 10: Frontend API client + types

**Files:**
- Modify: `apps/dashboard/src/api/types.ts` (append types)
- Create: `apps/dashboard/src/api/scheduled-posts.ts`

- [ ] **Step 1: Types** (append to `types.ts`)

```ts
export type SchedSender = 'bot' | 'mtproto_user';
export type SchedMedia  = 'none' | 'photo' | 'video';
export type SchedPlacement = 'above' | 'below';
export interface SchedButtonRow { buttons: { label: string; url: string }[]; }

export interface ComposedPostInput {
  channelId: string; sender: SchedSender; botId: string | null;
  text: string; mediaType: SchedMedia; mediaUrl: string | null;
  mediaPlacement: SchedPlacement; buttons: SchedButtonRow[]; scheduledAt: string;
}
export interface ScheduledPost extends ComposedPostInput {
  id: string; status: 'pending'|'sending'|'sent'|'failed'|'canceled';
  messageId: number | null; error: string | null; createdAt: string; updatedAt: string;
}
```

- [ ] **Step 2: API client**

```ts
import { api } from './client';
import type { ComposedPostInput, ScheduledPost } from './types';

export const scheduledPostsApi = {
  create: (input: ComposedPostInput) => api<ScheduledPost>('/scheduled-posts', { method: 'POST', body: JSON.stringify(input) }),
  list:   (status?: string) => api<ScheduledPost[]>(`/scheduled-posts${status ? `?status=${status}` : ''}`),
  update: (id: string, input: ComposedPostInput) => api<ScheduledPost>(`/scheduled-posts/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  cancel: (id: string) => api<{ ok: boolean }>(`/scheduled-posts/${id}/cancel`, { method: 'POST' }),
};
```

- [ ] **Step 3: tsc** — `cd apps/dashboard && npx tsc --noEmit` → no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/api/types.ts apps/dashboard/src/api/scheduled-posts.ts
git commit -m "feat(sched): dashboard API client + types"
```

---

## Task 11: Telegram preview component

**Files:**
- Create: `apps/dashboard/src/components/post/TelegramPreview.tsx`

- [ ] **Step 1: Write the preview**

```tsx
import type { ComposedPostInput } from '../../api/types';

/** Renders a Telegram-message-like bubble: media in chosen position, HTML text, button grid. */
export function TelegramPreview({ post }: { post: ComposedPostInput }) {
  const media = post.mediaType !== 'none' && post.mediaUrl ? (
    post.mediaType === 'photo'
      ? <img src={post.mediaUrl} alt="" style={{ width: '100%', borderRadius: 8, display: 'block' }} />
      : <video src={post.mediaUrl} controls style={{ width: '100%', borderRadius: 8, display: 'block' }} />
  ) : null;

  return (
    <div style={{ background: 'var(--color-surface-2)', borderRadius: 12, padding: 10, maxWidth: 360 }}>
      {post.mediaPlacement === 'above' && media}
      {/* Operator-authored Telegram HTML; rendered as-is for fidelity (trusted input). */}
      <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', margin: '8px 2px' }}
           dangerouslySetInnerHTML={{ __html: post.text || '<span style="opacity:.5">(порожньо)</span>' }} />
      {post.mediaPlacement === 'below' && media}
      {post.buttons.some(r => r.buttons.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {post.buttons.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', gap: 4 }}>
              {row.buttons.map((b, bi) => (
                <span key={bi} style={{ flex: 1, textAlign: 'center', padding: '6px 8px',
                  background: 'var(--color-surface-3)', borderRadius: 6, color: 'var(--color-accent)', fontSize: 13 }}>
                  {b.label || 'button'}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: tsc** — `cd apps/dashboard && npx tsc --noEmit`.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/post/TelegramPreview.tsx
git commit -m "feat(sched): Telegram preview bubble"
```

---

## Task 12: Composer modal + wire the «Новий пост» button

**Files:**
- Create: `apps/dashboard/src/components/post/NewPostModal.tsx`
- Modify: `apps/dashboard/src/components/AppShell.tsx` (open modal on button click)

- [ ] **Step 1: Write `NewPostModal`** — form (left) + `TelegramPreview` (right). Uses `Modal`, `useChannels`/`useBots`, `scheduledPostsApi`, and the same guardrail logic mirrored client-side (disable MTProto-user when buttons present; live char-limit). Full component:

```tsx
import { useMemo, useState, useEffect } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { Modal } from '../Modal';
import { TelegramPreview } from './TelegramPreview';
import { scheduledPostsApi } from '../../api/scheduled-posts';
import { trackingApi } from '../../api/tracking';
import { useBots } from '../../api/bots';
import type { ComposedPostInput, ScheduledPost } from '../../api/types';

const visibleLen = (html: string) => html.replace(/<[^>]+>/g, '').length;
const limitFor = (s: ComposedPostInput['sender'], m: ComposedPostInput['mediaType']) =>
  m === 'none' ? 4096 : s === 'mtproto_user' ? 2048 : 1024;

export function NewPostModal({ open, onClose, editing }:
  { open: boolean; onClose: () => void; editing?: ScheduledPost | null }) {
  const qc = useQueryClient();
  const { data: bots } = useBots();
  const channelsQ = useQuery({ queryKey: ['channels','mine',1,'',undefined],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', page: 1, pageSize: 100 }) });

  const [post, setPost] = useState<ComposedPostInput>(() => editing ?? {
    channelId: '', sender: 'bot', botId: null, text: '', mediaType: 'none',
    mediaUrl: null, mediaPlacement: 'above', buttons: [], scheduledAt: '',
  });
  useEffect(() => { if (editing) setPost(editing); }, [editing]);

  const hasButtons = post.buttons.some(r => r.buttons.length > 0);
  const len = visibleLen(post.text);
  const limit = limitFor(post.sender, post.mediaType);
  const overLimit = len > limit;
  const set = (patch: Partial<ComposedPostInput>) => setPost(p => ({ ...p, ...patch }));

  // Guardrail: buttons → force bot.
  useEffect(() => { if (hasButtons && post.sender !== 'bot') set({ sender: 'bot' }); }, [hasButtons]);

  const save = useMutation({
    mutationFn: (input: ComposedPostInput) => editing ? scheduledPostsApi.update(editing.id, input) : scheduledPostsApi.create(input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scheduled-posts'] }); onClose(); },
  });

  const errors = useMemo(() => {
    const e: string[] = [];
    if (!post.channelId) e.push('Оберіть канал');
    if (post.sender === 'bot' && !post.botId) e.push('Оберіть бота');
    if ((post.mediaType !== 'none') && !/^https?:\/\//i.test(post.mediaUrl ?? '')) e.push('Медіа-URL має бути http(s)');
    if (!post.scheduledAt) e.push('Вкажіть час');
    if (overLimit) e.push(`Текст ${len}/${limit} — перевищено ліміт`);
    if (hasButtons && post.mediaType !== 'none' && post.mediaPlacement === 'above' && len > 1024)
      e.push('Кнопки + фото з підписом >1024 неможливі в одному пості');
    return e;
  }, [post, len, limit, overLimit, hasButtons]);

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Редагувати пост' : 'Новий пост'} size="lg">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* channel */}
          <select className="input-field" value={post.channelId} onChange={e => set({ channelId: e.target.value })}>
            <option value="">— канал —</option>
            {channelsQ.data?.items.map(c => <option key={c.id} value={c.id}>{c.title ?? c.channelKey ?? c.id}</option>)}
          </select>
          {/* sender */}
          <div className="tabs-pill" style={{ width: 'fit-content' }}>
            {(['bot','mtproto_user'] as const).map(s => (
              <button key={s} type="button" disabled={hasButtons && s === 'mtproto_user'}
                onClick={() => set({ sender: s })}
                className={`tabs-pill-item${post.sender === s ? ' is-selected' : ''}`}>
                {s === 'bot' ? 'Бот' : 'MTProto-user'}
              </button>
            ))}
          </div>
          {post.sender === 'bot' && (
            <select className="input-field" value={post.botId ?? ''} onChange={e => set({ botId: e.target.value || null })}>
              <option value="">— бот —</option>
              {bots?.map(b => <option key={b.id} value={b.id}>{b.username ?? b.bot_id}</option>)}
            </select>
          )}
          {/* text */}
          <textarea className="input-field" rows={6} placeholder="Текст (Telegram HTML: <b>, <i>, <a href>)"
            value={post.text} onChange={e => set({ text: e.target.value })} />
          <div className="text-micro" style={{ color: overLimit ? 'var(--color-danger)' : 'var(--color-ink-dim)' }}>{len}/{limit}</div>
          {/* media */}
          <div style={{ display: 'flex', gap: 8 }}>
            <select className="input-field" value={post.mediaType} onChange={e => set({ mediaType: e.target.value as any })}>
              <option value="none">без медіа</option><option value="photo">фото</option><option value="video">відео</option>
            </select>
            {post.mediaType !== 'none' && (
              <>
                <input className="input-field" style={{ flex: 1 }} placeholder="media URL"
                  value={post.mediaUrl ?? ''} onChange={e => set({ mediaUrl: e.target.value })} />
                <select className="input-field" value={post.mediaPlacement} onChange={e => set({ mediaPlacement: e.target.value as any })}>
                  <option value="above">над текстом</option><option value="below">під текстом</option>
                </select>
              </>
            )}
          </div>
          {/* buttons */}
          <ButtonsEditor rows={post.buttons} onChange={buttons => set({ buttons })} />
          {/* schedule */}
          <input className="input-field" type="datetime-local"
            value={post.scheduledAt ? post.scheduledAt.slice(0,16) : ''}
            onChange={e => set({ scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : '' })} />
          {errors.length > 0 && <ul className="text-micro" style={{ color: 'var(--color-danger)', margin: 0, paddingLeft: 16 }}>{errors.map((x,i) => <li key={i}>{x}</li>)}</ul>}
          {save.error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(save.error as Error).message}</p>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn-secondary" onClick={onClose}>Скасувати</button>
            <button className="btn-primary" disabled={errors.length > 0 || save.isPending}
              onClick={() => save.mutate(post)}>{save.isPending ? 'Зберігаю…' : 'Запланувати'}</button>
          </div>
        </div>
        <div><div className="text-eyebrow" style={{ marginBottom: 8 }}>Прев'ю</div><TelegramPreview post={post} /></div>
      </div>
    </Modal>
  );
}

function ButtonsEditor({ rows, onChange }: { rows: ComposedPostInput['buttons']; onChange: (r: ComposedPostInput['buttons']) => void }) {
  const flat = rows[0]?.buttons ?? [];
  const setBtn = (i: number, patch: Partial<{ label: string; url: string }>) => {
    const next = flat.map((b, bi) => bi === i ? { ...b, ...patch } : b);
    onChange(next.length ? [{ buttons: next }] : []);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="text-eyebrow">Кнопки (url)</div>
      {flat.map((b, i) => (
        <div key={i} style={{ display: 'flex', gap: 6 }}>
          <input className="input-field" style={{ flex: 1 }} placeholder="назва" value={b.label} onChange={e => setBtn(i, { label: e.target.value })} />
          <input className="input-field" style={{ flex: 2 }} placeholder="https://…" value={b.url} onChange={e => setBtn(i, { url: e.target.value })} />
          <button className="btn-tiny" onClick={() => onChange([{ buttons: flat.filter((_, bi) => bi !== i) }].filter(r => r.buttons.length))}>✕</button>
        </div>
      ))}
      <button className="btn-tiny" style={{ width: 'fit-content' }}
        onClick={() => onChange([{ buttons: [...flat, { label: '', url: '' }] }])}>+ кнопка</button>
    </div>
  );
}
```

- [ ] **Step 2: Wire the button in `AppShell.tsx`** — add `const [composerOpen, setComposerOpen] = useState(false);`, set `onClick={() => setComposerOpen(true)}` on the «Новий пост» `<Button>`, and render `<NewPostModal open={composerOpen} onClose={() => setComposerOpen(false)} />` inside the `ConfirmProvider`.

- [ ] **Step 3: tsc + build** — `cd apps/dashboard && npx tsc --noEmit && npx vite build` → green. (Fix: confirm `useBots` returns `{id,bot_id,username}`; `trackingApi.listChannels` returns `{items}`; `Modal` supports `size="lg"`.)

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/post/NewPostModal.tsx apps/dashboard/src/components/AppShell.tsx
git commit -m "feat(sched): composer modal wired to Новий пост"
```

---

## Task 13: «Заплановані» list page + nav

**Files:**
- Create: `apps/dashboard/src/routes/scheduled.tsx`
- Modify: `apps/dashboard/src/components/AppSidebar.tsx` (point the Calendar slot at `/scheduled`, drop its `soon`)

- [ ] **Step 1: Write the route**

```tsx
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import { NewPostModal } from '../components/post/NewPostModal';
import { scheduledPostsApi } from '../api/scheduled-posts';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { fmtDate } from '../lib/format';
import type { ScheduledPost } from '../api/types';

export const Route = createFileRoute('/scheduled')({ component: ScheduledPage });

const TONE: Record<ScheduledPost['status'], 'neutral'|'success'|'warning'|'danger'> = {
  pending: 'neutral', sending: 'neutral', sent: 'success', failed: 'danger', canceled: 'warning',
};

function ScheduledPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<ScheduledPost | null>(null);
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['scheduled-posts'], queryFn: () => scheduledPostsApi.list() });
  const cancel = useMutation({ mutationFn: (id: string) => scheduledPostsApi.cancel(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scheduled-posts'] }) });

  return (
    <div>
      <PageHeader title="Заплановані" subtitle="Заплановані пости в Telegram"
        actions={<button className="btn-primary" onClick={() => { setEditing(null); setOpen(true); }}>+ Новий пост</button>} />
      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Завантаження…</p>}
      <div className="table-wrap"><table className="table"><thead><tr>
        <th>Час</th><th>Канал</th><th>Відправник</th><th>Статус</th><th>Текст</th><th style={{ textAlign:'right' }}>Дії</th>
      </tr></thead><tbody>
        {data?.map(p => (
          <tr key={p.id}>
            <td className="num">{fmtDate(p.scheduledAt)}</td>
            <td>{p.channelId.slice(0,8)}</td>
            <td>{p.sender === 'bot' ? 'Бот' : 'MTProto'}</td>
            <td><Badge tone={TONE[p.status]}>{p.status}</Badge>{p.error && <span className="text-micro" title={p.error} style={{ color:'var(--color-danger)', marginLeft:6 }}>!</span>}</td>
            <td className="meta" style={{ maxWidth: 280, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.text.replace(/<[^>]+>/g,'')}</td>
            <td style={{ textAlign:'right' }}>
              {p.status === 'pending' && <>
                <button className="btn-tiny" onClick={() => { setEditing(p); setOpen(true); }}>Ред.</button>
                <button className="btn-tiny-danger" style={{ marginLeft: 6 }}
                  onClick={async () => { if (await confirm(`скасувати запланований пост`)) cancel.mutate(p.id); }}>Скасувати</button>
              </>}
            </td>
          </tr>
        ))}
      </tbody></table></div>
      <NewPostModal open={open} onClose={() => setOpen(false)} editing={editing} />
    </div>
  );
}
```

- [ ] **Step 2: Nav** — in `AppSidebar.tsx`, change the Calendar item to `{ to: '/scheduled', label: 'Заплановані', icon: 'calendar' }` (remove `soon: true`).

- [ ] **Step 3: tsc + build** — `cd apps/dashboard && npx tsc --noEmit && npx vite build` → green. Confirm `Badge` accepts `tone` values used and `fmtDate` exists in `lib/format`.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/scheduled.tsx apps/dashboard/src/components/AppSidebar.tsx
git commit -m "feat(sched): Заплановані list page + nav"
```

---

## Task 14: End-to-end smoke + push

- [ ] **Step 1:** Dashboard HMR + automation running. Click **Новий пост** → compose a text post to a test channel via bot, schedule +1 min, save. Confirm it appears in «Заплановані» as `pending`.
- [ ] **Step 2:** Wait → row flips to `sent`; message appears in the test channel.
- [ ] **Step 3:** Compose an image + caption >1024 → UI forces/suggests MTProto-user; schedule; confirm it sends as the user account.
- [ ] **Step 4:** Compose with 2 url-buttons via bot; confirm buttons render in the channel.
- [ ] **Step 5:** Edit a pending post (change time/text) and cancel another; confirm both reflect.
- [ ] **Step 6:** Push the branch and open a PR into `develop`.

```bash
git push -u origin feat/scheduled-posts
```

---

## Self-review notes (gaps fixed inline)

- Added `'sending'` claim status (Task 3 Step 2) — not in the original spec table; required for the skip-locked double-send guard. Migration + type union updated accordingly.
- `ConfigCacheService.getChannelById` may not exist (Task 6 Step 2 verifies/adds it).
- Module import names (`ConfigCacheModule`, exports of `ComposedSenderService`, `DB_POOL`) are verified in Task 8 Step 4 against the real files, since exact module boundaries weren't all confirmed during exploration.
- MTProto-user photo-by-URL reuses `sendVideoWithCaption` (gramjs `sendFile` accepts URLs for both) — noted in Task 5 to avoid a second buffer-fetch path.
