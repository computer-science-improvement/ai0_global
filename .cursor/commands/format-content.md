Act as **`content-formatter`** (`.cursor/agents/content-formatter.md`).

## User input

Paste **one** of:

- Path(s) to JSON/text under `apps/pipeline/src/data/` (or describe where parser output lives), **or**
- A short excerpt + description of what “publish-ready” should look like.

## Rules

1. **Do not** run `claude -p` until you have asked and received answers about **formatting style** (tone, length, allowed HTML/markup, language, channel).
2. Use **headless** Claude CLI with this project’s default model:

   `claude -p "PROMPT" --model claude-sonnet-4-20250514`

   For very long prompts, use stdin or a file if the CLI supports it—keep the same `--model claude-sonnet-4-20250514` unless the user explicitly requests another model.
3. Process in **batches** if the dataset is large; agree output paths with the user (prefer `src/data/publish-ready/` for final posts).
4. Never pass secrets into the CLI; redact as needed.

## Deliverables

- The **questions** you asked (if not already answered).
- The **exact** shell command(s) or run them if the environment allows.
- **Output location** and a one-line **next step** (e.g. run `pnpm --filter pipeline run load:tg-posts` if applicable).
