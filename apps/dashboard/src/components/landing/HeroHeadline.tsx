// Spec 078 B5.1: the hero headline, word by word. CSS keyframes with `both` fill, not motion: the text must show up
// even when requestAnimationFrame is throttled (a background tab), and a reduced-motion visitor gets the final state at once.
import { Fragment, type JSX } from 'react';

// Owner decision 2026-10-06: the headline is always this, whatever the numbers say.
const WORDS: ReadonlyArray<{ w: string; accent?: boolean }> = [
  { w: 'A' }, { w: 'media' }, { w: 'network' }, { w: 'run' }, { w: 'by' }, { w: 'AI', accent: true }, { w: 'agents', accent: true },
];

/** Seconds between two words, and one word's own duration (landing.css `.lp-w > span`): the whole entry is under 900 ms. */
export const HEADLINE_STAGGER_S = 0.05;
export const HEADLINE_WORD_S = 0.45;
export const HEADLINE_TOTAL_S = HEADLINE_STAGGER_S * WORDS.length + HEADLINE_WORD_S;

export function HeroHeadline(): JSX.Element {
  return (
    <h1 className="lp-title">
      {WORDS.map((x, i) => (
        <Fragment key={x.w}>
          <span className="lp-w">
            <span className={x.accent ? 'is-accent' : undefined} style={{ animationDelay: `${((i + 1) * HEADLINE_STAGGER_S).toFixed(2)}s` }}>{x.w}</span>
          </span>
          {i < WORDS.length - 1 ? ' ' : null}
        </Fragment>
      ))}
      <span className="lp-caret" aria-hidden="true" />
    </h1>
  );
}
