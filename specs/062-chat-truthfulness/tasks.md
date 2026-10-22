# 062 tasks

- [x] T1 Footer stripping + prompt line; `actionLine` with called tools; precise `NOT_APPLIED_RE` fallback and `DID_NOT_CALL`; retry with tool trace or appended note; `retried_from`; replay tests on a chat-1 fixture.
- [x] T2 `lint_post` / `preview_post` with `draft_id`, made-up media URL rejection, `save_draft` merge, "this turn" stop text, data-question prompt rule, `fill_pct` for every catalog field; tests.
- [x] T3 `add_owner_rule` returns only conflicts it causes; `edit_my_skill` language/date warnings; `/align @channel` slash command + item list; dashboard links prefill `/align`; tests; docs (runbook §, specs README row 062 DONE, spec status done).

## Status

Done. One commit per task: T1 `ccd6ab56`, T2 `a6797846`, T3 the commit after them (`feat(chat): 062 T3 …`). No migration. Runbook: `docs/runbooks/agent-platform.md` § 21.

## Deltas from the spec

- **Retry rule (FR-003).** A reply whose only fault is a `did_not_call` denial keeps its answer and gets the `denialNote` appended, with no second run (the tools produced the answer; a re-run is where the false apology came from). A denied card, a denied agent or an unbacked claim is re-run once with the tool trace (about 1500 characters, one line of result per call, errors included). The trace lives on the recorder (`TurnRecorder.trace`) and is not stored.
- **`did_not_call` after reads.** "Я не викликав інструментів запису" (no write tools) after a read-only turn is true, so it passes; after a turn that wrote it is caught. A sentence naming a tool the turn did not call also passes.
- **`lint_post` / `preview_post` are one tool for both roles** (the registry refuses duplicate names), so the executor's schema also shows an optional `draft_id`; without a drafts port it answers `draft_id_unavailable`. `spec` became optional (neither `spec` nor `draft_id` is `invalid_args`). `invalid_media_url` is checked in these two tools only, not in `save_draft` or `lintPost` (fixtures and 063's lint area use example hosts).
- **`save_draft` merge** needs the keys the model sent, which the parsed spec loses (the schema defaults `media: []`). The tool's `spec` is now `ChatPostSpecSchema` (preprocess remembers the sent keys, `null` is dropped, a hidden symbol carries the omitted list); the model-facing JSON schema is unchanged. A call that does not go through the schema (direct `execute` in tests) is saved as given.
- **`fill_pct`**: a field with no entry in the dataset's `fill_rate` gets `0` once the stats exist (`stats_at` set); without stats nothing is claimed. The migration's stats function is not changed (it counts keys present in `data`, so empty strings still count as filled).
- **Skill warnings run on every `edit_my_skill` proposal**, not only new skills (a stale date in an edit matters as much). The language check is a heuristic: a sentence about reader text that prescribes a language whose script the card's lint rejects, ignoring sentences about code, prompts, quotes or translation, and `mixed` / same-script cards.
- **`add_owner_rule`** reads the conflicts before the rule is stored and again after, and reports the new ones plus those naming the rule. The note no longer says "@ai0 aligns them by card"; it says to offer `/align` only if the owner asks.
- **`/align`** takes an agent handle or a channel key (the links prefill `/align @handle`); without an argument it uses the chat's agent, then its channel. The card is proposed with the chat id so it shows in the chat, and the `action` event is streamed before the message.
- **Dashboard**: the Memory tab link now reads "Resolve in one card" (it no longer asks the agent). The card bubble lists the first 3 items with "+ N more".
