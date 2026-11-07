/**
 * Spec 090 FR-002: what owner silence does to an `awaiting_owner` directive. The registry (`autonomy/owner-gates.ts`)
 * decides; `DIRECTIVE_TIMEOUT_APPLY_KINDS` is an override that can pick which apply-capable kinds run, but can never
 * apply a kind whose gate says `drop`. `OWNER_SILENCE=wait` applies nothing (the pre-090 contract: every timeout drops).
 */
import { gateFor, gateHours, ownerSilenceMode, silenceFor, type Env } from '../autonomy/owner-gates';

export type DirectiveSilence = 'apply' | 'drop';

export function parseKinds(raw: string | undefined | null): string[] {
  return (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * `override` is an explicit list (tests, callers); when absent the live setting is read. An empty or absent list means
 * "the registry default", not "nothing".
 */
export function directiveSilence(kind: string, env: Env, override?: readonly string[]): DirectiveSilence {
  if (ownerSilenceMode(env) === 'wait') return 'drop';
  let onSilence;
  try { onSilence = gateFor(`directive:${kind}`).onSilence; } catch { return 'drop'; }
  // The registry wins on safety: a drop gate is never applied, whatever the setting says.
  if (onSilence !== 'apply') return 'drop';
  const list = override && override.length ? override : parseKinds(env('DIRECTIVE_TIMEOUT_APPLY_KINDS'));
  if (list.length) return list.includes(kind) ? 'apply' : 'drop';
  return silenceFor(`directive:${kind}`, env) === 'apply' ? 'apply' : 'drop';
}

/** The directive timeout in hours (the live setting, else the registry default). */
export function directiveTimeoutHours(env: Env): number {
  const h = gateHours('directive:frequency', env);
  return h && h > 0 ? h : 12;
}

/** The "owner answered N of M structural directives in 14 days" fact line for the manager (information, not an instruction). */
export function ownerAnswersLine(answered: number, total: number): string {
  return `owner answered ${answered} of ${total} structural directives in 14 days`;
}
