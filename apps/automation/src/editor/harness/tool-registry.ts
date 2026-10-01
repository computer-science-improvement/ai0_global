import type { EditorRole, ToolSpec } from '../llm/llm.types';
import { EditorTool, toToolSpec } from './tool';

/**
 * Holds every editor tool and answers "which tools may this role use on this
 * channel". A channel allowlist (card.tools_allow) can only narrow the role
 * default; it never grants a tool the role doesn't have.
 */
export class ToolRegistry {
  private readonly byName = new Map<string, EditorTool>();

  constructor(tools: EditorTool[]) {
    for (const t of tools) {
      if (this.byName.has(t.name)) throw new Error(`duplicate editor tool name: ${t.name}`);
      this.byName.set(t.name, t);
    }
  }

  all(): EditorTool[] {
    return [...this.byName.values()];
  }

  forRole(role: EditorRole, allow?: string[] | null): EditorTool[] {
    const allowSet = allow && allow.length ? new Set(allow) : null;
    return this.all().filter((t) =>
      t.roles.includes(role)
      // Terminal tools are the role's way to finish — never filtered out by a channel allowlist.
      && (!allowSet || allowSet.has(t.name) || t.kind === 'terminal'));
  }

  specs(tools: EditorTool[]): ToolSpec[] {
    return tools.map(toToolSpec);
  }

  get(name: string): EditorTool | undefined {
    return this.byName.get(name);
  }
}
