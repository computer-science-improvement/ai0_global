// Spec 078 B5.1: the hero orbit — MANAGER in the core, the network's agents on the inner ring, the platforms on the
// outer ring. Replaces the old AgentHierarchy diagram. Everything is drawn from the same public payloads as the rest of
// the page (networks, pulse): an agent tile exists only for an agent that is in the payload, a platform glows only when an
// agent published there this week.
//
// Motion is CSS only and compositor-only (transform / opacity): the rings spin, the labels counter-rotate so they stay
// upright, two satellites circle, the core ripples. The whole picture is decorative (aria-hidden); the sr-only sentence
// carries its facts. Sizes are in container-query units (see landing.css `.lp-orbit-cq`), so the orbit shrinks with its
// column instead of overflowing it on a phone.
import type { CSSProperties, JSX, ReactNode } from 'react';
import type { LandingNetwork, LandingPlatform, LandingPulse } from '../../api/landing';
import { Icon } from '../ui/Icon';
import { PLATFORM_META, PLATFORM_ORDER, agentNodes, livePlatforms, ringAngles } from '../../lib/landing-view';

/** What the outer ring shows before the showcase has loaded: the platforms the agents are built for. */
const DEFAULT_PLATFORMS: readonly LandingPlatform[] = PLATFORM_ORDER.slice(0, 5);

function OrbitNode({ angle, ring, children }: { angle: number; ring: 1 | 2; children: ReactNode }): JSX.Element {
  // rotate(angle) translateX(radius) puts the node on the ring; the inner rotate(-angle) undoes the tilt, and `.lp-up`
  // spins against the ring so the label keeps facing up.
  return (
    <div className="lp-node" style={{ transform: `rotate(${angle}deg) translateX(var(--lp-r${ring}))` }}>
      <div style={{ transform: `rotate(${-angle}deg)` }}>
        <div className={`lp-up lp-up${ring}`}>
          <div className="lp-cn">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function HeroOrbit({ networks, pulse, platforms }: {
  networks: LandingNetwork[] | undefined;
  pulse: LandingPulse | undefined;
  platforms: LandingPlatform[];
}): JSX.Element {
  const managerLive = pulse?.claims.managerLive ?? false;
  const agents = agentNodes(networks, 5);
  const ringPlatforms = (platforms.length > 0 ? platforms : DEFAULT_PLATFORMS).slice(0, 6);
  const lit = new Set(livePlatforms(pulse));
  const platformAngles = ringAngles(ringPlatforms.length, -140);
  // No agent in the payload (loading, or every channel is a pipeline): three empty slots keep the ring readable.
  const ghostCount = agents.length === 0 ? 3 : 0;
  const agentAngles = ringAngles(agents.length || ghostCount, -90);

  const summary = [
    managerLive ? 'A MANAGER agent watches the whole network.' : 'A MANAGER agent that steers the whole network is coming soon.',
    agents.length > 0 ? `Agents: ${agents.map((a) => a.name).join(', ')}.` : '',
    `Platforms: ${ringPlatforms.map((p) => PLATFORM_META[p].label).join(', ')}.`,
  ].filter(Boolean).join(' ');

  return (
    <div className="lp-orbit-wrap">
      <div className="lp-orbit-cq">
        <div className="lp-orbit lp-fade" style={{ animationDelay: '0.1s' }} aria-hidden="true">
          <div className="lp-ring lp-ring-2">
            {ringPlatforms.map((p, i) => (
              <OrbitNode key={p} ring={2} angle={platformAngles[i]}>
                <span className={`lp-plat${lit.has(p) ? ' is-on' : ''}`} style={{ '--lp-tint': PLATFORM_META[p].tint } as CSSProperties}>
                  <Icon name={PLATFORM_META[p].icon} size={13} />
                  <span className="lp-plat-text">{PLATFORM_META[p].label}{lit.has(p) ? ' · live' : ''}</span>
                </span>
              </OrbitNode>
            ))}
          </div>

          <div className="lp-ring lp-ring-1">
            {agents.length > 0
              ? agents.map((a, i) => (
                <OrbitNode key={a.key} ring={1} angle={agentAngles[i]}>
                  <span className={`lp-agent${a.mode === 'shadow' ? ' is-shadow' : ''}`}>{a.emoji ?? a.initials}</span>
                  <span className="lp-agent-name mono">{a.name}</span>
                </OrbitNode>
              ))
              : agentAngles.map((angle) => (
                <OrbitNode key={angle} ring={1} angle={angle}>
                  <span className="lp-agent is-ghost" />
                </OrbitNode>
              ))}
          </div>

          <div className="lp-sat lp-sat-1" />
          <div className="lp-sat lp-sat-2" />

          <div className={`lp-core${managerLive ? '' : ' is-dim'}`}>
            <span className="lp-core-title mono">MANAGER</span>
            <span className="lp-core-sub">{managerLive ? 'watches all' : 'soon'}</span>
          </div>
        </div>
      </div>
      <p className="lp-sr">{summary}</p>
    </div>
  );
}
