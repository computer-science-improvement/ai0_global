import { ToolFailure, type McpToolAnnotations } from '../../editor/mcp/mcp-server';
import { localDate, localTimeLabel, zonedToUtc } from '../../editor/roles/time';
import type { ConnectorTool } from '../types';

/**
 * Shared rules of the connector tools (spec 103 §7): channel keys, time in and out, truncation of untrusted text,
 * isError results with a reason and a hint, and the annotations every tool carries.
 */

/** Longest preview and message text a result carries; the rest is cut (the text is untrusted data). */
export const PREVIEW_MAX = 1500;
export const MESSAGE_MAX = 4000;

/** Short English reason plus a hint, as a tool error (the MCP server turns a ToolFailure into an isError result). */
export function refuse(reason: string, hint?: string): never {
  throw new ToolFailure(hint ? `${reason} Hint: ${hint}` : reason);
}

export function clip(s: string | null | undefined, max: number): string {
  const t = (s ?? '').toString();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Cut every string of a JSON value to `max` characters (a post spec can carry long bodies). */
export function clipDeep(v: unknown, max = PREVIEW_MAX, depth = 0): unknown {
  if (typeof v === 'string') return clip(v, max);
  if (depth > 8) return null;
  if (Array.isArray(v)) return v.slice(0, 60).map((x) => clipDeep(x, max, depth + 1));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clipDeep(x, max, depth + 1)]));
  }
  return v;
}

// ── channels ────────────────────────────────────────────────────────────────

/** Resolve a channel key against the known ones (exact, then case-insensitive, then with the leading @). */
export function resolveChannel(input: unknown, known: readonly string[]): string {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) refuse('channel is required.', `known channels: ${known.join(', ') || 'none'}`);
  if (/^(instagram|facebook|threads|tiktok|x|youtube):/i.test(raw)) {
    refuse(`${clip(raw, 80)} is not a Telegram channel.`, 'the connector works with Telegram channels only (keys like @my_channel)');
  }
  const plain = raw.replace(/^telegram:/i, '');
  const hit = known.find((k) => k === plain) ?? known.find((k) => k.toLowerCase() === plain.toLowerCase())
    ?? known.find((k) => k.toLowerCase() === `@${plain.toLowerCase()}`);
  if (!hit) refuse(`Unknown channel ${clip(raw, 80)}.`, `known channels: ${known.join(', ') || 'none'}`);
  return hit;
}

// ── time ────────────────────────────────────────────────────────────────────

const ISO_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})$/;

/**
 * A time given by the owner: ISO 8601 with an offset, or `YYYY-MM-DD HH:MM` in the channel's timezone. Null when it is
 * neither, or not a real date (2026-02-30, or a wall time that does not exist).
 */
export function parseTimeInput(input: unknown, tz: string): Date | null {
  if (typeof input !== 'string') return null;
  const t = input.trim();
  if (ISO_OFFSET_RE.test(t)) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = LOCAL_RE.exec(t);
  if (!m) return null;
  const [, date, hh, mm] = m;
  if (Number(hh) > 23 || Number(mm) > 59) return null;
  const d = zonedToUtc(date, `${hh}:${mm}`, tz);
  if (Number.isNaN(d.getTime())) return null;
  // A date that rolled over (02-30) or a time skipped by DST does not read back the same.
  return localDate(d, tz) === date && localTimeLabel(d, tz) === `${hh}:${mm}` ? d : null;
}

export interface TimeOut { at: string; local: string; tz: string }

/** `{at, local, tz}`: ISO UTC plus the channel's wall clock. */
export function timeOut(d: Date, tz: string): TimeOut {
  return { at: d.toISOString(), local: `${localDate(d, tz)} ${localTimeLabel(d, tz)}`, tz };
}

/** Parse or refuse with the accepted forms in the hint. */
export function requireTime(input: unknown, tz: string, field = 'at'): Date {
  const d = parseTimeInput(input, tz);
  if (!d) refuse(`${field} is not a valid time.`, `use ISO 8601 with an offset (2026-11-13T18:00:00+02:00) or 'YYYY-MM-DD HH:MM' in the channel's timezone (${tz})`);
  return d;
}

// ── tool building ───────────────────────────────────────────────────────────

interface ToolDef {
  name:        string;
  title:       string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<unknown>;
}

/** A JSON Schema object for a tool input. */
export function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** Read tools may run without a prompt: they change nothing and reach nothing outside the network. */
export function readTool(d: ToolDef): ConnectorTool {
  const annotations: McpToolAnnotations = { title: d.title, readOnlyHint: true, openWorldHint: false };
  return { ...d, annotations, scope: 'mcp:read' };
}

/** Write tools always prompt in Claude (destructive hint); `idempotent` where repeating the call changes nothing more. */
export function writeTool(d: ToolDef & { idempotent?: boolean }): ConnectorTool {
  const { idempotent, ...rest } = d;
  const annotations: McpToolAnnotations = {
    title: d.title, readOnlyHint: false, destructiveHint: true, ...(idempotent ? { idempotentHint: true } : {}), openWorldHint: false,
  };
  return { ...rest, annotations, scope: 'mcp:write' };
}

/** Validate tool arguments with a zod schema; a bad input is a short tool error, not a crash. */
export function parseArgs<T>(
  s: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: ReadonlyArray<PropertyKey>; message: string }> } } },
  args: unknown,
): T {
  const r = s.safeParse(args ?? {});
  if (!r.success) refuse(`Invalid input: ${zodReason(r.error)}.`, 'see the tool input schema');
  return r.data;
}

/** A zod failure as one short line for the model. */
export function zodReason(err: { issues: Array<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  return err.issues.slice(0, 4).map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ');
}
