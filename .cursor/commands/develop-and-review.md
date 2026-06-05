Run a **developer → reviewer** loop for `ai0_global`.

## Phase A — `monorepo-developer`

Act as **`monorepo-developer`** (`.cursor/agents/monorepo-developer.md`).

1. Read the task: user request + any attached `## Source Spec` or plan.
2. Load the correct skill into context:
   - `apps/pipeline` → `.cursor/skills/monorepo-apps-pipeline/SKILL.md`
   - `apps/automation` → `.cursor/skills/monorepo-apps-automation/SKILL.md`
3. Implement with **minimal diff**, matching existing patterns.

## Phase B — `code-reviewer` (mandatory)

Immediately after Phase A, act as **`code-reviewer`** (`.cursor/agents/code-reviewer.md`) on **all files touched** in Phase A.

- Use sections: **Blocking**, **Should fix**, **Nit**.
- If there are **zero Blocking and zero Should fix** issues, reply with **`## Review status: APPROVED`** and stop.

## Phase C — fix loop (conditional)

If the reviewer reports any **Blocking** or **Should fix** item:

1. Switch back to **`monorepo-developer`** and fix **only** those items.
2. Run **`code-reviewer`** again on the updated diff.
3. Repeat until **`## Review status: APPROVED`** **or** you reach **3** full review cycles—then stop with **`## Review status: STOPPED (max iterations)`** and list remaining issues for the user.

## Rules

- Do not expand scope beyond the original task while fixing review feedback.
- Do not skip Phase B after coding.
