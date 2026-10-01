# 014: Cross-promo (ВП) engine: evaluate, negotiate, schedule, verify

**Status:** SPEC · **Depends on:** 011, 012, tracking subsystem, 005 reserved slots, 010 composer

## Why
Cross-promo (взаємопіар) is the cheapest growth channel for a small network. To do it safely the agent must:
- decide **whether a partner channel is relevant and real**;
- agree terms within the owner's policy;
- publish our side on time;
- **verify** that the partner did the same.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Candidate intake.** Sources: DMs (011), group requests (013) and owner-entered candidates. Every candidate is resolved to a channel: via `@username` or a link, using the tracking resolve (read-only, no join; for private invite links only `checkInvite` preview). It is added to `tracked_channels` with `poll_tier='cold'` for at least 7 days of observation when not already tracked. |
| FR-002 | **Evaluation** (`evaluateVpCandidate`, deterministic plus one LLM classification). The result: <br>• **size and engagement:** subscribers; avg views/post over 30 days; ER = views/subs; growth curve. Flags on jumps above 20%/day without matching views (bought subscribers). <br>• **authenticity:** views/subs ratio bands; a dense ad-edge graph (`tracked_ad_edges`) suggesting it belongs to a bot or crypto-spam network; how often reposts and ads appear among its posts. <br>• **topic fit:** an LLM classification of its last 30 posts into our topic taxonomy, and an overlap score with our channel's `brief`. Banned topics give an instant reject. <br>• **size fit:** the ratio of their audience to ours, between 0.5 and 2 by default. <br>• **history:** past ВП with them (ledger), and whether they delivered. <br>The output is a score in 0..1, a decision (`accept` / `counter` / `reject`), reasons, and the evidence numbers. It is stored in `vp_candidates`. |
| FR-003 | **Terms policy** (owner config): <br>• formats: post exchange, mention in a digest, repost <br>• timing window <br>• "no deletion" duration (24/48 h) <br>• pin or no pin <br>• max ВП per channel per week <br>• a cooldown with the same partner (30 days) <br>• a size-ratio compensation rule (e.g. a smaller partner gets a digest mention instead of a post) <br>The agent proposes only terms inside the policy; anything outside requires owner approval. |
| FR-004 | **Our creative.** The 010 composer drafts our promo post for **their** channel: a description of our channel with a link, using our brand voice. We send it to them, and the owner approves it in phases 0–2. **Their creative** for our channel is linted like an ad (008), with `#взаємопіар` or a policy label, and gets a reserved slot (`kind='reserved'`, `vp_deal_id`) on the agreed date. |
| FR-005 | **The ВП deal state machine:** `proposed → agreed → scheduled → ours_published → theirs_verified → completed`, or `violated` / `canceled`. Both sides' times are stored. |
| FR-006 | **Verification.** After their agreed time + 2 h, the tracking poller checks their channel for a post that links to our channel (by username or link) and posts after the agreed time. It re-checks at the end of the no-deletion window: if the post was deleted early → `violated`. If nothing appears within 6 h → a polite reminder DM (011), and after 24 h → `violated`. The owner is notified and the ledger is updated. |
| FR-007 | **Ledger.** `vp_ledger(partner_channel, our_channel, date, our_views_24h, their_views_24h, subs_delta_ours_48h, outcome)`. It feeds the reviewer (005) and future scoring: partners who deliver get a higher score. |
| FR-008 | **Dashboard `/app/deals/vp`:** candidates with evidence, active deals, the ledger and the partner leaderboard. |

## Corner cases
- The partner changes their username after agreeing → track by channel id.
- The partner posts the link to an old username or with a typo → verification uses a fuzzy match, and an uncertain result
  → owner check.
- The partner's channel is private: no tracking poll is possible → the deal requires a screenshot plus owner confirmation,
  and is never auto-completed.
- Time zones and "ввечері" ambiguity → the agent confirms the exact Kyiv time in writing before `agreed`.
- The partner asks for money on top of the ВП → this becomes an ad deal (015) or is rejected.
- The partner's channel gets taken over or rebranded to a banned topic between the agreement and the date → re-evaluate
  24 h before; when the score drops → cancel politely.
- Our slot conflicts with a paid ad → paid ads have priority; the agent proposes another time.

## Success criteria
- Unit tests:
  - the scoring components, using fixture channels with known bot patterns;
  - the policy enforcement;
  - state machine transitions;
  - verification of a post found, a post deleted early, a post never published, and a private channel.
- Evals: `vp-relevant` → counter/accept within policy; `vp-botnet` → reject; `vp-banned-topic` → reject;
  `vp-no-show` → reminder, then violated.
