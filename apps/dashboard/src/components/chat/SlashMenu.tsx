// `/` command menu of the chat composer (spec 048 FR-003): typing `/` at the very
// start of the message lists the slash commands, filtered by the typed word.
// ↑/↓ move, Enter/Tab insert, Esc closes; a click inserts too. The commands run
// on the server in code (no model run); this list mirrors chat/slash-commands.ts.

import { useEffect, useState, type KeyboardEvent } from 'react';

export interface SlashCommandInfo { name: string; args: string; description: string }

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  { name: 'setup',  args: '@channel',            description: 'Set a channel up from its last 20 posts (one model run in the background)' },
  { name: 'steer',  args: '@channel @reference', description: 'Steer a channel by a public reference channel (@name or a t.me link)' },
  { name: 'align',  args: '@channel',            description: 'Align a channel\'s agent with your rules: one card for everything that keeps it from following them (no model run)' },
  { name: 'launch', args: '@new_channel [@ref …] brief', description: 'Launch a new channel from a brief and up to 3 reference channels' },
  { name: 'audit',  args: '',                    description: 'Run the sysadmin\'s audit of skills, memory, rules and tools now (about a minute)' },
  { name: 'rules',  args: '[@channel]',          description: 'Your rules for a channel' },
  { name: 'skills', args: '[@agent]',            description: 'An agent\'s skills' },
  { name: 'memory', args: '[@channel]',          description: 'What a channel\'s agent learnt from reviews and approvals' },
  { name: 'help',   args: '',                    description: 'The commands' },
];

/** A message the server runs as a command: `/word` at the start (a path such as `/app/setup` is not one). */
export function isSlashCommand(text: string): boolean {
  return /^\/[a-z]+(\s|$)/.test(text.trim());
}

/** The `/word` being typed at the start of the message, before any space, or null. */
export function slashToken(text: string, caret: number): string | null {
  const m = /^\/([a-z]{0,20})$/.exec(text.slice(0, caret));
  return m ? m[1] : null;
}

export function filterCommands(query: string): SlashCommandInfo[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

/** State of the menu for a textarea; `onKeyDown` returns true when it consumed the key. */
export function useSlashMenu(opts: {
  value: string; onChange: (v: string) => void; disabled?: boolean; textarea: () => HTMLTextAreaElement | null;
}) {
  const { value, onChange, disabled, textarea } = opts;
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [hi, setHi] = useState(0);
  const token = slashToken(value, Math.min(caret, value.length));
  const matches = token !== null ? filterCommands(token) : [];
  const open = token !== null && !disabled && !dismissed && matches.length > 0;

  useEffect(() => { setHi(0); }, [token]);
  useEffect(() => { if (token === null && dismissed) setDismissed(false); }, [token, dismissed]);

  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  const insert = (c: SlashCommandInfo) => {
    const rest = value.slice(Math.min(caret, value.length)).replace(/^[a-z]*/, '').replace(/^ /, '');
    const head = `/${c.name} `;
    onChange(head + rest);
    setCaret(head.length);
    requestAnimationFrame(() => {
      const el = textarea();
      if (!el) return;
      el.focus();
      el.setSelectionRange(head.length, head.length);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setHi((i) => (i + d + matches.length) % matches.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      const pick = matches[Math.min(hi, matches.length - 1)];
      // `/help` typed in full sends on Enter; a partial word completes first.
      if (e.key === 'Enter' && token === pick.name && !pick.args) return false;
      e.preventDefault();
      insert(pick);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(true);
      return true;
    }
    return false;
  };

  return { open, matches, hi, setHi, insert, onKeyDown, track };
}

export const SLASH_LIST_ID = 'chat-slash-list';

export function SlashMenu({ matches, hi, onHover, onPick, isMobile }: {
  matches: SlashCommandInfo[]; hi: number; onHover: (i: number) => void; onPick: (c: SlashCommandInfo) => void; isMobile: boolean;
}) {
  return (
    // `onMouseEnter` only moves the highlighted option (the keyboard's state); the look of the highlight is CSS.
    <div id={SLASH_LIST_ID} role="listbox" aria-label="Commands" className={`chat-menu compose-rise${isMobile ? ' is-mobile' : ''}`}
      style={{ ['--menu-w' as string]: '480px' }}>
      <div className="text-micro chat-menu-head">
        Commands run at once, without a model{isMobile ? '' : ' · ↑↓ to move, Enter to pick, Esc to close'}
      </div>
      {matches.map((c, i) => (
        <div key={c.name} id={`slash-${c.name}`} role="option" aria-selected={i === hi} className="chat-menu-item"
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(c)}>
          <div className="chat-menu-main">
            <div className="chat-menu-line">
              <span className="text-body-sm mono chat-menu-key" style={{ fontWeight: 500 }}>/{c.name}</span>
              {c.args && <span className="text-micro mono" style={{ color: 'var(--color-ink-muted)' }}>{c.args}</span>}
            </div>
            <div className="text-micro chat-menu-sub">{c.description}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
