# 075 — Datasets declare how they post

Status: draft · Builds on 058 (data store), 083 (`post_requires`), 068, 069 (import bundle), 071 (rounds), 072 (doctor), 073 (reasons catalogue, series-format lock) · Migration 099 · Linear AI0-253

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

## Why

The owner asked on 2026-10-27 (review `docs/reviews/2026-10-27-channel-onboarding.md`):

> «мені потрібно щоб коли я додаю новий канал то це було просто, швидко і зручно, щоб не доводилось 2 тижні дебажити його роботу»

Two young channels lost weeks to dataset problems:

- **@ai0_prompts_dev.** PromptHero rows had no prompt text, but they were counted as material (4 764 rows). A change_source card said "Checked now: 4764 rows" for a dataset with no postable rows. «бери з nanobanana» became a skill, not a series source. Then 8 of 9 Prompt slots skipped (`series_source_mismatch`, `origin_mismatch`, `prompt_text порожній`).
- **@pdr_dev_channel.** A poll went out without a correct answer (post 1725). `pdr_questions` was on reuse `never`. All 866 rows were used and the channel was dark for about 10 days. On 10-27 the brief got `correct_answer_num` off by one.

The common root: a dataset does not say how a post is made from a row. That knowledge sits in four other places:

- code maps keyed by legacy names: `PDR` (`apps/automation/src/editor/post/quiz-ground-truth.ts:5`), `RETELL_SOURCES` (`post/verbatim-guard.ts:13-18`), `DATASET_FORMATS` (`network/series.ts:111`), the `LEDGER_REUSABLE_HOSTS` default (`data/ledger-anchor.ts:14`);
- briefs in prose ("correct_index з correct_answer_num");
- `post_requires`, which the dashboard cannot set (no `post_requires` anywhere in `apps/dashboard/src`);
- a reuse default of `never` (`data/data.types.ts:152`, `components/data/ImportWizard.tsx:103`, `editor/docs/import-list.ts:153-154`).

This spec closes:

- **F04** rows that cannot be posted are counted as material;
- **F05** reuse defaults to `never`, so a dataset runs out silently;
- **F15** the answer key's base lives in prose, and ground truth exists only for `pdr_questions`;
- **F19** (order part) clause numbers sort lexically, and "1.10" is read as the number 1.1;
- **F26** content guards are keyed by legacy dataset and host names.

The fix: a dataset gets a **publish profile**. Guards, the writer's rows, the import, the doctor and a one-tap "Use in a channel" card all read it.

## What

### FR-001 The publish profile (migration 099)

- `database/migrations/099_dataset_publish.sql` adds the column and its check:
  ```sql
  ALTER TABLE data_schemas ADD COLUMN IF NOT EXISTS publish JSONB NOT NULL DEFAULT '{}';
  -- data_publish_valid(p jsonb, p_fields jsonb) IMMUTABLE: p is an object; format and text_use are from their
  -- lists or absent; answer_key.base is 0 or 1; every field the profile names exists in p_fields
  -- (jsonb_path_query 'lax $.answer_key.options_field[*]', '$.answer_key.correct_field', '$.media_field',
  --  '$.retell_fields[*][*]', '$.credit_fields[*]').
  -- Constraint data_schemas_publish_check CHECK (data_publish_valid(publish, fields)), added in a DO block
  -- only when pg_constraint has no row of that name (083:69-75 pattern).
  ```
- `database/migrations/down/099_dataset_publish.sql` drops the constraint, the function and the column (all `IF EXISTS`), and deletes its `schema_migrations` row. Running it twice is harmless.
- `PublishProfileSchema` sits in `data/data.types.ts`, next to `postRequiresSchema` (:139). Helpers go in the new `data/publish-profile.ts`, which imports the types; this avoids an import cycle.
  ```ts
  export const PUBLISH_FORMATS = ['quiz', 'poll', 'text', 'photo'] as const;
  export const TEXT_USES = ['verbatim', 'retell', 'cite'] as const;
  export const PublishProfileSchema = z.object({
    format:         z.enum(PUBLISH_FORMATS).optional(),
    answer_key:     z.object({
      options_field: z.union([FieldName, z.array(FieldName).min(2).max(10)]), // one array field, or 2–10 option fields
      correct_field: FieldName,
      base:          z.union([z.literal(0), z.literal(1)]),
    }).strict().optional(),
    text_use:       z.enum(TEXT_USES).optional(),       // unset = no verbatim check
    retell_fields:  z.array(z.union([FieldName, z.array(FieldName).min(1).max(4)])).max(6).optional(),
    media_field:    FieldName.optional(),
    credit_fields:  z.array(FieldName).max(4).optional(),
    reusable_hosts: z.array(HostName).max(10).optional(),
  }).strict();
  export type PublishProfile = z.infer<typeof PublishProfileSchema>;
  ```
  - `FieldName` is `z.string().regex(FIELD_NAME_RE)` (:23). `HostName` is a bare lower-case host.
  - Refinements: `answer_key` needs `format: 'quiz'`; `retell_fields` needs `text_use: 'retell'`.
  - Pure helpers in `data/publish-profile.ts`: `answerOf` (FR-004), `retellText` (FR-003), `formatNeeds(profile, roles)` (the fields a post of that format needs) and `proposePostRequires(schema)`.
- `DataSchema` (`data/data.types.ts:72-94`) gets `publish: PublishProfile`. `schemaInputSchema` (:142-176) takes `publish` (default `{}`). Its `superRefine` (:157-176) checks that the named fields exist, as it does for `post_requires`. `schemaPatchSchema` (:180-194) takes `publish`.
- `DataStore` (`data/data-store.ts`):
  - reads `publish` like `postRequiresCol` (:57): `COALESCE(to_jsonb(row)->'publish','{}')`, so code also runs before 099;
  - `createSchema` (:117-133) writes it when given;
  - `updateSchema` (:146-184) checks the field names (like :152-156) and adds it to the SET list (:165-177). Removing a field the profile names is refused with a readable error, never a constraint failure.
- `diffSchemas` (`data/schema-versioning.ts:92`) lists `publish` with the description-only keys, so it is never a version bump.

### FR-002 Backfill

099 fills the profile by key. It runs only while `publish = '{}'`, so an owner's value always wins. Each update is guarded by the fields it names. Every part is idempotent (`ci-bootstrap-check.sh` re-applies migrations).

| Dataset | `publish` | Also |
|---|---|---|
| `pdr_questions` | `{format:'quiz', answer_key:{options_field:'answers', correct_field:'correct_answer_num', base:1}, text_use:'verbatim'}` | `post_requires` = `[["text"],["answers"],["correct_answer_num"]]` while it is `[]` |
| other schemas with entity `quiz_question` / `poll_question` | `{format:'quiz'}` / `{format:'poll'}` | — |
| `recipes` | `{text_use:'retell', retell_fields:['description',['instructions_uk','instructions']]}` | — |
| `facts` / `articles` / `tg_posts` | `retell` with `['content']` / `['excerpt','content']` / `['post']` | — |
| `prompts` | `{format:'photo', text_use:'verbatim', media_field:'media_url'}` | — |
| `nanobanana_prompts` (import_list, entity `entry`) | `{format:'photo', text_use:'verbatim', media_field:'media_url', credit_fields:['author']}` | `credit_fields` only if the field exists |
| `pdr_rules` | `{text_use:'cite', reusable_hosts:['zakon.rada.gov.ua']}`; no format (a composed quiz is allowed) | — |

- The `post_requires` update and `data_schema_stats_refresh` run inside one DO block. It returns early when `data_schemas.post_requires` does not exist (`095_prompts_post_requires.sql` pattern). `post-requires.migration.pg.test.ts` applies every migration except 083 first.

### FR-003 Guards read the profile

- **Quiz ground truth.** `checkQuizGroundTruth` (`editor/post/quiz-ground-truth.ts:16-38`) works for any dataset whose profile has an `answer_key`. `PDR` (:5) and the PDR-only SQL (:21-26) go.
  - The row and the profile are read together by `loadRowProfile(pool, ref)` (new, in `data/publish-profile.ts`). It handles `data://` and the legacy `library://` alias.
  - The truth is `answerOf(profile, data)`.
  - The chosen option passes when it equals the truth after `norm` (:7).
  - When the truth is over 100 characters (the PostSpec cap, `post/post-spec.ts:109-112`), the option also passes if it equals the clipped option from FR-004. It also passes if it is a prefix of the truth that is at least 20 normalised characters and is a prefix of no other option.
  - The error stays `quiz_answer_mismatch`. Its Ukrainian detail names the 0-based `correct_index`.
