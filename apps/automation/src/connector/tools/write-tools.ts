import { z } from 'zod';
import type { ConnectorTool } from '../types';
import { clip, parseArgs, refuse, resolveChannel, schema, writeTool } from './common';
import { reasonOfHttp } from '../posts/connector-posts.service';
import { postSchema } from './read-tools';
import type { ConnectorWritePorts } from './ports';

/**
 * The connector's write tools (spec 103 §7). Scope mcp:write; every one carries destructiveHint so Claude asks before
 * it runs. Nothing here changes a mode, setting, model, budget or skill, and nothing publishes outside the approval path.
 */

/** Tools whose effect is the owner's own decision: the answer to "yes, do it" (§7, D2). Claude must ask first. */
export const OWNER_CONFIRMED_TOOLS: readonly string[] = ['approve_post', 'apply_card'];

/** Card kinds apply_card may apply (§7.1). Everything else is applied in the dashboard. */
export const CARD_KINDS_ALLOWED: readonly string[] = [
  'slot_change', 'replan_today', 'series_change', 'schedule_rule', 'owner_rule', 'set_brief', 'update_artifact',
  'fix_config_conflicts', 'series_pause_resume', 'content_examples', 'write_skill', 'attach_skill', 'detach_skill',
  'change_source', 'set_resource_profile', 'update_agent', 'file_directive',
];

/** Named for the error text and the tests; an unknown kind is refused too. */
export const CARD_KINDS_REFUSED: readonly string[] = [
  'slot_regenerate', 'create_agent', 'set_network_mode', 'migrate_strategies', 'strategy_cutover', 'strategy_rollback',
  'import_list', 'resync_import', 'edit_data_schema', 'repurpose',
];

export function isCardKindAllowed(kind: string): boolean { return CARD_KINDS_ALLOWED.includes(kind); }

const CARD_INPUT_MAX = 8192;
/** What a card's follow-ups reported, cut so a long result cannot flood the answer. */
const clipThen = (v: unknown): unknown => { const s = JSON.stringify(v) ?? ''; return s.length > 1500 ? clip(s, 1500) : v; };

const channelProp = { type: 'string', description: 'Channel key, e.g. @my_channel (list_channels shows them).' };
const atProp = { type: 'string', description: 'Time: ISO 8601 with an offset (2026-11-13T18:00:00+02:00) or YYYY-MM-DD HH:MM in the channel\'s timezone.' };
const postIdProp = { type: 'string', description: 'Post id from list_schedule or prepare_post.' };
const idArg = (name: string) => z.string().min(1).max(80, `${name} is too long`);

