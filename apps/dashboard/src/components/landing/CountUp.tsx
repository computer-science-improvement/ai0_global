// Spec 078 B5: the audience counters of #networks. The final number is in the DOM from the first render (and in a
// visually hidden span for screen readers), so nothing depends on the animation to be correct. With motion allowed the
// visible digits reset to 0 before paint and count up once the number scrolls into view.
import { useLayoutEffect, useRef, type JSX } from 'react';
import { compact } from '../../lib/landing-view';

export function CountUp({ to, className = 'lp-stat-num' }: { to: number; className?: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const final = compact(to);

  useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    if (!node) return;
    node.nodeValue = final;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    node.nodeValue = '0';
    let raf = 0;
    const run = () => {
      const t0 = performance.now();
      const dur = 1100;
      const step = (t: number) => {
        const p = Math.min(1, (t - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        node.nodeValue = compact(Math.round(to * eased));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const io = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) { io.disconnect(); run(); } },
      { threshold: 0.4 },
    );
    io.observe(ref.current as HTMLSpanElement);
    return () => { io.disconnect(); cancelAnimationFrame(raf); node.nodeValue = final; };
  }, [to, final]);

  return (
    <span className={className}>
      <span ref={ref} aria-hidden="true">{final}</span>
      <span className="lp-sr">{final}</span>
    </span>
  );
}