- **Verbatim.** `checkVerbatim` (`post/verbatim-guard.ts:89-104`) checks only `text_use: 'retell'`.
  - The source text is `retellText(profile, roles, data)`: the listed fields (a list means the first non-empty one), or else the `body` role.
  - `verbatim`, `cite` or unset means no check.
  - `RETELL_SOURCES` (:13-18) and the critic's copy `RETOLD_FIRST` (`critic/critic-source.ts:12-17`) are deleted. `retellSource` (:21-30, used at `critic-source.ts:58`) takes the profile.
  - Callers keep their signatures: `tools/role-tools.ts:206`, `chat/drafts.service.ts:185`, `platform/publish-platform.ts:103`.
- **Reusable hosts.** `reusableHosts(env)` (`data/ledger-anchor.ts:29-33`) returns the setting's hosts plus every dataset's `reusable_hosts`.
  - The dataset hosts come from a process cache: `setDatasetHosts` / `refreshDatasetHosts(pool)`.
  - The cache refreshes at boot (a DataModule provider), after a DataStore write that touches `publish`, and every 10 minutes.
  - `LEDGER_REUSABLE_HOSTS` stays a live setting (`settings/catalog.ts:140`).
  - Callers do not change: `data/content-ledger.ts:84` (a function, read per call), `tools/role-tools.ts:169`, `chat/drafts.service.ts:216`.
- **Series format.** `datasetFormat(entity)` (`network/series.ts:114-116`) becomes `datasetFormat(entity, publish?)`.
  - An `answer_key` gives `quiz`. `format: 'poll'` gives `poll`. Otherwise it falls back to the entity map (:111), for databases before 099.
  - `SeriesSourceCatalog` (:98-105) gets `publish?: Record<string, PublishProfile>`.
  - `seriesSourceCatalog` (`network/series-edit.ts:65-69`) selects it.
  - `seriesSourceErrors` (:119-133, check at :127-130) uses it.
  - Photo and text formats are not enforced on series saves.
- **New publish error `dataset_needs_quiz`.** It lives in `ScheduleService.publishGuard` (`schedule/schedule.service.ts:358-387`). It fires only for a slot whose series reads `library:D` and a post made from a row of D, when D's profile has an `answer_key` and `spec.format !== 'quiz'`.
  - Detail (uk): «рядок датасету з ключем відповідей публікується лише як quiz — постав format quiz і correct_index з рядка».
  - `refs` gets `format`. `role-tools.ts:222-224` passes `spec.format`.
  - The profile comes from a new optional dep `ScheduleServiceDeps.datasetProfile(key)` (:47-70), wired in `editor.module.ts` with `DataStore.getSchema`. Without the dep, the guard does nothing.
  - Plain slots are not checked, so a text explainer built from a PDR row stays allowed.

### FR-004 Code computes the answer

- `answerOf(profile, data)` returns `{ options, poll_options, correct_index, correct_option } | null`.
  - `options` is read in order from an array of strings or of `{text}` objects (`pdr_questions`), or from the listed option fields. The index is taken before blank fields are dropped.
  - `correct_index = Number(data[correct_field]) - base`, 0-based.
  - `poll_options` clips each option to 100 characters at a word boundary, with "…".
  - It returns null when the index is outside the options.
- The agent rows of `queryDataset` (`data/data-query.ts:334-341`) carry `correct_index`, `correct_option` and `poll_options` for an answer-key dataset. They carry `credit` (the `credit_fields` values joined with " · ") when the profile has credit fields. This covers search, `by ref` and next-row reads.
- `seriesNote` (`schedule/series-guard.ts:102-115`) gets `o.answerKey`. When it is set, the note adds one line (uk): «Правильну відповідь бери з полів рядка correct_index (рахуй від 0) і poll_options з query_data; не рахуй її з correct_answer_num сам.»
- `executorContext` (`schedule.service.ts:312-327`) sets `answerKey` from `datasetProfile` for the series' dataset.

### FR-005 Natural order and dotted keys

- `roundOrderSql` (`data/data-rounds.ts:35-49`): a text field (:43-45) sorts naturally:
  `(CASE WHEN v ~ '^[0-9]+([.][0-9]+)*$' THEN string_to_array(v, '.')::numeric[] END) ASC NULLS LAST, NULLIF(v, '') ASC NULLS LAST`.
  - It uses `numeric[]`, not `int[]`: a long digit key would overflow and abort the round query for the whole dataset.
  - Callers (`data-query.ts:309`, `data-rounds-api.ts:106`, `:142`) do not change, so the Rounds panel, the next row and agents agree.
- `inferType` (`data/import/type-inference.ts:66-90`), before the number branch (:78): a column stays `text` when two distinct values become the same number ("1.1" and "1.10", or "1,10").

### FR-006 The import proposes the profile

- New pure `inferPublishProfile(fields, roles, samples)` in `data/import/publish-inference.ts`. It returns `{ publish, post_requires, reuse_policy, base_ambiguous, notes }`. The notes are English.
  - **Answer key.** The options are an array field of 2–10 strings or `{text}`, or 2–10 fields named like `option_N` / `answer_[a-d]` / `variant_N`. The correct field is an int field named like `correct|right|answer_num|answer_index` whose values fit the options.
  - **Base.** A value of 0 means base 0. A value equal to the option count (and no 0) means base 1. Otherwise `base_ambiguous` is true and the owner must choose.
  - **Format.** `quiz` with an answer key. `photo` when the image role is filled in at least 90 % of samples and the body is prompt-like or short. `text` otherwise. `poll` is never inferred.
  - **`text_use`.** `verbatim` when the body field name contains `prompt`. `retell` when the body is `long_text`. Otherwise unset.
  - **`post_requires`.** The fields from `formatNeeds` that are filled in at least 90 % of samples, one group each.
  - **Reuse.** `cycle` with order `sequential` and `order_by` set to the key when an int or dotted key rises with the sample order. Otherwise `cycle` with order `random`.
  - **`credit_fields`.** The `source_name` role, when there is one.
- `DataImportService.infer` (`data/import/data-import.service.ts:111-125`), through `POST /api/data/imports/infer` (`data/data.controller.ts:144-150`), also returns `publish` (the proposal) and `sample_row` (the first sample row).
- `import_list`:
  - `planSchema` (`editor/docs/import-list.ts:140-160`) gives a new dataset the inferred profile and reuse instead of `never` (:153-154). The mapping's `post_requires` (:156) stays and is merged with the inferred one.
  - With `split_on` and an `url_anchor:` mapping, the profile gets `text_use: 'cite'` and the list host in `reusable_hosts`.
  - `previewOf` (:357-371) shows the profile and the reuse.
  - The preview probes up to 3 values of the media field with `safeGetBytes` (`editor/net/safe-http.ts:103`: `maxBytes` 5 MB, an `image/*` content type). Failures are notes, not errors.

### FR-007 Dashboard: "How it posts"

- New `components/data/PublishFields.tsx` holds:
  - format (`SegmentedTabs`);
  - answer key: an options select, a correct select, and "Counts from 1" / "Counts from 0". The base is required when `base_ambiguous`.
  - "Needed for posting": a `.chip-toggle` per field;
  - text use: Verbatim / Retell / Cite / Not set;
  - repeats (the existing `ReuseInput`).
  - one rendered sample quiz, with the correct option marked `.is-correct`. With no valid answer it shows "This row has no valid answer" as a `.callout-danger`.
- Pure logic goes in `src/lib/publish-profile.ts` (`renderSampleQuiz`, `answerOf` mirror, `publishPatch`). Its node:test sits next to it.
- `ImportWizard.tsx`:
  - a step `'publish'` between `'draft'` and `'report'` (:24);
  - the draft button reads "Next: how it posts";
  - `createDataset` (:100-105) sends `publish`, `post_requires` and `reuse_policy` from this step, not `{kind:'never'}` (:103).
- `SchemaEditor.tsx`:
  - a `SectionCard` "How it posts" after Dataset (:85-114), so `post_requires` is finally editable;
  - `Editable` (:22-29), `EDITABLE_KEYS` (`lib/data-store.ts:228-231`) and `schemaPatch` (:242) take `post_requires` and `publish`.
