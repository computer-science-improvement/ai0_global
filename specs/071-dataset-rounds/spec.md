# 071 — Dataset repeat in rounds (in order or random)

Status: planned · Builds on 058 (data store), 023 FR-010 / migration 060 (content ledger), 083 (`post_requires`), 061 (ledger anchors) · Migration 096

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

## Why

The owner asked for this on 2026-10-26:

> для контенту — баз даних додай налаштування, яке буде дозволяти повторення контенту і тип повторення — по черзі, або рандомно, але тільки після того як все було опубліковано, тобто якщо вибрано рандомно, то у список буде потрапляти те, що раніше не публікувалось, і коли буде опубліковане останнє, то тоді починається заново.

Today a dataset's `reuse_policy` is `never` (each row once per channel, for ever) or `after_days N` (a row may return N days after its own last post, whether or not the rest was posted).

**The pdr case.** @pdr_dev_channel used all 866 rows of `pdr_questions` by June and has had no material since. With `after_days` a row returns on its own clock, so the order is broken and repeats can come before unposted rows.

**What the owner wants are rounds.**
- Every row is posted once on a channel.
- Then a new round starts and every row is available again.
- Within a round, the rows go either in a fixed order ("по черзі") or at random among the rows not yet posted in this round.

The lead's code map is at `<scratchpad>/r5/map-071-dataset-rotation.md`. It has file:line anchors, the full SQL inventory and the migration traps. Where it and this spec differ, this spec wins.

## What

### FR-001 The policy

`reuse_policy` gets a third kind:

```json
{ "kind": "cycle", "order": "sequential" | "random", "order_by": ["ticket_number", "question_num"] }
```

- `order` defaults to `random`.
- `order_by` is optional: 1–3 field names of the dataset, scalar types only (int, number, date, datetime, month_day, text, enum). Without it, sequential order is import order (`data_items.id`).

**Validation.**
- In zod: `reusePolicySchema` in `data/data.types.ts`. `schemaInputSchema` and `DataStore.updateSchema` check that every `order_by` name is an existing scalar field.
- In SQL: an IMMUTABLE `data_reuse_policy_valid(jsonb)` replaces the inline CHECK. Find that CHECK by its definition in `pg_constraint`; it is a PG default name.

**Versioning.** `schema-versioning.ts:81` adds `reuse_policy` and `post_requires` to the description-only change keys, so a reuse-only edit previews as a change.

### FR-002 Rounds

A round is per dataset and **per resource**, like today's dedup: the same row may go to two channels.

**Storage.** A new table:

```sql
data_reuse_rounds (
  schema_id    uuid REFERENCES data_schemas(id) ON DELETE CASCADE,
  resource_ref text,
  round        int NOT NULL DEFAULT 1 CHECK (round >= 1),
  started_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schema_id, resource_ref)
)
```

- No row means round 1 with no start, so every earlier publication counts in round 1.
- Grant SELECT to `editor_ro`, as in 060.

**What blocks a row in a cycle dataset:**
- A `published` ledger row on the same resource with `used_at > started_at` of that resource's round blocks it, in resource scope.
- A new ledger status `passed` does the same, but only in resource scope and only for cycle datasets (FR-004).
- `error` rows block everywhere, as today.
- `shadowed` rows block on the same resource for 7 days, as today.

**Network scope** ("unposted network-wide", used only by `data_schema_stats_refresh`): a row counts as posted when some resource published it within that resource's current round. `passed` never counts network-wide.

