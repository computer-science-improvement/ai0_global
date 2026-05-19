# Discovery & Growth Recommendations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/recommendations` page to the dashboard that, given a target tracked channel and a budget, returns a ranked list of TeleAds catalog channels matching by theme overlap.

**Architecture:** New NestJS `DiscoveryModule` ingests TeleAds catalog daily into `candidate_channels` table; new `recommendations` endpoint joins this against `tracked_channels.themes` (new column) and Phase 3's `tracked_roi_cache`; React dashboard adds `/recommendations` route, `<EditThemesModal />` reused on channel detail page.

**Tech Stack:** NestJS 10 + TypeScript, PostgreSQL with GIN indexes on TEXT[], axios for TeleAds HTTP, Vite + React 18 + TanStack Router/Query + Tailwind v4 for dashboard.

**Cost-safety pre-condition for local testing:** Before running `pnpm dev:automation`, strip the `strategies` array in `apps/automation/config/channels.local.json` to `[]` so no posts publish and no Claude API calls fire. Restore from `channels.local.full-backup.json` when done. See [§ Cost-safe local dev](#cost-safe-local-dev) at the bottom.

---

## File map

### Backend — new files
```
database/migrations/004_discovery.sql

apps/automation/src/discovery/
├── discovery.module.ts
├── teleads/
│   ├── teleads.client.ts
│   ├── teleads.client.test.ts
│   ├── teleads-mapper.ts
│   ├── teleads-mapper.test.ts
│   └── teleads-ingestion.worker.ts
├── repositories/
│   ├── candidate-channels.repository.ts
│   └── channel-themes.repository.ts
├── recommendations/
│   ├── recommendations.service.ts
│   ├── recommendations.service.test.ts
│   └── recommendations.types.ts
└── api/
    ├── discovery.controller.ts
    └── dto/
        ├── recommendations.dto.ts
        └── themes.dto.ts
```

### Backend — modified
```
apps/automation/src/app.module.ts        (register DiscoveryModule)
apps/automation/package.json             (no new deps — axios + pg already there)
```

### Frontend — new files
```
apps/dashboard/src/api/discovery.ts
apps/dashboard/src/components/EditThemesModal.tsx
apps/dashboard/src/components/RecommendationsTable.tsx
apps/dashboard/src/components/TargetChannelPicker.tsx
apps/dashboard/src/components/BudgetInput.tsx
apps/dashboard/src/routes/recommendations.tsx
```

### Frontend — modified
```
apps/dashboard/src/api/types.ts          (Recommendation, Theme types)
apps/dashboard/src/components/Layout.tsx (nav link)
apps/dashboard/src/routes/channels.$id.tsx (wire EditThemesModal)
apps/dashboard/src/routeTree.gen.ts      (auto-regenerated)
```

---

## Task 1 — DB migration

**Files:**
- Create: `database/migrations/004_discovery.sql`

- [ ] **Step 1: Write migration**

```sql
-- 004_discovery.sql
-- Phase 4 MVP: candidate channels from external catalogs + themes on tracked channels.

CREATE TABLE IF NOT EXISTS candidate_channels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  slug          TEXT NOT NULL,
  link          TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  language      TEXT,
  themes        TEXT[] NOT NULL DEFAULT '{}',
  sex_ratio     INTEGER,
  price_min     INTEGER,
  price_max     INTEGER,
  avatar_url    TEXT,
  raw_payload   JSONB NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_candidate_channels_themes ON candidate_channels USING GIN (themes);
CREATE INDEX IF NOT EXISTS idx_candidate_channels_slug ON candidate_channels (LOWER(slug));
CREATE INDEX IF NOT EXISTS idx_candidate_channels_price ON candidate_channels (price_min);

ALTER TABLE tracked_channels
  ADD COLUMN IF NOT EXISTS themes TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_tracked_channels_themes
  ON tracked_channels USING GIN (themes);

INSERT INTO schema_migrations (version) VALUES ('004_discovery')
  ON CONFLICT (version) DO NOTHING;
```

- [ ] **Step 2: Apply migration locally**

```bash
docker exec -i ai0_global-postgres-1 psql -U ai0 -d ai0global \
  < database/migrations/004_discovery.sql
```

Expected output:
```
CREATE TABLE
CREATE INDEX
CREATE INDEX
CREATE INDEX
ALTER TABLE
CREATE INDEX
INSERT 0 1
```

- [ ] **Step 3: Verify schema**

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  \d candidate_channels
" | head -25
```

Expected: table with `themes TEXT[]`, GIN index on themes, etc.

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  SELECT version FROM schema_migrations WHERE version = '004_discovery';
"
```

Expected: 1 row returned.

- [ ] **Step 4: Commit**

```bash
git add database/migrations/004_discovery.sql
git commit -m "feat(discovery): 004 migration — candidate_channels + tracked_channels.themes"
```

---

## Task 2 — Recommendations types

**Files:**
- Create: `apps/automation/src/discovery/recommendations/recommendations.types.ts`

- [ ] **Step 1: Write the types file**

```ts
// apps/automation/src/discovery/recommendations/recommendations.types.ts

export interface CandidateChannelRow {
  id:            string;
  source:        string;
  external_id:   string;
  slug:          string;
  link:          string;
  title:         string;
  description:   string | null;
  language:      string | null;
  themes:        string[];
  sex_ratio:     number | null;
  price_min:     number | null;
  price_max:     number | null;
  avatar_url:    string | null;
}

export interface RecommendationItem {
  id:                 string;
  slug:               string;
  link:               string;
  title:              string;
  description:        string | null;
  themes:             string[];
  matchedThemes:      string[];
  score:              number;
  estimatedSubsPerAd: number | null;
  roiConfidence:      string | null;
  priceMin:           number;
  priceMax:           number | null;
  sexRatio:           number | null;
  avatarUrl:          string | null;
  language:           string | null;
  source:             string;
}

export interface RecommendInput {
  targetChannelId:        string;
  budget:                 number;
  limit?:                 number;
  excludeAlreadyTracked?: boolean;
}

export interface RecommendOutput {
  recommendations: RecommendationItem[];
  targetThemes:    string[];
  warning?:        string;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/discovery/recommendations/recommendations.types.ts
git commit -m "feat(discovery): recommendation DTO types"
```

---

## Task 3 — Pure-function scoring (test-first)

**Files:**
- Create: `apps/automation/src/discovery/recommendations/recommendations.service.test.ts`
- Create: `apps/automation/src/discovery/recommendations/recommendations.service.ts` (partial — score fn only)

- [ ] **Step 1: Write the failing tests for `score()` + `jaccard()`**

```ts
// apps/automation/src/discovery/recommendations/recommendations.service.test.ts
import { jaccardSimilarity, scoreCandidate } from './recommendations.service';

describe('jaccardSimilarity', () => {
  it('returns 0 when either side is empty', () => {
    expect(jaccardSimilarity([], ['a'])).toBe(0);
    expect(jaccardSimilarity(['a'], [])).toBe(0);
    expect(jaccardSimilarity([], [])).toBe(0);
  });

  it('returns 1 for identical sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccardSimilarity(['b', 'a'], ['a', 'b'])).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('returns 0.5 for half overlap', () => {
    // |∩|=1, |∪|=3, 1/3 ≈ 0.333
    expect(jaccardSimilarity(['a', 'b'], ['a', 'c'])).toBeCloseTo(0.333, 2);
  });

  it('deduplicates within each set before computing', () => {
    expect(jaccardSimilarity(['a', 'a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('is case-sensitive', () => {
    expect(jaccardSimilarity(['A'], ['a'])).toBe(0);
  });
});

describe('scoreCandidate', () => {
  it('returns the Jaccard score', () => {
    expect(
      scoreCandidate({ themes: ['a', 'b'] } as any, { themes: ['a', 'c'] } as any),
    ).toBeCloseTo(0.333, 2);
  });

  it('returns 0 when candidate themes empty', () => {
    expect(
      scoreCandidate({ themes: ['a'] } as any, { themes: [] } as any),
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/automation
pnpm test -- --testPathPattern=recommendations.service.test
```

Expected: FAIL with "Cannot find module './recommendations.service'"

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/automation/src/discovery/recommendations/recommendations.service.ts
import { CandidateChannelRow } from './recommendations.types';

/** Set-based Jaccard similarity. Inputs deduplicated; case-sensitive. */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return inter / union;
}

