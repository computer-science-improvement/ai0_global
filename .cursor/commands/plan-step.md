Continue the **orchestration plan** stored under **`tasks/`** (repo root).

## Resolve plan slug

1. If the user message includes a slug (e.g. `treatfield-psychotherapy`), use **`tasks/<slug>/`**.
2. Otherwise read **`tasks/_active`** (one line, trim whitespace). If missing or empty, ask the user for the slug or run **`/do-ebbing`** (full auto) or create a plan first.

## Execute one step

1. Open **`tasks/<slug>/MANIFEST.md`**. Find the **first** step that is still **`[ ]`** (unchecked).
2. Open the **`agents/…`** file linked from that step (path under **`tasks/<slug>/agents/`**). Read **`agent:`** from YAML frontmatter.
3. **Delegate** with the **Task** tool per **`.cursor/skills/monorepo-orchestrate-workflow/SKILL.md`** (**§ Phase B**, **§ Delegation policy**, **§ Thin parent**). Paste the full **`agents/NN-….md`** into the Task **`prompt`** plus pointers to **`.cursor/agents/<role>.md`**. If **`agent:`** is **`monorepo-developer`**, in the **same** invocation run **`Task(code-reviewer)`** after the developer returns (mandatory when Task is available), then mark the dev row **`[x]`** and **collapse** any following **`agent: code-reviewer`** rows per the skill (**§4.A.6**). If Task is missing or fails, state that once, then you may act inline instead.
4. In this **parent** chat, update **`MANIFEST.md`** (and **`tasks/_active`** if needed): set completed row(s) to **`[x]`**, add one-line note(s); if blocked, add **`BLOCKED:`** and what is needed. **Do not** edit `apps/*` or `database/*` in the parent when Task succeeded (**thin parent**).

## Rules

- Execute **only one** MANIFEST **row** per invocation unless the user explicitly asks for more. A **`monorepo-developer`** row still requires **two** Tasks (**dev** then **reviewer**) in that single invocation.
- Do not skip **`Task(code-reviewer)`** after **`Task(monorepo-developer)`** when Task is available.
- If no unchecked steps remain, reply with a short **plan complete** summary, then **delete `tasks/<slug>/scratch/`** if it exists (same rule as full **`/do-ebbing`** — see orchestration skill), and stop.
