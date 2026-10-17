# 041 Content quality — tasks

- [x] T1 (AI0-192) Lexicon `post/language/lexicon.ts`: `language_calque` errors (russisms, calques, «на борту» outside a vehicle), `language_case` / `language_suspect` / `language_euphony` warnings with exact replacements, `LEXICON_EXCEPTIONS`; gaming / IT slang joined to `SLANG_MARKERS` behind `format_prefs.slang`; critic `language` axis (≤ 3 revise, quote the words), lexicon findings in the critic prompt
- [x] T2 (AI0-193) `pass_with_edits` with ≤ 8 exact `{from, to}` edits applied by code (`critic/spec-edits.ts`) to every text leaf; a failed edit → revise with the notes; euphony fixes applied on any pass without an LLM turn; lint + render again after the edits; `edits` stored on the slot critic; a 4 with a «quoted» problem and no edits → revise (`quoted_problem`)
- [x] T3 (AI0-194) `rules/owner-style-overlay.ts` (no hashtags / no slang / simpler → beginner) merged wherever the style is read (card, profile, platform refs); planner style line (channel and network planners); no vocabulary → hashtags off and effective `hashtagMin` 0; conflicts `hashtag_min_without_vocabulary` (fix: `hashtag_min_zero`) and `rule_not_in_profile` (fix: rule written into `format_prefs.style`); profile / formatting saves return `conflicts`, the dashboard refreshes them
- [x] T4 (AI0-195) `evergreen-kind.ts`, `topic-key.ts` (`sameTopic`); `topic_repeat` error (evergreen vs the channel's evergreen posts of 30 days); `story_cross_channel` window 72 h, siblings matched by story or topic; `recent_topic` in `add_idea`, `topic_recent` in `submit_plan`; the last 30 days' topics in the planner and orchestrator prompts
- [x] T5 (AI0-196) `owner_rules` score + `rule_checks` for every listed rule, else revise (`owner_rules_missing`); a broken rule quotes the words; `isTextRule` keeps schedule / frequency / approval rules out of the critic prompt
- [x] T6 (AI0-197) Claim passages (quotes, «заявив / сказав / за словами / повідомив / каже»), ≤ 8 passages; `slop_adjective_triple` skips relative adjectives; `address_mixed` skips «зазвичай / вкрай / украй / бодай»; `lint_warnings` on the slot critic, `overruledWarnings()` → `lint_overruled` in the KPI digest; critic and manager skills trimmed under 6000 chars
- [x] T7 (AI0-198) `draftRisk` (`critic/critic-risk.ts`); risk ≥ 3 → owner / role critic model, else the light model (Anthropic `checker_light` = Haiku, OpenRouter `EDITOR_MODEL_CHECKER_LIGHT` or the normal checker); `route` and `cost_total_usd` on the slot critic; the critic block on the dashboard lists the applied edits
- [x] T8 (AI0-199) Setup: < 5 text posts → `too_few_posts` with an `insufficient_data` reason and no LLM run; span < 7 days → `insufficient_span`, no rate or quiet hours applied; text metrics over text posts only; `post/brief-media.ts` + `brief_media_missing` lint error; steering `rule_contradicts_metrics` (emoji, hashtags, chars, words) and the no-text note in both prompts
- [x] T9 (AI0-200) `review2-regression.ts` (10 posts, 1712–1714 reconstructed) + lint test per post; `critic/evals/review2-cases.json` (1713, 1717, 1719, 1724) for the 051 eval runner, not run here

## Deltas from the spec

- From the second critic pass on, edits that cannot be applied leave the post unedited instead of a revise (the rewrite chain stays within 046's cap).
- `quoted_problem` applies only to a score of 4.
- On OpenRouter the light critic model is only used when `EDITOR_MODEL_CHECKER_LIGHT` is set.
- `insufficient_data` is the existing `too_few_posts` status with a reason prefix (no migration).
- `recent_topic` / `topic_recent` and the topic match (siblings, `topic_repeat`) apply to evergreen posts, ideas and slots only: a news post on the same subject is a new story. Network plans have no free-topic slots, so `topic_recent` runs for channel plans.
- The network planner's style line is the anchor resource's.
- `brief_media_missing` is a Telegram lint check (platform specs carry their own media rules).
- The regression set has 10 posts (1712 counted); 1712, 1713 and 1714 had no stored spec and are reconstructed around the quoted defect.
- The chat's card for an own channel without an editorial card now carries the same effective style (no vocabulary → hashtags off), so a chat draft lints the same before and after scheduling stores the minimal card; such drafts carry no hashtags.
