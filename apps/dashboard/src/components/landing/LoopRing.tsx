// Spec 078 B5.2: the two pictures of the loop section — the six-step ring and the code-guard track. Static copy, no data:
// both are drawn art, so each is one `role="img"` with a sentence, and the lit step / lit gate are never the only carrier of
// meaning (the labels are always there).
//
// Compositor-only: the sweep and the token move with transform; a step or a gate "lights" by fading an overlay
// pseudo-element in and out (opacity), not by animating colour, border or box-shadow (see landing-sections.css).
import type { CSSProperties, JSX } from 'react';
import { Icon } from '../ui/Icon';
import { GUARDS, LOOP_STEPS } from '../../lib/landing-view';

/** Seconds after the token leaves for it to reach a gate at `at` percent (the token takes 5.28 s for 82 points, less a lead). */
export function gateDelay(at: number): number {
  return Math.round(((at - 4) * 0.0644 - 0.06) * 100) / 100;
}

const LOOP_LABEL = `One loop for every post: ${LOOP_STEPS.map((s) => s.label).join(', ')}, and back to ${LOOP_STEPS[0].label}.`;
const GUARD_LABEL = `Every post passes ${GUARDS.length} code guards before it is published: ${GUARDS.map((g) => g.label.toLowerCase()).join(', ')}.`;

export function LoopRing(): JSX.Element {
  return (
    <div className="lp-ringbox" role="img" aria-label={LOOP_LABEL}>
      <span className="lp-loopring" aria-hidden="true" />
      <span className="lp-sweep" aria-hidden="true" />
      {LOOP_STEPS.map((s, i) => (
        <span
          key={s.label}
          className="lp-step"
          data-label={s.label}
          style={{ left: `${s.x}%`, top: `${s.y}%`, '--d': `${i}s` } as CSSProperties}
          aria-hidden="true"
        >
          {s.label}
        </span>
      ))}
      <span className="lp-ring-core" aria-hidden="true">
        <span className="text-overline lp-ring-over">Every post</span>
        <span className="lp-ring-big">one loop</span>
      </span>
    </div>
  );
}

export function GuardTrack(): JSX.Element {
  return (
    <div className="lp-track" role="img" aria-label={GUARD_LABEL}>
      <span className="lp-rail" aria-hidden="true" />
      {GUARDS.map((g) => (
        <span key={g.id} aria-hidden="true">
          <span className="lp-gate" style={{ left: `${g.at}%`, '--gd': `${gateDelay(g.at)}s` } as CSSProperties}>
            <Icon name={g.icon} size={18} />
          </span>
          <span className="lp-glabel mono" style={{ left: `${g.at}%` }}>{g.label}</span>
        </span>
      ))}
      <span className="lp-token mono" aria-hidden="true">POST</span>
      <span className="lp-endp lp-gate-pill" style={{ '--gd': '5.2s' } as CSSProperties} aria-hidden="true">
        <Icon name="telegram" size={13} />
        Published
      </span>
    </div>
  );
}
