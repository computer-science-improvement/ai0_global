---
name: monorepo-orchestrate-workflow
description: >-
  Full autonomous orchestration for ai0_global: planner writes tasks/<slug>/ (+ scratch/ for ephemeral files),
  Phase B delegates each MANIFEST row via Task; after monorepo-developer, Task(code-reviewer) in the same turn;
  parent stays thin; delete tasks/<slug>/scratch/ when all steps [x]. Use for /do-ebbing, /orchestrate, /plan-step.
---

# Orchestrate workflow (`ai0_global`)

This mirrors the **planner → worker → code reviewer** pattern from Cursor subagent tutorials, mapped to **this repo’s agents** and **`tasks/`** on disk.

## Reality check (important)

- **Cursor UI Subagents** (Settings → Subagents) are **user-local** presets; the **Task** tool launches **in-session subagents** with a chosen `subagent_type`. Configure UI subagents if you want named presets; **delegation for this workflow uses the Task tool**, not manual copy-paste, whenever the tool is available.
- **Parent chat (orchestrator)** owns **`tasks/`** bookkeeping: read **`MANIFEST.md`**, invoke **Task** per step, then **update checkboxes** from the subagent result. Subagents execute the work; the parent stays **thin** unless Task is missing or fails (see **§ Thin parent**).
- **True OS-level parallelism** is not required; **sequential** Task calls until the manifest is complete is the target.

## Thin parent (Phase B — hard rule)

While executing **`/do-ebbing`** / **`/plan-step`** Phase B, the **parent chat must not** implement work that belongs to a worker role: no edits under `apps/*`, `database/*`, running scrapers/loaders, drive-by refactors, lint/config sweeps, or “finishing” what a subagent started.

**Allowed in the parent:** call **Task**, read subagent output, update **`MANIFEST.md`** / **`tasks/_active`**, create **`tasks/<slug>/scratch/`** if missing when a subagent needs it, **delete `tasks/<slug>/scratch/`** when the plan completes successfully (**§ Stop conditions**), short user-facing summary, and (if Task failed after retries) **one** explicit fallback line that execution continues inline.

**If Task is missing or fails:** state that once, then run the step inline; still update **`MANIFEST.md`**.

## Roles (mapping)

| Concept | This repo |
|---------|-----------|
| Planner | **`orchestrator-planner`** (`.cursor/agents/orchestrator-planner.md`) — writes **`tasks/<plan-slug>/`** |
| Worker | Per step: **`source-researcher`**, **`database-agent`**, **`monorepo-developer`**, **`content-formatter`**, **`terminal-debugger`** |
| Reviewer | **`code-reviewer`** after any **`monorepo-developer`** implementation step (same rules as **`/develop-and-review`**) |

## When `/do-ebbing` runs — two phases

### Phase A — Plan (skip if resuming an existing plan)

If the user did **not** say **`continue`** / **`resume`** **and** there is no usable **`tasks/<slug>/MANIFEST.md`** yet for this goal:

1. Act as **`orchestrator-planner`**: full plan, **create** **`tasks/<plan-slug>/`** per **`tasks/README.md`**.
2. Every **`agents/NN-….md`** file **must** start with YAML frontmatter:

```yaml
---
agent: source-researcher
---
```

Use the **`agent`** value as the stem of **`.cursor/agents/<agent>.md`** (e.g. `monorepo-developer`, `database-agent`).

3. Write **`tasks/_active`** = `<plan-slug>` (one line).
4. Create **`tasks/<plan-slug>/scratch/`** (empty directory). **Ephemeral plan artifacts** (fetched HTML, sample JSON, pasted specs, debug dumps) **must** live only under this path **or** under **`tasks/<plan-slug>/`** paths you explicitly treat as durable (e.g. `README.md`, `MANIFEST.md`, `agents/`). **Do not** create repo-root **`.tmp-*`**, stray files under **`apps/`**, or other ad-hoc temp paths for orchestration output.

### Plan artifacts and `scratch/` cleanup