export function scoreCandidate(
  target: { themes: string[] },
  candidate: { themes: string[] },
): number {
  return jaccardSimilarity(target.themes ?? [], candidate.themes ?? []);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- --testPathPattern=recommendations.service.test
```

Expected: PASS, 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/discovery/recommendations/recommendations.service.ts \
        apps/automation/src/discovery/recommendations/recommendations.service.test.ts
git commit -m "feat(discovery): Jaccard scoring with unit tests"
```

---

## Task 4 — Candidate channels repository (read + upsert)

**Files:**
- Create: `apps/automation/src/discovery/repositories/candidate-channels.repository.ts`

- [ ] **Step 1: Write the repository**

```ts
// apps/automation/src/discovery/repositories/candidate-channels.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { CandidateChannelRow } from '../recommendations/recommendations.types';

export interface UpsertInput {
  source:      string;
  external_id: string;
  slug:        string;
  link:        string;
  title:       string;
  description: string | null;
  language:    string | null;
  themes:      string[];
  sex_ratio:   number | null;
  price_min:   number | null;
  price_max:   number | null;
  avatar_url:  string | null;
  raw_payload: unknown;
}

@Injectable()
export class CandidateChannelsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async upsert(input: UpsertInput): Promise<{ inserted: boolean }> {
    const { rows } = await this.pool.query<{ inserted: boolean }>(
      `INSERT INTO candidate_channels
         (source, external_id, slug, link, title, description, language,
          themes, sex_ratio, price_min, price_max, avatar_url, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (source, external_id) DO UPDATE SET
         slug         = EXCLUDED.slug,
         link         = EXCLUDED.link,
         title        = EXCLUDED.title,
         description  = EXCLUDED.description,
         language     = EXCLUDED.language,
         themes       = EXCLUDED.themes,
         sex_ratio    = EXCLUDED.sex_ratio,
         price_min    = EXCLUDED.price_min,
         price_max    = EXCLUDED.price_max,
         avatar_url   = EXCLUDED.avatar_url,
         raw_payload  = EXCLUDED.raw_payload,
         last_seen_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        input.source, input.external_id, input.slug, input.link, input.title,
        input.description, input.language, input.themes, input.sex_ratio,
        input.price_min, input.price_max, input.avatar_url,
        JSON.stringify(input.raw_payload),
      ],
    );
    return { inserted: rows[0]?.inserted ?? false };
  }

  /**
   * Pre-filter: rows whose price fits the budget AND share at least one theme
   * with the target. Hard cap of 500 rows; score + final rank are computed in
   * the service layer.
   */
  async candidatesForBudgetAndThemes(opts: {
    targetThemes:           string[];
    budget:                 number;
    excludeOwnedUsernames:  string[];
    limit?:                 number;
  }): Promise<Array<CandidateChannelRow & {
    estimated_subs_per_ad: number | null;
    roi_confidence:        string | null;
  }>> {
    const limit = opts.limit ?? 500;
    const { rows } = await this.pool.query(
      `SELECT
         c.id, c.source, c.external_id, c.slug, c.link, c.title, c.description,
         c.language, c.themes, c.sex_ratio, c.price_min, c.price_max, c.avatar_url,
         r.estimated_subs_per_ad,
         r.confidence AS roi_confidence
       FROM candidate_channels c
       LEFT JOIN tracked_channels tc
              ON LOWER(tc.username) = LOWER(c.slug)
       LEFT JOIN tracked_roi_cache r
              ON r.channel_id = tc.id
       WHERE c.price_min IS NOT NULL
         AND c.price_min <= $1
         AND c.themes && $2::text[]
         AND (tc.id IS NULL OR LOWER(tc.username) <> ANY($3::text[]))
       LIMIT $4`,
      [opts.budget, opts.targetThemes, opts.excludeOwnedUsernames.map(s => s.toLowerCase()), limit],
    );
    return rows;
  }
}
```

- [ ] **Step 2: Sanity-compile**

```bash
cd apps/automation
pnpm exec tsc --noEmit
```

Expected: no errors (might fail on other unmerged work — see § Troubleshooting).

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/discovery/repositories/candidate-channels.repository.ts
git commit -m "feat(discovery): candidate-channels repository (upsert + budget query)"
```

---

## Task 5 — Channel themes repository

**Files:**
- Create: `apps/automation/src/discovery/repositories/channel-themes.repository.ts`

- [ ] **Step 1: Write the repository**

```ts
// apps/automation/src/discovery/repositories/channel-themes.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';

@Injectable()
export class ChannelThemesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getThemes(channelId: string): Promise<string[] | null> {
    const { rows } = await this.pool.query<{ themes: string[] }>(
      `SELECT themes FROM tracked_channels WHERE id = $1`,
      [channelId],
    );
    return rows[0]?.themes ?? null;
  }

  async setThemes(channelId: string, themes: string[]): Promise<boolean> {
    const dedup = Array.from(new Set(themes));
    const { rowCount } = await this.pool.query(
      `UPDATE tracked_channels SET themes = $1::text[] WHERE id = $2`,
      [dedup, channelId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Used by the recommendations service to compute the exclusion set. */
  async listMyUsernames(): Promise<string[]> {
    const { rows } = await this.pool.query<{ username: string }>(
      `SELECT username FROM tracked_channels
       WHERE is_mine = true AND username IS NOT NULL`,
    );
    return rows.map(r => r.username);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/discovery/repositories/channel-themes.repository.ts
git commit -m "feat(discovery): channel-themes repository (get/set/list-mine)"
```

---

## Task 6 — TeleAds HTTP client

**Files:**
- Create: `apps/automation/src/discovery/teleads/teleads.client.ts`
- Create: `apps/automation/src/discovery/teleads/teleads.client.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/automation/src/discovery/teleads/teleads.client.test.ts
import axios from 'axios';
import { TeleAdsClient } from './teleads.client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const fixture = {
  data: [{
    id: 1,
    slug: 'foo',
    link: 'https://t.me/foo',
    title: 'Foo',
    description: 'desc',
    source: 'Telegram',
    status: 'enabled',
    type: 'channel',
    language: 'ukrainian',
    sex: 'enabled',
    sex_ratio: 60,
    prices: [{ id: 1, type: '1day', price: 50000 }],
    categories: [{ id: 16, slug: 'znamenitosti', title: 'Знаменитості', status: 'enabled' } as any],
    avatar: null,
  }],
  meta: { current_page: 1, last_page: 1, total: 1, per_page: '100' },
  links: { first: '', last: '', prev: null, next: null },
};

describe('TeleAdsClient', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists products with default query params', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: fixture });
    const client = new TeleAdsClient();
    const page = await client.listProducts({ page: 1, perPage: 100 });
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://teleads.com.ua/api/promo/products/',
      expect.objectContaining({
        params: expect.objectContaining({ status: 'enabled', page: 1, per_page: 100 }),
      }),
    );
    expect(page.data[0].slug).toBe('foo');
    expect(page.meta.last_page).toBe(1);
  });

  it('appends category filter when categories provided', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: fixture });
    const client = new TeleAdsClient();
    await client.listProducts({ page: 1, perPage: 50, categories: [16, 30] });
    const callArgs = mockedAxios.get.mock.calls[0][1] as any;
    expect(callArgs.params.filter).toBe('categories:16,30;');
  });

  it('retries on 429 up to 3 times', async () => {
    const err: any = new Error('rate limit'); err.response = { status: 429 };
    mockedAxios.get
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ data: fixture });
    const client = new TeleAdsClient();
    const page = await client.listProducts({ page: 1, perPage: 10 });
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    expect(page.data[0].slug).toBe('foo');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- --testPathPattern=teleads.client.test
```

