# 047 Owner chat and rules — tasks

- [x] T1 (AI0-201) Owner requests count.
  - `agents/mentions.ts`: `REQUIREMENT_RE` and `hasRequirement`.
  - `chat/owner-intent.ts`: `offeredOptions` and `picksOfferedOption`.
  - The `agentIntent` gate was removed from `proposeCard` (builder tools) and from the schedule card tools.
  - Tests: `chat/owner-intent.047.test.ts`.
- [x] T2 (AI0-202) Chat facts and false denials.
  - `chat/chat-facts.ts`: `factsBlock`, `contradictedDenials`, `restatesFact`, `denialRePrompt` and `denialNote`.
  - `runGuarded` re-prompts once for unbacked claims and denials together.
  - Tests: `chat/chat-facts.047.test.ts`.
- [x] T3 (AI0-203) A message to several agents.
  - `leadingMentions`.
  - The `agents` route, with `composerTurn` and `runAddressees` (shared cap, earlier answers in the note), and the `addressees` stream event.
  - The dashboard live turn shows "To @a, @b · X is answering (i/n)".
  - Tests: `chat/multi-mention.047.test.ts`.
- [x] T4 (AI0-204) Rule lint.
  - `agents/rule-lint.ts` and `ruleToStore`.
  - `add_owner_rule` gains `points` and stores nothing on a lint failure.
  - Multi-line rules are indented in the writer prompt.
  - The agent memory page shows the lint, Retire and a summary.
  - Tests: `agents/rule-lint.047.test.ts`.
- [x] T5 (AI0-205) Resolver card.
  - `ConfigConflictsService.resolverFor` and `resolve(orch, skip)`.
  - `apply` gains a `keep` filter.
  - `fix_config_conflicts` is open to builder and composer, with payload `{handle, items}`.
  - The card shows checkboxes, and `input.skip` goes to apply.
  - The agent page shows `ConflictsLine`.
  - Tests: `rules/config-resolver.047.test.ts` and the updated `config-conflicts.040.test.ts`.
- [x] T6 (AI0-206) One voice and look first.
  - Migration `082_agent_voice.sql` and its down file.
  - `grammaticalGender` through the type, repository, PATCH, create and the @ai0 card.
  - `voiceLine` and `NO_UNREQUESTED_OFFERS` in the persona, builder and manager prompts.
  - The composer's look-first rule.
  - The dashboard Voice field.
  - Tests: `agents/agent-voice.047.test.ts`.
- [x] T7 (AI0-207) Formats from the dataset and truthful role modes.
  - `DATASET_FORMATS` / `datasetFormat` and the series check (`network/series.ts`); `seriesSourceCatalog` returns entities.
  - `boundDatasets` (`setup/setup.repository.ts`).
  - `allowedFormats(mix, datasets)`, the `checkSetup` requirement and `datasetsNote` in the onboarder prompt.
  - `effectiveMode` on role agents (tree and detail) from the `channelMode` dep, and `mode_follows_orchestrator`.
  - Dashboard: the Mode tile "follows @parent"; `StateBadges` shows the effective mode.
  - Tests: `setup/dataset-formats.047.test.ts`.
- [x] Follow-up 2026-10-18 (@ai0_prompts_dev): owner rule #23 «вимкнути перевірку мови» was stored, but `not_ukrainian` is switched only by the card's `language`, and the agent told the owner that only a code change could help.
  - A rule that turns the check off, or says the channel writes in English, against a `uk` card is now the conflict `language_check_rule`. Its fix sets the card's language: `en` for an English channel, else `mixed`. The fix goes through the resolver card.
  - The lint message says where the check comes from.
  - Tests: `rules/language-check.047.test.ts`.

## Deltas from the spec

- **Card tools are ungated; direct writes stay gated.** The verb gate was the cause of the refusals, but `steer_channel`, `analyze_channel_history` and owner directives write without a card, so they still need the owner's words.
- **Addressees are leading mentions only, at most 5.** A mention inside the text («подивись, як пише @nova») is what the message is about, not who it is for.
- **@manager among the addressees answers alone.** Coordinating is its job. A fan-out next to it would answer twice.
- **Lint thresholds are deliberately low** (2 content words, 4 for a pointer). «Без хештегів» is a full rule. A heading of a list is kept unless it is a pointer or a request.
- **Unknown skill or agent stays its own error code** (`unknown_skill` / `unknown_agent`) for the 040 callers. Other failures are `rule_lint_failed`.
- **Role modes are shown, not honoured.** Honouring a role's own mode would let a planner set to `off` silently stop a live channel. The card mode is the one publishing switch (031 FR-010). Existing role `mode` values are left in the table; nothing reads them.
- **Bound datasets come from series sources and the ledger, not from a new binding table.** That is where @pdr's dataset already shows. 90 days keeps a dataset the channel stopped using from forcing its format.
- **The playbook check on dataset formats applies to every later playbook edit.** An active playbook with a poll series from a quiz dataset has to fix that series in the same edit. The error names it.

## Owner actions after deploy

- Apply migration 082. It is additive and idempotent.
- On @loko_games and @nova_dev, open "Resolve in one card" and approve the waiting playbook draft and the junk-rule retirements.
- On @pdr, re-run "Setup from history". The proposal now includes quiz, and its playbook check asks for the quiz series format.
- Optionally set the Voice of agents that should write in the feminine.
