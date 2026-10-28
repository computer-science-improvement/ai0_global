// Spec 078 B5.1: the hero's agent.log (phase 1). The prototype's log is invented events with dev handles under a
// "streaming" dot; this one is lines made of the real numbers of the last 7 days (lib/landing-view agentLogLines), labelled
// as that. No pulse, or a pulse with nothing in it, means no terminal at all. A short list stays still; six lines or more
// scroll in a loop (the list is repeated once, the repeat is hidden from screen readers).
import type { JSX } from 'react';
import type { LandingPulse } from '../../api/landing';
import { agentLogLines, type LogLine } from '../../lib/landing-view';

/** From this many lines the list is taller than the window, so it scrolls. */
export const LOG_SCROLL_MIN = 6;

function Lines({ lines, hidden }: { lines: LogLine[]; hidden?: boolean }): JSX.Element {
  return (
    <ul className="lp-log-list" aria-hidden={hidden || undefined} aria-label={hidden ? undefined : 'Agent activity in the last 7 days'}>
      {lines.map((l) => (
        <li key={l.key} className="lp-log-line mono">
          <span className={`lp-log-role${l.owner ? ' is-owner' : ''}`}>{l.role}</span>
          <span>{l.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function AgentLog({ pulse }: { pulse: LandingPulse | undefined }): JSX.Element | null {
  const lines = agentLogLines(pulse);
  if (lines.length === 0) return null;
  const scroll = lines.length >= LOG_SCROLL_MIN;
  return (
    <div className="lp-term lp-fade" style={{ animationDelay: '0.3s' }}>
      <div className="lp-term-head">
        <span className="lp-term-title mono">agent.log</span>
        <span className="lp-term-tag mono">last 7 days</span>
      </div>
      <div className={`lp-feedwin${scroll ? ' is-scrolling' : ''}`}>
        <div className={scroll ? 'lp-feed' : undefined}>
          <Lines lines={lines} />
          {scroll && <Lines lines={lines} hidden />}
        </div>
      </div>
      {pulse?.stale && <p className="lp-term-note">Numbers from the last successful update.</p>}
    </div>
  );
}
