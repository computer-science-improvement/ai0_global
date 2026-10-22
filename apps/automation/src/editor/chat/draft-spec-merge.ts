import { z } from 'zod';
import { AgentPostSpecSchema, coerceAgentSpec, PostSpecSchema } from '../post/post-spec';

/**
 * Spec 062 FR-006: `save_draft` with `draft_id` used to replace the whole spec, so a model that re-sent only the text
 * silently lost the draft's media (chat e8c11647). The tool's spec is now parsed by `ChatPostSpecSchema`, which remembers
 * which top-level keys the model sent: a key it left out is taken from the stored draft, and an explicit `null` clears
 * the key. (The parsed spec alone cannot tell an omitted `media` from `media: []`: the schema defaults it.)
 */

const OMITTED = Symbol('omittedSpecKeys');
const SPEC_KEYS = Object.keys(PostSpecSchema.shape);

/** The keys of the spec being parsed right now. zod parses synchronously, so preprocess → transform never interleave. */
let sent: Set<string> | null = null;

export const ChatPostSpecSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { sent = null; return raw; }
  const coerced = coerceAgentSpec(raw) as Record<string, unknown>;
  sent = new Set(Object.keys(coerced));
  // null = «clear this key»: parsed as absent, so the schema's own default applies and the stored value is not restored.
  return Object.fromEntries(Object.entries(coerced).filter(([, v]) => v !== null));
}, AgentPostSpecSchema).transform((spec) => {
  const omitted = sent ? SPEC_KEYS.filter((k) => !sent!.has(k)) : [];
  sent = null;
  Object.defineProperty(spec, OMITTED, { value: omitted, enumerable: false });
  return spec;
});

/** The top-level keys the model did not send in this parsed spec (empty for a spec that did not come through the schema). */
export function omittedSpecKeys(spec: unknown): string[] {
  const v = (spec as { [OMITTED]?: unknown } | null)?.[OMITTED];
  return Array.isArray(v) ? (v as string[]) : [];
}

/** The new spec with the omitted keys filled from the stored one; `kept` names the keys that came from the draft. */
export function mergeDraftSpec(stored: unknown, spec: Record<string, unknown>, omitted: readonly string[]): { spec: Record<string, unknown>; kept: string[] } {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { spec, kept: [] };
  const old = stored as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...spec };
  const kept: string[] = [];
  for (const k of omitted) {
    if (old[k] === undefined) continue;
    if (JSON.stringify(old[k]) === JSON.stringify(spec[k])) continue;
    merged[k] = old[k];
    kept.push(k);
  }
  return { spec: merged, kept };
}
