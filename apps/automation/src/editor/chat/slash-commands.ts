import type { ArtifactChip, ArtifactRow, ArtifactType } from '../artifacts/artifact.types';
import type { PendingAction } from '../agents/pending-actions';

/**
 * Spec 048 FR-003: chat slash commands. They run in code — no model turn, no cost — and answer with one line and the
 * artifacts they made or found as chips.
 */
export const SLASH_COMMANDS = [
  { name: 'setup',  args: '@channel',            description: 'Set a channel up from its last 20 posts (one model run in the background)' },
  { name: 'steer',  args: '@channel @reference', description: 'Steer a channel by a public reference channel (@name or a t.me link)' },
  { name: 'align',  args: '@channel',            description: 'Align a channel\'s agent with your rules: one card for everything that keeps it from following them (no model run)' },
  { name: 'launch', args: '@new_channel [@ref …] brief', description: 'Launch a new channel from a brief and up to 3 reference channels (one model run in the background)' },
  { name: 'audit',  args: '',                    description: 'Run the sysadmin\'s audit of skills, memory, rules and tools now (about a minute)' },
  { name: 'rules',  args: '[@channel]',          description: 'Your rules for a channel' },
  { name: 'skills', args: '[@agent]',            description: 'An agent\'s skills' },
  { name: 'memory', args: '[@channel]',          description: 'What a channel\'s agent learnt from reviews and approvals' },
  { name: 'help',   args: '',                    description: 'The commands' },
] as const;

export type SlashName = typeof SLASH_COMMANDS[number]['name'];

export interface SlashCommand {
  name: SlashName | null;
  /** The word after `/` as typed (an unknown command keeps it for the answer). */
  word: string;
  args: string[];
  /** Everything after the command word as typed (line breaks kept), for commands with free text. */
  rest: string;
}

export interface SlashResult {
  content:   string;
  artifacts: ArtifactChip[];
  /** Spec 062 FR-008: a confirmation card the command proposed (the chat streams it like an agent's card). */
  action?:   PendingAction;
}

/** Spec 062 FR-008: the outcome of `/align`: the card (none when everything agrees) and one line per item. */
export type SlashAlign = { ok: true; handle: string; action: PendingAction | null; items: string[] } | { ok: false; error: string; details?: string };

export type SlashStart = { ok: true; chip: ArtifactChip } | { ok: false; error: string; details?: string; chip?: ArtifactChip };

export interface SlashDeps {
  setup(channelKey: string): Promise<SlashStart>;
  steer(channelKey: string, reference: string): Promise<SlashStart>;
  /** Spec 052 FR-001. */
  launch(q: { target: string; references: string[]; brief: string }): Promise<SlashStart>;
  /** Spec 055 FR-003: starts an audit in the background (the chip is the running report). */
  audit?(): Promise<SlashStart>;
  /** Spec 062 FR-008: the fix_config_conflicts card for the agent a handle or channel points at, proposed in this chat. */
  align?(target: string, chatId: string | null): Promise<SlashAlign>;
  list(q: { type: ArtifactType; agent?: string; channel?: string }): Promise<ArtifactRow[]>;
}

/** The chat's context: its agent and that agent's channel (or the channel picked in the composer). */
export interface SlashContext {
  agent:   string | null;
  channel: string | null;
  /** The chat the command runs in (a card it proposes belongs to it). */
  chatId?: string | null;
}

const CHANNEL = /^@[A-Za-z0-9_]{3,64}$/;
const HANDLE = /^@?[a-z][a-z0-9_]{2,31}$/;
const MAX_CHIPS = 20;