- `api/data.ts`: `DataSchema` (:14-34) gets `post_requires` and `publish`; `InferResult` (:115-125) gets `publish` and `sample_row`.
- "Use in a channel" appears on the wizard's Done step, beside "Open dataset" (:201), and on the "How it posts" section.
  - It opens `UseInChannel` (`Modal size="drawer"`) with a channel select (`useEditorChannels`) and a time, default 12:00.
  - It calls FR-009's endpoint and opens the returned card through `ActionCard` in `FocusedCardContext`, as `components/nav/NeedsYou.tsx:86-95` does (a local copy; NeedsYou is not edited).
- `components/chat/ActionCard.tsx` `KIND_META` (:22) gets `bind_dataset: { label: 'Use a dataset in a channel', icon: 'database' }`.
- Every block survives a 404 or a pre-099 schema without `publish` (an empty profile). All text is English, colours come from area CSS classes, and it works at 375px.

### FR-008 One postable count

- New `apps/automation/src/data/postable.ts`:
  ```ts
  export interface PostableCount { rows: number; postable: number; unposted: number; repeats: boolean }
  export async function postableCount(pool: Pick<Pool, 'query'>, schemaId: string, resourceRef: string | null): Promise<PostableCount>;
  ```
  - `rows` counts active rows.
  - `postable` counts active rows that pass `data_postable(post_requires, data)`.
  - `unposted` counts postable rows outside `usedRefsCte(resourceRef)` (`data/data-refs.ts:103-115`). For a cycle dataset it counts the current round. With no resource, it equals `postable`.
  - `repeats` is true when the reuse policy is `cycle`.
  - It is read-only and never rolls a round (unlike `buildCatalog`, `data/data-catalog.ts:195-206`).
- change_source:
  - `CandidateDeps.dataset` (`editor/sources/source-change.ts:63-71`) becomes `(key, resourceRef) => (PostableCount & { active: boolean }) | null`.
  - `source-wiring.ts:27-32` calls `postableCount`.
  - `checkCandidate` (:78-119) takes `{ resourceRef }`. Its library case (:109-114) fails `candidate_unpostable` when `postable = 0`, or when `unposted = 0` and the dataset does not repeat.
  - The evidence reads "N postable rows, M not yet posted on <resource>".
  - `source-tools.ts:80` passes `telegram:<key>`.
- 072's facts loader replaces its own per-dataset stats query with `postableCount`.

### FR-009 `bindDatasetPlan` and "Use in a channel"

- New `apps/automation/src/editor/datasets/bind-dataset.ts`:
  ```ts
  export interface DatasetBindPlan {
    dataset: string;
    op: 'create' | 'update';
    series: SeriesFields;              // source {kind:'library', table}, source_mode 'required', format from the profile
    takesOver: string | null;          // the series it rebinds
    datasetPatch: { post_requires?: string[][]; publish?: PublishProfile } | null;
    reuse: ReusePolicy | null;         // proposed when the dataset is on never / after_days
    warnings: string[];                // English: media probe, no postable rows, shared with other channels
    card: { kind: 'bind_dataset'; payload: Record<string, unknown>; then: FollowUp[]; summary: string } | null;
  }
  export async function bindDatasetPlan(d: BindDeps, channelKey: string, datasetKey: string, o?: { cadence?: string }): Promise<DatasetBindPlan | Fail>;
  ```
