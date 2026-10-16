# 040 tasks

Linear epic: AI0-126 (T1–T13: AI0-127 … AI0-139).

Wave 1 — production keeps running
- [x] T1 (AI0-127) FR-001 Budget pools: `editor.chat.<role>` usage for chat turns, production cap excludes chat, `editor.chat` cap ($1/day) seeded by migration 079, per-turn cap `EDITOR_CHAT_TURN_MAX_USD` ($0.30).
- [x] T2 (AI0-128) FR-002 + FR-003 Loop: circuit breaker (identical failed call, same error ×3 → tool dropped), `no_terminal`, 0-token retry, chat failure text without raw statuses.
- [x] T3 (AI0-129) FR-004 Idea review: paged compact `list_ideas`, batch in the reviewer prompt, `finish_idea_review` limits, `add_idea` per-run and backlog caps, duplicate → existing id.
- [x] T4 (AI0-130) FR-005 Planner inputs: `""` / nil UUID as absent, idea slot → fixed with the idea's topic, `same_plan_rejected` checklist.
- [x] T5 (AI0-131) FR-006 Sources: host failure memory (079 `source_host_failures`, 24 h), `host_blocked` + known alternatives, 404 "don't guess", `feed_unparseable`.
- [x] T6 (AI0-132) FR-007 Directives and manager: open set without `applied`, `supersedes`, schema defaults, `already_satisfied`, open directives in the prompt, skip unchanged reviews, digest wording.
- [x] T7 (AI0-133) FR-008 + FR-016 Honest metrics and small fixes: lint failures as errors, retries keep `scheduled_at`, `explain_decision` keys, `add_idea` valid refs + dropped resources.

Wave 2 — owner control
- [x] T8 (AI0-134) FR-009 + FR-015 Intent verbs and affirmative replies; chats bound to an agent keep it without a mention.
- [x] T9 (AI0-135) FR-010 + FR-011 Owner rules: overlap over the last 5 messages, `owner_rule` card fallback, `source_text` (079), skill existence; `rules-vs-config` check, `fix_config_conflicts` card, owner rules in executor/critic prompts + `owner_rules` axis.
- [x] T10 (AI0-136) FR-012 Owner and agent skills reach executor/checker (defaults, `agent_skills` on write, tone skill from the profile).
- [x] T11 (AI0-137) FR-013 Slot control from chat: `get_schedule` / `propose_slot_change` for @manager and channel agents, `regenerate`, `propose_replan_today`.
- [ ] T12 (AI0-138) FR-014 Truthful history: authors + action line per turn, claim guard (re-prompt, then visible note).
- [ ] T13 (AI0-139) Verification: replays of the export's failing runs as FakeLlm scripts, PG tests, docs and README row.
