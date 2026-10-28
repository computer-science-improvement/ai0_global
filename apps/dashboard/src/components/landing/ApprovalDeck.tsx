// Spec 078 B5.2: "Human in the loop" — the four agent modes and the approval deck.
//
// The deck is an illustration (aria-hidden): three English skeleton cards that take turns coming to the front, get an
// "Approved" stamp and fly off. They are drawn from placeholders on purpose — no real channel, handle or topic is shown.
// Under reduced motion the animation collapses (index.css) and the cards stay as a still stack, the first one on top.
import type { CSSProperties, JSX } from 'react';

interface Mode { name: string; note: string; tag?: string }

/** The agent modes of the editor (Off / Shadow / Approval / Live). Approval is what runs today, during the launch period. */
export const MODES: ReadonlyArray<Mode> = [
  { name: 'Off', note: 'The agent stays idle.' },
  { name: 'Shadow', note: 'Plans and writes next to you. Publishes nothing.' },
  { name: 'Approval', note: 'Every post waits for your yes.', tag: 'launch period' },
  { name: 'Live', note: 'Publishes on its own, through code guards.' },
];

export function ApprovalModes(): JSX.Element {
  return (
    <ul className="lp-modes" aria-label="Agent modes">
      {MODES.map((m) => (
        <li key={m.name} className={`lp-mode${m.tag ? ' is-on' : ''}`}>
          <div className="lp-mode-head">
            <span className="lp-mode-name">{m.name}</span>
            {m.tag && <span className="lp-mode-tag mono">{m.tag}</span>}
          </div>
          <div className="lp-mode-note">{m.note}</div>
        </li>
      ))}
    </ul>
  );
}

type Body = 'text' | 'options' | 'media';
interface DeckCard { mono: string; title: string; when: string; body: Body; delay: string }

const DECK: ReadonlyArray<DeckCard> = [
  { mono: 'MD', title: 'Morning digest', when: 'your channel · tomorrow 12:00', body: 'text', delay: '0s' },
  { mono: 'QZ', title: 'Quiz question', when: 'your channel · tomorrow 10:00', body: 'options', delay: '-3s' },
  { mono: 'DP', title: 'Daily pick', when: 'your channel · tomorrow 12:00', body: 'media', delay: '-6s' },
];

function Skeleton({ widths }: { widths: number[] }): JSX.Element {
  return (
    <div className="lp-sk-list">
      {widths.map((w, i) => <span key={i} className="lp-sk" style={{ width: `${w}%` }} />)}
    </div>
  );
}

export function ApprovalDeck(): JSX.Element {
  return (
    <div className="lp-deck-wrap" aria-hidden="true">
      <div className="lp-deck">
        {DECK.map((c) => (
          <div key={c.title} className="lp-pc" style={{ '--dl': c.delay } as CSSProperties}>
            <div className="lp-pc-head">
              <span className="lp-pc-mono mono">{c.mono}</span>
              <span className="lp-pc-who">
                <span className="lp-pc-title">{c.title}</span>
                <span className="lp-pc-when mono">{c.when}</span>
              </span>
            </div>
            {c.body === 'text' && <Skeleton widths={[92, 100, 76]} />}
            {c.body === 'options' && (
              <>
                <Skeleton widths={[88]} />
                <div className="lp-opts">
                  {['A', 'B', 'C', 'D'].map((o) => <span key={o} className={`lp-opt${o === 'B' ? ' is-pick' : ''}`}>{o}</span>)}
                </div>
              </>
            )}
            {c.body === 'media' && (
              <>
                <span className="lp-pc-media" />
                <Skeleton widths={[84, 62]} />
              </>
            )}
            <div className="lp-pc-btns">
              <span className="lp-fakebtn is-main">Approve</span>
              <span className="lp-fakebtn">Edit</span>
            </div>
            <span className="lp-stamp">Approved</span>
          </div>
        ))}
      </div>
      <p className="lp-deck-note text-micro">Illustration of the approval queue.</p>
    </div>
  );
}
