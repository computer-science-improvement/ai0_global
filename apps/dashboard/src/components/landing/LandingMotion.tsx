// Spec 078 B5: the landing's motion helpers.
//
// Rules (handoff §8, research/landing.md):
//  - Infinite loops are CSS keyframes on transform/opacity only. A `LoopScope` wraps each group of them and pauses
//    them while the group is off screen (an IntersectionObserver toggles `.is-offscreen`; landing.css pauses every
//    animation under it). No React state is involved, so scrolling never re-renders.
//  - Entrances below the fold use `Reveal` (motion `whileInView`, once). Above the fold the hero uses CSS keyframes with
//    `both` fill instead, so its text never waits on requestAnimationFrame.
//  - Reduced motion: the CSS side is collapsed by the global block at the end of index.css. `Reveal` renders a plain div
//    under it, because motion's `reducedMotion="user"` only drops transforms: an `initial={{ opacity: 0 }}` would still wait
//    for the observer.
import { createElement, useEffect, useRef, type CSSProperties, type HTMLAttributes, type JSX, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/** Fade + rise, once, when the block scrolls into view. */
export function Reveal({ children, className, style, delay = 0, y = 24 }: {
  children: ReactNode; className?: string; style?: CSSProperties; delay?: number; y?: number;
}): JSX.Element {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className} style={style}>{children}</div>;
  return (
    <motion.div
      className={className}
      style={style}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      // A small negative bottom margin: the block starts a little after it enters, but never so far that the last
      // block of a short page could not reach it.
      viewport={{ once: true, margin: '0px 0px -48px 0px' }}
      transition={{ duration: 0.55, delay, ease: [0.2, 0.7, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Toggles `.is-offscreen` on the element while it is outside the viewport (with a margin, so a loop is already running
 * when it scrolls in). Without IntersectionObserver the loops simply keep running.
 */
export function useLoopPause<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) el.classList.toggle('is-offscreen', !last.isIntersecting);
      },
      { rootMargin: '120px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

type ScopeTag = 'div' | 'section' | 'header' | 'footer';

/** A box whose looping animations pause while it is off screen. */
export function LoopScope({ as = 'div', className, children, ...rest }: {
  as?: ScopeTag; className?: string; children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'>): JSX.Element {
  const ref = useLoopPause<HTMLElement>();
  return createElement(as, { ref, className: className ? `lp-scope ${className}` : 'lp-scope', ...rest }, children);
}
