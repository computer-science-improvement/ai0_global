**Primary entry point** for multi-step monorepo work in `ai0_global`: **plan on disk** + **run the full execution loop** in one flow (unless the user asks for plan-only).

## Load first

Read and apply **`.cursor/skills/monorepo-orchestrate-workflow/SKILL.md`** — it defines **Phase A** (planner + `tasks/`) and **Phase B** (execute every MANIFEST step, including **`code-reviewer`** after **`monorepo-developer`**).

## User intent

- **Default:** user message = goal → **Phase A** as **`orchestrator-planner`** (`.cursor/agents/orchestrator-planner.md`) **including** writing **`tasks/<plan-slug>/`** per **`tasks/README.md`** (`README.md`, `MANIFEST.md`, **`agents/NN-….md`** with YAML **`agent:`** frontmatter, **`tasks/<plan-slug>/scratch/`**, **`tasks/_active`**) — then **immediately Phase B** in the **same** turn until all **`[x]`** or **`BLOCKED:`**. **Do not** stop after planning.
- **Phase B execution:** follow **`.cursor/skills/monorepo-orchestrate-workflow/SKILL.md`** (**§ Thin parent**, **§ Phase B**, **§ Delegation policy**). **Each** MANIFEST row is delegated with **Task** (`subagent_type` = that row’s **`agent:`**). Rows with **`monorepo-developer`** require **`Task(monorepo-developer)`** then **`Task(code-reviewer)` in the same turn** before moving on — **never skip** the reviewer Task when Task is available. The **parent** only updates **`MANIFEST.md`** / **`tasks/_active`** and summarizes; it **does not** edit `apps/*` or run loaders during Phase B. Inline work only if Task is unavailable or fails.
- **Resume:** user says **`continue`**, **`resume`**, or **`/do-ebbing continue`** → **skip Phase A**; use **`tasks/_active`** (or slug in message) and run **Phase B** only from the first `- [ ]`.
- **Plan only** (rare): user explicitly asks for outline / no execution → **Phase A only**, no app code/SQL; still create **`tasks/`** if they asked for on-disk plans.

## Chat summary (after Phase A when it ran)

Still satisfy **`orchestrator-planner`** closings: **task table**, **Execution order**, **`### 4. Paths on disk`**. Omit **`### 2. Launch: Step 1`** if you **immediately** run Phase B in this same response; otherwise include **Launch** for **`/plan-step`**-only follow-up.

## Rules

- Map owners using the planner’s **Role → how to run** table (`/research-source`, `/develop-and-review`, `/plan-step`, `/format-content`, `/debug-terminal`, @`database-agent`, etc.) when **writing** agent briefs.
- For **`monorepo-developer`** rows: **never** skip **`Task(code-reviewer)`** or the fix loop (up to **3** dev iterations per skill).
- **Task** delegation is **mandatory** for Phase B when the tool exists (see skill); the parent must not substitute “doing the work” in the main chat (**thin parent**).
- **Planner:** do **not** add a separate MANIFEST row with **`agent: code-reviewer`** immediately after **`monorepo-developer`** (orchestrator handles review automatically; duplicate rows confuse execution).
- **Artifacts:** any temp files from the plan (saved HTML, dumps) go under **`tasks/<plan-slug>/scratch/`** only — not repo root, not **`apps/`**. After **all** steps **`[x]`**, **delete** **`tasks/<plan-slug>/scratch/`** per **`.cursor/skills/monorepo-orchestrate-workflow/SKILL.md`**; if **`BLOCKED:`**, keep **`scratch/`**.

**Aliases:** **`/orchestrate`** — same behavior; prefer **`/do-ebbing`**.
