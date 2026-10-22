import type { Workspace } from './workspace';

/**
 * Provider-neutral chat types for the editor harness. Shape follows the
 * OpenAI chat-completions wire format, which OpenRouter speaks for every model;
 * the Anthropic client (spec 038) maps it to the Messages API.
 */

export type EditorRole =
  | 'planner' | 'executor' | 'reviewer' | 'checker' | 'composer'
  // Agent platform (specs 017–022): network/resource orchestrators, the idea reviewer, the MANAGER and the @ai0 builder.
  | 'orchestrator' | 'idea_reviewer' | 'manager' | 'builder'
  // Spec 042: channel setup from the channel's last posts (one analysis run, no publishing tools).
  | 'onboarder'
  // Spec 055: the sysadmin's weekly audit pass (one bounded run that comments on the code's findings; it changes nothing).
  | 'auditor';
/** Roles that run for one channel with its editorial card (the scheduler's roles). */
export type CardRole = 'planner' | 'executor' | 'reviewer';

export interface ToolCall {
  id:        string;
  name:      string;
  /** Raw JSON string exactly as the model produced it — parsed by the loop. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system';    content: string }
  | { role: 'user';      content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[];
      /** Spec 038: the provider's raw content blocks (Anthropic thinking + text + tool_use), sent back verbatim on the next turn. */
      providerContent?: unknown[] }
  | { role: 'tool';      toolCallId: string; content: string };

export interface ToolSpec {
  name:        string;
  description: string;
  /** JSON Schema (object) for the tool arguments. */
  parameters:  Record<string, unknown>;
}

export interface LlmRequest {
  model:        string;
  messages:     ChatMessage[];
  tools?:       ToolSpec[];
  maxTokens?:   number;
  temperature?: number;
  /** Reasoning budget for reasoning models (GLM 5.3 reasoning is mandatory and otherwise eats max_tokens). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Spec 038: which workspace serves the request (absent = openrouter); the RoutingLlmClient dispatches on it. */
  provider?:    Workspace;
  /**
   * Spec 053 FR-002: false = send no prompt-cache breakpoints (a one-call run never reads them back). Default true.
   * Spec 063 FR-008: 'prefix' = one breakpoint after the system prompt (tools and system are the stable part), none
   * on the messages: a one-call run whose per-item text follows a stable prefix (the critic) reads the prefix back.
   */
  cache?:       boolean | 'prefix';
  /** Spec 053 FR-002: cancels the HTTP call (a caller that timed out). */
  signal?:      AbortSignal;
}

export interface LlmUsage {
  promptTokens:     number;
  completionTokens: number;
  costUsd:          number;
}

export interface LlmResponse {
  message:      Extract<ChatMessage, { role: 'assistant' }>;
  finishReason: string | null;
  usage:        LlmUsage;
}

export interface LlmClient {
  chat(req: LlmRequest): Promise<LlmResponse>;
}