export function buildWriteTools(p: ConnectorWritePorts): ConnectorTool[] {
  const known = async () => (await p.cards()).map((c) => c.channelKey);

  const preparePost = writeTool({
    name: 'prepare_post', title: 'Prepare a post',
    description: 'Write a post yourself and schedule it. It is rendered and checked now, locked from the automation (agents will not edit, replace or skip it) and goes out at its time through the normal publisher. In approve mode it waits for approve_post; in live mode it is approved at once. Telegram only; the channel must be in approve or live mode; the time is 5 minutes to 60 days ahead and outside quiet hours. Run check_post first.',
    inputSchema: schema({
      channel: channelProp, at: atProp, post: postSchema(),
      needs_approval: { type: 'boolean', description: 'true: wait for approval; false: approve at once. Default: wait in approve mode, approved in live mode.' },
    }, ['channel', 'at', 'post']),
    async call(args) {
      const a = parseArgs(z.object({ channel: z.string(), at: z.string(), post: z.unknown(), needs_approval: z.boolean().optional() }), args);
      return p.posts.prepare({ channel: resolveChannel(a.channel, await known()), at: a.at, post: a.post, needsApproval: a.needs_approval });
    },
  });

  const planPost = writeTool({
    name: 'plan_post', title: 'Plan a post',
    description: 'Reserve a slot with a brief and let the channel agent write the post at its time. The slot is locked: replans and the SLO controller leave it alone. Use it when you want the agent\'s voice but your topic.',
    inputSchema: schema({
      channel: channelProp, at: atProp,
      topic: { type: 'string', minLength: 3, maxLength: 300, description: 'What the post is about.' },
      angle: { type: 'string', maxLength: 300, description: 'The angle or takeaway (optional).' },
      format: { type: 'string', description: 'Post format (text, photo, album, poll, quiz, video, carousel, longread). Default: the channel\'s most used.' },
      notes: { type: 'string', maxLength: 600, description: 'Extra instructions or facts for the writer (optional).' },
    }, ['channel', 'at', 'topic']),
    async call(args) {
      const a = parseArgs(z.object({
        channel: z.string(), at: z.string(), topic: z.string().trim().min(3).max(300), angle: z.string().max(300).optional(),
        format: z.string().max(40).optional(), notes: z.string().max(600).optional(),
      }), args);
      return p.posts.plan({ channel: resolveChannel(a.channel, await known()), at: a.at, topic: a.topic, angle: a.angle, format: a.format, notes: a.notes });
    },
  });

  const updatePost = writeTool({
    name: 'update_post', title: 'Update a post', idempotent: true,
    description: 'Change a post that has not gone out: a written post takes new text (post) and/or a new time (at); a planned post takes a new topic, angle, format or time. An agent\'s post becomes locked from the automation and keeps its status. Not within 2 minutes of its time.',
    inputSchema: schema({
      post_id: postIdProp, post: postSchema(), at: atProp,
      topic: { type: 'string', maxLength: 300, description: 'New topic (planned posts).' }, angle: { type: 'string', maxLength: 300, description: 'New angle (planned posts).' },
      format: { type: 'string', description: 'New format (planned posts).' },
    }, ['post_id']),
    async call(args) {
      const a = parseArgs(z.object({
        post_id: idArg('post_id'), post: z.unknown().optional(), at: z.string().optional(), topic: z.string().trim().min(3).max(300).optional(),
        angle: z.string().max(300).optional(), format: z.string().max(40).optional(),
      }), args);
      return p.posts.update({ postId: a.post_id, post: a.post, at: a.at, topic: a.topic, angle: a.angle, format: a.format });
    },
  });

  const cancelPost = writeTool({
    name: 'cancel_post', title: 'Cancel a post', idempotent: true,
    description: 'Cancel a planned, waiting or approved post. No replacement is made. A published post stays.',
    inputSchema: schema({ post_id: postIdProp, reason: { type: 'string', maxLength: 300, description: 'Why (kept in the log).' } }, ['post_id']),
    async call(args) {
      const a = parseArgs(z.object({ post_id: idArg('post_id'), reason: z.string().max(300).optional() }), args);
      return p.posts.cancel({ postId: a.post_id, reason: a.reason });
    },
  });

  const rejectPost = writeTool({
    name: 'reject_post', title: 'Reject an agent post',
    description: 'Reject a post the agent wrote that waits for approval; the agent may write a replacement. For posts made through the connector use cancel_post.',
    inputSchema: schema({ post_id: postIdProp, reason: { type: 'string', maxLength: 500, description: 'Why: the agent reads it for the replacement.' } }, ['post_id']),
    async call(args) {
      const a = parseArgs(z.object({ post_id: idArg('post_id'), reason: z.string().max(500).optional() }), args);
      return p.posts.reject({ postId: a.post_id, reason: a.reason });
    },
  });

  const approvePost = writeTool({
    name: 'approve_post', title: 'Approve a post', idempotent: true,
    description: 'Approve a post that waits for approval so it goes out at its time. Only after the owner has said to approve this post: show them the preview (get_post) and ask first.',
    inputSchema: schema({ post_id: postIdProp }, ['post_id']),
    async call(args) {
      const a = parseArgs(z.object({ post_id: idArg('post_id') }), args);
      return p.posts.approve({ postId: a.post_id });
    },
  });

  const replanChannel = writeTool({
    name: 'replan_channel', title: 'Replan a channel',
    description: 'Run the planner again for a channel\'s day, in the background, with an optional instruction. Locked posts (made through the connector) stay; agent posts not yet written may change. Returns started, replan_in_progress, editor_disabled or channel_off.',
    inputSchema: schema({
      channel: channelProp, day: { type: 'string', enum: ['today', 'tomorrow'], description: 'Which day (default today).' },
      instruction: { type: 'string', maxLength: 600, description: 'What to plan around, e.g. "a launch post at 18:00". It cannot change rules, mode or budget.' },
    }, ['channel']),
    async call(args) {
      const a = parseArgs(z.object({ channel: z.string(), day: z.enum(['today', 'tomorrow']).default('today'), instruction: z.string().max(600).optional() }), args);
      const channel = resolveChannel(a.channel, await known());
      const r = await p.replan(channel, { day: a.day, instruction: a.instruction });
      const notes: Record<string, string> = {
        started: 'The planner is running in the background; list_schedule shows the new plan in a minute or two.',
        replan_in_progress: 'A replan for this channel is already running.',
        editor_disabled: 'The editor is disabled (EDITOR_ENABLED), so nothing can be planned.',
        channel_off: 'The channel is off: switch it on in the dashboard first.',
      };
      return { channel, day: a.day, status: r.status, note: notes[r.status] };
    },
  });

  const talkToAgent = writeTool({
    name: 'talk_to_agent', title: 'Talk to an agent',
    description: 'Send a message to one of the network\'s agents (list_agents) and wait for the answer, up to wait_seconds. The chat is marked as started from Claude; publishing is off in it, so drafts and cards are proposals. If the agent is still answering, use read_agent_chat. Continue a chat only with chat_id from an earlier talk_to_agent. get_draft shows a draft in full.',
    inputSchema: schema({
      message: { type: 'string', minLength: 1, maxLength: 8000, description: 'What to say.' },
      agent: { type: 'string', description: 'Agent handle, with or without @ (list_agents). Default: the network manager.' },
      chat_id: { type: 'string', description: 'Continue this chat (from an earlier talk_to_agent).' },
      channel: channelProp,
      wait_seconds: { type: 'integer', minimum: 0, maximum: 100, description: 'How long to wait for the answer (default 60, at most 100).' },
    }, ['message']),
    async call(args) {
      const a = parseArgs(z.object({
        message: z.string().trim().min(1).max(8000), agent: z.string().max(80).optional(), chat_id: z.string().max(80).optional(),
        channel: z.string().optional(), wait_seconds: z.number().int().min(0).max(100).optional(),
      }), args);
      const channel = a.channel ? resolveChannel(a.channel, await known()) : null;
      return p.chat.talk({ message: a.message, agent: a.agent, chatId: a.chat_id, channel, waitSeconds: a.wait_seconds });
    },
  });

  const applyCard = writeTool({
    name: 'apply_card', title: 'Apply a card',
    description: `Apply a card an agent proposed in a chat (its id is in read_agent_chat). Only after the owner has said to apply this card: show them its summary and ask first. Some kinds can only be applied in the dashboard: ${CARD_KINDS_REFUSED.join(', ')}. Optional input carries the owner's choices: skip_then (a list of follow-up actions or their indexes to leave out, for write_skill / attach_skill cards that carry ticked follow-ups such as detach_skill) and, for content_examples, the choice per example (for example {"examples": [{"index": 0, "choice": "bad"}]}; with no input every example is kept as good). Applying reports what the follow-ups did in result.then.`,
    inputSchema: schema({
      card_id: { type: 'string', description: 'Card id from read_agent_chat or talk_to_agent.' },
      input: { type: 'object', description: 'The owner\'s choices for the card (skip_then, content_examples choices). At most 8 KB of JSON.' },
    }, ['card_id']),
    async call(args) {
      const a = parseArgs(z.object({ card_id: idArg('card_id'), input: z.record(z.string(), z.unknown()).optional() }), args);
      if (a.input !== undefined && JSON.stringify(a.input).length > CARD_INPUT_MAX) refuse('input is too large.', `at most ${CARD_INPUT_MAX} bytes of JSON`);
      const card = await p.cardsApi.get(a.card_id);
      if (!card) refuse(`No card ${clip(a.card_id, 60)}.`, 'card ids come from read_agent_chat');
      if (!isCardKindAllowed(card.kind)) {
        refuse(`Cards of kind ${clip(card.kind, 60)} cannot be applied from Claude.`, 'open the dashboard chat and apply it there; the connector never changes modes, agents, imports or strategies');
      }
      if (card.status !== 'pending') refuse(`This card is ${card.status}, not pending.`);
      let settled: { action?: { status?: string; error?: string | null; result?: { then?: unknown } | null } } | null | undefined;
      try {
        settled = (await p.cardsApi.apply(a.card_id, a.input)) as typeof settled;
      } catch (err) { return reasonOfHttp(err); }
      const action = settled?.action;
      if (action && action.status !== 'applied') {
        refuse(`The card was not applied: it is ${clip(String(action.status), 40)}.`, action.error ? `reason: ${clip(String(action.error), 300)}` : undefined);
      }
      const then = action?.result?.then;
      return {
        card_id: a.card_id, kind: card.kind, applied: true, summary: clip(card.summary, 400),
        ...(then !== undefined ? { then: clipThen(then) } : {}), untrusted_fields: ['summary', ...(then !== undefined ? ['then'] : [])],
      };
    },
  });

  const discardCard = writeTool({
    name: 'discard_card', title: 'Discard a card', idempotent: true,
    description: 'Discard a pending card an agent proposed. Any kind may be discarded.',
    inputSchema: schema({ card_id: { type: 'string', description: 'Card id from read_agent_chat.' } }, ['card_id']),
    async call(args) {
      const a = parseArgs(z.object({ card_id: idArg('card_id') }), args);
      const card = await p.cardsApi.get(a.card_id);
      if (!card) refuse(`No card ${clip(a.card_id, 60)}.`, 'card ids come from read_agent_chat');
      if (card.status !== 'pending') refuse(`This card is ${card.status}, not pending.`);
      try { await p.cardsApi.discard(a.card_id); } catch (err) { return reasonOfHttp(err); }
      return { card_id: a.card_id, kind: card.kind, discarded: true };
    },
  });

  return [preparePost, planPost, updatePost, cancelPost, rejectPost, approvePost, replanChannel, talkToAgent, applyCard, discardCard];
}
