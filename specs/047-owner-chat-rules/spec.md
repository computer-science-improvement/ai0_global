# 047 Owner chat and rules

**Epic:** AI0-180 (T1–T7 = AI0-201…207) · **Priority:** P1 · **Depends on:** 018, 031, 040, 041, 042 · **Status:** DONE 2026-10-18 (deltas in [tasks.md](tasks.md))

## Why

Review 2 (`docs/reviews/2026-10-17-agent-review-2.md`) found the owner's chat failing in ways that cost them trust:

- **Asks that were refused.** «Хай буде…», «потрібно щоб…» and a reply picking an option the agent itself offered got "I need an explicit request". Card tools were gated by the same verb check that guards direct writes.
- **Denials of facts.** An agent said a card was not applied when it was, said an agent did not exist when it did, and said it had not called a tool it had just called.
- **One agent per message.** «@ai_global @loko_games @nova_dev переплануйте» reached only the first agent.
- **Junk rules.** Rule #15 «Ці правила завжди виконуються для всіх постів» was stored while the owner's 8-point list it pointed at was lost. #14 named a skill that does not exist, and #10 was a request to the agent, not a rule.
- **Config conflicts.** Conflicts were listed, but nothing resolved them. A playbook draft had waited for approval since 10-12, and its fix was blocked.
- **Voice.** @ai0 wrote «я дав» and «я писала» in one chat. It also offered a handle change nobody asked for. A composer said «не бачу цього поста в даних» without searching, and found the post a turn later.
- **Formats and modes.**
  - @pdr's onboarder allowed poll / text / photo for a `quiz_question` dataset, so post 1725 went out as a poll with no correct answer.
  - Role agents showed `off` (or `approve`) but ran and published live.

## Requirements

### FR-001 Owner requests count (T1, AI0-201)

- **Card tools are not verb-gated.** A tool that only *proposes* a card can be called on any turn: the card itself is the owner's confirmation. Direct writes (steering, history analysis, owner directives) and paid runs stay gated.
- **Requirement phrasing counts as a change intent:** хай (буде), нехай, потрібно / треба (щоб), хочу (щоб), хотів би, дай(те), пусть, нужно чтобы, let it be, I want, I'd like, make it, should / must be. A negated phrase («не треба») does not count.
- **Picking an offered option counts.** A short reply (≤ 120 chars, no negation) counts when it names an option from the agent's last message, by number, ordinal or text, and that message proposed a change.

### FR-002 Chat facts and false denials (T2, AI0-202)

- **Facts in the system prompt:** every chat turn gets the chat's last 12 cards with their status and the network's agent roster, labelled "all real".
- **Denials are checked against the data.** After the turn, a reply that contradicts the data gets one re-prompt with the evidence. The kinds are: "not applied" for an applied card, "no such agent" for a handle in the roster, and "did not call" for a tool called in the turn.
  - If the re-prompt does not fix it, the reply is kept with the note "(Check: the data says otherwise — …)".
  - Quoted text is ignored.
  - The 040 claim guard does not flag a sentence that restates an applied card.

### FR-003 A message to several agents (T3, AI0-203)

- **Addressees.** These are the mentions at the start of the message, separated by spaces, commas, і / й / та / and / &. Mentions later in the text are data.
- **Several channel agents.** With 2–5 channel agents addressed, each answers in turn as its own message.
  - A role resolves to its orchestrator.
  - Later agents see the earlier answers.
  - The agents share one per-turn cap (`EDITOR_CHAT_TURN_MAX_USD`). An agent is skipped with a note when under $0.02 is left.
- **With @manager.** If @manager is among the addressees, it answers alone and coordinates.
- **One mention** keeps the old route.

### FR-004 Rule lint (T4, AI0-204)

- **Lint at write time.** `add_owner_rule` lints the rule. A failing rule is not stored. The issues are:
  - `pointer_only`: points at other text with fewer than 4 content words;
  - `too_vague`: fewer than 2 content words;
  - `meta_request`: «запамʼятай…», «додай правило…»;
  - `unknown_skill`;
  - `unknown_agent`.
- **A list from the owner is one rule.** When the owner's message holds a list of 2–12 points, the rule is stored as one multi-line rule in the owner's own words. This applies to explicit `points`, and to a vague heading next to a list.
- **The agent page** shows the lint per owner rule ("needs fixing") and a Retire button.

### FR-005 Resolver card (T5, AI0-205)

- **One card per channel.** `fix_config_conflicts` (builder and composer) proposes it with the items in apply order:
  1. a playbook draft waiting for approval;
  2. junk owner rules (by FR-004 lint) to retire;
  3. the config conflicts (040 FR-011).
- **The owner can untick items.** Unticked keys (`playbook:<id>`, `rule:<id>`, `conflict:<code>:<ref>`) are left as they are.
- **The agent page** shows "N conflicts with your rules", with "See them" and "Resolve in one card".

### FR-006 One voice, no unrequested offers, look first (T6, AI0-206)

- **One voice per agent.** `agents.grammatical_gender` holds `masculine` or `feminine`; NULL = masculine (migration 082).
  - It is set on create and edited on the agent page (Voice) or through the @ai0 card.
  - Persona, builder and manager prompts carry the voice line «Не змінюй рід».
- **No unrequested offers.** The same prompts say: answer what the owner asked, and propose a change only when it solves a problem the owner named.
- **Look first.** The composer finds a post the owner pasted or named (get_recent_posts / get_network_posts) before it judges it. It never says «не бачу в даних» before searching.

### FR-007 Formats from the dataset; truthful role modes (T7, AI0-207)

- **Datasets imply formats:** `quiz_question` → quiz, `poll_question` → poll (`DATASET_FORMATS`).
- **The onboarder knows the channel's datasets.** These are the library sources of its playbook series plus datasets with published rows in its content ledger in the last 90 days.
  - The onboarder is told the format they need.
  - That format is allowed even though a quiz looks like a poll in the history.
  - A proposal without it gets a check error.
- **Series formats.** A series sourced from such a dataset must use that format: `validatePlaybook`, through the source catalog's entities.
- **A role agent has no mode of its own.** Runs never read its `mode` column. The agent page, tree and badges show the orchestrator's channel-card mode ("follows @parent"). A PATCH of a role agent's mode is refused (`mode_follows_orchestrator`).
