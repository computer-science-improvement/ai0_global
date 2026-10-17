# 045 Steering — tasks

- [x] T1 (AI0-171) Store: `081_steering.sql` + down, `SteeringRepository` (enqueue, claimNext, requeueStuck, update, list/get, open-set uniqueness, text drop on discard/supersede), PG test
- [x] T2 (AI0-172) Reading + analysis: Telegram `SteeringSourceReader`, 20 usable posts, metrics, `submit_steering` with the code checks, onboarder prompt with the target's rules; unit tests (FakeLlm)
- [x] T3 (AI0-173) Service, worker (editor minute tick), API `/api/steering` (create, activate ≤ 3, pause/resume/discard/reanalyze, rule switch/edit, estimate), module wiring
- [x] T4 (AI0-174) Prompts: lowest-priority steering block for the planner / writer (`buildSystemPrompt`, network planner) and the critic request
- [x] T5 (AI0-175) Copy guard `steering_copy` at the publish guards
- [x] T6 (AI0-176) Dashboard: `/app/steering` (compact cards + dialog, New steering), agent Overview line, nav entry
- [x] T7 (AI0-177) @ai0 `steer_channel`, runbook section, README row, status
