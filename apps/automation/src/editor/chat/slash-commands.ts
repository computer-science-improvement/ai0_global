import type { ArtifactChip, ArtifactRow, ArtifactType } from '../artifacts/artifact.types';

/**
 * Spec 048 FR-003: chat slash commands. They run in code — no model turn, no cost — and answer with one line and the
 * artifacts they made or found as chips.
 */
export const SLASH_COMMANDS = [
  { name: 'setup',  args: '@channel',            description: 'Set a channel up from its last 20 posts (one model run in the background)' },
  { name: 'steer',  args: '@channel @reference', description: 'Steer a channel by a public reference channel (@name or a t.me link)' },
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
}

export interface SlashResult {
  content:   string;
  artifacts: ArtifactChip[];
}

export type SlashStart = { ok: true; chip: ArtifactChip } | { ok: false; error: string; details?: string };

export interface SlashDeps {
  setup(channelKey: string): Promise<SlashStart>;
  steer(channelKey: string, reference: string): Promise<SlashStart>;
  list(q: { type: ArtifactType; agent?: string; channel?: string }): Promise<ArtifactRow[]>;
}

/** The chat's context: its agent and that agent's channel (or the channel picked in the composer). */
export interface SlashContext {
  agent:   string | null;
  channel: string | null;
}

const CHANNEL = /^@[A-Za-z0-9_]{3,64}$/;
const HANDLE = /^@?[a-z][a-z0-9_]{2,31}$/;
const MAX_CHIPS = 20;

/** `/word args…` at the start of the message; a path such as `/app/setup` is not a command. */
export function parseSlash(text: string): SlashCommand | null {
  const m = /^\/([a-z]+)(?=\s|$)([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const known = SLASH_COMMANDS.find((c) => c.name === m[1]);
  return { name: known?.name ?? null, word: m[1], args: m[2].trim().split(/\s+/).filter(Boolean) };
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
