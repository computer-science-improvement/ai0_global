/**
 * Provider-neutral chat types for the editor harness. Shape follows the
 * OpenAI chat-completions wire format, which OpenRouter speaks for every model.
 */

export type EditorRole = 'planner' | 'executor' | 'reviewer' | 'checker' | 'composer';
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
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
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
