Act as the **`source-researcher`** agent defined in `.cursor/agents/source-researcher.md`.

**User context (fill in or infer):** paste the target URL(s) and what data you need.

## Required workflow

1. Research the source (HTTP vs client-rendered vs JSON API; use browser / Playwright MCP when needed).
2. Output a full **`## Source Spec`** using the template from the agent file.

## Mandatory closing sections (always include)

### 1. `## Recommendations for database-agent`

- Whether **`database/init.sql`** changes are needed (`SCHEMA_CHANGE_REQUIRED` vs fits existing table).
- If schema work is needed: proposed table/columns, uniqueness / `ON CONFLICT` key, indexes, and impact on existing loaders or automation queries.
- If no schema change: name the **existing table(s)** and any column mapping notes.

### 2. `## Commands to parse and load (pipeline)`

From repo root, suggest **concrete** `pnpm` commands. Use **only** scripts that exist in `apps/pipeline/package.json` (adjust names if the spec implies a new `parse:*` / `load:*` you will add later).

**Typical patterns:**

- Full refresh (heavy): `pnpm --filter pipeline run sync`  
  (runs `parse` then `load:all`; requires Postgres up and `.env` configured.)

- Schema first (if needed): `pnpm --filter pipeline run init-db`  
  or reset: `pnpm --filter pipeline run init-db:reset` (destructive).

- Targeted examples (pick what matches the spec):

  - `pnpm --filter pipeline run parse:academy`
  - `pnpm --filter pipeline run parse:md`
  - `pnpm --filter pipeline run parse:mcpservers`
  - `pnpm --filter pipeline run parse:samorozvytok`
  - `pnpm --filter pipeline run load`
  - `pnpm --filter pipeline run load:prompts`
  - `pnpm --filter pipeline run load:daytoday`
  - `pnpm --filter pipeline run load:recipes`
  - `pnpm --filter pipeline run load:facts`
  - `pnpm --filter pipeline run load:pdr`
  - `pnpm --filter pipeline run load:tg-posts`

- Safer smoke tests when applicable: `LOAD_LIMIT=5` / `PARSE_LIMIT=3` variants if those scripts exist for the chosen loader/parser.

State **prerequisites**: Docker Postgres (`pnpm db:up` or `docker compose up -d postgres`), and that **`pnpm install`** was run at repo root.

**Do not** implement parsers or loaders in this command—spec and recommendations only.
