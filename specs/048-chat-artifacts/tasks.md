# 048 Chat workspace and artifacts — tasks

Order: T1 + T2 → T3 → T4 → T5 → T6 + T7 → T8. Each stage ends with tests and a commit.

- [x] T1 (AI0-208) Artifact registry, versions table (migration 084), API.
- [x] T2 (AI0-209) `get_artifact` / `update_artifact` tools; `update_artifact` cards for live artifacts.
- [x] T3 (AI0-210) Slash commands `/setup`, `/steer`, `/rules`, `/skills`, `/memory`, `/help`; the `/` menu.
- [x] T4 (AI0-211) Chat layout: icon rail, three columns, mobile drawer and sheet.
- [x] T5 (AI0-212) `editor_chat_messages.artifacts`, chips, side panel with edit, actions, versions and Ask the agent.
- [x] T6 (AI0-213) `/app/artifacts` page.
- [x] T7 (AI0-214) Agent page Artifacts tab and Overview line.
- [ ] T8 (AI0-215) Remove `/app/setup` and `/app/steering`, redirects, menu, docs.

## Owner decisions (2026-10-18)

- The app menu becomes the icon rail on the chat page; it is not hidden.
- The agent page gets an Artifacts tab, and the old tabs stay for now.
- An agent's change to a live artifact goes through an Apply / Discard card. A change to a draft applies at once.
- The design was approved without a separate spec review: "write the spec and build it".

## Deltas from the spec

- T1: setup artifacts are read only in the registry. Apply / Discard link to the existing `/api/channel-setup/proposals/:id/…` endpoints; a section edit stays on the setup review until T8 moves it.
- T1: steering sets got a hand edit (`SteeringService.editRules`: enable or disable, rewrite, add, remove). It uses the same rule checks as the analysis and refuses to enable a conflicting rule.
- T1: owner-rule edits retire the old line and add a new one (`evidence.replaces`), so the memory history stays.
- T2: owner rules always go through a card for an agent, even when the channel has none yet: rules are the owner's words.
- T3: an unknown `/word` answers with the command list instead of going to the model; a path such as `/app/setup` is an ordinary message. A command never gets the composer's "Channel:" line — the picked channel goes with the request, and the chat agent's channel comes first.
- T3: `/setup` and `/steer` start the work as the owner (the same services as the pages), so `/steer` checks the target has an editor card.
- T4: the rail's own toggle on /app/chat opens the full menu there only (`dashboard:chat-nav` = open / rail; the ⌘K "Collapse sidebar" action flips the same choice on that page). The chat search field shows from six chats on. The artifact column comes with the panel in T5.
- T5: a message stores chips `{type, id, title, status}` (not a version); the chip reads the artifact live, so its status and version are the current ones.
- T5: an `update_artifact` card links its artifact when the card is proposed (the chip shows the artifact as it is now), not at Apply. `edit_my_skill` proposes a `write_skill` card, which has no skill id until Apply, so it adds no chip.
- T5: `[[type:id]]` references in the owner's message show as chips under it, and `get_artifact` is told to read them.
- T5: with the panel open on a desktop under 1280 px, the chat list moves to the drawer so the thread keeps its width.
- T2: adapters got `check` (rules: schema, ids, lint; steering: schema, ids, status). A change the type refuses never becomes a card.
- T6: the status filter is a view, not a status: All / Needs you (ready, pending) / In use / Closed (discarded, superseded, failed…), filtered in the page (`?view=`); `?type`, `?agent`, `?open=type:id` as planned. "Open in chat" goes to the chat that made or named the artifact (`chatId`, the latest message whose chips hold it); with none it opens a new chat with `@agent [[type:id]]` in the composer and the panel. The page header keeps "Setup from history" and "New steering", which open the chat with `/setup ` or `/steer ` typed.
- T7: the tab lists the agent's own artifacts (`agent=<handle>`; a role agent shows its own). The Overview line replaces the 045 steering line: latest setup with its status and date · active steering with sources · owner rules count, linking to the tab.
