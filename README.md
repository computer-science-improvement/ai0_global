# AI0 Global

Автоматизація контент-каналів: парсинг, обробка даних, генерація та публікація контенту.

## Структура

```
ai0_global/
├── apps/
│   ├── automation/              # NestJS — стратегії, scheduler, публікація
│   └── pipeline/                # Увесь код і дані під src/
│       ├── package.json
│       └── src/
│           ├── parsers/, loaders/, tg/, lib/
│           ├── data/            # raw / normalized / publish-ready
│           ├── config/, docs/
│           └── tools/           # normalize-data.js, additional-data/scripts
├── database/
│   └── init.sql                 # SQL schema bootstrap
├── docker-compose.yml
└── .env.example
```

## Setup

1. **Install dependencies**

   ```bash
   pnpm install
   ```

2. **Environment**

   Copy `.env.example` to `.env` and set PostgreSQL credentials and API keys.

3. **Database**

   ```bash
   docker compose up -d postgres
   cd apps/pipeline && pnpm run init-db
   ```

4. **Load data**

   ```bash
   cd apps/pipeline && pnpm run load:all
   ```

## Scripts (pipeline)

- `pnpm run init-db` — initialize DB schema from `database/init.sql`
- `pnpm run init-db:reset` — drop and recreate schema
- `pnpm run parse` — run all parsers
- `pnpm run load:all` — load all data into DB
- `pnpm run load:daytoday` — load daytoday.ua content

## Data lifecycle (`apps/pipeline/src/data`)

- `raw/` — scraper/parser raw outputs
- `normalized/` — normalized datasets consumed by loaders
- `generated/` — intermediate generated datasets
- `publish-ready/` — final prepared assets for publishing channels

## Scripts (automation)

- `pnpm run dev` — run NestJS in dev mode
- `GET /trigger/:type` — manually trigger a strategy (dev only)

## Libs

- **pg** — direct PostgreSQL connection
- **axios** — HTTP requests
- **cheerio** — HTML parsing
- **dotenv** — environment variables