/** `/word args…` at the start of the message; a path such as `/app/setup` is not a command. */
export function parseSlash(text: string): SlashCommand | null {
  const m = /^\/([a-z]+)(?=\s|$)([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const known = SLASH_COMMANDS.find((c) => c.name === m[1]);
  return { name: known?.name ?? null, word: m[1], args: m[2].trim().split(/\s+/).filter(Boolean), rest: m[2].trim() };
}

const REF_TOKEN = /^(?:telegram:)?@[A-Za-z][A-Za-z0-9_]{3,31}$|^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/\S+$/i;

/**
 * Spec 052: `/launch @new [@ref …] brief…` — the first handle is the new channel, the handles right after it are the
 * references, the rest (a leading dash or colon dropped) is the brief with its line breaks.
 */
export function parseLaunchArgs(rest: string): { target: string; references: string[]; brief: string } | null {
  let text = rest.trim();
  const take = (): string | null => {
    const m = /^(\S+)(\s+|$)/.exec(text);
    if (!m || !REF_TOKEN.test(m[1].replace(/[,;]$/, ''))) return null;
    text = text.slice(m[0].length);
    return m[1].replace(/[,;]$/, '');
  };
  const target = take();
  if (!target) return null;
  const references: string[] = [];
  for (let ref = take(); ref; ref = take()) references.push(ref);
  const brief = text.replace(/^[—–:\-]+\s*/, '').trim();
  return { target, references, brief };
}

const usage = (name: SlashName) => {
  const c = SLASH_COMMANDS.find((x) => x.name === name)!;
  return `/${c.name}${c.args ? ` ${c.args}` : ''}`;
};

const help = () => ['Commands:', ...SLASH_COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''} — ${c.description}`)].join('\n');

const channelArg = (a: string | undefined) => {
  if (!a) return null;
  const t = a.replace(/^telegram:/, '').replace(/^(https?:\/\/)?t\.me\//i, '@');
  const k = t.startsWith('@') ? t : `@${t}`;
  return CHANNEL.test(k) ? k : undefined;
};

const chip = (r: ArtifactRow): ArtifactChip => ({ type: r.type, id: r.id, title: r.title, status: r.status });

const ERRORS: Record<string, string> = {
  not_own_channel: 'is not one of your tracked channels',
  no_card:         'has no editor card yet — set the channel up first (/setup)',
  same_channel:    'the reference must be another channel',
  invalid_source:  'the reference is not a public channel',
  already_open:    'this reference is already being analysed for the channel',
};

const ALIGN_ITEMS_SHOWN = 8;

const LAUNCH_ERRORS: Record<string, string> = {
  invalid_target:      'the new channel must be a handle: /launch @new_channel [@reference …] what the channel is about',
  brief_too_short:     'describe the channel after the handles in at least 30 characters: what it publishes and for whom',
  too_many_references: 'at most 3 reference channels',
  already_running:     'already runs in approval or live mode — use /setup or the agent page',
};

export async function runSlash(cmd: SlashCommand, ctx: SlashContext, d: SlashDeps): Promise<SlashResult> {
  const say = (content: string, artifacts: ArtifactChip[] = []): SlashResult => ({ content, artifacts });
  if (!cmd.name) return say(`There is no command /${cmd.word}.\n${help()}`);
  const wrong = () => say(`Usage: ${usage(cmd.name!)}`);

  switch (cmd.name) {
    case 'help':
      return say(help());

    case 'setup': {
      if (cmd.args.length > 1) return wrong();
      const key = channelArg(cmd.args[0]) ?? (cmd.args.length ? undefined : ctx.channel);
      if (!key) return wrong();
      const r = await d.setup(key);
      if (!r.ok) return say(`${key} ${ERRORS[r.error] ?? r.details ?? r.error}.`);
      return say(`Setup from history queued for ${key}. The analysis starts within a minute; open the proposal from the card below.`, [r.chip]);
    }

    case 'steer': {
      if (cmd.args.length < 1 || cmd.args.length > 2) return wrong();
      const target = cmd.args.length === 2 ? channelArg(cmd.args[0]) : ctx.channel;
      const reference = cmd.args[cmd.args.length - 1];
      if (!target) return wrong();
      const r = await d.steer(target, reference);
      if (!r.ok) {
        const why = ERRORS[r.error] ?? r.details ?? r.error;
        return say(r.error === 'not_own_channel' || r.error === 'no_card' ? `${target} ${why}.` : `Steering for ${target}: ${why}.`);
      }
      return say(`Steering for ${target} queued. The reference's last 20 posts are read within a minute; review and activate the rules from the card below.`, [r.chip]);
    }

    case 'align': {
      if (cmd.args.length > 1) return wrong();
      if (!d.align) return say('Aligning is not available here.');
      const target = cmd.args.length ? channelArg(cmd.args[0]) : (ctx.agent ? `@${ctx.agent}` : ctx.channel);
      if (!target) return cmd.args.length ? wrong() : say(`Name the channel: ${usage('align')}`);
      const r = await d.align(target, ctx.chatId ?? null);
      if (!r.ok) return say(r.error === 'unknown_agent' ? `${target} is not a channel or agent of the network.` : `Align ${target}: ${r.details ?? r.error}.`);
      if (!r.action) return say(`@${r.handle}: the playbook, profiles and your rules already agree — nothing to align.`);
      const shown = r.items.slice(0, ALIGN_ITEMS_SHOWN).map((i) => `- ${i}`);
      const more = r.items.length > ALIGN_ITEMS_SHOWN ? [`- … and ${r.items.length - ALIGN_ITEMS_SHOWN} more`] : [];
      return { content: [`@${r.handle} has ${r.items.length} item${r.items.length === 1 ? '' : 's'} to align with your rules. The card below applies them — untick what you want to keep, then press Apply:`, ...shown, ...more].join('\n'), artifacts: [], action: r.action };
    }

    case 'launch': {
      const a = parseLaunchArgs(cmd.rest);
      if (!a) return wrong();
      const r = await d.launch(a);
      if (!r.ok) {
        if (r.error === 'already_open') return say(`${a.target} already has a launch — open it from the card below.`, r.chip ? [r.chip] : []);
        return say(`Launch of ${a.target}: ${LAUNCH_ERRORS[r.error] ?? r.details ?? r.error}.`);
      }
      const refs = a.references.length ? ` The ${a.references.length === 1 ? 'reference is' : `${a.references.length} references are`} read first.` : '';
      return say(`Launch of ${a.target} queued.${refs} The plan is ready in a few minutes; the card below shows it and what only you can do (add the bot as an admin).`, [r.chip]);
    }

    case 'audit': {
      if (cmd.args.length) return wrong();
      if (!d.audit) return say('The audit is not available here.');
      const r = await d.audit();
      if (!r.ok) {
        if (r.error === 'already_running') return say('An audit is already running — open it from the card below.', r.chip ? [r.chip] : []);
        return say(`The audit did not start: ${r.details ?? r.error}.`);
      }
      return say('Audit started. The sysadmin checks skills, memory, rules and tools; the report fills in within a minute — open it from the card below.', [r.chip]);
    }

    case 'rules':
    case 'memory': {
      if (cmd.args.length > 1) return wrong();
      const key = cmd.args.length ? channelArg(cmd.args[0]) : ctx.channel;
      if (!key) return cmd.args.length ? wrong() : say(`Name the channel: ${usage(cmd.name)}`);
      const rows = await d.list({ type: cmd.name, channel: key });
      if (!rows.length) return say(cmd.name === 'rules' ? `${key} has no rules of yours yet.` : `${key} has nothing learnt yet.`);
      return say(cmd.name === 'rules' ? `Your rules for ${key}:` : `What the agent of ${key} learnt:`, rows.slice(0, MAX_CHIPS).map(chip));
    }

    case 'skills': {
      if (cmd.args.length > 1) return wrong();
      const raw = cmd.args[0];
      if (raw && !HANDLE.test(raw)) return wrong();
      const handle = raw ? raw.replace(/^@/, '') : ctx.agent;
      const rows = await d.list({ type: 'skill', ...(handle ? { agent: handle } : {}) });
      if (!rows.length) return say(handle ? `@${handle} has no skills of its own.` : 'There are no skills yet.');
      const more = rows.length > MAX_CHIPS ? ` (the latest ${MAX_CHIPS} of ${rows.length})` : '';
      return say(`${handle ? `Skills of @${handle}` : 'Skills'}${more}:`, rows.slice(0, MAX_CHIPS).map(chip));
    }
  }
}
