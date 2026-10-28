// Spec 078 B5.2: the role explorer of #how-it-works — MANAGER → Orchestrator → five worker roles → platforms, joined by
// connectors with a travelling dot. A role is a toggle button (aria-pressed); the card on the right describes the pressed
// one (aria-live). Replaces the "Who runs the network" row of the old HowItWorks and the AgentHierarchy diagram.
//
// What is live comes from the pulse: worker buttons carry a dot for a role that ran this week, the MANAGER is dimmed and
// marked "soon" until `claims.managerLive`, the Orchestrator count is live + training agents, and a platform pill glows
// only when an agent published there this week.
import { useState, type JSX } from 'react';
import type { LandingPlatform, LandingPulse } from '../../api/landing';
import { Icon } from '../ui/Icon';
import {
  PLATFORM_META, explorerRoles, livePlatforms, orchestratorCount, type ExplorerId, type ExplorerRole,
} from '../../lib/landing-view';

function Conn({ n }: { n?: 2 | 3 }): JSX.Element {
  return <span className={`lp-conn${n ? ` d${n}` : ''}`} aria-hidden="true" />;
}

export function RoleExplorer({ pulse, platforms }: { pulse: LandingPulse | undefined; platforms: LandingPlatform[] }): JSX.Element {
  const managerLive = pulse?.claims.managerLive ?? false;
  const roles = explorerRoles(managerLive);
  const [picked, setPicked] = useState<ExplorerId>('manager');
  const cur = roles.find((r) => r.id === picked) ?? roles[0];
  const ran = new Set(pulse?.agents.rolesActive ?? []);
  const orchestrators = orchestratorCount(pulse);
  const lit = new Set(livePlatforms(pulse));

  const btn = (r: ExplorerRole, extra: string, content: JSX.Element): JSX.Element => (
    <button
      type="button"
      key={r.id}
      className={`lp-rnode${extra}${picked === r.id ? ' is-on' : ''}${r.soon ? ' is-dim' : ''}`}
      aria-pressed={picked === r.id}
      onClick={() => setPicked(r.id)}
    >
      {content}
    </button>
  );

  return (
    <div className="lp-explorer">
      <div className="lp-ex-diagram" role="group" aria-label="Agent roles">
        <span className="lp-ex-grid" aria-hidden="true" />
        {btn(roles[0], ' is-big', <><span className={`lp-dot${managerLive ? '' : ' is-idle'}`} aria-hidden="true" />MANAGER{roles[0].soon && <span className="lp-soon">soon</span>}</>)}
        <Conn />
        {btn(roles[1], ' is-big', <>Orchestrator{orchestrators > 0 && <span className="lp-rnode-n mono" title={`${orchestrators} orchestrators: live and in training`}>{`×${orchestrators}`}</span>}</>)}
        <Conn n={2} />
        <div className="lp-ex-workers">
          {roles.slice(2).map((r) => btn(r, '', (
            <>
              {r.title}
              {ran.has(r.id) && <><span className="lp-ran" aria-hidden="true" /><span className="lp-sr"> (ran this week)</span></>}
            </>
          )))}
        </div>
        {platforms.length > 0 && (
          <>
            <Conn n={3} />
            <div className="lp-ex-plats" aria-label="Platforms">
              {platforms.map((p) => (
                <span key={p} className={`lp-plat${lit.has(p) ? ' is-on' : ''}`} title={lit.has(p) ? 'An agent published here this week' : undefined}>
                  <Icon name={PLATFORM_META[p].icon} size={13} />
                  {PLATFORM_META[p].label}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="lp-ex-card" aria-live="polite" aria-atomic="true">
        <div className="lp-ex-num mono">{`${cur.num} / 07`}</div>
        <div className="lp-ex-title">{cur.title}{cur.soon && <span className="lp-soon">soon</span>}</div>
        <p className="lp-ex-desc">{cur.desc}</p>
        <div className="lp-ex-tags">
          {cur.tags.map((t) => <span key={t} className="lp-tag mono">{t}</span>)}
        </div>
        <div className="lp-ex-up">Reports to <b>{cur.up}</b></div>
      </div>
    </div>
  );
}
