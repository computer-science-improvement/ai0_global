// Spec 078 B5.1: the strip under the hero — every channel and profile of the showcase in a looping row, then the
// outline words Plan / Write / Guard / Publish / Measure / Learn going the other way. The channels are the showcase
// payload flattened (lib/landing-view marqueeChannels), named like the cards below. While the payload loads the row keeps
// its height; with no resources the row is left out and only the words remain.
//
// The row is two identical halves, so a shift of -50% loops without a seam; the second half and any repeat that pads a
// short list are aria-hidden. Under reduced motion landing.css lays the row out as a wrapped list and drops the words.
import type { JSX } from 'react';
import type { LandingNetwork } from '../../api/landing';
import { Icon } from '../ui/Icon';
import { PLATFORM_META, fillTo, marqueeChannels, type MarqueeChannel } from '../../lib/landing-view';

/** Enough pills per half to be wider than a large monitor. */
const MIN_PER_HALF = 12;

const WORDS: ReadonlyArray<{ w: string; fill?: boolean }> = [
  { w: 'Plan' }, { w: 'Write', fill: true }, { w: 'Guard' }, { w: 'Publish' }, { w: 'Measure', fill: true }, { w: 'Learn' },
];

function Chan({ c }: { c: MarqueeChannel }): JSX.Element {
  const tone = c.aiRun === 'live' ? 'is-live' : c.aiRun === 'shadow' ? 'is-shadow' : 'is-pipe';
  return (
    <>
      <span className={`lp-chan-dot ${tone}`} aria-hidden="true" />
      <span className="lp-chan-name">{c.name}</span>
      {c.handle && <span className="lp-chan-handle mono">{c.handle}</span>}
      {c.platform !== 'telegram' && <Icon name={PLATFORM_META[c.platform].icon} size={13} />}
    </>
  );
}

export function ChannelMarquee({ networks, loading }: { networks: LandingNetwork[] | undefined; loading: boolean }): JSX.Element {
  const items = marqueeChannels(networks);
  const half = fillTo(items, MIN_PER_HALF);
  return (
    <section className="lp-marquee" aria-label="Channels in the network">
      {loading && <div className="lp-mq-reserve" aria-hidden="true" />}
      {!loading && half.length > 0 && (
        <div className="lp-mqwrap">
          <div className="lp-mq">
            <ul className="lp-mq-half">
              {half.map(({ item, copy }) => (
                <li key={`${item.key}/${copy}`} className="lp-chan" aria-hidden={copy > 0 || undefined}><Chan c={item} /></li>
              ))}
            </ul>
            <ul className="lp-mq-half" aria-hidden="true">
              {half.map(({ item, copy }) => (
                <li key={`${item.key}/${copy}`} className="lp-chan"><Chan c={item} /></li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="lp-mqwrap lp-mq-words" aria-hidden="true">
        <div className="lp-mq lp-mq-rev">
          {[0, 1].map((half2) => (
            <div key={half2} className="lp-mq-half">
              {WORDS.map((x) => <span key={x.w} className={`lp-outline${x.fill ? ' is-fill' : ''}`}>{x.w}</span>)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
