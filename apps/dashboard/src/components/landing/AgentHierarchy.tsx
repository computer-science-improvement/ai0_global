// Spec 026 FR-005: the hero diagram — who runs the network, drawn from live data.
//   MANAGER (dimmed and marked "soon" unless claims.managerLive)
//   → up to 4 real networks with their orchestrator agent
//   → the roles inside each orchestrator (lit when the role ran this week)
//   → the platforms the network publishes to (from the showcase data).
// Pure flex tiers joined by short connectors, so it wraps on a phone without a
// separate mobile layout. The travelling dots stop under prefers-reduced-motion.
import type { CSSProperties, JSX } from 'react';
import type { LandingNetwork, LandingPlatform, LandingPulse } from '../../api/landing';
import { Icon } from '../ui/Icon';
import { PLATFORM_META, diagramNodes, roleChips } from '../../lib/landing-view';

function Connector({ delay = 0 }: { delay?: number }): JSX.Element {
  return (
    <span className="ah-link" aria-hidden>
      <span className="ah-packet" style={{ animationDelay: `${delay}s` }} />
    </span>
  );
}

export function AgentHierarchy({ networks, pulse, platforms }: {
  networks: LandingNetwork[] | undefined;
  pulse: LandingPulse | undefined;
  platforms: LandingPlatform[];
}): JSX.Element {
  const managerLive = pulse?.claims.managerLive ?? false;
  const nodes = diagramNodes(networks);
  const roles = roleChips(pulse);

  return (
    <figure className="ah" aria-label="How the agents are organised">
      <div className={`ah-node ah-manager${managerLive ? '' : ' is-dim'}`}>
        <span className="ah-dot" aria-hidden />
        <span className="ah-node-title">MANAGER</span>
        <span className="ah-node-sub">{managerLive ? 'watches the whole network' : 'network-wide agent'}</span>
        {!managerLive && <span className="ah-soon">soon</span>}
      </div>

      <Connector />

      <div className="ah-tier">
        {nodes.length > 0 ? nodes.map((n) => (
          <span key={n.key} className={`ah-node ah-net${n.mode === 'live' ? ' is-live' : ''}`}>
            {n.emoji && <span aria-hidden>{n.emoji}</span>}
            <span className="ah-net-name">{n.label}</span>
            <span className="ah-mode">{n.mode === 'live' ? 'agent live' : n.mode === 'shadow' ? 'agent in shadow' : 'pipeline'}</span>
          </span>
        )) : (
          <span className="ah-node ah-net">
            <span className="ah-net-name">Orchestrator per network</span>
          </span>
        )}
      </div>

      <Connector delay={0.6} />

      <div className="ah-tier ah-roles" aria-label="Roles inside each orchestrator">
        {roles.map((r) => (
          <span key={r.kind} className={`ah-role${r.active ? ' is-active' : ''}`} title={r.active ? 'Ran this week' : undefined}>
            {r.label}
          </span>
        ))}
      </div>

      {platforms.length > 0 && (
        <>
          <Connector delay={1.2} />
          <div className="ah-tier" aria-label="Platforms">
            {platforms.map((p) => (
              <span key={p} className="lp-rail-item" style={{ '--lp-tint': PLATFORM_META[p].tint } as CSSProperties}>
                <Icon name={PLATFORM_META[p].icon} size={15} />
                {PLATFORM_META[p].label}
              </span>
            ))}
          </div>
        </>
      )}

      <style>{`
        .ah {
          margin: var(--space-section) auto 0; padding: 0;
          width: 100%; max-width: 820px;
          display: flex; flex-direction: column; align-items: center;
        }
        .ah-tier { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-sm); max-width: 100%; }
        .ah-node {
          position: relative;
          display: inline-flex; align-items: center; gap: 8px; max-width: 100%;
          padding: 8px 16px; border-radius: var(--radius-pill);
          background: var(--color-surface-2);
          border: 1px solid var(--color-hairline-strong);
          color: var(--color-ink);
          font-size: 13px; font-weight: 600; letter-spacing: -0.13px;
        }
        .ah-manager { box-shadow: 0 0 24px color-mix(in srgb, var(--color-accent) 18%, transparent); flex-wrap: wrap; justify-content: center; }
        .ah-manager.is-dim { box-shadow: none; border-style: dashed; color: var(--color-ink-muted); }
        .ah-manager.is-dim .ah-dot { background: var(--color-ink-dim); box-shadow: none; animation: none; }
        .ah-node-title { letter-spacing: 0.6px; }
        .ah-node-sub { font-weight: 500; color: var(--color-ink-muted); }
        .ah-soon {
          padding: 1px 8px; border-radius: var(--radius-pill);
          background: var(--color-warning-soft); color: var(--color-warning);
          font-size: 11px; font-weight: 600;
        }
        .ah-dot {
          width: 8px; height: 8px; border-radius: var(--radius-pill);
          background: var(--color-accent); box-shadow: 0 0 10px var(--color-accent);
          animation: lp-pulse 2.4s ease-in-out infinite;
        }
        .ah-net { font-weight: 500; }
        .ah-net-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
        .ah-net.is-live { border-color: color-mix(in srgb, var(--color-accent) 45%, transparent); }
        .ah-mode { font-size: 11px; font-weight: 500; color: var(--color-ink-muted); white-space: nowrap; }
        .ah-net.is-live .ah-mode { color: var(--color-success); }
        .ah-role {
          padding: 5px 12px; border-radius: var(--radius-pill);
          font-size: 12px; font-weight: 500;
          background: var(--color-surface-1); color: var(--color-ink-muted);
          border: 1px dashed var(--color-hairline);
        }
        .ah-role.is-active {
          color: var(--color-ink); border-style: solid;
          border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
          background: color-mix(in srgb, var(--color-accent) 8%, transparent);
        }
        .ah-link {
          position: relative; display: block;
          width: 1px; height: 34px; margin: 4px 0;
          background: repeating-linear-gradient(to bottom, var(--color-hairline-strong) 0 3px, transparent 3px 7px);
        }
        .ah-packet {
          position: absolute; left: -2px; top: 0;
          width: 5px; height: 5px; border-radius: var(--radius-pill);
          background: var(--color-accent); box-shadow: 0 0 6px var(--color-accent);
          animation: ah-travel 1.8s ease-in infinite;
        }
        @keyframes ah-travel { from { transform: translateY(0); opacity: 1; } to { transform: translateY(29px); opacity: 0.2; } }
        .lp-rail-item {
          display: inline-flex; align-items: center; gap: 7px;
          padding: 8px 14px; border-radius: var(--radius-pill);
          background: var(--color-surface-1);
          border: 1px solid var(--color-hairline-soft);
          color: var(--color-ink-muted);
          font-size: 13px; font-weight: 500; letter-spacing: -0.13px;
        }
        .lp-rail-item svg { color: var(--lp-tint, currentColor); opacity: 0.9; }
        @media (prefers-reduced-motion: reduce) {
          .ah-packet { display: none; }
          .ah-dot { animation: none; }
        }
        @media (max-width: 480px) {
          .ah-node { padding: 7px 12px; font-size: 12px; }
          .ah-link { height: 24px; }
          @keyframes ah-travel { from { transform: translateY(0); } to { transform: translateY(19px); } }
        }
      `}</style>
    </figure>
  );
}
