import { z } from 'zod';
import type { EditorRole, ToolSpec } from '../llm/llm.types';

/**
 * read     — no side effects (may hit DB read-only or the network).
 * act      — side effect, but the run continues (e.g. add_memory).
 * terminal — side effect that ends the run on success (publish_post, submit_plan…).
 */
export type ToolKind = 'read' | 'act' | 'terminal';

export interface ToolContext {
  runId:      string;
  role:       EditorRole;
  channelKey: string | null;
  slotId?:    string | null;
  /** Arbitrary per-run data the runner wants tools to see (e.g. the channel card). */
  extras?:    Record<string, unknown>;
}

/** A failed tool call: returned to the model as data so it can recover. */
export interface ToolError {
  error:    string;
  details?: unknown;
}

export interface EditorTool<I = any, O = any> {
  name:        string;
  description: string;
  input:       z.ZodType<I>;
  kind:        ToolKind;
  roles:       EditorRole[];
  execute(input: I, ctx: ToolContext): Promise<O | ToolError>;
}

export function defineTool<S extends z.ZodType, O>(t: {
  name:        string;
  description: string;
  input:       S;
  kind:        ToolKind;
  roles:       EditorRole[];
  execute(input: z.infer<S>, ctx: ToolContext): Promise<O | ToolError>;
}): EditorTool<z.infer<S>, O> {
  return t as unknown as EditorTool<z.infer<S>, O>;
}

/**
 * The channel a tool works on. Scheduled roles have a fixed ctx.channelKey; the
 * chat composer (010) has none and works on the chat's current channel, kept in
 * the mutable per-run ctx.extras.chat (save_draft switches it).
 */
export function channelOf(ctx: ToolContext): string | null {
  return ctx.channelKey ?? ((ctx.extras?.chat as { channelKey?: string | null } | undefined)?.channelKey ?? null);
}

export function isToolError(v: unknown): v is ToolError {
  return !!v && typeof v === 'object' && typeof (v as any).error === 'string';
}

export function toToolSpec(t: EditorTool): ToolSpec {
  const schema = z.toJSONSchema(t.input as z.ZodType, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, parameters: schema };
}

/** Nest multi-provider token: every tool provider is registered under it. */
export const EDITOR_TOOLS = Symbol('EDITOR_TOOLS');
