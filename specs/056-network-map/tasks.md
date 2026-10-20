# 056 tasks

Linear epic: AI0-248.

- [x] T1 FR-001, FR-002, FR-005 backend: `GET /api/map`, `unitState` (pure, tested), events, roads, alerts, level score, 5 s cache, PG test for the snapshot queries.
- [x] T2 FR-003: the `/app/map` page (deterministic layout, SVG territories, buildings, units, roads, HUD, drawers, legend, phone, empty state), nav entry, mocks, browser check.
- [x] T3 FR-004: adaptive polling, snapshot diff, animations, event feed, reduced motion.
- [x] T4 FR-005: pixel avatars and levels on the page.
- [x] T5: runbook section 15, specs README row DONE, spec status done.

## Status

Done 2026-10-20. One commit per task:

- T1 `7dd8907e` — `GET /api/map` (state, events, roads, alerts, level score, 5 s cache, PG test).
- T2 `5661a971` — the `/app/map` page, layout, drawers, HUD, nav entry.
- T3 `0540d432` — adaptive polling, snapshot diff, animations, reduced motion.
- T4 `2c28862c` — pixel avatars and level badges on the page.
- T5 — runbook section 15, specs README row DONE, spec status done (the last commit).

Verified: automation `npm test` and `npm run build` on Node 20; dashboard `npx tsc --noEmit`, `npm test` (248 tests) and `npm run build`; the PG test of the snapshot queries on the scratch DB; the page in a browser against a mock backend that serves `demoSnapshot` (desktop and 375 px).

## Deltas from the spec

- **Chat link:** `/app/chat` has no `agent=` search parameter, so the unit drawer links to `/app/chat?q=@handle ` (the composer starts with the mention). No link to a Loadout tab (spec 054 is not part of this work).
- **Connection alerts** point to `/app/connections?section=telegram|meta|tiktok` (the page needs a section), not to the bare page.
- **No migration.** Roads, levels and states are derived from existing tables; every query skips a table or column that is missing (42P01 / 42703).
- **State precedence** in `unitState`: paused, off, running (planning, writing or reviewing by the run's role), error, publishing (a slot going out within 10 min, or being posted), waiting, idle. A running slot therefore outranks "waiting".
- **Level for role agents** is their orchestrator's, as the spec says; the snapshot carries the same `levelStats` for them.
- **Frontier:** resources outside any network sit in a dashed "Frontier" territory.
- **Top bar:** under 1180 px wide (the sidebar takes 234 px) it drops runs, posts and the "Updated" text; on a phone it also drops the spend meter. The legend starts open only on screens of 1100 px and wider.
- **Long gaps:** after more than 2 minutes between two snapshots (a background tab) the diff plays nothing, but the feed still marks the new lines and a new alert still bumps the counter. A diff plays at most 16 effects.
- **Badges** (level, emoji) on the map appear from 60 % zoom; the handle labels from 80 %.
- **Found in the browser check:** the viewport never measured the stage because it mounts after the data loads (the map stayed at 100 % instead of fitting); it now uses a callback ref. The map root also scrolled sideways when the top bar was too wide; it is now clipped.
- `src/lib/map-demo.ts` (a deterministic demo network with a tick) is used by the tests and by a scratch mock backend; the app does not import it.