Expected: FAIL with "Cannot find module './teleads.client'"

- [ ] **Step 3: Implement the client**

```ts
// apps/automation/src/discovery/teleads/teleads.client.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const BASE = 'https://teleads.com.ua/api/promo';

export interface TeleAdsPrice {
  id: number;
  type: string;       // '1day', '24h', 'always', etc.
  price: number;      // kopecks
}

export interface TeleAdsCategory {
  id: number;
  slug: string;
  title: string;
  status: string;
}

export interface TeleAdsAvatar {
  media?: {
    sizes?: Record<string, { url: string; width: number; height: number }>;
  };
}

export interface TeleAdsProduct {
  id: number;
  slug: string;
  link: string;
  title: string;
  description: string | null;
  source: string;
  status: string;
  type: string;
  language: string | null;
  sex: string;
  sex_ratio: number | null;
  prices: TeleAdsPrice[];
  categories: TeleAdsCategory[];
  avatar: TeleAdsAvatar | null;
}

export interface TeleAdsPage {
  data: TeleAdsProduct[];
  meta: { current_page: number; last_page: number; total: number; per_page: string | number };
  links: { first: string; last: string; prev: string | null; next: string | null };
}

@Injectable()
export class TeleAdsClient {
  private readonly logger = new Logger(TeleAdsClient.name);

  async listProducts(opts: {
    page: number;
    perPage: number;
    categories?: number[];
    sort?: string;
  }): Promise<TeleAdsPage> {
    const params: Record<string, string | number> = {
      status: 'enabled',
      page: opts.page,
      per_page: opts.perPage,
    };
    if (opts.categories && opts.categories.length > 0) {
      params.filter = `categories:${opts.categories.join(',')};`;
    }
    if (opts.sort) params.sorting = opts.sort;

    return this.requestWithRetry(`${BASE}/products/`, params);
  }

  async listCategories(): Promise<TeleAdsCategory[]> {
    const res = await this.requestWithRetry(`${BASE}/categories/`, {
      type: 'product',
      status: 'enabled',
    });
    return res.data;
  }

  private async requestWithRetry(
    url: string,
    params: Record<string, string | number>,
    attempt = 1,
  ): Promise<any> {
    try {
      const res = await axios.get(url, {
        params,
        timeout: 15_000,
        headers: { 'User-Agent': 'ai0_global/discovery (+ ingestion)' },
      });
      return res.data;
    } catch (err: any) {
      const status = err.response?.status;
      const retriable = status === 429 || (status && status >= 500);
      if (retriable && attempt < 3) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        this.logger.warn(`TeleAds ${status} on ${url} — retry ${attempt}/3 after ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        return this.requestWithRetry(url, params, attempt + 1);
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- --testPathPattern=teleads.client.test
```

Expected: PASS, 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/discovery/teleads/teleads.client.ts \
        apps/automation/src/discovery/teleads/teleads.client.test.ts
git commit -m "feat(discovery): TeleAds HTTP client with retry"
```

---

## Task 7 — TeleAds product → row mapper

**Files:**
- Create: `apps/automation/src/discovery/teleads/teleads-mapper.ts`
- Create: `apps/automation/src/discovery/teleads/teleads-mapper.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// apps/automation/src/discovery/teleads/teleads-mapper.test.ts
import { mapTeleAdsProduct } from './teleads-mapper';
import { TeleAdsProduct } from './teleads.client';

const baseProduct: TeleAdsProduct = {
  id: 1179,
  slug: 'truexanewsua',
  link: 'https://t.me/truexanewsua',
  title: 'Труха',
  description: 'desc',
  source: 'Telegram',
  status: 'enabled',
  type: 'channel',
  language: 'ukrainian',
  sex: 'enabled',
  sex_ratio: 53,
  prices: [{ id: 1, type: '1day', price: 80000 }],
  categories: [{ id: 34, slug: 'novini-i-zmi', title: 'Новини і ЗМІ', status: 'enabled' }],
  avatar: null,
};

describe('mapTeleAdsProduct', () => {
  it('maps the happy path', () => {
    const row = mapTeleAdsProduct(baseProduct);
    expect(row.source).toBe('teleads');
    expect(row.external_id).toBe('1179');
    expect(row.slug).toBe('truexanewsua');
    expect(row.title).toBe('Труха');
    expect(row.themes).toEqual(['novini-i-zmi']);
    expect(row.sex_ratio).toBe(53);
    expect(row.price_min).toBe(80000);
    expect(row.price_max).toBe(80000);
  });

  it('picks min and max across multiple price tiers', () => {
    const row = mapTeleAdsProduct({
      ...baseProduct,
      prices: [
        { id: 1, type: '1day', price: 80000 },
        { id: 2, type: '24h',  price: 50000 },
        { id: 3, type: 'always', price: 200000 },
      ],
    });
    expect(row.price_min).toBe(50000);
    expect(row.price_max).toBe(200000);
  });

  it('handles empty prices array', () => {
    const row = mapTeleAdsProduct({ ...baseProduct, prices: [] });
    expect(row.price_min).toBeNull();
    expect(row.price_max).toBeNull();
  });

  it('sets sex_ratio to null when sex flag is disabled', () => {
    const row = mapTeleAdsProduct({ ...baseProduct, sex: 'disabled', sex_ratio: 53 });
    expect(row.sex_ratio).toBeNull();
  });

  it('extracts 320x320 avatar when available', () => {
    const row = mapTeleAdsProduct({
      ...baseProduct,
      avatar: {
        media: {
          sizes: {
            '320x320': { url: 'https://cdn/big.webp', width: 320, height: 320 },
            '150x150': { url: 'https://cdn/small.webp', width: 150, height: 150 },
          },
        },
      },
    });
    expect(row.avatar_url).toBe('https://cdn/big.webp');
  });

  it('falls back to any available avatar size', () => {
    const row = mapTeleAdsProduct({
      ...baseProduct,
      avatar: {
        media: {
          sizes: { '150x150': { url: 'https://cdn/x.webp', width: 150, height: 150 } },
        },
      },
    });
    expect(row.avatar_url).toBe('https://cdn/x.webp');
  });

  it('returns null avatar when no avatar', () => {
    const row = mapTeleAdsProduct({ ...baseProduct, avatar: null });
    expect(row.avatar_url).toBeNull();
  });

  it('captures all themes from categories', () => {
    const row = mapTeleAdsProduct({
      ...baseProduct,
      categories: [
        { id: 1, slug: 'a', title: 'A', status: 'enabled' },
        { id: 2, slug: 'b', title: 'B', status: 'enabled' },
      ],
    });
    expect(row.themes).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- --testPathPattern=teleads-mapper.test
```

Expected: FAIL with "Cannot find module './teleads-mapper'"

- [ ] **Step 3: Implement the mapper**

