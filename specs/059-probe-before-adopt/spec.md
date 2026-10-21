# 059 — Probe before adopt

Status: in progress · Builds on 017 (skill self-edits), 034 FR-012 (dry-run preview), 041 (critic), 053 (token economy) · Migration 092

## Why

The owner asked (2026-10-21) whether to move to Google Research's Harness² (recursive harness improvement, arXiv 2610.14224).
Verdict: no — it is Python research code, its per-task Propose–Probe–Compose costs ~4 agent runs per task, and our tasks
(short, repeated posts with owner/critic signals) are not what it is built for. One idea is worth taking: **a harness edit is
probed on real work, old vs new, before it is adopted**, and a lesson is kept only with the evidence that supports it.

Today an agent's `propose_skill_edit` (spec 017 FR-008) applies **at once** as a new version; the daily
`SkillVersionEvaluator` rolls it back after 7 days if the scope KPI dropped. A bad edit therefore writes a week of posts.

## What

### 1. Probe states for a skill version

`propose_skill_edit` no longer makes the new body live at once. It writes the version with `outcome = 'probing'`
(migration 092 adds `probing` and `rejected` to the version outcome check, and `probe JSONB` on the version row) and returns
`{ ok: true, probing: true, version }` with a Ukrainian line for the agent ("зміну перевіряю на 3 недавніх постах, рішення — у
наступному прогоні"). The live body stays the previous version until the probe adopts the new one.

Owner edits and rollbacks are never probed (the owner decides). Builtin sync is not probed.

### 2. The probe (`SkillProbe`, code + LLM, offline)

Runs from the existing daily/minute machinery (pick the hook the evaluator uses), at most `SKILL_PROBE_PER_DAY` probes
(setting, default 3), each within `SKILL_PROBE_BUDGET_USD` (setting, default 0.30), oldest `probing` first.

For a version of agent A's skill S:
1. **Pick samples:** the `SKILL_PROBE_SAMPLES` (setting, default 3) most recent **published or approved** slots of A's scope
   whose writer role loads S (skill `appliesTo` includes the writer role, or the skill is inline). No such slots → no probe
   (step 5).
2. **Run pairs:** for each sample slot, two dry-run executor runs through the existing preview path (`preview-run.ts`,
   `PreviewSink`, spend feature `editor.probe` — add it to the usage feature registry next to `editor.preview`): one with the
   **current** skill body, one with the **proposed** body (override the resolved skill text for this run only — no DB write).
   Same slot, same model, same tools; nothing is stored on the slot, nothing is published, no Inbox items from the critic.
3. **Judge:** a pairwise judge call (critic model, small prompt, JSON out) per sample: given the slot topic, the resource's
   profile/rules summary, post A and post B in random order, return `{better: 'A'|'B'|'same', reasons: string[] (≤3), risks:
   string[]}`. Plus code signals per side: the critic verdict from the sink (pass / pass_with_edits / revise / reject), lint
   warnings count, length vs the format's target. Map back to old/new.
4. **Decide (code):**
   - **adopt** when the new side is never worse on the critic verdict ladder, has no new reject, and wins or ties the judge
     in a majority with ≥1 win; → the version becomes live, `outcome = 'pending'` with the usual 7-day KPI review (the
     evaluator keeps working as today on top).
   - **reject** when the new side gets a reject/revise the old did not, or loses the judge in a majority; →
     `outcome = 'rejected'`, the live body stays, and the agent gets an `avoid` memory line with the reasons (the evaluator's
     `remember` hook).
   - otherwise **inconclusive** → adopt as today (live + 7-day KPI review) with `probe.verdict = 'inconclusive'`.
   The budget running out mid-probe → inconclusive with what was gathered.
5. **No probe possible** (no samples, preview path unavailable for the platform, probes disabled with
   `SKILL_PROBE_PER_DAY = 0`) → adopt as today with `probe.verdict = 'unprobed'` and the reason. Behaviour never gets worse
   than today.
6. **Evidence stored** on the version: `probe = { verdict, samples: [{slotId, old: {critic, lint, chars, preview(≤600)},
   new: {...}, judge: {better, reasons, risks}}], costUsd, at }`.
7. **Owner note:** one Inbox item per probed version (adopted / rejected / inconclusive), English in the Inbox, Ukrainian in
   the Telegram alert like the existing `skill_self_edit` note (which now says "checking on 3 recent posts" instead of
   "applied"). Rejected ones carry an **Adopt anyway** action (owner override → live + KPI review).

### 3. Evidence for lessons (small)

The memory line written on rejection and on a KPI rollback carries `evidence` (the version id and the probe/KPI summary) —
the `remember` hook already takes `evidence`; make sure both paths pass it and the agent page memory list shows a short
"why" for such lines where the UI already lists memory.

### 4. Dashboard

- Agent page → Skills → versions: a version shows its probe state (`Probing…`, `Adopted after probe`, `Rejected by probe`,
  `Inconclusive`, `Unprobed`) as a `<Badge>`; clicking opens a dialog with the samples side by side (old vs new preview,
  critic verdicts, judge reasons) and, for rejected, **Adopt anyway** (confirm).
- Settings catalog: the three settings (`SKILL_PROBE_PER_DAY` 0–20 default 3, `SKILL_PROBE_SAMPLES` 1–5 default 3,
  `SKILL_PROBE_BUDGET_USD` 0–2 default 0.30), group next to the other agent settings, English descriptions.
- English UI text only; CompactCard/Modal/Badge conventions from `apps/dashboard/CLAUDE.md`.

### 5. @sysadmin

The weekly audit (055) gets one code check: versions stuck in `probing` > 3 days, and the probe reject rate per agent over
30 days (an agent whose edits are rejected ≥ 3 times is flagged "self-edits keep failing — consider locking its skills").

## Not in scope

Probing owner rules, steering sets, playbooks or prompts (later, same machinery); any per-post multi-run (the probe never
runs on the live path); new LLM providers.

## Acceptance

- Unit tests with fakes: sample picking, pairing and order randomisation mapped back, decision table (adopt / reject /
  inconclusive / unprobed), budget cut-off, daily cap, the tool's new return, owner override, evaluator untouched for
  `pending`.
- PG test (own throwaway DB): migration 092 (+ down), probing → live switch keeps the previous body live until adopt.
- No paid calls in tests; the judge and executor are fakes.
- Dashboard tsc/tests/build; the lead checks the versions dialog in the browser on mocks.
- Runbook: a new § in `docs/runbooks/agent-platform.md` (next free number); specs README row 059 DONE.
