# 004: Tasks

Constitution Check: I ✅ (renderer and lint are deterministic), II ✅ (skills and tools), VI ✅ (pure functions, snapshot tests).

## Phase 1: Model
- [x] T001 `src/editor/post/post-spec.ts`: zod schema plus types (FR-001).
- [x] T002 Test first, then `src/editor/post/inline-markup.ts`: markdown-lite to escaped Telegram HTML (FR-002).

## Phase 2: Render and lint (US1, US2, US4)
- [x] T003 Test first, then `src/editor/post/render-telegram.ts` (FR-003).
- [x] T004 Test first, then `src/editor/post/lint-post.ts` (FR-004).

## Phase 3: Publish adapter
- [x] T005 Test first (with fake axios), then `src/editor/publish/telegram-editor.publisher.ts` (FR-006).

## Phase 4: Tools (US3)
- [x] T006 `get_channel_card`, `lint_post`, `preview_post` and `extract_images` tools, each with a test (FR-005).

## Phase 5: Skills
- [x] T007 [P] Write the 8 format skills.
- [x] T008 [P] Write the quality and voice skills.
- [x] T009 [P] Write the 3 workflow skills.
- [x] T010 Frontmatter and listing test (SC-3).
