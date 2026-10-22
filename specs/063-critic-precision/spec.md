# 063 — Critic precision

Status: draft · Builds on 037 (integrity checks), 041 (critic axes, pass_with_edits), 046 (fallback ladder) · No migration

## Why

Review 3 (`docs/reviews/2026-10-22-agent-review-3.md`, findings 7–9, 18 and the P3 notes) found that the critic loses good posts and lets a few real defects through.

- **False grounding reject.** Slot `11d73ed6` was rejected over «$1 млрд» and «SB 53». The fetched TechCrunch text says "over a billion dollars" and "Senate Bill 53". `number_not_in_sources` (`post/grounding.ts`, `post/integrity/checks/sources.ts`) does not read spelled-out numbers or bill names, and the critic repeated the lint hint as fact. The same claims passed 5 h later in `f5fa0177`.
- **A fixable revise became a lost slot.** In `1fb75a76` the critic asked for fixable edits. The fallback step `next_candidate` (`silent/fallback-ladder.ts:208-218`) banned that very source («Не бери повторно»), so the slot skipped.
- **Topic substitution.** 3 rejects were "post is about another topic": the executor could not find the slot's article and wrote about something else.
- **pass_with_edits broke a sentence.** pp1732 «(context window) — це ліміт» became «(context window) ліміт». The edit (critic-gate `edit()`, about lines 408–431) only re-runs lint and guards.
- **Wrong time.** pp1716 says «до 22 жовтня, 17:00 за Києвом», but the API said 15:00Z = 18:00 Kyiv. The model converted time zones itself. The reminder's critic claimed the two times match.
- **Duplicate source link.** 5 of 37 posts had the same URL both as an inline anchor and as the «→ Source» line. `duplicate_attribution` only catches «Джерело: …» text.
- **Style axes don't discriminate.** voice and ai_likeness were never below 4 (46/46). Two Haiku explainers ended with a trailing emoji. One analogy opener («X — це як Y», «Уявіть…») was used for every explainer. Person names were mixed Latin/Cyrillic within a channel (`style.names` unset).
- **Critic cost.** The Opus critic's 13.4k-token prefix is sent uncached on every check.

## What

### FR-001 Numbers and names in grounding

The number/claim extractor normalises before comparing:

- Spelled scales: "a/one/over a billion|million|thousand", «мільярд/млрд», «мільйон/млн», «тис.», "$1B", «$1 млрд».
- Bill and act names: "Senate Bill 53" ↔ "SB 53", "Assembly Bill N" ↔ "AB N".
- Thousands separators and spaces: «5,120», «5 120».
- Percent written out: "40 percent" ↔ «40%».

Add unit tests with the review-3 cases, plus the review-2 cases «5,120», «$2,599.99», «18-core» and «3,552x3,840», which must not be false positives.

In the critic prompt, lint warnings are hints to verify against the passages. A warning is not proof. The critic quotes the passage when it confirms a missing number.

### FR-002 Revise keeps the source

- In the fallback ladder, a critic verdict `revise` with fixable notes (the default for revise) re-runs the executor on the **same source** with the notes.
- Only `reject` (or `revise` with grounding ≤ 2, or wrong topic) bans the source and moves to `next_candidate`.
- The ladder stays bounded as in 046 (one revise, then skip).

### FR-003 Never substitute the topic

The executor prompt gets this rule: «Якщо джерело слота не знайдено або недоступне — `skip_slot` з причиною; ніколи не пиши про інший матеріал замість теми слота». The critic's wrong-topic reject reason stays as is.

### FR-004 Safe edits

- **Dash replacement in code.** «— це» stays. The dash-to-comma/colon rule becomes a deterministic transform in code, not a model edit. Keep it consistent with the existing em-dash audit.
- **Reject word-dropping edits.** An edit whose `to` drops a word token that is not punctuation and not a duplicated word is rejected and recorded as such.
- **Re-check after edits.** After edits, re-run the Ukrainian lexicon/euphony check. A new finding reverts that edit.

### FR-005 Local times come from tools

- Tools that return event or deadline times (free-games / deals APIs, `fetch_api` results with ISO times the platform knows, news event dates) add `*_local` fields in Europe/Kyiv, e.g. `"ends_at_local": "22.10, 18:00 (Київ)"`. Find the call sites; at minimum cover the Epic/free-games path.
- Executor prompt: «Час для читача бери з полів *_local; не перераховуй часові пояси сам».

### FR-006 One link per source

- New lint `duplicate_source_link` (warning, auto-fixable): an inline link whose URL equals `source.url` (canonical) while the arrow/source line is present.
- The auto-fix keeps the inline anchor and drops the arrow line, or the other way round if the channel's style says so. Document the choice.

### FR-007 Voice tells

- `slop-lint` warnings for:
  - a trailing emoji at the end of the post on channels whose style limits emoji;
  - the analogy opener («— це як», «Уявіть, що») used in ≥ 2 of the channel's last 5 posts.
- The critic rubric anchors voice and ai_likeness with 2 concrete low-score examples each, so the scores spread.
- `style.names` defaults to `original` (names as in the source, Latin) when unset. Document this in the resource style.

### FR-008 Critic prefix cache

On the Anthropic path, the critic's stable part (rubric, channel profile and rules) gets a cache breakpoint. Per-post content comes after it. This keeps 053 T2's "no cache write for one-off checks": cache only when the stable prefix is ≥ 1024 tokens, and measure with a fake in the test.

## Acceptance

- Unit tests: the number normaliser (true positives kept, review-3 and review-2 false positives gone), the revise/reject ladder, the edit guard (pp1732 case rejected, «тими самі»→«ті самі» kept), `*_local` fields, `duplicate_source_link` + fix, the slop warnings, and the cache breakpoint placement.
- No paid calls.
