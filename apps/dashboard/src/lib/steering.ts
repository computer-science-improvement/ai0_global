// Steering (spec 045): labels, the actions a set allows and the card's key facts.
// Pure (type-only imports), so node tests can import it.
import type { SteeringAction, SteeringRuleKind, SteeringSetBrief, SteeringStatus } from '../api/steering';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

export const STEERING_STATUS: Record<SteeringStatus, { label: string; tone: Tone; hint?: string }> = {
  queued:        { label: 'Queued', tone: 'neutral' },
  collecting:    { label: 'Reading posts', tone: 'neutral' },
  analyzing:     { label: 'Analyzing', tone: 'neutral' },
  ready:         { label: 'Ready to review', tone: 'warning', hint: 'Review the rules and activate them' },
  active:        { label: 'Active', tone: 'success', hint: 'The agent follows these rules (below the channel\'s own rules)' },
  paused:        { label: 'Paused', tone: 'neutral', hint: 'The agent does not get these rules until you resume' },
  discarded:     { label: 'Discarded', tone: 'neutral' },
  superseded:    { label: 'Superseded', tone: 'neutral', hint: 'A newer analysis of the same reference replaced it' },
  failed:        { label: 'Failed', tone: 'danger' },
  no_access:     { label: 'No access', tone: 'danger', hint: 'The tracking account cannot read this channel: it must be public' },
  too_few_posts: { label: 'Too few posts', tone: 'neutral', hint: 'Fewer than 5 posts to learn from' },
};

export const RULE_KIND_LABEL: Record<SteeringRuleKind, string> = {
  structure: 'Structure', hook: 'Hook', length: 'Length', formatting: 'Formatting', cta: 'Call to action',
  series: 'Series', topic: 'Topics', mix: 'Post mix',
};

export const isBusy = (s: SteeringStatus | null | undefined) => s === 'queued' || s === 'collecting' || s === 'analyzing';
export const isClosed = (s: SteeringStatus) => s === 'discarded' || s === 'superseded' || s === 'failed' || s === 'no_access' || s === 'too_few_posts';
/** Rules can be switched and edited while the set is open for review or in use. */
export const rulesEditable = (s: SteeringStatus) => s === 'ready' || s === 'active' || s === 'paused';

/** The actions a set allows, in the order the dialog shows them (primary first). */
export function steeringActions(s: SteeringStatus): SteeringAction[] {
  switch (s) {
    case 'ready':  return ['activate', 'discard'];
    case 'active': return ['pause', 'reanalyze', 'discard'];
    case 'paused': return ['resume', 'reanalyze', 'discard'];
    case 'queued': return ['discard'];
    case 'failed': case 'no_access': case 'too_few_posts': return ['reanalyze', 'discard'];
    case 'discarded': case 'superseded': return ['reanalyze'];
    default:       return [];
  }
}

export const ACTION_LABEL: Record<SteeringAction, string> = {
  activate: 'Activate', pause: 'Pause', resume: 'Resume', discard: 'Discard', reanalyze: 'Analyze again',
};

/** `telegram:@ref` → `@ref`. */
export const refLabel = (ref: string) => ref.replace(/^telegram:/, '');

/** The card's count line: "4 of 6 rules on · 1 conflict". */
export function rulesLine(s: Pick<SteeringSetBrief, 'rulesActive' | 'rulesTotal' | 'conflicts' | 'status'>): string | null {
  if (!s.rulesTotal) return null;
  const on = `${s.rulesActive} of ${s.rulesTotal} rule${s.rulesTotal === 1 ? '' : 's'} on`;
  return s.conflicts ? `${on} · ${s.conflicts} conflict${s.conflicts === 1 ? '' : 's'}` : on;
}

/** Errors of the API as owner-facing text. */
export const STEERING_ERRORS: Record<string, string> = {
  invalid_source:   'Give a public Telegram channel as @username or a t.me link.',
  not_own_channel:  'Pick one of your own tracked channels as the target.',
  no_card:          'This channel has no editor card yet. Set the channel up first.',
  same_channel:     'The reference must be another channel.',
  already_open:     'This reference is already being analysed for this channel.',
  too_many_active:  'A channel follows at most 3 references. Pause or discard one first.',
  rule_conflict:    'This rule contradicts the channel\'s own rules, so it is never given to the agent.',
  rule_invalid:     'A rule describes the technique in its own words and does not quote the reference.',
};

export function steeringErrorText(code: string | null | undefined, fallback: string): string {
  return (code && STEERING_ERRORS[code]) || fallback;
}
