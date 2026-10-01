# 003: Plan

## Constitution Check
| Principle | How this plan complies |
|---|---|
| I. Agents decide, code guarantees | The loop only *proposes* tool calls. Every effect sits inside a tool's `execute`, and every act tool validates its own invariants (004/005). |
| II. Agent/skill/tool first | The harness is the foundation that lets new capabilities be tools and skills. |
| III. Shadow first | `EDITOR_ENABLED` is off by default, and channel mode defaults to `off`; shadow mode is introduced in 005. |
| IV. Observable and costed | `editor_runs` and `editor_run_steps` record every turn; the budget is checked before each LLM call. |
| V. Least privilege | No shell or FS tools. `sql_readonly` runs under the `editor_ro` role with a READ ONLY transaction. `web_fetch` is SSRF-filtered. |
| VI. Offline tests | `LlmClient` and `HttpGet` are injectable interfaces, so tests use fakes. |
| VII. Simplicity | A ~200-line loop, raw `pg`, `zod`, and no agent framework. |

## Layout (`apps/automation/src/editor/`)
```
editor.module.ts                 Nest module (imports CommonModule, PublishersModule, StatsModule)
editor.tokens.ts                 DI tokens: LLM_CLIENT, EDITOR_CLOCK
llm/llm.types.ts                 ChatMessage, ToolSpec, ToolCall, LlmRequest, LlmResponse, LlmClient
llm/openrouter.client.ts         FR-001 (axios is injected so tests can fake it)
llm/model-registry.ts            FR-002
harness/tool.ts                  EditorTool, ToolContext, defineTool(), toToolSpec()
harness/tool-registry.ts         FR-004
harness/agent-loop.ts            FR-005
harness/budget.service.ts        FR-006
harness/run-recorder.ts          FR-007 (editor_runs / editor_run_steps repository)
harness/truncate.ts              JSON-safe 8 KB truncation
db/readonly-sql.ts               classifier + wrapper (pure, tested)
db/readonly-query.service.ts     FR-008 execution
net/ssrf-guard.ts                URL and DNS resolve check for private, loopback and link-local addresses (pure, tested)
tools/read/*.tool.ts             FR-009 tools, one file each
skills/skill-library.ts          list and load markdown skills from apps/automation/editor-skills/**
```
`ToolContext` = `{ runId, role, channelKey, slotId?, card?, clock, logger }`. Tools receive repositories through Nest
DI. Each tool is a Nest provider that exposes `.tool` (the EditorTool object), and the registry collects them through a
multi-provider token `EDITOR_TOOLS`.

## Loop algorithm
```
assert enabled
run = recorder.start(role, channelKey, slotId, model)
messages = [system, user]
for step in 1..maxSteps:
  budget.check(channelKey) → if exceeded: finish(run,'budget_exceeded'); return
  res = llm.chat({model, messages, tools: specs, tool_choice:'auto', max_tokens, temperature})
  recorder.llmStep(run, res)
  messages.push(res.message)
  if no res.toolCalls: finish(run,'ok', finalText=res.message.content); return
  for call in res.toolCalls:
     tool = registry.get(call.name) ?? → result {error:'tool_not_allowed'}
     args = JSON.parse(call.arguments) ?? → {error:'invalid_json'}
     parsed = tool.input.safeParse(args) ?? → {error:'invalid_args', details}
     result = await withTimeout(tool.execute(parsed, ctx), 30s) catch → {error:message}
     recorder.toolStep(run, call, result)
     messages.push({role:'tool', tool_call_id: call.id, content: JSON.stringify(result) (truncated 16 KB)})
     if tool.kind==='terminal' && !result.error: finish(run,'ok', terminalResult=result); return
finish(run,'max_steps')
```
Any thrown LLM error (after the client's own retries) ends the run with `finish(run,'error')`. The loop never throws to the caller.

## Testing
- `openrouter.client.test.ts`: fake axios.
- `agent-loop.test.ts`: scripted `FakeLlm`, in-memory recorder, fake budget.
- `readonly-sql.test.ts`, `ssrf-guard.test.ts`, `model-registry.test.ts`, `tool-registry.test.ts`, `truncate.test.ts`.
- Read-tool tests that need a DB fake `pool.query` with recorded SQL plus canned rows, matching the existing repository-test style.