```ts
// apps/automation/src/discovery/teleads/teleads-mapper.ts
import { TeleAdsProduct } from './teleads.client';
import { UpsertInput } from '../repositories/candidate-channels.repository';

const AVATAR_SIZE_PREFERENCE = ['320x320', '600x600', '800x550', '150x150', 'base'];

export function mapTeleAdsProduct(p: TeleAdsProduct): UpsertInput {
  const prices = (p.prices ?? []).map(t => t.price).filter(v => Number.isFinite(v));
  const themes = (p.categories ?? []).map(c => c.slug).filter(Boolean);

  let avatar_url: string | null = null;
  const sizes = p.avatar?.media?.sizes;
  if (sizes) {
    for (const key of AVATAR_SIZE_PREFERENCE) {
      if (sizes[key]?.url) { avatar_url = sizes[key].url; break; }
    }
    if (!avatar_url) {
      const first = Object.values(sizes)[0];
      avatar_url = first?.url ?? null;
    }
  }

  return {
    source:      'teleads',
    external_id: String(p.id),
    slug:        p.slug,
    link:        p.link,
    title:       p.title,
    description: p.description ?? null,
    language:    p.language ?? null,
    themes,
    sex_ratio:   p.sex === 'enabled' && Number.isFinite(p.sex_ratio as number)
                   ? (p.sex_ratio as number)
                   : null,
    price_min:   prices.length ? Math.min(...prices) : null,
    price_max:   prices.length ? Math.max(...prices) : null,
    avatar_url,
    raw_payload: p,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- --testPathPattern=teleads-mapper.test
```

Expected: PASS, 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/discovery/teleads/teleads-mapper.ts \
        apps/automation/src/discovery/teleads/teleads-mapper.test.ts
git commit -m "feat(discovery): TeleAds product → row mapper with tests"
```

---

## Task 8 — TeleAds ingestion worker

**Files:**
- Create: `apps/automation/src/discovery/teleads/teleads-ingestion.worker.ts`

- [ ] **Step 1: Write the worker**

```ts
// apps/automation/src/discovery/teleads/teleads-ingestion.worker.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TeleAdsClient } from './teleads.client';
import { mapTeleAdsProduct } from './teleads-mapper';
import { CandidateChannelsRepository } from '../repositories/candidate-channels.repository';

const PAGE_DELAY_MS = 200;

@Injectable()
export class TeleAdsIngestionWorker {
  private readonly logger = new Logger(TeleAdsIngestionWorker.name);

  constructor(
    private readonly client: TeleAdsClient,
    private readonly repo:   CandidateChannelsRepository,
  ) {}

  /** Daily at 04:00 UTC — quiet time, well after the motivation-channel slots. */
  @Cron('0 4 * * *')
  async run(): Promise<void> {
    const stats = await this.ingest();
    this.logger.log(
      `TeleAds ingestion done: ${stats.inserted} new, ${stats.updated} updated, ${stats.total} total in ${stats.durationMs}ms`,
    );
  }

  async ingest(): Promise<{ inserted: number; updated: number; total: number; durationMs: number }> {
    const start = Date.now();
    let inserted = 0;
    let updated  = 0;
    let total    = 0;

    let firstPage: Awaited<ReturnType<TeleAdsClient['listProducts']>>;
    try {
      firstPage = await this.client.listProducts({ page: 1, perPage: 100 });
    } catch (err: any) {
      this.logger.error(`TeleAds page 1 failed: ${err.message}`);
      return { inserted, updated, total, durationMs: Date.now() - start };
    }

    const lastPage = firstPage.meta.last_page ?? 1;
    const handlePage = async (page: typeof firstPage) => {
      for (const product of page.data) {
        try {
          const row = mapTeleAdsProduct(product);
          const res = await this.repo.upsert(row);
          if (res.inserted) inserted++; else updated++;
          total++;
        } catch (err: any) {
          this.logger.warn(`Skip product ${product.id}: ${err.message}`);
        }
      }
    };

    await handlePage(firstPage);

    for (let page = 2; page <= lastPage; page++) {
      await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
      try {
        const p = await this.client.listProducts({ page, perPage: 100 });
        await handlePage(p);
      } catch (err: any) {
        this.logger.warn(`TeleAds page ${page} failed (skipped): ${err.message}`);
      }
    }

    return { inserted, updated, total, durationMs: Date.now() - start };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/discovery/teleads/teleads-ingestion.worker.ts
git commit -m "feat(discovery): TeleAds daily ingestion worker"
```

---

## Task 9 — Recommendations service (full)

**Files:**
- Modify: `apps/automation/src/discovery/recommendations/recommendations.service.ts`
- Modify: `apps/automation/src/discovery/recommendations/recommendations.service.test.ts`

- [ ] **Step 1: Append recommendation pipeline tests**

Append to existing `recommendations.service.test.ts`:

```ts
import { RecommendationsService } from './recommendations.service';

const fakeRepo = {
  candidatesForBudgetAndThemes: jest.fn(),
};
const fakeThemes = {
  getThemes: jest.fn(),
  listMyUsernames: jest.fn(),
};

const C = (id: string, slug: string, themes: string[], price: number, roi: number | null = null) => ({
  id, source: 'teleads', external_id: id, slug, link: `https://t.me/${slug}`,
  title: slug, description: null, language: null, themes, sex_ratio: null,
  price_min: price, price_max: price, avatar_url: null,
  estimated_subs_per_ad: roi, roi_confidence: roi ? 'medium' : null,
});

describe('RecommendationsService.recommend', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns warning when target has no themes', async () => {
    fakeThemes.getThemes.mockResolvedValueOnce([]);
    fakeThemes.listMyUsernames.mockResolvedValueOnce([]);
    fakeRepo.candidatesForBudgetAndThemes.mockResolvedValueOnce([]);
    const svc = new RecommendationsService(fakeRepo as any, fakeThemes as any);
    const res = await svc.recommend({ targetChannelId: 'x', budget: 100000 });
    expect(res.recommendations).toHaveLength(0);
    expect(res.warning).toContain('themes');
  });

  it('ranks by score desc, then ROI desc, then price asc', async () => {
    fakeThemes.getThemes.mockResolvedValueOnce(['a', 'b']);
    fakeThemes.listMyUsernames.mockResolvedValueOnce([]);
    fakeRepo.candidatesForBudgetAndThemes.mockResolvedValueOnce([
      C('1', 'low_score',   ['a'],          50),         // jaccard 1/2 = .5
      C('2', 'tied_no_roi', ['a', 'b'],     200),        // 1.0
      C('3', 'tied_roi',    ['a', 'b'],     300, 42),    // 1.0, ROI 42
      C('4', 'tied_cheap',  ['a', 'b'],     100),        // 1.0 — cheaper than #2
    ]);
    const svc = new RecommendationsService(fakeRepo as any, fakeThemes as any);
    const res = await svc.recommend({ targetChannelId: 'x', budget: 1_000_000 });
    expect(res.recommendations.map(r => r.slug)).toEqual([
      'tied_roi',    // score 1.0, ROI 42
      'tied_cheap',  // score 1.0, no ROI, price 100
      'tied_no_roi', // score 1.0, no ROI, price 200
      'low_score',   // score 0.5
    ]);
  });

  it('applies limit', async () => {
    fakeThemes.getThemes.mockResolvedValueOnce(['a']);
    fakeThemes.listMyUsernames.mockResolvedValueOnce([]);
    fakeRepo.candidatesForBudgetAndThemes.mockResolvedValueOnce([
      C('1', 'a', ['a'], 10),
      C('2', 'b', ['a'], 20),
      C('3', 'c', ['a'], 30),
    ]);
    const svc = new RecommendationsService(fakeRepo as any, fakeThemes as any);
    const res = await svc.recommend({ targetChannelId: 'x', budget: 1000, limit: 2 });
    expect(res.recommendations).toHaveLength(2);
  });

