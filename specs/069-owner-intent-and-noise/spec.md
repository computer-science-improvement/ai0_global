# 069 — Owner intent reaches the pipeline, less noise, a manager with teeth

Status: planned · Builds on 047 (owner rules), 048 (chat cards), 060 (note gate, adherence), 062 (chat truthfulness), 065/066 (`import_list`), 012 (owner bot) · No migration

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

## Why

Review 4 found four problems.

**1. The owner's source change never reached the pipeline (P1 #4).** On 10-22 the owner told @ai0_prompts_dev to take prompts from awesome-nanobanana-pro, and @ai_global to take them from prompts.chat.
- The composer wrote skills (nanobanana-github-prompt-post v1–v4, prompts-chat-source). It never imported anything: `import_list` was offered in 14 composer runs and called 0 times.
- The planner never sees channel skills (`skills/skill-defaults.ts:10`: executor, composer, checker), so it kept pinning PromptHero rows.
- The old skill «Фільтр provider=prompthero» stayed enabled next to the new «PromptHero не використовую».
- Nothing routes "бери з X" to an import. The import tools are passive, and the runbooks expect the owner to type «імпортуй …». The composer also cannot turn a skill off (`detach_skill` is builder-only).

**2. Owner noise (P2 #6).** After the deploy the owner got 41 notes and 40 cards in 4 days, and tapped none. Causes:
- `note-gate.ts` compares a note only with the last one (`past[0]`), so streak 8 → 6 → 8 fires three times;
- `series_missed` re-evaluates yesterday as the 48-hour window slides, and fires again;
- every fire is a new Telegram message, even though `BotApi.edit` exists;
- `event_not_covered` has no gate.

**3. The manager is toothless (P2 #7).** 11 runs, all `continue`, 0 directives since 10-18. «Escalate if it continues» was written in 5 reviews and never done. Not-followed advice drops out of the next digest, because the open-directives query excludes `evaluated`.

**4. Two chat defects (P3).**
- **Claim guard.** The 062 claim guard flagged a true statement: a skill applied by card earlier in the same chat. The retry kept the first answer in history, and the model publicly apologised («Я виправляю відповідь…»).
- **Attribution.** To meet "no author, no link", the composer posted a CC BY 4.0 prompt as `origin=original`. Nothing checks `origin=original` against the text that was read.

The lead's code map is at `<scratchpad>/r5/map-069-owner-intent.md`. It has file:line anchors. Where it and this spec differ, this spec wins.

## What

### FR-001 Cards can carry follow-ups

**Follow-up items.** Any pending action's payload may carry `then: [{ key, kind, payload, summary }]`.

**Applying a card.** `agents/pending-actions.ts` `applyOnce`:
1. It runs the main handler first.
2. After success, it runs each item through the same registered handler map.
3. It skips the keys listed in `input.skip_then`. This key is new; `fix_config_conflicts` keeps its own `input.skip`.

**Each item:**
- runs in its own try;
- records its outcome in `result.then: [{ key, ok, error?, result? }]`;
- does not change the card's status (only the main handler does);
- cannot nest: an item's own `then` is ignored.

**Dashboard** (`components/chat/ActionCard.tsx`):
- `then` items render as a ticked checklist, generalising `ResolverSkipContext`;
- Apply sends `input.skip_then` for the unticked items;
- the result view lists each item's outcome;
- `import_list` gets a `KIND_META` / `BOXED` entry if it lacks one.

All UI text is English.

**Owner bot.** Chat cards stay dashboard-only, as today (`actionSource` lists only cards without a chat).

### FR-002 "Take content from X" becomes one card

**New optional inputs** for `import_list` (`docs/import-list-tools.ts`):
- **`series`** (a series name). It becomes a `series_change` item: `{ op: 'update', fields: { source: { kind: 'library', table: <dataset> }, source_mode: 'required' } }`.
  - It is validated when proposed, by `prepareSeriesChange(..., { pendingTables: [dataset] })`. `sourceProblems` (`schedule.service.ts:463-471`) and `seriesSourceErrors` (`network/series.ts:119-133`) accept a dataset that the same card creates.
  - It is skipped with the error `import_empty` when the import wrote 0 rows.
- **`stop_using`** (the owner's words). It becomes an `owner_rule` item, linted and stored by the same path as `add_owner_rule`.
- **`disable_skills`** (skill handles). Each becomes a `detach_skill` item, served by the existing handler (`editor.module.ts` ~:946); no new tool is exposed. Conflicts found by FR-003 are added here too.

**Wiring.** `buildImportListTools` gets the schedule, agents and skills dependencies, which are already in scope in `editor.module.ts`.

**Tool descriptions.**
- `import_list` becomes active: «Коли власник каже "бери з X" / "не бери Y" — виклич import_list з series і stop_using; ніколи не пиши скіл про джерело контенту».
- `agentPersona` (`agents/agent-prompts.ts:44`), `buildComposerSystemPrompt` (`roles/prompts.ts:155`), `editor-composer-workflow.md` and `agent-chat-etiquette.md` map the source-change intent to this route.

**Loadout.** Check that the composer's loadout (spec 054) always offers `import_list`.

**Skill writes.** `edit_my_skill` and the builder's `write_skill` refuse a body that prescribes a live content source: a URL or API to take posts from, a `provider=` filter, or a dataset to use instead of the series source. The error is `source_belongs_in_import`, with a hint to call `import_list`. A skill about how to use a dataset is fine (pick a row, keep the prompt verbatim, credit the author).

**Runbook.** §§ 24–25 change: the agent proposes the bundle, and the owner only ticks items and applies.

### FR-003 Skill conflicts are found when a skill is written

`agents/skill-warnings.ts` gets two pure functions, `skillConflicts(newBody, existing[])` and `sourceInSkill(body)`.

- **Tokens.** Second-level host labels, `data://` and `library:` keys, `provider=X`, and the words inside negated clauses (не бери, не використов…, never, don't use, замість).
- **Hard conflict.** The new skill's negated tokens meet an existing skill's positive tokens, or the reverse. This becomes a `detach_skill` follow-up, ticked.
  - Test pair from the export: 7a054c4f «Фільтр provider=prompthero» vs d3ef5edb «PromptHero не використовую».
- **Soft conflict.** The two skills name different sources and share a format or series word. This becomes a follow-up, unticked.
- **Existing skills.** `skills.listForAgent` over the orchestrator and its children: enabled skills whose `appliesTo` overlaps. `AgentChatToolDeps.skills` widens from `findShared` to include `listForAgent`.
- **Where it runs.** `edit_my_skill` / `write_skill` attach the conflicts as `then` items of the `write_skill` card.

### FR-004 One live note per problem

**`decideNote`** (`agents/note-gate.ts`):
- **Window.** It compares with the **union** of the parts of the subject's notes inside `OWNER_NOTE_REPEAT_DAYS`, not only the last note.
- **Numeric parts** (`streak:N`, `name:N`) fire only when N ≥ (max N said in the window) + step. The step comes from the gate (`grow`), with a default of `EDITOR_CRITIC_REJECT_STREAK`. A decrease never fires.
- **Non-numeric parts** fire when not seen in the window.
- **Repeat.** Otherwise it fires again after the repeat window ("still going").
- **Run length.** It also returns `runLength`, the number of consecutive notes of the subject.

**Past days** (`silent/silent-days.ts` ~:190). A past day fires only its first note: skip it when any note with ref `<ref>|<day>#…` exists. Today keeps the gate. A first miss reported late, after midnight, still fires.

**Edit in place** (owner bot):
- **When.** A note supersedes an older note of the same subject whose card is open, has a `message_id` and is under 24 h old.
- **What happens.**
  1. `owner_cards.repository` gets `retarget(cardId, newRefId, title, body, buttons)`: one UPDATE, guarded against the unique (kind, ref_id).
  2. The bot calls `api.edit` (`editMessageText`) instead of closing the old card and sending a new one.
  3. The callback `oc:<card>:<idx>` stays valid.
- **Fallback.** On `BotApiError.gone`, send a new message. `notModified` is a no-op.
- **When to send a new message anyway.** When the severity rises to critical, or the card is older than 24 h.
- **Interface.** `OwnerInbox.supersede` returns the superseded ids, and `deliver` passes `{ replaces }` to the card sink.

**Demotion.**
- **When.** A subject reaches `runLength ≥ 3` with no owner action since the run started. Owner action means a card of the subject resolved from Telegram (`resolved_by LIKE 'telegram:%'`) or a dashboard decision on its note.
- **What happens.** The next notes of the subject are posted at severity `info`. The card sink already ignores `info`.
- **The daily report.** `owner-reports.ts` `daily()` lists these subjects under «Повторюється без вашої реакції» (one line each: what, since when, how many times).

**`event_not_covered`** (`story/event-watch.ts:55`) goes through `postOnce` with the subject `event:<ref>:<event key>`. It is marked read once the event is covered or past.

**Do not rename the critic subject** `silent:<ref>:critic`. `kpi-digest.service.ts` `signalsOf` parses it.

### FR-005 The manager escalates by code

**`ManagerRunner.escalate()`** runs from the hourly housekeeping (`editor.module.ts` ~:805). It uses no LLM.

**Triggers:**
1. Two or more `verification.adherence = 'not_followed'` directives for the same target agent and kind within 14 days.
2. A negative posts anomaly (`kpi_snapshots.metrics->'posts'->>'anomaly'`, z < 0) on 3 or more consecutive days for an agent with no directive filed in that span.

**Output:**
- one Inbox note via `postOnce`: kind `manager_escalation`, severity `action`, gate subject `escalation:<handle>:<kind|posts>`, parts = the directive ids or days. Text in Ukrainian, naming the advice that was not followed and what the owner can do;
- one manager memory line.

It is an Inbox note, not a code-filed `strategy` directive: approving one rebuilds the playbook.

**Digest.**
- The digest gets an `escalations` block («не виконано за 14 днів»), counted in `digestHash`. Only open escalations, in a stable order.
- The open-directives query also shows `evaluated` directives with `not_followed` from the last 14 days.

**`submit_review`.** It gets `escalations: [{ subject, directive_id? , decline_reason? }]`. `checkEscalations` refuses a review that leaves an open escalation without a filed directive id or a decline reason of 20 chars or more. A `continue` verdict cannot leave one unaddressed.

**Cadence and cost:**
- `DEFAULT_MANAGER_TIMES = ['09:00']`;
- `loop.run(..., { cache: false })` at `manager-runner.ts` ~:230. All 11 manager runs since 10-21 were one call: a ~16.7k cache write and 0 reads;
- `deps.inbox` widens to include `postOnce`.

### FR-006 The claim guard knows the chat's past

In `chat/turn-record.ts`, `chat-facts.ts` and `editor-chat.service.ts`:
- **Write claims.** «записав / зберіг / створив» in a sentence that names скіл / пост / чернетк* / draft / skill is a **write** claim, not a rule claim.
- **Backing from the chat's past.** `unbackedClaims` also takes the actions of earlier turns in the chat and the applied cards in `ChatFacts`.
  - A claim is backed when its sentence names the skill handle, the rule number (#N) or the card id of an earlier applied action.
  - Free-word overlap is not enough.
- **Retry on a claim.** It rebuilds the history **without** the first answer and adds a system note: «відповідай на останнє повідомлення власника ще раз; кажи лише те, що зробили інструменти; ніколи не згадуй перевірку чи виправлення». Still one retry at most.
- **The denial path** (`contradictedDenials`, `denialRePrompt`) is unchanged. `chat-truthfulness.062.test.ts:189` keeps its shape.

### FR-007 `origin=original` is checked against what was read

- **New lint error.** `post/lint-post.ts` gets `origin_mismatch`. It fires when `origin === 'original'` and the post shares a verbatim run of `MAX_VERBATIM_RUN` (80) chars or more with any `ctx.sources` text (`verbatim-guard.ts` `longestCommonRun`). The hint: use `origin=library` + `library_ref`, or `origin=external` + `source`.
- **Executor path.** It uses `CriticGate.groundingSources`, which spec 067 extends with `read_doc` / `find_in_doc` texts. Write against the current interface; the merge brings the rest.
- **Chat path.**
  - `TurnRecorder.wrap` keeps a per-chat, in-memory capture of the texts returned by library, doc and web read tools (TTL 6 h, capped).
  - `drafts.save` / `guards()` pass it as lint sources. Chat drafts lint with no sources today.
- **Skill writes.** `skill-warnings` refuse a skill body that prescribes `origin=original` together with a fetched or library source.

## Out of scope

- Giving skills to the planner.
- A `read_by` column on `agent_inbox`. Owner action is inferred from cards and dashboard decisions.
- Dataset repeat modes (spec 071). `import_list` keeps creating datasets with reuse `never`.

## Acceptance

Unit tests with fakes and PG tests where SQL changes. The code map lists the new and the updated tests.

**Bundle:**
- An `import_list` call with `series`, `stop_using` and `disable_skills` gives one card with three follow-ups.
- On Apply: the import runs, then the series change with `source_mode: required`, then the rule, then the detach. An unticked item is not run. A failing item is shown while the card stays applied.

**Skill writes and conflicts:**
- The review-4 skill pair is a hard conflict.
- `source_belongs_in_import` refuses «бери пости з https://… API», and a style-only skill passes.

**Notes:**
- streak 8 → 6 does not fire; 8 → 9 with step 3 does not; 8 → 11 does;
- A → B → A in the window does not fire;
- yesterday is not re-fired;
- a superseding note edits the open card (edit called, send not called);
- `gone` falls back to send;
- `runLength ≥ 3` without owner action gives info notes, listed in `daily()`;
- the second identical `event_not_covered` posts nothing.

**Manager:**
- 2 not-followed directives give one escalation note, and the gate stops a repeat;
- 3 negative days give one note;
- the digest hash changes with a new escalation;
- `submit_review` that ignores it is refused, and is accepted with a directive id or a reason;
- the default times are `['09:00']` and `cache: false` is passed.

**Chat:**
- «я записав скіл X» with an earlier applied `write_skill` card naming X is backed;
- an unbacked claim retries without the first answer, and the final text has no «виправляю».

**Lint:**
- `origin=original` with an 80-char run from a source gives `origin_mismatch`;
- library + `library_ref` passes;
- no sources means no error.

**Existing tests** whose expectations change on purpose are updated: `note-gate.060.test.ts:22`, `owner-notes.060.pg.test.ts:64`.

`npm test`, `npm run build` and the dashboard checks pass.

## Amendments after the builder check

The builder check (2026-10-27) found gaps. These rules override the body.

**A1. Retry on a claim (FR-006).**
- The retry history is `input.history` without the first answer.
- The retry's user message is the owner's last message plus a system note:
  «відповідай на останнє повідомлення власника ще раз; кажи лише те, що зробили інструменти; ніколи не згадуй перевірку чи виправлення. Ці виклики вже виконано в цьому ході — не повторюй їх: <traceText(rec.trace)>»
- When a turn has both unbacked claims and contradicted denials, use this claim shape and append `denialRePrompt`.
- A denial-only retry keeps today's shape (062 test `:189`).
- Update `turn-record.040.test.ts:110`.
- Add a test that a retry after an `add_owner_rule` call does not store the rule twice.

**A2. Follow-up item shape (FR-001, FR-003).**
- An item is `{ key, kind, payload, summary, ticked?: boolean, requires?: 'main_rows' }`. `ticked` defaults to true.
- The dashboard starts `skip_then` with the keys of items whose `ticked === false`.
- In `applyOnce`, when `input.skip_then` is absent (API, owner bot), items with `ticked === false` are skipped and recorded as `{ key, ok: false, error: 'not_ticked' }`.
- The `run()` input merges `{ skip, skip_then }`; it does not overwrite.
- Item handlers are called as `h(item.payload, mainAction, null)`.
- Validate follow-up kinds against the registered handlers at propose time.
- `ActionCard` renders the follow-up checklist for any kind, outside `BOXED`.

**A3. `import_empty` (FR-002).**
- `import_list` sets `requires: 'main_rows'` on the series item.
- `applyOnce` skips such an item with error `import_empty` when the main result has `inserted + updated + skipped === 0`. A re-import of an unchanged list (all `skipped`) is not empty.
- At propose time, also check `datasetFormat(new_schema.entity)` against the series format.

**A4. Digest and directives (FR-005).**
- `countsAsCover` returns false for any row with `adherence === 'not_followed'`, whatever its status.
- `openDirectivesText` marks evaluated not-followed rows as «не виконано — ескалюй, не дублюй як пораду».
- Escalations count in both `digestHash` and `reviewSignature`.

**A5. Escalation triggers (FR-005).**
- Trigger 1 parts stay the directive ids.
- Trigger 2 parts are [`posts_from:<first day of the run>`, `days:<N>`], with gate `grow { days: 3 }`. A run that keeps going fires again only after 3 more days.
- One definition of an "open escalation" is shared by `escalate()`, the digest block and `checkEscalations`: an unread `manager_escalation` note from the last 14 days, keyed by its gate subject.
- A `directive_id` in `submit_review` escalations must be in this review's `directive_ids` and target the escalation's agent. `SubmitReviewInput.escalations` defaults to `[]`.
- Note text: English title and body, Ukrainian `alert` (house rule). `refType` is `escalation`, never `directive` or `playbook` (`OWN_CARD_REF_TYPES` would swallow the card).
- Do not change the manager's cache mode. Drop the `cache: false` item: the manager now makes two or more calls per run, so `prefix` is cheaper.

**A6. `event_not_covered` (FR-004).** This replaces the bullet in the body.
- `event_not_covered` keeps its `postOnce` ref, with no gate.
- `EventRecapWatch.check` marks its unread notes read (`inbox.markRead`, which closes the cards through the sweep) when the event is covered or its alert grace (`EVENT_ALERT_GRACE_HOURS`) has run out.
- `EventWatchDeps.inbox` widens to include `markRead`.
- Acceptance: an open `event_not_covered` note is marked read once the event gets a recap, and once its grace has passed.

**A7. Skill conflict tokens (FR-003).** This replaces the token rule in the body.
- Positive tokens are host labels, `data://` and `library:` keys and `provider=` values found outside negated clauses.
- Negated tokens are the same kinds plus bare words (lower-cased, 4 letters or more) inside a clause that contains a negation marker, on either side of it.
- A hard conflict is negated ∩ positive, where the positive side is only source-kind tokens.
- Candidates are the enabled own or inherited skills of the orchestrator and its children (add the `agents` dependency). Never builtin, safety or `isProtectedSkill` skills, and never the skill with the same name as the one being written.
- For `import_list`, run `skillConflicts` on «не використовуй <stop_using>» against the existing skills.
- A `disable_skills` item's payload is `{ handle: <owning agent handle>, skill: <name> }` (`editor.module.ts:946`). Resolve the owner through `listForAgent` over the orchestrator and its children.
- The three-follow-up acceptance test uses a fixture with no conflicting skills.

**A8. Past days in `silent-days` (FR-004).** This replaces "past days fire only their first note".
- A past day is skipped when a `series_missed` or `dark_day` note with ref `<ref>|<day>#…` already exists.
- Otherwise it goes through the gate as today, so a late first miss fires only when its parts are new in the window.
- A past-day note never supersedes or retargets a note of a later day.
- Pass a `reportedDays` input into `evaluateSilentDays` from `check()`. Do not restructure `load()`, which 068 edits.
- Add one test where a 068 placeholder skip yields a single gated note.

**A9. Edit in place (FR-004).** `OwnerInbox.post` and `postOnce` today call `supersede()` → `supersedeSink` before `deliver()`, so the card is already closed when the sink runs. New order:
1. compute the superseded ids;
2. call `deliver(id, i, { replaces })`; the card sink retargets at most one open card and returns its id;
3. call `supersedeSink` with the remaining ids only.

**A10. Run length and demotion (FR-004).**
- `runLength` = 1 + the number of the subject's earlier notes, counted back from the newest, while consecutive notes are at most `repeatDays + 1` days apart.
- An owner action is an `owner_cards` row joined to a note of the run with `resolved_by LIKE 'telegram:%'`. Drop "a dashboard decision on its note": no such record exists.
- Never demote `critical`.
- `daily()` finds demoted subjects by recomputing the same rule, not by a stored marker.
- With the owner bot inactive, `deliver()` falls back to `sendAlert` for every severity. Skip `sendAlert` for demoted info notes.

**A11. `origin_mismatch` (FR-007).**
- Check each source in 8 000-char windows overlapping by `MAX_VERBATIM_RUN`.
- The executor path catches web, feed and doc reads only. Library-row copies are caught in chat and by the skill refusal. Do not add a `query_data` capture to `critic-gate.ts` (067 owns that file).
- Chat capture: a shared in-memory `ChatReadCapture` keyed by `chatId` (TTL 6 h, capped). The `TurnRecorder` wrap writes to it for `web_fetch`, `fetch_feed`, `read_doc`, `find_in_doc`, `query_data` and `search_library`. `DraftsService` reads it through `draft.chatId`.
- Store only `AuditSource { url, text }`, with no image, images or `publishedAt`, so that `image_not_from_source` and the freshness checks stay off for chat drafts.
- The skill refusal returns an error code (`origin_original_with_source`) from `edit_my_skill` and `write_skill`, like `source_belongs_in_import`.

**A12. `import_list` wiring (FR-002).**
- Export `scopeOf` from `schedule-tools.ts` for the series item.
- `stop_using` needs `channelOf(ctx)`. It returns `no_channel` in a builder chat without a channel.
- The owner-rule item uses kind `avoid`.
- Shared files with 070: add the new zod fields at the end of `ImportListInput` and add the payload fields additively (spread, no reordering). Put the routing text as a separate leading sentence of the tool description, joined with `[routing, existing].join(' ')`. Keep 070's `split_on` in `payloadOf` when adding `then`.

**A13. Tests that will change on purpose.** In addition to the body's list: `note-gate.060.test.ts:21` and `turn-record.040.test.ts:110`.

**A14. Shared files.** Keep diffs in `editor.module.ts`, `roles/prompts.ts`, `silent-days.ts` and the runbook additive and local to the named functions.

**Merge order.** 069 merges after 067, 068 and 070, and before 071.