| Location | Lifecycle |
|----------|-----------|
| **`tasks/<slug>/README.md`**, **`MANIFEST.md`**, **`agents/**`** | Durable plan definition; keep unless the user deletes the whole plan folder. |
| **`tasks/<slug>/scratch/**`** | **Ephemeral.** Any subagent or planner saving files for this plan writes **here** (e.g. `scratch/page.html`, `scratch/source-spec-dump.md`). |

**Delegation prompt append** (for every Task whose work may produce on-disk artifacts): *If you write any non-code plan files for this run, paths must be under **`tasks/<slug>/scratch/`** (create the directory if missing). Do not write orchestration temp files to the repo root or under `apps/`.*

**After full success:** when **all** MANIFEST steps are **`[x]`** and nothing is **`BLOCKED:`**, the **parent** chat **must delete** the directory **`tasks/<slug>/scratch/`** entirely (all files inside). If **`scratch/`** does not exist, skip.

**When blocked or incomplete:** **do not** delete **`scratch/`** — leave artifacts for debugging and unblocking.

**Thin parent:** removing **`scratch/`** on success is **allowed** (housekeeping only, not product code).

### Phase B — Execute loop (runs after Phase A when planning happened, or alone when **`continue`** / **`resume`**)

Repeat until **no** unchecked `- [ ]` steps remain in **`tasks/<slug>/MANIFEST.md`** **or** a step is **`BLOCKED:`**:

1. Resolve **`<slug>`** from the user message, else **`tasks/_active`** (trim). If missing, stop and ask for a slug or goal.
2. Open **`MANIFEST.md`**. Find the **first** line with `- [ ]`.
3. Open the linked **`agents/NN-….md`**. Read **`agent:`** from frontmatter (required).
4. **Branch** (do **not** double-run the same work):

   **A. `agent:` is `monorepo-developer` — atomic develop + review**

   1. Run **`Task(subagent_type: monorepo-developer, …)`** with the step brief (see **§ Delegation policy**).
   2. If the developer result is **`BLOCKED:`**, mark that MANIFEST row accordingly and **stop the loop** (no reviewer Task).
   3. **Otherwise**, **in the same turn**, run **`Task(subagent_type: code-reviewer, …)`** with: repo root, **bullet list of file paths** from the developer result, and instructions to follow **`.cursor/agents/code-reviewer.md`**. **Skipping this Task is a workflow failure** when the Task tool is available.
   4. If the reviewer lists **blocking** issues, run **`monorepo-developer`** again with those fixes (up to **3** developer attempts **total** for this MANIFEST row), then run **`code-reviewer`** again after each fix attempt. On **`STOPPED (max iterations)`**, mark the row **`BLOCKED:`** and stop.
   5. Mark the **`monorepo-developer`** row `- [x]` with a one-line note (include review outcome).
   6. **Collapse duplicate reviewer rows:** for each **following** MANIFEST line in file order, if it is still `- [ ]` and its linked `agents/…` has **`agent: code-reviewer`**, mark that line `- [x]` with note *Satisfied by mandatory post-developer `Task(code-reviewer)`* — **no second reviewer Task**.

   **B. `agent:` is `code-reviewer`**

   - If this row was **not** consumed by **A.6** (e.g. review-only plan, or resume after an old run): run **`Task(code-reviewer, …)`** once, then mark `- [x]`.
   - If your MANIFEST still pairs `code-reviewer` immediately after `monorepo-developer` but **A.6** was skipped by mistake, run **one** `Task(code-reviewer)` for the prior dev work, then mark **both** rows `[x]` (do not run reviewer twice).

   **C. Any other `agent:`** (`source-researcher`, `database-agent`, `content-formatter`, `terminal-debugger`, …)

   - Run **one** **`Task`** per **§ Delegation policy**, then mark that row `- [x]` (unless `BLOCKED:`).

5. If any step set **`BLOCKED:`**, stop the loop.
6. **Continue** to the next `- [ ]` without waiting for a new user message **within the same `/do-ebbing` invocation**.

### Standalone `code-reviewer` rows (planner should avoid)