  it('throws 404 when target not found', async () => {
    fakeThemes.getThemes.mockResolvedValueOnce(null);
    const svc = new RecommendationsService(fakeRepo as any, fakeThemes as any);
    await expect(svc.recommend({ targetChannelId: 'missing', budget: 100 }))
      .rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test -- --testPathPattern=recommendations.service.test
```

Expected: FAIL — `RecommendationsService` not exported yet.

- [ ] **Step 3: Extend the service**

Append to `recommendations.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { CandidateChannelsRepository } from '../repositories/candidate-channels.repository';
import { ChannelThemesRepository } from '../repositories/channel-themes.repository';
import {
  RecommendInput, RecommendOutput, RecommendationItem,
} from './recommendations.types';

@Injectable()
export class RecommendationsService {
  constructor(
    private readonly candidates: CandidateChannelsRepository,
    private readonly themes:     ChannelThemesRepository,
  ) {}

  async recommend(input: RecommendInput): Promise<RecommendOutput> {
    const targetThemes = await this.themes.getThemes(input.targetChannelId);
    if (targetThemes === null) {
      throw new NotFoundException(`Target channel ${input.targetChannelId} not found`);
    }
    if (targetThemes.length === 0) {
      return {
        recommendations: [],
        targetThemes:    [],
        warning:         'Set themes on the target channel first',
      };
    }

    const excludeOwnedUsernames =
      input.excludeAlreadyTracked === false ? [] : await this.themes.listMyUsernames();

    const rows = await this.candidates.candidatesForBudgetAndThemes({
      targetThemes,
      budget:                input.budget,
      excludeOwnedUsernames,
      limit:                 500,
    });

    const scored: RecommendationItem[] = rows.map(r => {
      const matched = r.themes.filter(t => targetThemes.includes(t));
      const score = scoreCandidate({ themes: targetThemes }, { themes: r.themes });
      return {
        id:                 r.id,
        slug:               r.slug,
        link:               r.link,
        title:              r.title,
        description:        r.description,
        themes:             r.themes,
        matchedThemes:      matched,
        score,
        estimatedSubsPerAd: r.estimated_subs_per_ad ?? null,
        roiConfidence:      r.roi_confidence ?? null,
        priceMin:           r.price_min!,           // SQL guarantees not null
        priceMax:           r.price_max,
        sexRatio:           r.sex_ratio,
        avatarUrl:          r.avatar_url,
        language:           r.language,
        source:             r.source,
      };
    });

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      const ra = a.estimatedSubsPerAd ?? -1;
      const rb = b.estimatedSubsPerAd ?? -1;
      if (ra !== rb) return rb - ra;
      return a.priceMin - b.priceMin;
    });

    const limit = input.limit ?? 20;
    return {
      recommendations: scored.slice(0, limit),
      targetThemes,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test -- --testPathPattern=recommendations.service.test
```

Expected: PASS, all 12 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/discovery/recommendations/recommendations.service.ts \
        apps/automation/src/discovery/recommendations/recommendations.service.test.ts
git commit -m "feat(discovery): recommendations service (rank by score → ROI → price)"
```

---

## Task 10 — DTOs

**Files:**
- Create: `apps/automation/src/discovery/api/dto/recommendations.dto.ts`
- Create: `apps/automation/src/discovery/api/dto/themes.dto.ts`

- [ ] **Step 1: Write recommendations DTO**

```ts
// apps/automation/src/discovery/api/dto/recommendations.dto.ts
import { IsBoolean, IsInt, IsOptional, IsPositive, IsString, IsUUID, Max } from 'class-validator';

export class RecommendRequestDto {
  @IsUUID()
  targetChannelId!: string;

  @IsInt()
  @IsPositive()
  budget!: number;             // kopecks

  @IsOptional()
  @IsInt()
  @IsPositive()
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsBoolean()
  excludeAlreadyTracked?: boolean;
}
```

- [ ] **Step 2: Write themes DTO**

```ts
// apps/automation/src/discovery/api/dto/themes.dto.ts
import { ArrayMaxSize, IsArray, IsString, Matches } from 'class-validator';

export class UpdateThemesDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(/^[a-z0-9-]+$/, { each: true, message: 'theme slug must be lower-kebab-case' })
  themes!: string[];
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/automation/src/discovery/api/dto
git commit -m "feat(discovery): request DTOs with class-validator"
```

---

## Task 11 — Discovery controller

**Files:**
- Create: `apps/automation/src/discovery/api/discovery.controller.ts`

- [ ] **Step 1: Write the controller**

```ts
// apps/automation/src/discovery/api/discovery.controller.ts
import {
  Body, Controller, Get, HttpCode, Inject, Param, Put, Post, UseGuards, BadRequestException,
} from '@nestjs/common';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { TeleAdsClient, TeleAdsCategory } from '../teleads/teleads.client';
import { ChannelThemesRepository } from '../repositories/channel-themes.repository';
import { RecommendationsService } from '../recommendations/recommendations.service';
import { RecommendRequestDto } from './dto/recommendations.dto';
import { UpdateThemesDto } from './dto/themes.dto';

@Controller('api')
@UseGuards(TrackingAuthGuard)
export class DiscoveryController {
  private categoryCache: { at: number; data: TeleAdsCategory[] } | null = null;
  private validSlugs: Set<string> = new Set();

  constructor(
    private readonly teleads: TeleAdsClient,
    private readonly themes:  ChannelThemesRepository,
    private readonly recs:    RecommendationsService,
  ) {}

  @Get('themes')
  async themesList(): Promise<{ themes: { slug: string; title: string }[] }> {
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (!this.categoryCache || Date.now() - this.categoryCache.at > ONE_DAY) {
      const data = await this.teleads.listCategories();
      this.categoryCache = { at: Date.now(), data };
      this.validSlugs = new Set(data.map(c => c.slug));
    }
    return {
      themes: this.categoryCache.data.map(c => ({ slug: c.slug, title: c.title })),
    };
  }

  @Get('tracked-channels/:id/themes')
  async getChannelThemes(@Param('id') id: string): Promise<{ themes: string[] }> {
    const themes = await this.themes.getThemes(id);
    if (themes === null) throw new BadRequestException(`Channel ${id} not found`);
    return { themes };
  }

  @Put('tracked-channels/:id/themes')
  @HttpCode(204)
  async updateChannelThemes(
    @Param('id') id: string,
    @Body() body: UpdateThemesDto,
  ): Promise<void> {
    // Validate against cached theme vocabulary (lazy refresh)
    if (this.validSlugs.size === 0) await this.themesList();
    const invalid = body.themes.filter(t => !this.validSlugs.has(t));
    if (invalid.length) {
      throw new BadRequestException(`Unknown themes: ${invalid.join(', ')}`);
    }
    const ok = await this.themes.setThemes(id, body.themes);
    if (!ok) throw new BadRequestException(`Channel ${id} not found`);
  }

  @Post('recommendations')
  async recommendations(@Body() body: RecommendRequestDto) {
    return this.recs.recommend(body);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/automation/src/discovery/api/discovery.controller.ts
git commit -m "feat(discovery): REST controller (themes + recommendations)"
```

---

## Task 12 — DiscoveryModule wiring

**Files:**
- Create: `apps/automation/src/discovery/discovery.module.ts`
- Modify: `apps/automation/src/app.module.ts`

- [ ] **Step 1: Write DiscoveryModule**

```ts
// apps/automation/src/discovery/discovery.module.ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TrackingModule } from '../tracking/tracking.module';
import { TeleAdsClient } from './teleads/teleads.client';
import { TeleAdsIngestionWorker } from './teleads/teleads-ingestion.worker';
import { CandidateChannelsRepository } from './repositories/candidate-channels.repository';
import { ChannelThemesRepository } from './repositories/channel-themes.repository';
import { RecommendationsService } from './recommendations/recommendations.service';
import { DiscoveryController } from './api/discovery.controller';

@Module({
  imports: [DatabaseModule, TrackingModule],
  controllers: [DiscoveryController],
  providers: [
    TeleAdsClient,
    TeleAdsIngestionWorker,
    CandidateChannelsRepository,
    ChannelThemesRepository,
    RecommendationsService,
  ],
  exports: [
    CandidateChannelsRepository,
    ChannelThemesRepository,
  ],
})
export class DiscoveryModule {}
```

- [ ] **Step 2: Register in AppModule**

Find the imports array in `apps/automation/src/app.module.ts` and add `DiscoveryModule`:

```ts
import { DiscoveryModule } from './discovery/discovery.module';
// ...
@Module({
  imports: [
    // ...existing modules...
    DiscoveryModule,
  ],
  // ...
})
export class AppModule {}
```

- [ ] **Step 3: Verify backend boots**

```bash
cd apps/automation
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/automation/src/discovery/discovery.module.ts apps/automation/src/app.module.ts
git commit -m "feat(discovery): wire DiscoveryModule into AppModule"
```

---

## Task 13 — Backend smoke test

This is a manual verification step — no code, no commit. Run the local stack with a stripped strategies array (see § Cost-safe local dev).

- [ ] **Step 1: Pre-flight**

```bash
# Backup current strategies array
cp apps/automation/config/channels.local.json apps/automation/config/channels.local.testing-backup.json

# Strip strategies for cost-safe boot
python3 -c "
import json
with open('apps/automation/config/channels.local.json') as f: c = json.load(f)
c['strategies'] = []
with open('apps/automation/config/channels.local.json', 'w') as f: json.dump(c, f, indent=2, ensure_ascii=False)
print('strategies count:', len(c['strategies']))
"
```

- [ ] **Step 2: Start postgres + automation**

```bash
pnpm db:up
pnpm dev:automation
# Wait for boot — look for "1 bot(s), N channel(s), 0 strategy(ies)"
```

- [ ] **Step 3: Trigger ingestion manually** (separate shell)

```bash
# Find the running container's NestJS REPL or hit it via HTTP if exposed.
# Simplest: invoke the worker from psql by inserting one row and seeing the controller respond.
# For now we trigger via a one-shot:
docker exec -e NODE_OPTIONS='--experimental-vm-modules' ai0_global-automation-1 \
  node -e "const a=require('@nestjs/core');const m=require('./dist/discovery/discovery.module').DiscoveryModule;a.NestFactory.createApplicationContext(m).then(async app=>{const w=app.get(require('./dist/discovery/teleads/teleads-ingestion.worker').TeleAdsIngestionWorker);console.log(await w.ingest());await app.close();process.exit(0);})"
```

(Note — if the automation isn't running in docker locally, run from your laptop instead: `cd apps/automation && pnpm exec ts-node -e "..."` using the same pattern.)

Expected: `{ inserted: 1300+, updated: 0, total: 1300+, durationMs: 30000-60000 }`

- [ ] **Step 4: Verify rows**

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  SELECT count(*) AS total,
         count(*) FILTER (WHERE price_min IS NOT NULL) AS priced,
         count(DISTINCT unnest(themes)) AS distinct_themes
  FROM candidate_channels;
"
```

Expected: total ≈ 1,386, priced close to total, distinct_themes ≈ 60.

- [ ] **Step 5: Smoke test recommendations endpoint**

```bash
# Find a tracked channel id with is_mine = true (one of yours)
TARGET_ID=$(docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -tA -c "
  SELECT id FROM tracked_channels WHERE is_mine = true LIMIT 1;
")
echo "Target: $TARGET_ID"

# Set themes on it (use a theme actually present in candidates)
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c "
  UPDATE tracked_channels
  SET themes = ARRAY['motivaciya-i-samorozvitok','cikavi-fakti','tsutatu']
  WHERE id = '$TARGET_ID';
"

# Call the endpoint (the cookie-JWT guard is bypassed locally if you set a bearer header — check tracking-auth.guard.ts.
# Alternative: hit it via the dashboard once it's wired)
curl -s -X POST 'http://localhost:3001/api/recommendations' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <local-stub-token>" \
  -d "{\"targetChannelId\":\"$TARGET_ID\",\"budget\":1000000,\"limit\":5}" \
  | python3 -m json.tool | head -40
```

Expected: JSON with 5 recommendations sorted by score desc.

- [ ] **Step 6: Restore strategies for later use (optional)**

```bash
mv apps/automation/config/channels.local.testing-backup.json apps/automation/config/channels.local.json
```

No commit — this is a smoke test only.

---

## Task 14 — Frontend types

**Files:**
- Modify: `apps/dashboard/src/api/types.ts`

- [ ] **Step 1: Add the new types**

Append:

```ts
// apps/dashboard/src/api/types.ts (append at bottom)

export interface Theme {
  slug:  string;
  title: string;
}

export interface RecommendationItem {
  id:                 string;
  slug:               string;
  link:               string;
  title:              string;
  description:        string | null;
  themes:             string[];
  matchedThemes:      string[];
  score:              number;
  estimatedSubsPerAd: number | null;
  roiConfidence:      string | null;
  priceMin:           number;
  priceMax:           number | null;
  sexRatio:           number | null;
  avatarUrl:          string | null;
  language:           string | null;
  source:             string;
}

export interface RecommendResponse {
  recommendations: RecommendationItem[];
  targetThemes:    string[];
  warning?:        string;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/dashboard/src/api/types.ts
git commit -m "feat(dashboard): discovery DTO types"
```

---

## Task 15 — Frontend API client (react-query hooks)

**Files:**
- Create: `apps/dashboard/src/api/discovery.ts`

- [ ] **Step 1: Write the hooks**

```ts
// apps/dashboard/src/api/discovery.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { RecommendResponse, Theme } from './types';

export function useThemes() {
  return useQuery({
    queryKey: ['themes'],
    queryFn: () => apiFetch<{ themes: Theme[] }>('/api/themes').then(r => r.themes),
    staleTime: 24 * 60 * 60 * 1000,
  });
}

export function useChannelThemes(channelId: string | null) {
  return useQuery({
    queryKey: ['channel-themes', channelId],
    queryFn: () => apiFetch<{ themes: string[] }>(`/api/tracked-channels/${channelId}/themes`).then(r => r.themes),
    enabled: !!channelId,
  });
}

export function useUpdateChannelThemes(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (themes: string[]) =>
      apiFetch(`/api/tracked-channels/${channelId}/themes`, {
        method: 'PUT',
        body: JSON.stringify({ themes }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channel-themes', channelId] });
      qc.invalidateQueries({ queryKey: ['recommendations'] });
      qc.invalidateQueries({ queryKey: ['channel', channelId] });
    },
  });
}

export function useRecommendations(input: {
  targetChannelId: string | null;
  budget:          number;
  limit?:          number;
}) {
  return useQuery({
    queryKey: ['recommendations', input],
    queryFn: () =>
      apiFetch<RecommendResponse>('/api/recommendations', {
        method: 'POST',
        body: JSON.stringify({
          targetChannelId: input.targetChannelId,
          budget:          input.budget,
          limit:           input.limit ?? 20,
        }),
      }),
    enabled: !!input.targetChannelId && input.budget > 0,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/dashboard/src/api/discovery.ts
git commit -m "feat(dashboard): discovery react-query hooks"
```

---

## Task 16 — `<EditThemesModal />` component

**Files:**
- Create: `apps/dashboard/src/components/EditThemesModal.tsx`

- [ ] **Step 1: Write the modal**

```tsx
// apps/dashboard/src/components/EditThemesModal.tsx
import { useEffect, useState } from 'react';
import { useChannelThemes, useThemes, useUpdateChannelThemes } from '../api/discovery';

interface Props {
  channelId: string;
  channelTitle: string;
  open: boolean;
  onClose: () => void;
}

export function EditThemesModal({ channelId, channelTitle, open, onClose }: Props) {
  const { data: vocab } = useThemes();
  const { data: current } = useChannelThemes(open ? channelId : null);
  const update = useUpdateChannelThemes(channelId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (open && current) setSelected(new Set(current));
  }, [open, current]);

  if (!open) return null;

  const filtered = (vocab ?? []).filter(t =>
    !filter || t.title.toLowerCase().includes(filter.toLowerCase()) || t.slug.includes(filter),
  );

  const toggle = (slug: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold">Edit themes</h2>
        <p className="mb-4 text-sm text-gray-600">{channelTitle}</p>
        <input
          type="text"
          placeholder="Filter themes…"
          className="mb-3 w-full rounded-md border px-3 py-2 text-sm"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <div className="mb-4 max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
          {filtered.map(t => (
            <label key={t.slug} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-gray-100">
              <input
                type="checkbox"
                checked={selected.has(t.slug)}
                onChange={() => toggle(t.slug)}
              />
              <span className="text-sm">{t.title}</span>
              <span className="ml-auto font-mono text-xs text-gray-400">{t.slug}</span>
            </label>
          ))}
          {filtered.length === 0 && (
            <p className="p-2 text-sm text-gray-500">No themes match "{filter}"</p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            disabled={update.isPending}
            onClick={async () => {
              await update.mutateAsync(Array.from(selected));
              onClose();
            }}
            className="rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/dashboard/src/components/EditThemesModal.tsx
git commit -m "feat(dashboard): EditThemesModal — vocab search + checkbox select"
```

---

## Task 17 — `<TargetChannelPicker />` + `<BudgetInput />` components

**Files:**
- Create: `apps/dashboard/src/components/TargetChannelPicker.tsx`
- Create: `apps/dashboard/src/components/BudgetInput.tsx`

- [ ] **Step 1: TargetChannelPicker**

```tsx
// apps/dashboard/src/components/TargetChannelPicker.tsx
import { useChannelsQuery } from '../api/channels';

interface Props {
  value:    string | null;
  onChange: (id: string | null) => void;
}

export function TargetChannelPicker({ value, onChange }: Props) {
  const { data: channels, isLoading } = useChannelsQuery({ mine: true });

  if (isLoading) return <div className="text-sm text-gray-500">Loading channels…</div>;

  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value || null)}
      className="w-full rounded-md border px-3 py-2 text-sm"
    >
      <option value="">— pick a target channel —</option>
      {(channels ?? []).map(c => (
        <option key={c.id} value={c.id}>
          {c.title ?? c.username ?? c.id.slice(0, 8)}
        </option>
      ))}
    </select>
  );
}
```

(`useChannelsQuery` already exists in `apps/dashboard/src/api/channels.ts`. If
the signature doesn't accept `{ mine: true }`, extend it to filter client-side
with `channels?.filter(c => c.isMine)`.)

- [ ] **Step 2: BudgetInput**

```tsx
// apps/dashboard/src/components/BudgetInput.tsx
interface Props {
  /** Budget in kopecks (internal). */
  value:    number;
  /** Called with new kopecks value. */
  onChange: (kopecks: number) => void;
}

export function BudgetInput({ value, onChange }: Props) {
  const uah = value / 100;
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={1}
        step={10}
        value={uah || ''}
        onChange={e => {
          const n = parseFloat(e.target.value);
          onChange(Number.isFinite(n) ? Math.round(n * 100) : 0);
        }}
        className="w-32 rounded-md border px-3 py-2 text-right text-sm"
      />
      <span className="text-sm text-gray-600">UAH</span>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/TargetChannelPicker.tsx \
        apps/dashboard/src/components/BudgetInput.tsx
git commit -m "feat(dashboard): TargetChannelPicker + BudgetInput (UAH↔kopecks)"
```

---

## Task 18 — `<RecommendationsTable />` component

**Files:**
- Create: `apps/dashboard/src/components/RecommendationsTable.tsx`

- [ ] **Step 1: Write the table**

```tsx
// apps/dashboard/src/components/RecommendationsTable.tsx
import type { RecommendationItem } from '../api/types';

interface Props {
  items:        RecommendationItem[];
  targetThemes: string[];
}

export function RecommendationsTable({ items, targetThemes }: Props) {
  if (items.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-gray-500">
        No matches for this target / budget.
      </p>
    );
  }

  const targetSet = new Set(targetThemes);

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">Channel</th>
            <th className="px-3 py-2">Themes</th>
            <th className="px-3 py-2 text-right">Score</th>
            <th className="px-3 py-2 text-right">Price (UAH)</th>
            <th className="px-3 py-2 text-right">Subs/ad</th>
            <th className="px-3 py-2 text-right">F/M</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((r, idx) => (
            <tr key={r.id} className="border-t hover:bg-gray-50">
              <td className="px-3 py-2 font-mono text-xs text-gray-500">{idx + 1}</td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  {r.avatarUrl && (
                    <img src={r.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
                  )}
                  <div>
                    <div className="font-medium">{r.title}</div>
                    <a href={r.link} target="_blank" rel="noopener noreferrer"
                       className="font-mono text-xs text-blue-600 hover:underline">
                      @{r.slug}
                    </a>
                  </div>
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {r.themes.slice(0, 5).map(t => (
                    <span
                      key={t}
                      className={`rounded px-2 py-0.5 text-xs ${
                        targetSet.has(t) ? 'bg-blue-100 font-semibold text-blue-900' : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {t}
                    </span>
                  ))}
                  {r.themes.length > 5 && (
                    <span className="text-xs text-gray-400">+{r.themes.length - 5}</span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2 text-right font-mono">{(r.score * 100).toFixed(0)}%</td>
              <td className="px-3 py-2 text-right font-mono">{(r.priceMin / 100).toFixed(0)}</td>
              <td className="px-3 py-2 text-right font-mono">
                {r.estimatedSubsPerAd == null ? '—' : (r.estimatedSubsPerAd > 0 ? '+' : '') + r.estimatedSubsPerAd}
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {r.sexRatio == null ? '—' : `${r.sexRatio}/${100 - r.sexRatio}`}
              </td>
              <td className="px-3 py-2 text-right">
                <a
                  href={r.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline"
                >
                  Open ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/dashboard/src/components/RecommendationsTable.tsx
git commit -m "feat(dashboard): RecommendationsTable with matched-themes highlight"
```

---

## Task 19 — `/recommendations` route

**Files:**
- Create: `apps/dashboard/src/routes/recommendations.tsx`

- [ ] **Step 1: Write the route**

```tsx
// apps/dashboard/src/routes/recommendations.tsx
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { BudgetInput } from '../components/BudgetInput';
import { EditThemesModal } from '../components/EditThemesModal';
import { Layout } from '../components/Layout';
import { RecommendationsTable } from '../components/RecommendationsTable';
import { TargetChannelPicker } from '../components/TargetChannelPicker';
import { useChannelThemes, useRecommendations } from '../api/discovery';

export const Route = createFileRoute('/recommendations')({
  component: RecommendationsPage,
});

function RecommendationsPage() {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [budget, setBudget] = useState<number>(50_000); // 500 UAH default
  const [editOpen, setEditOpen] = useState(false);

  const { data: targetThemes } = useChannelThemes(targetId);
  const recs = useRecommendations({ targetChannelId: targetId, budget });

  return (
    <Layout>
      <h1 className="mb-6 text-2xl font-semibold">Recommendations</h1>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
            Target channel
          </label>
          <TargetChannelPicker value={targetId} onChange={setTargetId} />
          {targetId && (
            <button
              onClick={() => setEditOpen(true)}
              className="mt-2 text-xs text-blue-600 hover:underline"
            >
              Edit themes ({targetThemes?.length ?? 0})
            </button>
          )}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
            Budget
          </label>
          <BudgetInput value={budget} onChange={setBudget} />
        </div>
        <div className="flex items-end">
          <span className="text-xs text-gray-500">
            Sorted by theme match → ROI → price.
          </span>
        </div>
      </div>

      {targetThemes && targetThemes.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1">
          <span className="text-xs text-gray-500">Target themes:</span>
          {targetThemes.map(t => (
            <span key={t} className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900">
              {t}
            </span>
          ))}
        </div>
      )}

      {recs.isLoading && <p className="text-sm text-gray-500">Computing recommendations…</p>}
      {recs.error && <p className="text-sm text-red-600">Failed to load recommendations.</p>}
      {recs.data?.warning && (
        <p className="mb-4 rounded-md border-l-4 border-yellow-400 bg-yellow-50 p-3 text-sm">
          {recs.data.warning}
        </p>
      )}

      {recs.data && (
        <RecommendationsTable
          items={recs.data.recommendations}
          targetThemes={recs.data.targetThemes}
        />
      )}

      {targetId && editOpen && (
        <EditThemesModal
          channelId={targetId}
          channelTitle="Target channel"
          open={editOpen}
          onClose={() => setEditOpen(false)}
        />
      )}
    </Layout>
  );
}
```

- [ ] **Step 2: Regenerate route tree**

The TanStack Router plugin will detect the new file. Run the dev server briefly to regenerate:

```bash
cd apps/dashboard
pnpm dev &
DEV_PID=$!
sleep 5
kill $DEV_PID 2>/dev/null
git diff src/routeTree.gen.ts
```

If `routeTree.gen.ts` has been updated (it will list `/recommendations`), commit it in the next step.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/routes/recommendations.tsx \
        apps/dashboard/src/routeTree.gen.ts
git commit -m "feat(dashboard): /recommendations route with target picker + budget + table"
```

---

## Task 20 — Wire EditThemesModal into channel detail

**Files:**
- Modify: `apps/dashboard/src/routes/channels.$id.tsx`

- [ ] **Step 1: Add modal trigger to channel detail page**

In `apps/dashboard/src/routes/channels.$id.tsx`, find the channel header section and add an "Edit themes" button + modal:

```tsx
// Near the imports
import { useState } from 'react';
import { EditThemesModal } from '../components/EditThemesModal';
import { useChannelThemes } from '../api/discovery';

// Inside the component, after existing useState/useQuery calls:
const [themesOpen, setThemesOpen] = useState(false);
const { data: channelThemes } = useChannelThemes(channelId);

// In the JSX, near the channel title:
<button
  onClick={() => setThemesOpen(true)}
  className="ml-3 rounded-md bg-gray-100 px-3 py-1 text-xs hover:bg-gray-200"
>
  Edit themes ({channelThemes?.length ?? 0})
</button>

// At the bottom of the component return:
{themesOpen && (
  <EditThemesModal
    channelId={channelId}
    channelTitle={channel?.title ?? channelId}
    open={themesOpen}
    onClose={() => setThemesOpen(false)}
  />
)}
```

(Exact placement depends on the existing JSX. Insert after channel header / title, before charts.)

- [ ] **Step 2: Commit**

```bash
git add apps/dashboard/src/routes/channels.\$id.tsx
git commit -m "feat(dashboard): Edit themes button on channel detail page"
```

---

## Task 21 — Add nav link in Layout

**Files:**
- Modify: `apps/dashboard/src/components/Layout.tsx`

- [ ] **Step 1: Add the link**

Find the nav element in `Layout.tsx` (with existing links to `/channels`, `/graph`, etc.) and add:

```tsx
<Link
  to="/recommendations"
  className="rounded-full px-4 py-1.5 text-sm transition hover:bg-gray-100 [&.active]:bg-black [&.active]:text-white"
>
  Recommendations
</Link>
```

- [ ] **Step 2: Commit**

```bash
git add apps/dashboard/src/components/Layout.tsx
git commit -m "feat(dashboard): nav link to /recommendations"
```

---

## Task 22 — Frontend smoke test

Manual verification end-to-end.

- [ ] **Step 1: Pre-flight (strategies stripped — see § Cost-safe local dev)**

- [ ] **Step 2: Start backend + frontend**

```bash
# Terminal 1
pnpm db:up
pnpm dev:automation

# Terminal 2
cd apps/dashboard
pnpm dev
```

- [ ] **Step 3: In browser**

1. Open `http://localhost:5173`
2. Log in (Telegram Login, existing flow)
3. Navigate to `/recommendations`
4. Pick a target channel from the dropdown
5. Click "Edit themes" → select 3-5 themes (e.g. motivaciya-i-samorozvitok, cikavi-fakti, tsutatu) → Save
6. The recommendations table should populate within a couple seconds
7. Confirm: rows sorted by score, matched themes highlighted in blue, price displayed in UAH
8. Adjust budget — table re-queries and re-ranks

If everything works, no commit needed (smoke test only).

---

## Task 23 — Push the branch

- [ ] **Step 1: Verify all commits**

```bash
git log --oneline feat/graph-and-roi..HEAD | head -30
```

Should show ~22 commits (one per task above + spec + initial merge).

- [ ] **Step 2: Push**

```bash
git push origin feat/graph-and-roi
```

CI on dev-stage will not auto-deploy (deploy-dev only triggers on push to
`develop`), so prod / dev-stage remain on the current `develop` HEAD until you
merge.

---

## Cost-safe local dev

When you run `pnpm dev:automation` during this work, the scheduler will try to
fire all the strategies in `channels.local.json`. To prevent posting and
Claude API spend during smoke tests, **strip the strategies array** before
starting the automation and restore it when done:

```bash
# Strip
cp apps/automation/config/channels.local.json apps/automation/config/channels.local.before-discovery.json
python3 -c "
import json
with open('apps/automation/config/channels.local.json') as f: c = json.load(f)
c['strategies'] = []
with open('apps/automation/config/channels.local.json', 'w') as f: json.dump(c, f, indent=2, ensure_ascii=False)
"

# Run + test

# Restore
mv apps/automation/config/channels.local.before-discovery.json apps/automation/config/channels.local.json
```

If you forget to restore, the next `pnpm dev:automation` boots with empty
strategies (no posts, no costs). The full backup file
`channels.local.full-backup.json` from the earlier session is also available.

---

## Self-review

**Spec coverage:**
- Architecture diagram → Task 12 (module wiring) + Task 19 (route) ✓
- Data model (candidate_channels + tracked_channels.themes) → Task 1 ✓
- TeleAds endpoints + pagination → Task 6 ✓
- Product field mapping → Task 7 ✓
- Daily cron → Task 8 ✓
- Scoring formula (Jaccard) + tie-breakers (ROI desc, price asc) → Task 3 + 9 ✓
- SQL pre-filter with theme && operator → Task 4 ✓
- 4 endpoints (themes, get/set channel themes, recommendations) → Task 10 + 11 ✓
- Frontend route + EditThemesModal + table → Tasks 16-19 ✓
- Smoke tests → Tasks 13 + 22 ✓
- Out-of-scope features explicitly absent ✓

**Placeholder scan:** none found — every step contains complete code or exact
commands.

**Type consistency:** `RecommendationItem` fields match across
recommendations.types.ts, recommendations.service.ts, dashboard/api/types.ts,
RecommendationsTable.tsx. ✓

**Open assumption that needs verification during implementation:**
- The dashboard's `useChannelsQuery` may not accept `{ mine: true }` — Task 17
  notes the fallback (client-side filter). Check the existing hook signature
  before writing TargetChannelPicker.
- `apps/dashboard/src/api/client.ts`'s `apiFetch` helper exists from Phase 2;
  if its signature differs (e.g. expects path-only), adjust hooks accordingly.
- The TrackingAuthGuard's local-dev escape hatch (bearer fallback vs
  cookie-only) determines whether Task 13 step 5 works as-is.
