# Orchestration task plans (`ai0_global`)

When **`/do-ebbing`** (or the **`orchestrator-planner`** agent) runs, it **creates a directory per goal** under **`tasks/`** (repo root).

## Layout

```
tasks/
  README.md                 ← this file
  _active                   ← single line: slug of the plan to run with /plan-step
  <plan-slug>/
    README.md               ← goal, constraints, risks, task table
    MANIFEST.md             ← ordered steps with checkboxes + links to agent prompts
    agents/
      01-source-researcher.md
      02-database-agent.md
      03-monorepo-developer-pipeline.md
      ...
    scratch/                ← ephemeral only (HTML dumps, samples); deleted after full MANIFEST success
```

**`code-reviewer`:** do **not** add a dedicated `agents/NN-code-reviewer.md` MANIFEST step right after `monorepo-developer`. The **`/do-ebbing`** executor always runs **`Task(code-reviewer)`** immediately after **`Task(monorepo-developer)`** (see **`.cursor/skills/monorepo-orchestrate-workflow/SKILL.md`**). Use a **`code-reviewer`** row only for **review-only** plans.

- **`agents/*.md`**: self-contained brief for **one** role. The executing chat should follow the matching agent definition in **`.cursor/agents/<role>.md`** and use this file as context (attach or `@` the path).
- **`MANIFEST.md`**: execution order. After a step finishes, mark it **`[x]`** and add a short note (executor may update the file).
- **`_active`**: optional default slug for **`/plan-step`** when you do not pass a slug in chat.
- **`scratch/`**: created with each plan; put all **temporary** files from research or debugging here. **Ignored by git** (`tasks/**/scratch/`). After **every** MANIFEST checkbox is **`[x]`**, the orchestrator **removes `scratch/`**; on **`BLOCKED:`**, it is **kept** for inspection.

## How to run the chain

### Full auto (default entry: **`/do-ebbing`**)

1. Run **`/do-ebbing`** with your goal → **`.cursor/skills/monorepo-orchestrate-workflow/SKILL.md`**: planner creates **`tasks/<plan-slug>/`**, then **Phase B** runs each MANIFEST row in order. When the **Task** tool is available, each row is delegated (`subagent_type` matches **`agent:`**); **`monorepo-developer`** rows **always** get **`Task(code-reviewer)` in the same turn** (no separate MANIFEST row for that). The **parent** stays **thin**: **`MANIFEST.md`** / **`_active`** updates only, no app code in the main chat. If Task is unavailable, the step may run inline.
2. To continue an existing plan without replanning: **`/do-ebbing continue`** (uses **`tasks/_active`**).

**Alias:** **`/orchestrate`** — same as **`/do-ebbing`**.

**Note:** **Cursor UI Subagents** (Settings) are optional presets. Repo orchestration expects **Task-tool subagents** for workers; the parent chat stays the orchestrator for **`tasks/`** bookkeeping.

### Manual (one step per message)

1. You can still use **`/plan-step`** (or **`/plan-step your-slug`**) after a plan exists → read the next unchecked step, open the linked **`agents/…`** file, delegate per the skill (for **`monorepo-developer`**, still run **dev + reviewer** Tasks in one turn).
2. Repeat **`/plan-step`** until **`MANIFEST.md`** shows all steps done or blocked.

You can also @-mention the same role and attach the **`agents/*.md`** file.
