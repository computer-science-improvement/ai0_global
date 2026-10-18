# 048 Chat workspace and artifacts — tasks

Order: T1 + T2 → T3 → T4 → T5 → T6 + T7 → T8. Each stage ends with tests and a commit.

- [x] T1 (AI0-208) Artifact registry, versions table (migration 084), API.
- [x] T2 (AI0-209) `get_artifact` / `update_artifact` tools; `update_artifact` cards for live artifacts.
- [x] T3 (AI0-210) Slash commands `/setup`, `/steer`, `/rules`, `/skills`, `/memory`, `/help`; the `/` menu.
- [ ] T4 (AI0-211) Chat layout: icon rail, three columns, mobile drawer and sheet.
- [ ] T5 (AI0-212) `editor_chat_messages.artifacts`, chips, side panel with edit, actions, versions and Ask the agent.
- [ ] T6 (AI0-213) `/app/artifacts` page.
- [ ] T7 (AI0-214) Agent page Artifacts tab and Overview line.
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
- T2: adapters got `check` (rules: schema, ids, lint; steering: schema, ids, status). A change the type refuses never becomes a card.
