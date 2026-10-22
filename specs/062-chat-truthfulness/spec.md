# 062 — Chat truthfulness

Status: draft · Builds on 040 (claim guard), 047 (denial check, intent gate, paste lookup), 048 (slash commands) · No migration

## Why

Review 3 (`docs/reviews/2026-10-22-agent-review-3.md`, findings 5 and 19) found that in the owner's chat `e8c11647` (@ai0_prompts_dev, 10-18) two false statements came from our own guard and history code:

- **A false apology.**
  - Run `4e4d4e82` did the work: 3 tools and a correct answer. The model ended that answer with a footer it typed itself, «[дії: немає — нічого не збережено й не опубліковано]».
  - The 047 denial check (`chat/chat-facts.ts:36`, `NOT_APPLIED_RE`) matched «нічого не збережено». It fell back to the last card (`:67`), an unrelated applied skill card, and called it a contradicted denial.
  - `runGuarded` (`chat/editor-chat.service.ts`) re-ran with text only. The retry had no tool context and answered «Ви праві… Інструментів у тому ході я не викликав».
- **A false self-accusation.** Read-only turns show in history as «[дії: немає — інструменти нічого не змінили]» (`chat/turn-record.ts:88-98`, which omits `TurnActions.tools`). The model then told the owner that its two earlier tool-backed answers «нічого не перевіряв інструментами».
- **Model-written footers.** 5 of 10 replies carried a model-typed `[дії: …]` footer, 2 began with `@ai0_prompts_dev:`, and 1 copied `[чернетки: …]`. These are unverified claims dressed as system facts.

The same chat also showed these problems:

- `add_owner_rule` returns every old conflict of the channel (`agents/agent-chat-tools.ts:207`). That led to an unrequested hashtag card, which the owner applied in 7 s.
- A new skill (`edit_my_skill`) prescribed English-only captions that the channel's own `not_ukrainian` lint rejects, and it contained dated facts («станом на 2026-10-18 … порожній»).
- `lint_post` was called on a made-up spec (`origin: library`, a `cdn.prompthero.com/placeholder.jpg` media URL) and reported as re-linting the draft.
- A yes/no question about data was answered from catalog metadata without reading one row.
- `save_draft` with `draft_id` replaces the whole spec (`chat/drafts.service.ts:97-127`), so the media field was silently dropped. The 3-attempt counter resets each turn, but the text reads as if it were global.
- "Resolve in one card" runs a full LLM turn (44 tools, ~$0.03–0.09) for one deterministic `fix_config_conflicts` call.

## What

### FR-001 System footers are the system's

- Before the guards run and before saving, strip from the model's final text: a trailing `[дії: …]`, `[чернетки: …]` or `[actions: …]` block (one or more, at the end), and a leading `@handle:` prefix. Implement this as one function in `turn-record.ts` (or a sibling), with tests.
- Composer and builder prompts get one line: «Не пиши рядки [дії: …], [чернетки: …] чи «@handle:» — їх додає система».

### FR-002 History shows read tools

`actionLine` prints the tools that were called, de-duplicated:

- `[дії: змін немає; викликано: library_catalog, sql_readonly]` for read-only turns.
- `[дії: картка …; викликано: …]` for turns that wrote something.
- `[дії: інструменти не викликались]` only when none were called.

### FR-003 The denial check is precise

- `NOT_APPLIED_RE` may fall back to the latest card only when the sentence mentions a card: «картк», «card», «Apply», «застосув» or a card id. Otherwise a sentence about a post or draft is not a card denial.
- `DID_NOT_CALL` fires when the turn's `tools.length > 0` and the sentence denies calling tools, whether or not it names a tool, and whether or not the turn wrote anything.
- **Retry with the trace.** When a denial is contradicted, the retry gets the first run's tool trace as context: tool names plus a one-line result each, at most about 1500 chars. Or, for a pure footer/denial mismatch, append the system `denialNote` to the first answer instead of re-running. Choose per case and document the rule.
- **Traceable.** A replaced first answer stays traceable: the stored message gets `actions.retried_from = <first run id>`.

### FR-004 Lint and preview the real draft

- `lint_post` and `preview_post` in chat accept `draft_id`. They load the stored spec, and the given spec fields override it.
- Media URLs whose host or path looks made up are rejected with `invalid_media_url`: hosts `example.*`, or `placeholder`/`example` as a path segment or file name.

### FR-005 Data questions read rows

- The composer and builder prompt gets this rule: «На питання про зміст даних спершу query_data (3 рядки), потім відповідь».
- `library_catalog` shows `fill_pct` for every field it lists. The fields without it today (`media_url`, `prompt_text`, `title`) get it too.

### FR-006 Saves merge, counters say "this turn"

- `save_draft` with `draft_id` shallow-merges omitted top-level spec keys from the stored draft. An explicit `null` clears a key.
- The attempt-limit stop text says «у цьому ході» (this turn).

### FR-007 Rules and skills from chat

- `add_owner_rule` returns only the config conflicts the new rule causes: diff conflicts before and after, or filter by the rule id.
- `edit_my_skill` for a new skill checks the skill body against the channel card:
  - Language: a body that prescribes captions in a language the card's lint rejects gets a warning in the tool result.
  - Dates: dated facts («станом на <date>», «станом на сьогодні») get a warning.
  - These are warnings, not blocks. The model must mention them to the owner.

### FR-008 `/align @channel`

- A slash command (`chat/slash-commands.ts` pattern) runs `fix_config_conflicts` for the channel in code ($0). It returns the card plus a short item list in the reply.
- The "Resolve in one card" links (`AgentOverview.tsx:103`, `AgentMemoryHistory.tsx:37`) prefill `/align @handle`.
- Card bubbles for `fix_config_conflicts` list their items.

## Acceptance

Replay tests (fixtures modelled on chat `e8c11647`) must cover:

- A model-written footer → no false denial, no retry.
- A read-only turn's history line names the tools.
- A generic «я не викликав інструментів» after reads is caught.
- The retry gets the trace.

Unit tests for `lint_post(draft_id)`, the placeholder URL rejection, the save merge, the `add_owner_rule` conflict diff, the skill warnings and `/align`. Dashboard tests for the new link target.