**SQL changes.** Never change a ledger function signature. A rerun of 060 in CI would re-create the old form as a second overload (094:50-52 explains this).
- **New helpers:** `content_reuse_at(policy, since)` and `content_ref_reuse_at(source_ref, row_resource)`. They add `since` (the round start of the ledger row's own resource) into the policy JSON.
- **`content_ledger_blocks`:** same signature, now STABLE (the cast of `since` is STABLE). It gets the `cycle` and `passed` branches.
- **Re-created to pass the round start of `l.resource_ref`:** `content_ledger_blocking`, `content_ledger_used` and `data_schema_stats_refresh` (the 083 body plus rounds).

### FR-003 When a round ends

**`data_round_roll(schema_id, resource_ref) → boolean`** is plpgsql, VOLATILE, under `pg_advisory_xact_lock` per (dataset, resource).
- It returns false unless the dataset is a cycle dataset and the resource is real (not blank, not `*`).
- **Open rows.** A row is open when it is active and `data_postable`, is not done in this round on the resource (no `published` or `passed` with `used_at > started_at`, by `data://` ref or `legacy_ref`), is not error-marked anywhere, and is not held by an `awaiting_approval` / `approved` slot or an awaiting platform post on the resource.
- **The rule.** When no row is open and at least one row is done in this round, the next round starts: `round + 1`, `started_at = now()`, and it returns true. "At least one done" means an empty or all-unpostable dataset never loops.
- Match the dataset key with `split_part(substr(source_ref, 8), '/', 1)`, never `LIKE`, because `_` is a wildcard.

**Who calls it:**
1. **A trigger on `content_ledger`.** It fires `AFTER INSERT OR UPDATE OF used_at` when the row is `data://` and `published` or `passed`, and rolls if the dataset is a cycle dataset. Errors are swallowed with a WARNING, like the 060 triggers. This covers every writer, the SQL-only ones included.
2. **A trigger on `data_schemas`.** It fires `AFTER UPDATE OF reuse_policy` when the kind becomes `cycle`. It deletes the dataset's rounds, then rolls every resource that has `published` or `passed` rows of the dataset. Switching `pdr_questions` to cycle therefore frees all 866 rows on @pdr_dev_channel in the same update.
3. **TS, when a read finds nothing.**
   - `buildCatalog` with a resource: a cycle dataset with `unposted_here = 0` and postable rows → roll, then recount.
   - `runQueryData`: 0 rows with `unposted_on` on a cycle dataset → roll, then re-query.
   - These run only on zero, so they are cheap. `executorContext`'s `unposted` goes through `buildCatalog`, so a required library series is never skipped as empty after a roll.

### FR-004 Rows that cannot be posted do not block a round

**`content_ledger_pass(resource, ref, origin, slot, note)`** records a `passed` row only when the ref is a `data://` row of a cycle dataset. For other datasets it does nothing.

**`ContentLedger.pass(ref, {...})`** calls it. `LEDGER_STATUSES` and the `LedgerVerdict` union gain `passed`, and the pre-flight verdict text gains «пропущене в цьому колі».

**It is written by:**
- **The fallback ladder.** When a `data://` source enters `avoid` after a non-fixable failure (`editor-runner.service.ts` ~:509 and ~:582), the new runner dep `passRow(slot, ref, reason)` is called. It is wired next to `deadSource` in `editor.module.ts`.
- **`skip_slot`.** It gets an optional `ref` (`CONTENT_REF_RE`): «рядок бібліотеки, з якого пост неможливий» → `pass`. Spec 068 adds a required `cause` to the same tool in parallel; add only `ref`, and the lead merges the two.

A passed row comes back in the next round.

### FR-005 Order

**Sequential:**
- **Query order.** In `queryDataset`, when `unpostedOn` is set and the dataset is cycle/sequential, the ORDER BY is the round order. That is `order_by` (typed like the filter SQL, numbers through a `jsonb_typeof` guard, NULLS LAST), then `d.id`. It overrides `order`.
  - Filters and search still apply, so "next" means next within the filter.
  - `search_library` inherits this.
- **The tool result.** `runQueryData` returns `repeat: { order, round }` and `next: rows[0].ref`, with the note «датасет іде по черзі — бери перший рядок».
- **The executor.** `ScheduleService.executorContext` gets a new dep `nextRow(resource, table, category)`. For a slot whose series or pin source is `library:<cycle/sequential table>`, it adds «Матеріал цього слота — наступний по черзі рядок data://…; бери саме його».
- **The guard.** `ScheduleService.publishGuard` refuses `not_next_in_order` («серія бере рядки по черзі; наступний — data://…»). This applies only to series slots whose library source is that dataset, when `library_ref` ≠ `nextRow` (within the series category). Free posts and chat posts are not ordered; they still count as done in the round.

**Random:**
- The open rows in `ORDER BY random()`.
- Rows published on the resource within the last 7 days go last, so the last row of round k is not the first of round k+1.

### FR-006 Agent-facing text

- **`reuseText`** for cycle: «кожен рядок — раз на канал за коло; коли все опубліковано тут, починається нове коло; порядок: по черзі | випадково».
- **`library_catalog` entries** get `repeat: { order, round }`.
- **`catalogPromptSummary`** shows a cycle dataset as «• pdr_questions: … — по колу (по черзі), коло 2: лишилось 840 з 866».
- **`runwayDays`** is null for cycle datasets, and `checkLowRunway` skips them: a round never runs out.
- **The zero-hit note** of `query_data` also says when every row is unpostable.

### FR-007 The owner's setting

**Dashboard** (all text in English):
- **The Reuse field** (`components/data/SchemaEditor.tsx` `ReuseInput`) offers four options:
  - "Never again";
  - "After N days";
  - "Repeat in rounds — in order";
  - "Repeat in rounds — random".

  The hint reads: "Every row is posted once on each channel; when all are posted, a new round starts." For "in order", an optional "Order by" select of the dataset's scalar fields, default "Import order".
- **The dataset page** (`routes/app.data_.$key.tsx`):
  - for cycle datasets, a Rounds panel with one row per resource: round N, done X of Y, next ref (sequential), and a "Restart round" action behind a confirm;
  - the Unposted tile reads "in current rounds".
- **`api/data.ts`.** The `ReusePolicy` union, `useDatasetRounds(key)` and the restart mutation. `lib/data-store.ts` `reuseLabel()` is unit-tested.
- **Robustness.** Keep the page working when the rounds endpoint 404s: hide the panel.

**API** (`data/data.controller.ts`):
- `GET /api/data/schemas/:key/rounds` returns per resource `{ resource_ref, round, started_at, done, open, total, next }`;
- `POST /api/data/schemas/:key/rounds/restart` with `{ resource_ref }` starts the next round now.

**Chat.** `edit_data_schema` gets a `reuse` target: the owner applies it on a card, through the same `applyDataSchemaSuggestion` path. So «давай pdr_questions по колу по черзі» works from the agent chat.

### FR-008 Export and docs

- **Export.** `scripts/export-agent-history.sh` dumps `data_reuse_rounds`.
- **Runbook § 30.** What rounds are, how to switch, and what happens at the switch. After deploy the owner sets `pdr_questions` to "Repeat in rounds — in order" with order by `ticket_number`, `question_num`. If a later import changed the order, the owner checks the numbering first.

## Migration 096 traps

These are taken from the code map; read it.

- **No stats refresh call.** `data/post-requires.migration.pg.test.ts` applies every migration except 083 before 083. So 096 must not call `data_schema_stats_refresh()` and must not define SQL-language functions that reference `data_postable`, `post_requires` or `rows_unpostable`. Put those inside plpgsql bodies.
- **Idempotent and lexically last.** `database/ci-bootstrap-check.sh` re-applies 042+ in lexical order (060 and 083 run again before 096). 096 must be idempotent and must leave the final bodies in place.
- **Constraints.** Drop the inline CHECKs by looking up their definitions in `pg_constraint`, and keep 094's anchor check.
- **The down file** restores the 060 and 083 bodies and both CHECKs, deletes `passed` rows, sets cycle policies to `never`, and drops the triggers, functions and table.

## Out of scope

- Network-wide rounds (one post of a row per network per round).
- A per-round history table. The ledger keeps one row per (resource, ref, status), so the latest `used_at` wins.
- An `import_list` reuse argument. New datasets start as `never`, and the owner changes them in the dashboard or by card.

## Acceptance

**PG tests** (`data/data-rounds.pg.test.ts`, own datasets with a test prefix):
- round 1: a published row blocks, the others are open;
- publishing the last open row starts round 2, and every row is open, including the one just posted;
- rows added mid-round are open;
- hidden, unpostable and error-marked rows do not keep a round open;
- an empty or all-unpostable dataset never rolls;
- a waiting slot's row does not keep the round open;
- `passed` ends a round, blocks only in the current round on that resource and never network-wide;
- `pass` ignores non-cycle datasets;
- switching a fully used dataset (pdr-like, `used_at` months ago) to cycle frees it at once, and switching back to `never` blocks it again;
- rounds are per resource;
- network stats count only current rounds;
- two concurrent publishes of the last row start one round;
- the restart endpoint;
- the down file and a re-apply.

**Unit tests:**
- the policy schema and the `order_by` checks;
- the round order SQL (typed casts);
- `query_data` sequential order only with `unposted_on` on a cycle/sequential dataset, with `next` and the note;
- the lazy roll on zero;
- catalog text, summary line and runway null;
- `executorContext` next-row line;
- `publishGuard` `not_next_in_order` for series slots only (category-scoped; free posts allowed);
- `passRow` called for a non-fixable `data://` failure and not for a fixable revise;
- `skip_slot` `ref` → `pass`;
- dashboard `reuseLabel` / `schemaPatch` with a cycle policy.

`ContentLedger.check`, `query_data`, `library_catalog` and the pre-flight behave exactly as before for `never` and `after_days` datasets; the existing tests stay green. `npm test`, `npm run build` and the dashboard checks pass.

## Amendments after the builder check

The builder check (2026-10-27) found gaps. These rules override the body.

**A1. The stats function in migration 096.**
- 096 creates the round-aware `data_schema_stats_refresh` only when `data_schemas.post_requires` exists. Wrap it in a `DO` block that checks `information_schema.columns` and runs the `CREATE` through `EXECUTE`.
- Without the column, the 060 body stays, so `post-requires.migration.pg.test.ts:77` keeps working.
- The down file restores the 083 body under the same guard.
- Every "apply all migrations but X first" test must keep working.

**A2. `passRow` (FR-004).** This replaces "when a `data://` source enters avoid".
- `passRow(slot, libraryRef, reason)` gets the failed post's own `library_ref`: from `postSpec.library_ref` or `platformSpec.library_ref` of the slot, or from the spec the `PublishProbe` captured. It never uses `sourceOf()`.
- It is called only for:
  - a critic reject that is not fixable (after 067's `isFixableRevise`);
  - a failed `revise_source` step;
  - `quiz_answer_mismatch`.
- It is never called for guard or lint codes: `not_next_in_order`, `library_item_already_posted`, `series_source_mismatch`, `lint_failed`, `too_similar`.
- Add a test where the post has both a `library_ref` and a `source.url`.
- `passRow` and `ContentLedger.pass` are best-effort: catch and log errors.

**A3. The `not_next_in_order` guard (FR-005).**
- The guard applies only when `refDataset(library_ref)` is the series' table and `nextRow` is not null.
- Before comparing, canonicalise `library_ref` (`library://` → `data://`) with `content_ref_canonical` or `ContentLedger.canonical()`.
- A post without a `library_ref`, or with one from another dataset, is not this guard's concern; `seriesSourceMismatch` already handles required sources.
- The classification of the code is in 068 (`CONTENT_FAILURE_CODES`, `RULES` `lint` group, streak `other`).
- The series note for a sequential slot says it overrides any planner `data://` hint in «Підказки джерел».
- When `nextRow` finds nothing on a cycle dataset, call `data_round_roll` and query again, as `runQueryData` does.

**A4. Order by (FR-007).** For "in order", show up to three ordered selects over the dataset's scalar fields: «Order by», then «Then by» twice. The default «Import order» sends no `order_by`.

**A5. The `data_schemas` trigger (FR-003).**
- It fires only `WHEN (NEW.reuse_policy->>'kind' = 'cycle' AND OLD.reuse_policy->>'kind' IS DISTINCT FROM 'cycle')`.
- A change of `order` or `order_by` keeps the rounds.
- For each resource, take the advisory lock before deleting or upserting its rounds row, in the same order as `data_round_roll`.

**A6. Down-file test.**
- `data/data-rounds.migration.pg.test.ts` builds its own throwaway database (`init.sql` plus all migrations, in the style of `post-requires.migration.pg.test.ts`).
- It applies the 096 down file, checks that the 060/083 bodies and both CHECKs are back, then re-applies 096.
- The down file never runs against the shared `EDITOR_PG_TEST_URL` database.

**A7. The row's own source URL, lead decision.**
- `sourceGuard` skips the `source.url` ledger check when `spec.library_ref` names a row of a cycle dataset that the ledger allowed for this post (open in the current round).
- Reason: the library row is the material and the URL is a citation. pdr posts cite law clauses (061 anchors), and the pdr_rules rows of spec 070 carry `source_url`. Without this rule, round 2 would be refused with `source_already_posted`.
- `never` and `after_days` datasets keep today's check.
- Test: a cycle-dataset row in round 2 whose post cites a URL used in round 1 passes. The same post under a `never` dataset is refused.

**A8. `edit_data_schema` `reuse` target.**
- `EditSchemaInput` gains `reuse: ReusePolicy`, required when `target = 'reuse'`.
- `old_text` must equal `reuseText` of the current policy. `new_text` is derived as `reuseText(reuse)`; the agent does not supply it.
- The dedupe key is `target='reuse'`, `field=''`.
- `DataSuggestions` `what()` shows «Reuse». `api/data.ts` `DataSuggestion.target` gains `'reuse'`.
- `order_by` is validated in `applyDataSchemaSuggestion` through `updateSchema`.
- `ActionCard` changes only the `edit_data_schema` label, if anything (069 edits that file).

**A9. SQL details.**
- A real resource is not blank and does not match `':\*$'` (the legacy wildcard is `telegram:*`). Skip such refs in the switch trigger and the rounds API.
- A round starts at `clock_timestamp()`, not `now()`, so the row just posted is still open in the new round under the strict `>`.
- Code that runs before 096 is applied queries `data_reuse_rounds`, or calls `data_round_roll` or `content_ledger_pass`, only for cycle datasets. The old CHECK forbids cycle, so none exist before 096.
- "Same signature" also means the same `RETURNS` and `OUT` columns for `content_ledger_blocking` and `content_ledger_used`.
- The SQL validator accepts `{kind:'cycle'}` with no `order` and treats it as random. Use `order_by` names only through `lit()` and `FIELD_NAME_RE`.
- `queryDataset`'s `withTotal` slices off only the last two params. A new `ORDER BY` placeholder (the 7-day tail's resource) reuses the CTE's existing `rr` placeholder.
- The file is `096_data_reuse_rounds.sql`, with its down file, and schema_migrations `096_data_reuse_rounds`. The code map's `095` is wrong.
- Down file order:
  1. drop the triggers;
  2. `UPDATE` cycle → never and `DELETE` the `passed` rows;
  3. drop the new CHECKs and re-add the old ones;
  4. drop `data_reuse_policy_valid` after the CHECK that depends on it;
  5. restore the 060/083 bodies;
  6. drop `content_reuse_at` / `content_ref_reuse_at`.

**A10. Agent side.**
- The lazy roll and `next` run only when `refs` is absent (068's `refs` path).
- The «пропущене в цьому колі» text goes in `sourceUsedDetails` and in 068's `data://` pre-flight check, not in `assessUrl`.
- `skip_slot` takes `ref` together with 068's `{reason, cause, code?}`. A ref-skip carries any cause.
- The lazy roll in `buildCatalog` also serves 068's pre-flight.
- Thread `repeat` through `CatalogEntry` → `summarize()` / `CatalogSummary` → `CatalogOverviewRow`, so that `catalogOverview`, `datasetUsage` and `checkLowRunway` return null runway and `catalogPromptSummary` prints the round line.
- With `order=random`, the 7-day tail comes first in `ORDER BY`. An explicit `newest` or `oldest` from the agent is kept. Sequential overrides `order`.
- Schema versioning compares `reuse_policy` with sorted keys: jsonb reorders keys.

**A11. Rounds API.**
- GET lists resources from `data_reuse_rounds` plus the distinct `resource_ref`s that have published or passed `data://` rows of the dataset, minus `:*` refs.
  - `total` = active postable rows;
  - `done` = rows published or passed after `started_at`;
  - `open` = as in `data_round_roll`.
- Restart normalises `resource_ref` with `ledgerResource()`, takes the same advisory lock, and inserts round 2 when no row exists.
- `app.data.tsx` (the dataset list, around line 80) also shows an Unposted number. Use the same «in current rounds» wording there for cycle datasets.
- Build the Rounds panel to the owner's compact card + details dialog rule (`CompactCard`).

**Merge order.** 071 merges last, after 067, 068, 070 and 069.

## Status

- T1 done — migration 096 (+ down): policy validator and CHECK, `passed` status, `data_reuse_rounds`, `content_reuse_at` / `content_ref_reuse_at`, `content_ledger_blocks` (STABLE; cycle + passed), the re-created `content_ledger_blocking` / `content_ledger_used` / `data_schema_stats_refresh` (guarded by the `post_requires` column), `data_round_roll`, `content_ledger_pass`, both triggers; `ReusePolicy` union, zod and `order_by` checks (`schemaInputSchema`, `DataStore.updateSchema`), `ContentLedger.pass`, `LEDGER_STATUSES`, schema-versioning keys with sorted-key compare; PG tests (`data-rounds.pg.test.ts`, `data-rounds.migration.pg.test.ts`) and unit tests (`data-rounds.test.ts`) (one commit, see the log).

## Deltas from the spec

- T1: `data_reuse_policy_valid` keeps the old CHECK's leniency for `after_days` with no `days` (the 058 CHECK allowed it; a stricter one could fail the migration on an odd row); when `days` is present it must be an integer in 1–3650. It uses CASE, not AND, wherever a cast follows a type test (SQL does not promise to stop at the first false).
- T1: both PG test files create their own database next to `EDITOR_PG_TEST_URL` (`createMigratedDb` of the 055 sysadmin tests), including `data-rounds.pg.test.ts`: the shared scratch database stays at 094, so it cannot run the new SQL, and the rule «code that runs before 096 queries the rounds table only for cycle datasets» keeps the PG tests of the shared database green.
- T1: `content_ledger_pass` returns true whenever the ref is a `data://` row of a cycle dataset (a first record or a repeat that moves `used_at` forward), not only for a new ledger row. `ContentLedger.pass` is best-effort (A2): an error, also from a database without 096, is logged and returns false.
- T1: `content_ledger_blocking` orders `error, published, passed, shadowed`.