- **New plans:** the **planner must not** add a MANIFEST step with **`agent: code-reviewer`** immediately after **`monorepo-developer`**. Post-dev review is **always** **§4.A.3** (never a separate MANIFEST checkbox for the same work).
- **Legacy MANIFESTs** that still list `04-code-reviewer.md` after `03-monorepo-developer`: handled by **§4.A.6** (one `Task(code-reviewer)` per developer step).
- **Review-only** plans: a standalone **`agent: code-reviewer`** step is valid — use **§4.B**.

## Delegation policy (**required** when Task is available)

1. **If the Task tool is available in this session** — for **each** unchecked MANIFEST step you MUST call **Task** with:
   - **`subagent_type`** from the table below (must match the **`agent:`** frontmatter value).
   - **`description`**: short label, e.g. `MANIFEST step 02 — database-agent (tasks/<slug>)`.
   - **`prompt`**: paste the **entire** body of **`tasks/<slug>/agents/NN-….md`** (including YAML frontmatter), then append:
     - Repo root path and **`<slug>`**.
     - Instruction: *Read and follow **`.cursor/agents/<agent>.md`** for role behavior.*
     - Instruction: *Return a short **Step result** block: DONE or `BLOCKED:` + reason; list **files changed**; **for `monorepo-developer` only:** an explicit bullet list of **file paths** for the mandatory follow-up **`code-reviewer`** Task.*
     - Instruction: *Any ad-hoc saved artifacts for this plan go under **`tasks/<slug>/scratch/`** only (see skill § Plan artifacts).*
   - **`readonly`**: use **`true`** only when the step brief requires **no writes** anywhere in the repo; if the brief saves artifacts under **`tasks/<slug>/scratch/`** or edits app code/SQL, use **`false`** (default for **`database-agent`**, **`monorepo-developer`**, **`terminal-debugger`**, **`content-formatter`**). **`source-researcher`**: use **`false`** when the brief asks to persist samples to disk (scratch only); otherwise **`true`** is OK if the spec stays chat-only.

2. **If the Task tool is missing or every call fails** — state that once, then run the step **inline** in the parent chat (same rules as before); still update **`MANIFEST.md`**.

### `agent:` frontmatter → Task `subagent_type`

| `agent:` in `agents/NN-….md` | `subagent_type` |
|------------------------------|-----------------|
| `source-researcher` | `source-researcher` |
| `database-agent` | `database-agent` |
| `monorepo-developer` | `monorepo-developer` |
| `content-formatter` | `content-formatter` |
| `terminal-debugger` | `terminal-debugger` |
| `code-reviewer` | `code-reviewer` |
| (planner-only steps, rare) | `orchestrator-planner` |

**`/plan-step`**: exactly **one** MANIFEST **row** per user message. For rows whose **`agent:`** is **`monorepo-developer`**, that single “step” still requires **`Task(monorepo-developer)`** then **`Task(code-reviewer)`** in the **same** response (**§4.A**), then update **`MANIFEST.md`** (and collapse any duplicate **`code-reviewer`** rows per **§4.A.6**). For all other agents, **one** Task per row unless Task is unavailable.

**Phase A (planner)** may stay in the **parent** chat for a single coherent `tasks/<slug>/` write; optionally delegate Phase A with **`subagent_type: orchestrator-planner`** if the user asked for an isolated planning-only pass.

## Stop conditions

- All steps **`[x]`** → delete **`tasks/<slug>/scratch/`** if it exists (**§ Plan artifacts**), then short **Plan complete** summary (what changed, key paths, suggested `pnpm` checks).
- **`BLOCKED:`** → explain what the user must provide (secrets, style for formatter, manual decision). **Do not** delete **`scratch/`**.
- **`content-formatter`**: if style was **not** confirmed in the brief, mark **BLOCKED** unless the user already stated style in the **same** thread.

## Scope

- Respect **`.cursor/rules/*`** and app skills; smallest diffs; no secrets in committed files.
- Do not invent **`pnpm`** scripts: use **`apps/pipeline/package.json`** / **`apps/automation/package.json`**.
