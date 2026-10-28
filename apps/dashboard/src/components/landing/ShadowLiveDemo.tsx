// Spec 078 B5.2: the "Shadow first" demo of #white-label. A two-state switch (Shadow / Live) over two lanes of post blocks:
// in shadow the agent's blocks are dashed (written, not published) next to the client's current setup; in live they are
// filled and the old setup steps back. The lanes are decorative (aria-hidden) and say "Illustration"; the caption under the
// title is the accessible description and is announced when the switch changes.
import { useState, type JSX } from 'react';

export const DEMO_BLOCKS = 20;

export const DEMO_CAPTION = {
  shadow: 'In shadow the agent plans and writes next to your current setup. Nothing it writes is published, so you can compare.',
  live: 'Switched to live: the agent publishes, through code guards, and your old setup steps back. You decide this channel by channel.',
} as const;

function Lane({ label, tone, fast, retired }: { label: string; tone: 'now' | 'shadow' | 'live'; fast?: boolean; retired?: boolean }): JSX.Element {
  // Two identical halves: the strip moves by exactly one half, so the loop has no seam.
  const half = (hidden: boolean) => (
    <span className="lp-flow-half" aria-hidden={hidden || undefined}>
      {Array.from({ length: DEMO_BLOCKS }, (_, i) => <span key={i} className="lp-pb" />)}
    </span>
  );
  return (
    <div className="lp-lane-wrap">
      <div className={`lp-lane-label mono${tone === 'now' ? '' : ' is-agent'}`}>{label}</div>
      <div className={`lp-lane is-${tone}${retired ? ' is-retired' : ''}`}>
        <div className={`lp-flow${fast ? ' is-fast' : ''}`}>
          {half(false)}
          {half(true)}
        </div>
      </div>
    </div>
  );
}

export function ShadowLiveDemo(): JSX.Element {
  const [live, setLive] = useState(false);
  return (
    <div className="lp-demo">
      <div className="lp-demo-top">
        <div className="lp-demo-copy">
          <h3 className="lp-demo-title">Shadow first</h3>
          <p className="lp-demo-caption" aria-live="polite">{live ? DEMO_CAPTION.live : DEMO_CAPTION.shadow}</p>
        </div>
        <div className={`lp-seg${live ? ' is-live' : ''}`} role="group" aria-label="Agent mode">
          <span className="lp-seg-thumb" aria-hidden="true" />
          <button type="button" aria-pressed={!live} onClick={() => setLive(false)}>Shadow</button>
          <button type="button" aria-pressed={live} onClick={() => setLive(true)}>Live</button>
        </div>
      </div>
      <div className="lp-lanes" aria-hidden="true">
        <Lane label="your current setup" tone="now" retired={live} />
        <Lane label={`ai0 agent · ${live ? 'live' : 'shadow'}`} tone={live ? 'live' : 'shadow'} fast />
      </div>
      <p className="lp-demo-note text-micro">Illustration, not your data.</p>
    </div>
  );
}