- Series choice, in this order:
  1. a series that already reads `library:D` (its format is set to the profile's format);
  2. else an active series of the same format with no required source (it is taken over);
  3. else a new series named after the dataset, with cadence `o.cadence ?? 'daily@12:00'` and a Ukrainian brief template per format.
- The series is validated now with `ScheduleService.prepareSeriesChange` (`schedule.service.ts:617-627`), with the scope from `scopeByChannel` (:107).
- `datasetPatch` adds the format's missing needs to `post_requires` and sets `publish.format` when it is unset.
- The card is the main kind `bind_dataset`. Its payload is `{channel, dataset, patch, expect}`. Its follow-ups run in order:
  - `series_change`;
  - the resume items (`resumeItems`, exported from `editor/docs/import-bundle.ts:186-212`);
  - an `edit_data_schema` item with target `reuse` (`tools/data-tools.ts:183-227`), ticked;
  - `detach_skill` items from `conflictFollowUps` (`agents/skill-conflict-followups.ts`) with `keep: [dataset]`;
  - all within `MAX_FOLLOW_UPS`.
- With no scope or no playbook (077's new channel), `card` is null and the other parts are filled.
- The Apply handler (`editor/datasets/bind-dataset-action.ts`) re-reads the schema and refuses `stale` when `post_requires` or `publish` changed since the proposal. It writes through `DataStore.updateSchema`. It is registered next to `edit_data_schema` (`editor.module.ts:2016`).
- Entry points:
  - `POST /api/editor/channels/:key/bind-dataset {dataset, cadence?}` in the new `editor/datasets/datasets.controller.ts` (controllers list `editor.module.ts:2506`). It refuses a second pending card for the same channel and dataset, as `import_list` does (`docs/import-list-tools.ts:88-91`).
  - The chat tool `propose_dataset_binding` (`editor/datasets/dataset-tools.ts`, `kind: 'act'`, `roles: ['composer','builder']`, `chatOnly`), registered beside `buildImportListTools` (`editor.module.ts:1290`).
  - 077's `/launch … from dataset` calls the function.

### FR-010 Doctor checks and reasons

- New `apps/automation/src/editor/readiness/dataset-facts.ts` provides `loadDatasetPublishFacts(pool, channelKey, series)`. For each dataset a series of the channel reads, it returns:
  - the schema parts (fields, roles, `post_requires`, `reuse_policy`, `publish`);
  - `postableCount` on `telegram:<channel>`;
  - the top host of the `url` role in 200 rows (its share, and whether the values carry `#anchors`);
  - the series reading it;
  - `sharedWith`, the other channels with a series on it.
  072's `loadChannelFacts` stores it as `facts.datasetPublish` with one appended line. The checks never query.
- `readiness/checks/datasets.ts` holds pure `DoctorCheck`s, appended to `DOCTOR_CHECKS`:

| Code | When | Severity | Fix |
|---|---|---|---|
| `dataset_post_rule_missing` | a field the format needs is neither in `post_requires` nor `required` without a default | warn | `dataset_patch` with `proposePostRequires` |
| `dataset_no_postable_rows` | rows > 0 and postable = 0 | error when a required series reads it, else warn | link |
| `answer_key_series_not_quiz` | an answer-key dataset is read by a series whose format is not quiz | error | `bind_dataset` |
| `brief_index_arithmetic` | that series' brief names the correct field together with "-1", "+1" or «мінус/плюс один» | warn | link only (no prose rewrite) |
| `reusable_host_missing` | at least 50 % of rows cite one host with `#anchors`, and it is not a reusable host | warn | `dataset_patch` `publish.reusable_hosts` |
| `dataset_text_use_unset` | the body role is `long_text` and `text_use` is unset | warn | `dataset_patch` with the inferred `text_use` |

- Each finding's evidence names `shared_with`, because a dataset patch changes those channels too.
- New fix kinds (sysadmin `Fix` union, `editor/sysadmin/audit.types.ts`, and 072's shared runner):
  - `dataset_patch {dataset, patch, expect}` applies through the FR-009 apply function;
  - `bind_dataset {channel, dataset}` proposes the FR-009 card and returns its id.
  - Neither is auto-safe.
- New `ReasonEntry` lines are appended to `editor/reasons/catalogue.ts`:
  - the six codes above, with kind `dataset`;
  - `dataset_needs_quiz`, kind `dataset`;
  - `candidate_unpostable`, kind `source`.
  Each line has `en`, `uk` and `fix`, and the link `/app/data/:dataset?tab=schema`.

## Not doing

- Composite dedup suggestions, a collision report, re-import placement by `order_by`, a `dataset_keys_sort_lexically` fix kind. Natural order is simply the default.
- Retyping a field or changing the dedup key of a dataset with rows.
- Credit or cite publish guards. Credit reaches the writer as the `credit` row field.
- Letter or text answer keys ("B", or the answer text in a field).
- A $0 check of quizzes composed from text datasets such as `pdr_rules`. The critic reads the row.
- A media probe in the doctor sweep or in the file-import infer. The data module has no HTTP client; import_list and the bind card probe.
- Page upload, egress proxy, source probes (076). `/launch from dataset` (077 calls FR-009).
- Rewriting briefs, skills or rules, mirroring the card into the playbook, archetype presets, a "rewrite stale drafts" card (review §7).
- A paid rehearsal, a mode gate, an event bus or DB triggers.

## Tests

- **Unit (apps/automation, fakes):**
  - `data/publish-profile.test.ts`: the schema (unknown field, `answer_key` without quiz, base 2); `answerOf` (strings, `{text}`, field list, base 0 and 1, out of range, a clip at 100 on a word boundary); `retellText`; `formatNeeds`; `proposePostRequires`.
  - `post/quiz-ground-truth.test.ts`: a generic base-0 field-list dataset; PDR base 1 unchanged; a clipped option passes; a prefix shared by two options fails; a dataset with no answer key gives null.
  - `post/verbatim-guard` tests: unset `text_use` means no check; `retell_fields` are used; `verbatim` means no check.
  - `network/series` tests: `datasetFormat` with a profile. Schedule tests: `dataset_needs_quiz` fires only on a series slot bound to that dataset; a plain text slot from a PDR row passes.
  - `data/data-rounds.test.ts`: the natural-order SQL. `type-inference.test.ts`: "1.1"/"1.10" stay text; "2.5"/"3.75" stay number.
  - `data/import/publish-inference.test.ts`: PDR-like rows give quiz with base 1; 0..3 give base 0; {1,2} with 4 options is ambiguous; nanobanana-like rows give photo and verbatim; articles-like rows give text and retell; clause keys give cycle sequential.
  - `datasets/bind-dataset.test.ts`: the three series choices; reuse `never` adds the reuse item; no playbook gives `card: null`; `keep` holds; `MAX_FOLLOW_UPS` is respected.
  - `readiness/checks/datasets.test.ts`: each code fires and stays quiet on fixtures. `sources` tests: `candidate_unpostable` and the evidence text. The 073 catalogue test passes with the new codes.
- **PG (`*.075.pg.test.ts`, scratch PG pattern `common/testing/pg-test-url.ts`, own database each, dropped at the end):**
  - migration 099: the column; the check refuses an unknown field; the backfill per key; an owner value is kept; a re-apply is harmless; the down file runs twice; a run with 083 left out;
  - DataStore create/update with `publish` and no version bump;
  - `postableCount` with ledger rows and a cycle round, and its parity with `buildCatalog`;
  - natural order 1.1, 1.2, 1.10, 2.1, and a 20-digit key without an error;
  - `query_data` rows carry `correct_index`;
  - `bind_dataset` Apply applies the patch and refuses a stale one;
  - `loadDatasetPublishFacts`.
- **Dashboard:** `lib/publish-profile.test.ts` (sample render, patch), the `lib/data-store` tests (editable keys), `lib/no-cyrillic-ui.test.ts`, `tsc --noEmit`, build.
- **Acceptance replays (fixtures, no service):**
  - **@pdr_dev_channel.** `pdr_questions` rows (base 1, 4 options, one option over 100 characters) and a poll series «Тест дня» on reuse `never`.
    - The doctor gives `answer_key_series_not_quiz` with the `bind_dataset` fix.
    - The bind plan sets quiz and proposes cycle sequential.
    - Ground truth passes the right option and refuses the off-by-one.
    - The post-1725 poll is refused with `dataset_needs_quiz`.
  - **@ai0_prompts_dev.** `prompts` (PromptHero rows without `prompt_text`) and `nanobanana_prompts`.
    - change_source on `prompts` gives `candidate_unpostable`.
    - The bind takes over the Prompt series (photo) as required `library:nanobanana_prompts`.
    - A verbatim prompt raises no `too_verbatim`.
  - **No false blocker on @ai0_global.** Its card, series and datasets give no error-severity dataset finding. The retell sources for `recipes`, `facts`, `articles` and `tg_posts` match the deleted map exactly (golden test).

## Lead calls (answered — see Amendments)

1. **Who owns which dataset check?** Recommendation: 072 keeps `dataset_without_series`, runway and `dataset_order_random_for_series`. 075 owns the six codes above. If 072 already created `checks/datasets.ts`, 075 appends its checks to that file and leaves 072's checks unchanged.
2. **Is `bind_dataset` the fix for 072's `dataset_without_series`?** Recommendation: yes, wired at merge. It proposes a card and stays out of Fix all.
3. **New imports propose `cycle` instead of `never`.** This reverses 071's "default stays never" for import proposals only. The schema default stays `never`. Recommendation: yes; the owner sees it in the wizard and on the card.
4. **Credit and cite guards?** Recommendation: not now. The writer gets `credit`; the critic sees the row.
5. **`pdr_rules` keeps no format.** Recommendation: yes.
6. **Does the backfill give `pdr_questions` a `post_requires`?** Recommendation: yes. Rows without answers must not count as material.
7. **Default time for a new bound series.** Recommendation: 12:00, editable in the form; the chat passes a cadence.
8. **`dataset_needs_quiz` kind.** Recommendation: `dataset`.
9. **Facts loading.** Recommendation: 075's `dataset-facts.ts` is called from 072's `facts.ts`, so `facts.ts` stays the only entry and the checks stay pure.

## Amendments after the builder check

These rules come from two sources:
- the lead's decisions after the drafts (contract, "Decisions after the drafts", 2026-10-29);
- the builder check (`w7/check-075.md`, 33 items, each verified against HEAD 1ecb8160).

They override the body. A*n* answers check item *n*.

### Lead decisions

**L1. Lead calls.** All nine recommendations are accepted, with these changes:
- Q1 is replaced by L2.
- Q2: yes. 075 wires it itself in T11 (A5), because 075 is built on W1 merged. The lead does nothing at merge.
- Q3–Q9 stand:
  - imports propose `cycle`, and the schema default stays `never`;
  - no credit or cite guards;
  - `pdr_rules` keeps no format;
  - the backfill gives `pdr_questions` a `post_requires`;
  - a new bound series defaults to 12:00;
  - `dataset_needs_quiz` has kind `dataset`;
  - `dataset-facts.ts` is called from 072's `facts.ts`.

**L2. Doctor codes, one owner each.**
- **075 owns four doctor checks.** They go in a new file, `apps/automation/src/editor/readiness/checks/datasets.ts`, appended to `DOCTOR_CHECKS`:
  - `answer_key_series_not_quiz`;
  - `brief_index_arithmetic`;
  - `reusable_host_missing`;
  - `dataset_text_use_unset`.

  072 has no `checks/datasets.ts`. Its files are `source`, `series`, `material`, `tools`, `config`, `pauses` and `launch`.
- **075 owns two run-time codes:** `dataset_needs_quiz` (kind `dataset`) and `candidate_unpostable` (kind `source`).
- **075 does not build** `dataset_post_rule_missing` or `dataset_no_postable_rows`. Strike both FR-010 rows, their tests and every mention of them.
- **072 owns the material codes**, in `checks/material.ts`: `dataset_without_series`, `dataset_post_requires_missing`, `dataset_low_fill`, `material_exhausted`, `material_low` and `dataset_order_random`.
  - 075 changes none of their logic.
  - 075 only feeds them through `postableCount` (A2) and gives `dataset_without_series` its fix (A5).
- **073 owns the series codes:** `series_format_unavailable`, `series_in_quiet_hours` and `series_rate_over_card_max`. On series formats, 075 adds only `answer_key_series_not_quiz`.

**L3. Names 075 exports.** Other specs use these names exactly.
- `postableCount(pool, dataset: { id?: string; key?: string }, resourceRef: string | null)`, in `apps/automation/src/data/postable.ts` (A3).
- `bindDatasetPlan(d: BindDeps, channelKey, datasetKey, o?: { cadence?: string }): Promise<DatasetBindPlan | Fail>`, in `editor/datasets/bind-dataset.ts`.
  - `card` is `null` when the channel has no playbook, which is the case for every new launch.
  - 077 treats a `Fail` as a dataset warning.
- `PublishProfileSchema` in `data/data.types.ts`. Its helpers go in `data/publish-profile.ts`.
- This amendment adds two names for 077: `applyDatasetPatch` (A26) and `chooseBindSeries` (A24).

**L4. Fix kinds.**
- `dataset_patch` and `bind_dataset` join the `Fix` union in `editor/sysadmin/audit.types.ts` and the shared runner `editor/sysadmin/fix-runner.ts`.
- Results use the contract's `FixResult = { ok; applied?; proposal?: { actionId }; error? }` (A4).
- Neither kind is auto-safe.
- Both are outside Fix all. For `bind_dataset` the contract says so; for `dataset_patch` see A4 and Open 1.

**L5. 073's names.** 075 uses these and does not copy them:
- `ReasonEntry`, `REASONS` and `reasonFor`, in `editor/reasons/catalogue.ts`;
- `CONFIG_FAILURE_CODES` and `isConfigCode`;
- the dashboard mirror `apps/dashboard/src/lib/reasons.ts` and its drift test;
- the series-format lock (`series_format_mismatch` in `publishGuard`).

Series format is authoritative for series slots (contract decision 1).

**L6. 074's seam.** Until the W2 merge, 074 gets its `no_material` evidence through `unposted(ref, table)`. The lead swaps that seam for `postableCount` at the W2 merge. 075 does not edit 074's code.

**L7. Shared lines.** Each spec edits from the merged state of the waves before it.
- `schedule.service.ts` is edited by 073, then by 074 and 075, then by 077. 075 edits it from the W1-merged state and keeps its edits small.
- `editor.module.ts` is append-only.

**L8. No gate, no event bus, no triggers.**
- The dataset PATCH route and the `bind_dataset` Apply do not call `ReadinessService.recheck`.
- Two things cover them instead (A7):
  - 072's dashboard invalidates `['readiness']` after every mutation;
  - the 10-minute sweep.

**L9. Tests.**
- Every PG file builds its own scratch database (`common/testing/pg-test-url.ts`) and drops it at the end.
- `t046` is never altered.
- Nothing starts the service or calls a network.

### Builder check

**A1. The down file name (wrong fact).**
- The file is `database/migrations/down/099_dataset_publish.down.sql`. Existing down files follow this pattern: `down/095_prompts_post_requires.down.sql`, `down/096_data_reuse_rounds.down.sql`.
- `database/ci-bootstrap-check.sh` globs only `database/migrations/*.sql`, so CI never runs a down file. `publish-profile.075.pg.test.ts` applies the down file twice itself.
- The spec, the tasks and the runbook all use this name.

**A2. Four checks; `postableCount` feeds 072.**
- The FR-010 table keeps only the four codes in L2.
- `proposePostRequires` stays, because `bindDatasetPlan`'s `datasetPatch` uses it.
- In 072's `readiness/facts.ts`:
  - delete the local `countPostable(pool, schemaIds, resourceRef)`;
  - call `postableCount(pool, { id }, resourceRef)` once per bound dataset (a channel has about ten), with no batch wrapper;
  - fill the same fact fields as before: active rows = `rows`, not-postable rows = `rows − postable`, postable rows unused here = `unposted`.
- 072's material tests pass unchanged.

**A3. `postableCount`.**
```ts
export interface PostableCount { rows: number; postable: number; unposted: number; repeats: boolean }
export async function postableCount(pool: Pick<Pool, 'query'>, dataset: { id?: string; key?: string },
                                    resourceRef: string | null): Promise<PostableCount | null>;
```
- `id` wins over `key`. A key is resolved with `SELECT id FROM data_schemas WHERE key = $1`.
- It returns `null` when no dataset matches. Callers map that to `unknown_dataset`.
- The resource is normalised inside with `resourceKeys(resourceRef).resourceRef` (`data/data-refs.ts:81`). Never hand-build `telegram:${key}`.
- A blank ref, or one ending in `:*`, counts as no resource, so `unposted = postable`.
- The counts copy `buildCatalog`'s live counts (`data/data-catalog.ts:176-189`), including the second `NOT EXISTS` for `legacy_ref`.
- It is read-only and never rolls a round.
- Test: `telegram:pdr_dev_channel`, `@pdr_dev_channel` and `telegram:@pdr_dev_channel` give the same `unposted`.

**A4. Fix results and Fix all.**
- **Union** (`sysadmin/audit.types.ts`):
  ```ts
  | { kind: 'dataset_patch'; dataset: string; patch: DatasetPatch; expect: DatasetExpect }
  | { kind: 'bind_dataset';  channel: string; dataset: string }
  ```
  - `DatasetPatch = { post_requires?: string[][]; publish?: PublishProfile }` and `DatasetExpect = { post_requires: string[][]; publish: PublishProfile }` are exported from `data/publish-profile.ts` (T1), so `audit.types.ts` imports types only.
  - `FIX_KINDS` lists both kinds.
- **Ports.** They are injected; `fix-runner.ts` imports neither DataStore nor bind-dataset.
  - `applyDatasetPatch?(p): Promise<{ applied: string } | { stale: true }>`;
  - `proposeBind?(channel, dataset): Promise<{ actionId: string }>`.

  They are wired in `editor.module.ts`, where 072 builds the fix ports. A missing port fails with `fix_unavailable`, as in 072.
- **Results.**
  - `bind_dataset` returns `{ ok: true, proposal: { actionId } }`. When a card for the same channel and dataset is already pending, it returns that card's id and makes no second card.
  - `dataset_patch` returns `{ ok: true, applied: 'dataset <key>: <changed parts>' }`, or `{ ok: false, error: 'stale' }`.
  - `fixLabel` gives "Propose using <dataset> in this channel" and "Update dataset <dataset>".
- **Fix all.** Add `FIX_ALL_SKIPS = ['dataset_patch', 'bind_dataset'] as const` to 072's `readiness/auto-fix.ts`, beside `AUTO_SAFE_FIX_KINDS`.
  - `ReadinessService.fix(key, undefined, via)` skips findings whose fix kind is listed. This covers Fix all and the owner bot's «Виправити все».
  - `ReadinessView.fixable` and the owner-bot count K leave them out.
  - `fix(key, [code], via)`, the row's Fix button, applies them.
  - Why `dataset_patch` too: it changes a dataset that other channels read (`shared_with`).
- **Proposals.** `fix()`'s result gains `proposed: Array<{ code: string; actionId: string }>`.
  - The Readiness row's Fix button opens the proposed card with the same local CardOpener as `UseInChannel` (T10).
  - Without `FocusedCardContext`, it shows the toast "Card proposed — see Inbox".
- **Tests.**
  - `sysadmin/fix-runner.test.ts`: both kinds with fake ports, including stale and a missing port.
  - The `readiness/auto-fix` test: neither kind is in `AUTO_SAFE_FIX_KINDS`, and both are in `FIX_ALL_SKIPS`.
  - A `ReadinessService` test with fakes: Fix all skips both kinds, and a fix that names the code applies it.

**A5. The fix for `dataset_without_series`.**
- In 072's `readiness/checks/material.ts`, its finding gets `fix: { kind: 'bind_dataset', channel, dataset }`. That is one line; use the facts' own names.
- This replaces 072's table cell "none (075 adds one in W2)".
- Test: the finding carries the fix, and Fix all does not apply it (A4).

**A6. The dashboard mirror.**
- Each new code gets two lines in the same commit:
  - its `ReasonEntry` on the server;
  - its mirror line `{ code, en, fix: en, link }` in `apps/dashboard/src/lib/reasons.ts`.
- Which task adds each code is set in A23.
- That task also runs the dashboard `npx tsc --noEmit` and `npm test`.
- Links:
  - `answer_key_series_not_quiz`, `brief_index_arithmetic` and `dataset_needs_quiz` link to `/app/agents/:agent?tab=schedule`;
  - `reusable_host_missing`, `dataset_text_use_unset` and `candidate_unpostable` link to `/app/data/:dataset?tab=schema`.

**A7. `configHash` covers `publish`.**
- In 072's `configHash`, the dataset tuple becomes (key, version, `reuse_policy`, `post_requires`, `publish`). Facts read `publish` through `publishSql('s')` (A12).
- Test: a `publish` change flips `configHash`; a key reorder does not.
- After 099 is deployed, a channel bound to a dataset whose stored profile differs from its legacy profile (A12) sees one hash change. 074's hook then runs its $0 repair once. The runbook says so.
- The data routes do not call `recheck` (L8). This is the design, not a delta.

**A8. Backfill and `dataset_text_use_unset`.**
- 099 also sets `quotes` → `{text_use:'verbatim'}` and `jokes` → `{text_use:'verbatim'}`. It does this by key, and only while `publish = '{}'`.
- `dataset_text_use_unset` fires only when all of these hold:
  - `text_use` is unset;
  - the first field of the `body` role is `long_text`;
  - the median body length over A31's sample rows (`bodyMedianChars`) is over 400 characters;
  - an active series of the channel reads the dataset.
- Its fix is `dataset_patch` with `text_use: 'verbatim'` when the body field name contains `prompt`, else `'retell'`.
- Fixture: the datasets bound on @ai0_global give no `dataset_text_use_unset`.

**A9. One answer case table.**
- New file `apps/automation/src/data/publish-profile.cases.json`. Each case is a `(profile, data)` input with the expected `answerOf` result (or `null`). It covers:
  - strings, `{text}` objects and a field list;
  - base 0 and base 1;
  - a blank option in the middle;
  - options of 100 and 101 characters, a clip at a space and a hard clip;
  - an index out of range;
  - fewer than 2 options left, and more than 10.
- `data/publish-profile.test.ts` and `apps/dashboard/src/lib/publish-profile.test.ts` both read it with `readFileSync`, as `components/chat/SlashMenu.test.ts:24-28` does. Each asserts its own `answerOf` on every case.

**A10. The format the guard reads.**
```ts
const fmt = s.format ?? refs.format;
if (profile?.answer_key && fmt && fmt !== 'quiz') return { error: 'dataset_needs_quiz', details: … };
```
- The series' own format comes first.
- `platform/platform-tools.ts:85` calls `publishGuard` with no format. Do not edit it.
- Tests:
  - refs without a format, on a poll series, give `dataset_needs_quiz`;
  - the same on a quiz series give `null`.

**A11. Config class and branch order.**
- **Order** inside `if (s && !s.pin)`:
  1. `series_source_mismatch`;
  2. 073's `series_format_mismatch`;
  3. `dataset_needs_quiz`;
  4. `not_next_in_order`.
- **Config class.** Append `dataset_needs_quiz` (one name each, no reformat) to two places:
  - the list `isConfigCode` reads (`CONFIG_FAILURE_CODES`, wherever 073 put it at merge);
  - the `config` pattern of `RULES` in `editor/silent/skip-reasons.ts`.

  As a config code it never counts toward the breaker, never runs the ladder and never puts the row aside.
- **Pre-flight.** With A20's catalogue `publish`, 073's pre-flight (`config_source_missing` through `seriesSourceErrors`) already skips such a slot at $0, before the writer runs. `dataset_needs_quiz` is the backstop at publish time.
- **Tests:**
  - a poll series with a PDR ref gives `dataset_needs_quiz`;
  - `isConfigCode('dataset_needs_quiz')` is true;
  - the skip text `dataset_needs_quiz: …` classifies as `config`.

**A12. Before 099: a legacy fallback in SQL.**
This differs from the checker's `hasColumn` proposal. It has the same effect with less plumbing.
- `data/publish-profile.ts` exports `LEGACY_PUBLISH: Readonly<Record<string, PublishProfile>>`. It is frozen and marked `// remove once 099 is applied everywhere`. It holds:
  - `pdr_questions`: `{format:'quiz', answer_key:{options_field:'answers', correct_field:'correct_answer_num', base:1}, text_use:'verbatim'}`;
  - `recipes`, `facts`, `articles` and `tg_posts` with `text_use:'retell'`, and retell lists equal to today's `RETELL_SOURCES`.
- `publishSql(alias)` returns:
  ```sql
  COALESCE(to_jsonb(<alias>)->'publish',
           CASE <alias>.key WHEN 'pdr_questions' THEN '<json>'::jsonb … ELSE '{}'::jsonb END) AS publish
  ```
  - It is built from `LEGACY_PUBLISH`, a constant, with single quotes doubled.
  - After 099 the column is `NOT NULL`, so the fallback never applies.
- Every profile read uses `publishSql`: DataStore (A19), `loadRowProfile` (A18), `seriesSourceCatalog` (A20), the hosts refresher (A13), 072's facts (A7) and `loadDatasetPublishFacts` (A33).
- So these pass unchanged:
  - `tools/data-tools.pg.test.ts:116-126`, on t046 at 096;
  - `data/data-store.migration.pg.test.ts:160`, on a database at 058.

  Nothing stops silently between a deploy and 099.
- Golden PG test: after 099, the stored `publish` of those five keys equals `LEGACY_PUBLISH`.
- The runbook says: "Until 099 is applied, the guards use a frozen legacy map for `pdr_questions` and the four retell datasets; nothing stops." It does not say "verbatim checks stop until applied".

**A13. Reusable hosts with no hidden cache in the pure function.**
- **`data/ledger-anchor.ts`:**
  - `datasetHosts(): string[]` reads a module variable, default `[]`;
  - `setDatasetHosts(hosts)` normalises the hosts (lower case, no `www.`, no duplicates);
  - `reusableHosts(env = process.env, extra: readonly string[] = datasetHosts())` returns the setting's hosts (or the default), then `extra`, without duplicates;
  - `isReusableHost`'s default stays `reusableHosts()`.
- **`data/publish-profile.ts`** (T1): `onPublishChanged(fn)` registers one listener, and `publishChanged()` calls it.
  - With no listener, `publishChanged()` does nothing, and it never queries.
  - DataStore calls it after a `createSchema` or `updateSchema` that wrote `publish` or `status`.
- **New `data/dataset-hosts.refresher.ts`:** `DatasetHostsRefresher`, in the DataModule providers (`data/data.module.ts:11`).
  - It refreshes in `onModuleInit` and on `@Cron('*/10 * * * *', { name: 'dataset-hosts' })`. Nothing in the app uses `@Interval`.
  - It registers itself with `onPublishChanged`.
  - It reads `publishSql('s')->'reusable_hosts'` of active datasets.
  - On an error it logs and keeps the previous list.
- **Tests:**
  - `ledger-anchor.test.ts:20-24`: the exact lists are unchanged (call `setDatasetHosts([])` in `beforeEach`), plus one merge case;
  - the refresher, with a fake pool: an error keeps the list;
  - DataStore's fake-pool tests see no extra query.

**A14. Resume items on a card that writes no rows.**
- `resumeItems` is exported from `import-bundle.ts`. `bindDatasetPlan` calls `resumeItems(d, scope, { dataset, series: plan.series.name }, notes)`.
  - `BindDeps.pauses` is required.
  - It strips `requires` from each returned item.
- The items are offered only when `postableCount(…).postable > 0` on the channel. Otherwise the plan gets a warning instead.
- There is no `fitFollowUps`. The items go in this order:
  1. `series_change` (one item);
  2. the resume items (two at most);
  3. the reuse item (one at most);
  4. the conflict items, with `limit = MAX_FOLLOW_UPS - then.length`.

  So the card never goes over the cap.
- Test: Apply runs the resume item when the main result is `{ unchanged: true }`.

**A15. ImportWizard.**
- **Steps.** A new dataset goes pick → draft → publish → report → done. The `existing` mode does not change and has no publish step.
- **Draft step.** Its primary button reads "Next: how it posts" and creates nothing.
- **`remapProfile(proposal, inferred: FieldDef[], fields: DraftField[])`**, in `lib/publish-profile.ts`:
  - field *i* of `inferred` is draft field *i* (`ImportWizard.tsx:41-42`);
  - it maps the inferred names to the current names;
  - it drops excluded names from `publish`, from `post_requires` (a group loses the name; an empty group goes) and from the reuse `order_by`;
  - an answer key left with fewer than 2 option fields is dropped, with a note.

  It runs on entering the publish step and again in `createAndCheck`.
- **Publish step.**
  - Its primary button, "Create dataset and check file", runs `createAndCheck`, which moves here from the draft step. It sends `publish`, `post_requires` and `reuse_policy`.
  - The button is disabled while `base_ambiguous && base == null`, with the line "Choose whether answers count from 0 or 1".
  - After the dataset is created, the step is read-only. Back from report goes to publish; Back from publish goes to draft, which stays locked as today.
- **Tests:** rename, exclude, a group with an alternative, and an answer key that loses an option field.

**A16. SchemaEditor.**
- **(a) `post_requires` groups.**
  - A single-field group is a `.chip-toggle` per field.
  - A multi-field group is a read-only chip, "any of a, b", and it is kept unchanged on save.
  - Helpers in `lib/publish-profile.ts`: `postRequiresChips` and `postRequiresFromChips`.
- **(b) Pre-099 schemas.** `pick()` normalises `publish ?? {}` and `post_requires ?? []` for both the saved and the edited copy, so `schemaPatch` compares normalised values. `EDITABLE_KEYS` gains `post_requires` and `publish`.
- **Tests** in `lib/data-store.test.ts`:
  - a pre-099 schema gives no patch;
  - an OR group survives a toggle of another field.

**A17. Computed row keys in `query_data`.** This replaces FR-004's second bullet.
- **Where.** In the agent branch of `queryDataset` (`data/data-query.ts:333-341`), after the field loop.
  - Compute from the unclipped `r.data`.
  - Do it whatever `o.fields` lists.
- **Name clash.** A key is skipped when the schema has a field of that name.
- **Which keys:**
  - `correct_index` on every row of an answer-key dataset;
  - `correct_option` and `poll_options` only on a by-ref read, or when the result has 3 rows or fewer;
  - `credit` on every row: the `credit_fields` values joined with " · ", clipped as the loop clips.

**A18. Guard signatures and the tests that change.**
- **`loadRowProfile(pool, ref)`** returns `{ key: string; roles: Roles; publish: PublishProfile; data: Record<string, unknown> | null } | null`.
  - It is one query.
  - A `LEFT JOIN` makes a missing row of a known dataset return `data: null`.
  - It returns `null` when the dataset does not exist.
  - It handles `data://` and `library://` (`/^library:\/\/([a-z_]+)\/(.+)$/`).
- **`checkQuizGroundTruth`:**
  - no `answer_key` → `null`;
  - `data: null` → `library_ref_not_found`, as today;
  - otherwise it checks against `answerOf`.
- **Retell text.** `retellText(profile, roles, data)` in `publish-profile.ts` replaces `retellSource(key, data)`, which is deleted from `verbatim-guard.ts`. It returns `''` unless `text_use` is `'retell'`.
- **Critic.**
  - `critic-source.ts` gets `libraryRowText(row, retellFields: string[] = [])`, where `retellFields` are the flattened `retell_fields`, listed first.
  - `libraryTextOf` reads through `loadRowProfile`.
  - `RETOLD_FIRST` is deleted.
- **Tests to edit:**
  - `critic/read-capture.test.ts:282-286`: the new signature, with the same expected text;
  - `post/quiz-ground-truth.test.ts` and `post/verbatim-guard.test.ts`: their fake pools answer the one `loadRowProfile` row shape;
  - `chat/drafts.service.test.ts`, if its fake pool serves these queries.
- **Unchanged (A12):** `tools/data-tools.pg.test.ts:116-126` and `data/data-store.migration.pg.test.ts:160`.

**A19. DataStore read and write paths.**
- `publishSql(alias)` goes into all four reads:
  - `listSchemas` (`data-store.ts:68`);
  - `getSchema` (:99);
  - the RETURNING of `createSchema` (:127);
  - the RETURNING of `updateSchema` (:180).
- `createSchema` writes `publish` only when it is non-empty, as it does for `post_requires`.
- `updateSchema` runs a check whenever `fields`, `post_requires` or `publish` is in the patch.
  - It checks the effective `post_requires` and `publish` (the patch value, else the current one) against the effective fields.
  - It fails with `DataStoreError('invalid', 'publish names unknown field <x>')` or `'post_requires points to unknown field <x>'`.
- Tests:
  - each read path returns `publish`;
  - a fields-only patch that removes a profile field gives the readable error.

**A20. `datasetFormat` and its callers.**
- `datasetFormat(entity, publish?)` stays back-compatible:
  - an `answer_key` gives `quiz`;
  - `format: 'poll'` gives `poll`;
  - otherwise it uses the entity map.
- `setup/setup-analysis.ts:109` and `setup/dataset-formats.047.test.ts:22-23` do not change.
- `SeriesSourceCatalog.publish?: Record<string, PublishProfile>` is optional.
  - `seriesSourceErrors` calls `datasetFormat(cat.entities?.[t], cat.publish?.[t])`.
  - When the need comes from the profile, its Ukrainian text says «ключ відповідей» instead of the entity.
- `seriesSourceCatalog` (`network/series-edit.ts:66`) reads `SELECT s.key, s.entity, ${publishSql('s')} FROM data_schemas s WHERE s.status = 'active' ORDER BY s.key`. Today it has no table alias.
- Tests:
  - an entity-less dataset (`item`) with an `answer_key` makes a poll series fail;
  - catalogue fakes without `publish` keep working.

**A21. Natural order.**
- The text branch of `roundOrderSql` (`data-rounds.ts:43-45`) uses `txt` = `d.data->>'<name>'`:
  ```
  (CASE WHEN ${txt} ~ '^[0-9]+([.][0-9]+)*$' THEN string_to_array(${txt}, '.')::numeric[] END) ASC NULLS LAST,
  NULLIF(${txt}, '') ASC NULLS LAST
  ```
  There is no `\d` in the template string.
- **Mixed values.** Numeric-looking values come first in natural order, then the others in lexical order, then blanks. This is the intended behaviour, not a delta.
- **Tests:**
  - rewrite the exact-SQL assertion in `data/data-rounds.read.test.ts:23-31`. The body's "`data/data-rounds.test.ts`: the natural-order SQL" is wrong, because that file has no SQL-text test;
  - add the PG order case in a new `data/data-rounds.075.pg.test.ts`.

**A22. Task order.** T1 creates the `publishChanged` registry, and DataStore calls it there. T3 registers the refresher.

**A23. Catalogue lines land with their code.**
- `dataset_needs_quiz` lands in T4, with `CONFIG_FAILURE_CODES` and `RULES`.
- `candidate_unpostable` lands in T8.
- The four doctor codes land in T11.
- Before T4, read how 073's catalogue test finds its codes (from exported lists) at the base commit.

**A24. Series choice.** This replaces FR-009's three rules.
1. **A series that already reads `library:D`.** Take the first by playbook position. Set its format to the profile's format and its `source_mode` to `required`.
2. **Else, a series to take over.** It is an active series of the profile's format (`text` when the profile has none) whose source is one of these:
   - absent;
   - not `required`;
   - a `library` source whose dataset has `postable = 0` on this resource (`postableCount`).

   If several match, take the one whose name or brief mentions the dataset key or title, else the first by position. The others are listed in `warnings` ("Also matches: …").
3. **Else, a new series.**

- The rule is the pure function `chooseBindSeries(series, o: { dataset, title, format, unpostable: ReadonlySet<string> })`, exported from `bind-dataset.ts`. It returns `{ rule: 1 | 2 | 3; series: Series | null; others: string[] }`.
- Pin this fixture in `bind-dataset.test.ts` (@ai0_prompts_dev):
  - the series `Prompt`: format photo, source `library:prompts`, `source_mode` `required`, postable 0;
  - expect `takesOver = 'Prompt'`, `series_change` op `update`, and `before` = that series.

**A25. Conflict items.**
- They are added only when the series taken over had a source:
  ```ts
  conflictFollowUps(d, agent, { body: `не використовуй ${seriesSourceLabel(old)}` },
    { skip: keysOnCard, limit: MAX_FOLLOW_UPS - then.length, keep: [dataset] })
  ```
- Rule 1, rule 2 with no old source, and rule 3 add none.
- Test both cases.

**A26. `expect` and Apply.**
- **Payload:** `{ channel, dataset, patch: DatasetPatch | null, expect: DatasetExpect }`.
  - `expect` is `{ post_requires, publish }` as read when the card is proposed.
  - `DatasetBindPlan` also carries `expect`, for 077.
- **`applyDatasetPatch(store, { dataset, patch, expect })`**, exported from `bind-dataset-action.ts`:
  - it re-reads the schema with `DataStore.getSchema` and compares sorted-key JSON of both parts;
  - if they differ, it throws `DataStoreError('conflict', 'stale: the dataset changed after the card was made; ask for a fresh one')`;
  - otherwise it calls `updateSchema` with `changedBy: 'owner (bind card)'`;
  - a `null` patch returns `{ unchanged: true }`, and the follow-ups still run.
- The `bind_dataset` main handler is `applyDatasetPatch`. The `dataset_patch` fix port uses the same function and maps a stale result to `{ stale: true }`.
- **The reuse item:**
  - kind `edit_data_schema`, ticked;
  - payload `{ dataset, target: 'reuse', reuse, old_text: reuseText(current.reuse_policy), evidence: 'Proposed with the dataset binding: rows repeat in rounds instead of running out.' }`;
  - the policy comes from `inferReuse` (T7) over the first 200 active rows by id.
- **Endpoint.** It answers 409 `already_proposed` with `{ actionId }` of the pending card. The dashboard opens that card.
- **Shared proposer.** `proposeBinding(d, channelKey, datasetKey, o)` in `bind-dataset.ts` is the one proposer. The endpoint, the chat tool and the fix port all call it.

**A27. `answerOf`.**
- **Options** come from the array field (strings or `{text}`) or from the listed fields, in order, each trimmed.
- **The correct option** is `options[Number(data[correct_field]) - base]`. The result is `null` when that index is not an integer, is out of range, or points at a blank option.
- **`poll_options`** are the non-blank options.
  - Each is clipped to at most 100 characters, "…" included: cut at the last space before character 99, else cut hard at 99, then add "…".
  - The result is `null` when fewer than 2 or more than 10 options remain.
- **`correct_index`** is the position of the correct option within `poll_options`.
- **`correct_option`** is the unclipped text.
- **Ground truth (FR-003).** The chosen option passes when its normalised text:
  - equals the normalised truth;
  - or equals the normalised clipped truth;
  - or is a prefix of at least 20 normalised characters of the truth, and of no other option.

**A28. Base inference.** This counts rows with an integer value and their own option count *n*.
- **Base 0:** some value is 0, and no value equals its row's *n*.
- **Base 1:** some value equals its row's *n*, and no value is 0.
- **Ambiguous:** anything else (both kinds of evidence, or neither). `base_ambiguous` is set and the base is left unset.
- A value outside 0..*n* means the field is not an answer key.
- Tests: PDR-like rows, values 0..3, values {1, 2} only, and both 0 and *n*.

**A29. `import_list`.**
- `previewOf` stays sync. It prints `plan.newSchema?.publish` and `plan.newSchema?.reuse_policy` for a new dataset; `ImportPlan` already carries `newSchema`.
- `planSchema` has one caller, `buildPlan` (`import-list.ts:346`), and it runs after the rows are built.
  - It gains an optional `rows`.
  - With no kept rows, it infers from the mapping only: photo + verbatim when `prompt_text` and an image are mapped, and reuse `cycle` random.
- The media probe runs in `import-list-tools.ts`, after `previewOf`.
  - It reads up to 3 values through `safeGetBytes`.
  - It adds `media_probe: { checked, ok, notes }` to the tool result.
  - It is skipped without `d.http`.
- The three direct `previewOf` tests keep their calls.

**A30. `checkCandidate`.**
- **Signature:** `checkCandidate(s, d, o: { resourceRef?: string | null } = {})`.
- **Library case:**
  - an unknown or inactive dataset → `unknown_dataset`;
  - rows = 0 → `candidate_empty`, "the dataset has no rows", unchanged;
  - rows > 0 and postable = 0 → `candidate_unpostable`, "none of the N rows has what a post needs (post_requires)";
  - unposted = 0 and the dataset does not repeat → `candidate_unpostable`, "every postable row was already posted on <resource>";
  - otherwise ok, with the evidence "N postable rows, M not yet posted on <resource>", or "N postable rows" when there is no resource.
- **Deps.**
  - `CandidateDeps.dataset(key, resourceRef)` returns `(PostableCount & { active: boolean }) | null`.
  - `source-wiring.ts` reads the status, then calls `postableCount` by id.
  - `source-tools.ts:80` passes ``{ resourceRef: `telegram:${key}` }``; `postableCount` normalises it.
- **Tests.** Update the fake and the expected evidence at `sources.049.test.ts:83` ("12 postable rows").
- **Callers.** `checkCandidate` has one caller (`source-tools.ts:80`) and `candidateDeps` has one (`editor.module.ts:1302`). 076 changes both files in W1 (`CandidateDeps.probe`), so edit them on the merged state.

**A31. Detection rules.**
- **`brief_index_arithmetic`.** For each active series that reads an answer-key dataset, test its brief with a regex (flags `iu`).
  - The pattern is the profile's `correct_field` (escaped), then, within 40 characters, `(?:[−–-]\s?1(?!\p{N})|\+\s?1(?!\p{N})|(?:мінус|плюс)\s+(?:один|1)(?![\p{L}\p{N}]))`.
  - The same arithmetic within 40 characters *before* the field also counts.
  - Never use `\b` after Cyrillic: in JS, `\b` is ASCII-only.
  - Positive tests: «correct_index = correct_answer_num - 1» and «correct_answer_num мінус один».
  - Negative tests: «1-2 речення», «correct_answer_num» on its own, and «-1 бал» without the field.
- **`reusable_host_missing`:**
  - take the last 200 active rows by id, descending, and the first non-empty value of the `url` role;
  - the host comes from `refHost()`;
  - `urlRows` = rows with a URL;
  - `topHostShare` = rows on the top host ÷ `urlRows`;
  - `anchorShare` = top-host rows whose URL matches `#.+` ÷ top-host rows.

  It fires when `urlRows ≥ 10`, `topHostShare ≥ 0.5`, `anchorShare ≥ 0.5` and `!isReusableHost('https://' + topHost + '/', facts.reusableHosts)`. Its fix is a `dataset_patch` that adds the host to `publish.reusable_hosts` (the whole `publish` object is sent, with `expect`).
- Both are computed in `loadDatasetPublishFacts` (A33). The checks stay pure.

**A32. `HostName`.**
- It is `z.string().max(100).regex(/^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/)`.
- A bad host is refused, never rewritten.
- The wizard, the inference and the doctor fix lower-case the host and strip `www.` before they send it.
- The SQL validator does not check host shape. A comment in 099 says zod owns it.

**A33. Facts with no duplicate reads.**
- In 072's `facts.ts`, the per-dataset read gains `fields` (name and type) and `publish` (`publishSql`). Nothing else is read again.
- `loadDatasetPublishFacts(pool, channelKey, datasets)` adds only the new parts:
  ```ts
  Record<datasetKey, { urlRows; topHost; topHostShare; anchorShare; bodyMedianChars; sharedWith: string[] }>
  ```
  - It runs one SQL per dataset, over its last 200 active rows, plus one SQL for `sharedWith`.
  - Its result is stored as `facts.datasetPublish`, with `facts.reusableHosts = reusableHosts()`.
  - It is one line in `loadChannelFacts`.
- Confirm 072's names (`ChannelFacts.datasets` and its field names) at the base commit. Adapt the names, not the behaviour.

### Open for the lead

1. **Is `dataset_patch` outside Fix all (A4)?** The contract says so only for `bind_dataset`. Recommendation: yes. A patch changes a dataset that other channels read, so the owner applies it from its own row.
2. **077 must follow the new names.**
   - 077 FR-001 still calls `postableCount(pool, schemaId, …)`.
   - 077 FR-002 restates the old take-over rule ("no required source"), which fails the @ai0_prompts_dev case.

   Recommendation: 077 uses the contract signature (L3), calls `chooseBindSeries` (A24) and applies the patch with `applyDatasetPatch` (A26).

## Lead decisions after the integration review (2026-10-29)

These override everything above, including the Amendments. They come from a cross-spec review of all six specs (the item numbers I1… are that review's).

- **I2:** add `materialAvailable(counts, reusePolicy)` next to `postableCount`: `unposted > 0 || (policy.kind === 'cycle' && postable > 0)`. It is the single predicate for 072's `pause_cause_gone` and 074's auto-resume; the lead switches both at the W2 merge.
- **I3:** do not add `FIX_ALL_SKIPS`. 072's `FIX_ALL_EXCLUDED_KINDS` already lists `dataset_patch` and `bind_dataset`. Call `fix(key, {}, via)` for Fix all and `fix(key, { keys: [findingKey] }, via)` for one row.
- **I4:** `publishGuard` keeps 073's order: `series_format_mismatch` first, covering pins. Add `dataset_needs_quiz` right after it under the same condition. `platform-tools.ts:85` already passes the format after 073; do not edit it.
- **I11:** `dataset_needs_quiz` goes only into `CONFIG_FAILURE_CODES`; the `RULES` pattern is generated from that list. Its catalogue kind `dataset` is a display group.
- **I10:** 075 is rebased on 074 before its merge (074 merges first). Append-only edits to shared arrays; catalogue entries and `lib/reasons.ts` in the same commit.
