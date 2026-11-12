import { z } from 'zod';
import type { EditorCard } from '../../editor/card';
import { reasonFor, reasonOfError } from '../../editor/reasons/catalogue';
import { localDate, zonedToUtc } from '../../editor/roles/time';
import { addDays } from '../../editor/approval/approval-timing';
import type { ChannelSloRow } from '../../editor/slo/channel-slo.repository';
import type { ConnectorTool } from '../types';
import type { ScheduleRow } from '../queries/connector-queries';
import type { ConnectorChatService } from '../chat/connector-chat.service';
import type { ConnectorPostsService } from '../posts/connector-posts.service';
import {
  MESSAGE_MAX, PREVIEW_MAX, clip, clipDeep, isUuid, parseArgs, readTool, refuse, requireTime, resolveChannel, schema, timeOut,
} from './common';
import type { ConnectorReadPorts } from './ports';

/**
 * The connector's read tools (spec 103 §7): scope mcp:read, no side effects, no model calls. Every result that carries
 * text from posts, sources, agents or logs names those fields in `untrusted_fields` and cuts them.
 */

const KYIV = 'Europe/Kyiv';
const DAY_MS = 86_400_000;

const channelProp = { type: 'string', description: 'Channel key, e.g. @my_channel (list_channels shows them).' };

const sloView = (r: ChannelSloRow | null) => (r ? {
  day: r.day, state: r.state, published: r.published, target: r.target, planned_ahead: r.plannedAhead, skipped: r.skipped,
  replacements: r.replacements, reason: r.reason ? clip(r.reason, 200) : null,
} : null);

/** One problem for get_problems. */
export interface Problem {
  severity: 'critical' | 'warning' | 'info';
  channel:  string | null;
  kind:     string;
  title:    string;
  detail:   string;
  since:    string | null;
  ref:      { type: string; id: string } | null;
}

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const;
const chanOfRef = (ref: string | null | undefined) => (ref ? ref.replace(/^telegram:/, '') : null);

/** The one place that gathers problems (get_problems and get_channel's count read it). */
export async function collectProblems(p: ConnectorReadPorts, channel: string | null): Promise<Problem[]> {
  const now = p.now();
  const out: Problem[] = [];
  const add = (x: Problem) => { if (!channel || x.channel === channel) out.push(x); };

  const health = await p.health().catch(() => null);
  if (health) {
    for (const c of health.connections) {
      add({ severity: c.state === 'token_invalid' || c.state === 'no_access' ? 'critical' : 'warning', channel: chanOfRef(c.ref), kind: 'connection',
        title: `${c.ref}: ${c.state.replace(/_/g, ' ')}`, detail: clip(c.detail ?? '', 300), since: c.since, ref: { type: 'resource', id: c.ref } });
    }
    for (const s of health.sources) {
      add({ severity: 'warning', channel: s.channelKey, kind: 'source', title: `Source ${clip(s.ref, 100)} is ${s.state}`, detail: `${s.errors} errors in ${s.calls} calls`,
        since: s.lastOkAt, ref: { type: 'source', id: s.id } });
    }
    if (!channel) {
      for (const b of health.budget.blocking) {
        add({ severity: 'critical', channel: null, kind: 'budget', title: 'A spending cap blocks AI calls', detail: clip(JSON.stringify(b), 300), since: null, ref: null });
      }
    }
    const stuckSeverity: Record<string, Problem['severity']> = { slot_overdue: 'critical', slot_failed: 'warning', slot_running: 'warning', approval_waiting: 'warning' };
    for (const g of health.stuck) {
      for (const it of g.items) {
        add({ severity: stuckSeverity[g.kind] ?? 'info', channel: it.channelKey ?? null, kind: g.kind, title: `${g.label}: ${clip(it.title, 120)}`,
          detail: clip(it.detail ?? g.rule, 300), since: it.at, ref: { type: 'item', id: it.id } });
      }
    }
  }

  // Each channel's own day: SLO row of today.
  const cards = await p.cards();
  for (const card of cards) {
    if (channel && card.channelKey !== channel) continue;
    const row = await p.slo.get(card.channelKey, localDate(now, card.timezone)).catch(() => null);
    if (!row || row.state === 'on_track' || row.state === 'met') continue;
    const sev: Problem['severity'] = row.state === 'dark' ? 'critical' : row.state === 'starved' || row.state === 'behind' ? 'warning' : 'info';
    add({ severity: sev, channel: card.channelKey, kind: 'slo', title: `${card.channelKey} is ${row.state.replace(/_/g, ' ')} today`,
      detail: `${row.published}/${row.target} published, ${row.plannedAhead} planned ahead${row.reason ? `; ${clip(row.reason, 160)}` : ''}`,
      since: row.darkSince?.toISOString() ?? null, ref: { type: 'channel', id: card.channelKey } });
  }

  for (const n of await p.queries.inbox(channel, 30)) {
    add({ severity: n.severity === 'critical' ? 'critical' : 'warning', channel: channel ?? chanOfRef(n.refId), kind: `inbox:${n.kind}`, title: clip(n.title, 200), detail: '',
      since: n.createdAt.toISOString(), ref: { type: 'inbox', id: String(n.id) } });
  }

  for (const g of await p.queries.closedGroups(channel, new Date(now.getTime() - DAY_MS))) {
    const code = reasonOfError(g.error);
    const entry = reasonFor(code);
    add({ severity: g.status === 'failed' || g.n >= 3 ? 'warning' : 'info', channel: g.channelKey, kind: 'closed_without_post',
      title: `${g.n} post${g.n === 1 ? '' : 's'} closed without going out: ${entry?.en ?? code ?? clip(g.error ?? g.status, 120)}`,
      detail: entry?.fix?.en ?? clip(g.error ?? '', 200), since: g.last.toISOString(), ref: { type: 'reason', id: code ?? g.status } });
  }

  for (const a of await p.queries.approvals(channel, now)) {
    add({ severity: 'warning', channel: a.channelKey, kind: a.status === 'expired' ? 'approval_expired' : 'approval_waiting',
      title: a.status === 'expired' ? `A post expired unapproved: ${clip(a.topic, 100)}` : `A post waits for approval: ${clip(a.topic, 100)}`,
      detail: `Scheduled ${a.scheduledAt.toISOString()}`, since: a.scheduledAt.toISOString(), ref: { type: 'post', id: a.id } });
  }

  for (const z of await p.queries.pauses(channel)) {
    add({ severity: 'warning', channel: z.channelKey, kind: `${z.kind}_pause`, title: `Paused: ${clip(z.label, 100)}`, detail: clip(z.reason, 200), since: z.since.toISOString(), ref: null });
  }

  for (const r of await p.queries.readiness(channel)) {
    for (const b of r.blockers) {
      add({ severity: 'warning', channel: r.channelKey, kind: 'readiness', title: `Setup blocker: ${b.code}`, detail: clip(b.detail, 240), since: null, ref: { type: 'channel', id: r.channelKey } });
    }
  }

  if (!channel) {
    const flag = (k: string) => (p.env(k) ?? '').trim();
    if (flag('EDITOR_ENABLED').toLowerCase() === 'false') {
      add({ severity: 'warning', channel: null, kind: 'global', title: 'The editor is disabled (EDITOR_ENABLED)', detail: 'Nothing is planned or written until it is on.', since: null, ref: null });
    }
    if (!flag('OPENROUTER_API_KEY') && !flag('EDITOR_ANTHROPIC_API_KEY')) {
      add({ severity: 'warning', channel: null, kind: 'global', title: 'No AI key is configured', detail: 'Agents and chats cannot run.', since: null, ref: null });
    }
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.since ?? '').localeCompare(a.since ?? ''));
}

function scheduleItem(r: ScheduleRow, tz: string) {
  const origin = r.legacy ? 'legacy_composer' : r.createdVia === 'connector' ? 'connector'
    : r.hints.some((h) => h.startsWith('ad_order:')) ? 'ad' : r.hints.some((h) => h.startsWith('chat_draft:')) ? 'chat_draft'
    : r.promo ? 'promo' : r.scheduleRuleId ? 'pin' : r.slo ? 'slo' : 'agent';
  return {
    post_id: r.id, channel: r.channelKey, ...timeOut(r.scheduledAt, tz), status: r.status, origin, locked: !!r.lockedBy,
    title: clip(r.title ?? r.topic, 200), format: r.format,
    needs_approval: r.status === 'awaiting_approval' || (r.status === 'planned' && r.mode === 'approve'),
    ...(r.resourceRef && !r.resourceRef.startsWith('telegram:') ? { resource: r.resourceRef } : {}),
  };
}

export interface ReadToolDeps {
  ports: ConnectorReadPorts;
  posts: Pick<ConnectorPostsService, 'check'>;
  chat:  Pick<ConnectorChatService, 'read'>;
}

export function buildReadTools(d: ReadToolDeps): ConnectorTool[] {
  const p = d.ports;
  const knownKeys = async () => (await p.cards()).map((c) => c.channelKey);
  const cardOf = async (input: unknown): Promise<EditorCard> => {
    const key = resolveChannel(input, await knownKeys());
    const card = await p.card(key);
    if (!card) refuse(`Unknown channel ${key}.`);
    return card;
  };
  const tzOf = async (key: string | null) => (key ? (await p.card(key))?.timezone : null) ?? KYIV;

  const listChannels = readTool({
    name: 'list_channels', title: 'List channels',
    description: 'List the network\'s Telegram channels with their mode, timezone, agent, today\'s progress against the daily target, the next post time and how many posts wait for approval. Start here to learn the channel keys.',
    inputSchema: schema({}),
    async call() {
      const now = p.now();
      const cards = await p.cards();
      const [facts, agents] = await Promise.all([p.queries.channelFacts(cards.map((c) => c.channelKey), now), p.agents()]);
      const channels = await Promise.all(cards.map(async (c) => {
        const slo = await p.slo.get(c.channelKey, localDate(now, c.timezone)).catch(() => null);
        const f = facts[c.channelKey];
        const effective = await p.modeOf(c).catch(() => c.mode);
        return {
          channel: c.channelKey, title: c.title ? clip(c.title, 120) : null, mode: effective, ...(effective !== c.mode ? { card_mode: c.mode } : {}),
          tz: c.timezone, agent: agents.find((a) => a.channel === c.channelKey && a.kind === 'orchestrator')?.handle ?? null,
          today: {
            published: slo?.published ?? null, target: slo?.target ?? null, state: slo?.state ?? null, planned_ahead: slo?.plannedAhead ?? null,
            next_post_at: f?.nextPostAt ? timeOut(f.nextPostAt, c.timezone) : null,
          },
          approvals_waiting: f?.approvalsWaiting ?? 0,
        };
      }));
      return { channels, untrusted_fields: ['channels[].title'] };
    },
  });

  const getChannel = readTool({
    name: 'get_channel', title: 'Get a channel',
    description: 'One channel in detail: mode, timezone, posts per day, quiet hours, minimum gap, formats, brief, its agent, today\'s and the last 7 days of delivery against target, the next 5 posts and the number of open problems.',
    inputSchema: schema({ channel: channelProp }, ['channel']),
    async call(args) {
      const card = await cardOf(args.channel);
      const now = p.now();
      const day = localDate(now, card.timezone);
      const [slo, history, next, agents, problems, effective] = await Promise.all([
        p.slo.get(card.channelKey, day).catch(() => null), p.slo.history(day, 7, card.channelKey).catch(() => []),
        p.queries.upcoming(card.channelKey, now, 5), p.agents(), collectProblems(p, card.channelKey), p.modeOf(card).catch(() => card.mode),
      ]);
      return {
        channel: card.channelKey, title: card.title ? clip(card.title, 120) : null, mode: effective, card_mode: card.mode, tz: card.timezone,
        language: card.language, posts_per_day: [card.postsPerDayMin, card.postsPerDayMax],
        quiet_hours: { from: card.quietStartHour, to: card.quietEndHour }, min_gap_minutes: card.minGapMinutes, plan_hour: card.planHour,
        formats: card.formats, brief: clip(card.brief, PREVIEW_MAX),
        agent: agents.find((a) => a.channel === card.channelKey && a.kind === 'orchestrator')?.handle ?? null,
        slo_today: sloView(slo), slo_7_days: history.map(sloView),
        next_posts: next.map((r) => scheduleItem(r, card.timezone)), open_problems: problems.length,
        untrusted_fields: ['title', 'brief', 'next_posts[].title'],
      };
    },
  });

  const ScheduleIn = z.object({
    channel: z.string().optional(), from: z.string().optional(), hours: z.number().int().min(1).max(336).default(48),
    include_closed: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(100),
  });
  const listSchedule = readTool({
    name: 'list_schedule', title: 'List the schedule',
    description: 'When posts go out: every planned, waiting, approved or running post in a time window, across channels or for one. Includes posts made through the connector and the old composer\'s one-off posts. Use it to see the plan and to find post ids.',
    inputSchema: schema({
      channel: channelProp,
      from: { type: 'string', description: 'Start of the window: ISO 8601 with an offset, or YYYY-MM-DD HH:MM in the channel\'s timezone. Default now.' },
      hours: { type: 'integer', minimum: 1, maximum: 336, description: 'Window length in hours (default 48).' },
      include_closed: { type: 'boolean', description: 'Also show published, skipped, failed and expired posts (default false).' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Most posts to return (default 100).' },
    }),
    async call(args) {
      const a = parseArgs(ScheduleIn, args);
      const channel = a.channel ? resolveChannel(a.channel, await knownKeys()) : null;
      const tz = await tzOf(channel);
      const from = a.from ? requireTime(a.from, tz, 'from') : p.now();
      const { rows, truncated } = await p.queries.schedule({ channel, from, to: new Date(from.getTime() + a.hours * 3_600_000), includeClosed: a.include_closed, limit: a.limit });
      const tzs = new Map((await p.cards()).map((c) => [c.channelKey, c.timezone]));
      return {
        from: from.toISOString(), hours: a.hours,
        items: rows.map((r) => scheduleItem(r, tzs.get(r.channelKey) ?? KYIV)), truncated,
        ...(truncated ? { hint: 'The list was cut: narrow it with channel, hours or a later from.' } : {}),
        untrusted_fields: ['items[].title'],
      };
    },
  });

  const getPost = readTool({
    name: 'get_post', title: 'Get a post',
    description: 'One post in detail: status and the reason in plain words with the fix when it did not go out, topic, angle, format, who made it and whether it is locked, the preview, the spec, lint warnings, the critic\'s verdict, approval details, the runs that wrote it and the published link.',
    inputSchema: schema({ post_id: { type: 'string', description: 'Post id from list_schedule.' } }, ['post_id']),
    async call(args) {
      const id = parseArgs(z.object({ post_id: z.string().min(1).max(80) }), args).post_id;
      const detail = await p.queries.slotDetail(id);
      if (!detail) refuse(`No post ${clip(id, 60)}.`, 'post ids come from list_schedule');
      const s = detail.slot;
      const card = await p.card(s.channelKey);
      const tz = card?.timezone ?? KYIV;
      const code = reasonOfError(s.error);
      const entry = reasonFor(code);
      const critic = s.critic ? { verdict: s.critic.verdict, notes: clip(s.critic.notes, 600), reason: clip(s.critic.reason, 200) } : null;
      return {
        post_id: s.id, channel: s.channelKey, ...timeOut(s.scheduledAt, tz), status: s.status, kind: s.kind,
        origin: s.createdVia === 'connector' ? 'connector' : s.scheduleRuleId ? 'pin' : s.promo ? 'promo' : s.slo ? 'slo' : 'agent',
        locked: !!s.lockedBy, locked_by: s.lockedBy ?? null, topic: clip(s.topic, 300), angle: s.angle ? clip(s.angle, 300) : null, format: s.format,
        reason: s.error ? { code, label: entry?.en ?? null, fix: entry?.fix?.en ?? null, detail: clip(s.error, 300) } : null,
        preview: s.renderedPreview ? clip(s.renderedPreview, PREVIEW_MAX) : null,
        spec: s.postSpec ? clipDeep(s.postSpec) : null, lint_warnings: (s.lintWarnings ?? []).map((w) => clip(String(w), 300)), critic,
        approval: s.approvedAt || s.status === 'awaiting_approval' || s.rejectReason ? {
          approved_at: s.approvedAt?.toISOString() ?? null, owner_edited: !!s.ownerEdited, reject_reason: s.rejectReason ? clip(s.rejectReason, 300) : null,
          editable_until: new Date(s.scheduledAt.getTime() - 120_000).toISOString(),
        } : null,
        runs: detail.runs.map((r) => ({ id: r.id, role: r.role, status: r.status, cost_usd: r.costUsd, at: r.startedAt.toISOString() })),
        published: detail.published ? {
          at: detail.published.postedAt.toISOString(), message_id: detail.published.messageId,
          link: s.channelKey.startsWith('@') ? `https://t.me/${s.channelKey.slice(1)}/${detail.published.messageId}` : null,
        } : null,
        untrusted_fields: ['topic', 'angle', 'reason.detail', 'preview', 'spec', 'lint_warnings', 'critic'],
      };
    },
  });

  const getProblems = readTool({
    name: 'get_problems', title: 'Get problems',
    description: 'What needs attention, critical first: broken connections, blocked sources, stuck or overdue posts, channels behind their daily target, unread critical notes, posts that closed without going out (grouped by reason, with the fix), approvals waiting or expired, pauses, setup blockers and global flags. Use it first when asked "is everything fine?".',
    inputSchema: schema({ channel: channelProp }),
    async call(args) {
      const channel = args.channel ? resolveChannel(args.channel, await knownKeys()) : null;
      const all = await collectProblems(p, channel);
      return {
        count: all.length, problems: all.slice(0, 60), ...(all.length > 60 ? { truncated: true } : {}),
        ...(all.length ? {} : { note: 'Nothing needs attention.' }),
        untrusted_fields: ['problems[].title', 'problems[].detail'],
      };
    },
  });

  const LogsIn = z.object({
    channel: z.string().optional(), since: z.string().optional(), until: z.string().optional(), level: z.enum(['info', 'warn', 'error']).optional(),
    kinds: z.array(z.enum(['run', 'slot', 'inbox', 'decision', 'publish'])).optional(), limit: z.number().int().min(1).max(200).default(100),
  });
  const getLogs = readTool({
    name: 'get_logs', title: 'Get logs',
    description: 'A merged activity log, newest first: agent runs, post outcomes (skipped, failed, published), inbox notes, decisions the system made on your behalf and published posts. Filter by channel, time, level and kind. Use get_run for the steps of one run.',
    inputSchema: schema({
      channel: channelProp, since: { type: 'string', description: 'Start: ISO 8601 with an offset, or YYYY-MM-DD HH:MM. Default 24 hours ago.' },
      until: { type: 'string', description: 'End, same forms. Default now.' }, level: { type: 'string', enum: ['info', 'warn', 'error'], description: 'Only this level.' },
      kinds: { type: 'array', items: { type: 'string', enum: ['run', 'slot', 'inbox', 'decision', 'publish'] }, description: 'Only these kinds of entries.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Most entries to return (default 100).' },
    }),
    async call(args) {
      const a = parseArgs(LogsIn, args);
      const channel = a.channel ? resolveChannel(a.channel, await knownKeys()) : null;
      const tz = await tzOf(channel);
      const now = p.now();
      const since = a.since ? requireTime(a.since, tz, 'since') : new Date(now.getTime() - DAY_MS);
      const until = a.until ? requireTime(a.until, tz, 'until') : new Date(now.getTime() + 60_000);
      const rows = await p.queries.logs({ channel, since, until, level: a.level ?? null, kinds: a.kinds ?? null, limit: a.limit });
      const cut = rows.length > a.limit;
      return {
        entries: rows.slice(0, a.limit).map((r) => ({ at: r.at.toISOString(), level: r.level, kind: r.kind, channel: r.channelKey, title: clip(r.title, 240), ref: r.ref })),
        truncated: cut, ...(cut ? { hint: 'Cut at the limit: narrow it with since, kinds or channel.' } : {}),
        untrusted_fields: ['entries[].title'],
      };
    },
  });

  const getRun = readTool({
    name: 'get_run', title: 'Get an agent run',
    description: 'One agent run: role, model, status, cost and its steps (up to 60, each input and output cut to 1,000 characters). Use it to see why an agent did what it did; run ids come from get_post and get_logs.',
    inputSchema: schema({ run_id: { type: 'string', description: 'Run id.' } }, ['run_id']),
    async call(args) {
      const id = parseArgs(z.object({ run_id: z.string().min(1).max(80) }), args).run_id;
      const r = /^[0-9a-f-]{36}$/i.test(id) ? await p.run(id) : null;
      if (!r) refuse(`No run ${clip(id, 60)}.`, 'run ids come from get_post and get_logs');
      const cut = (v: unknown) => (v == null ? null : clip(typeof v === 'string' ? v : JSON.stringify(v), 1000));
      return {
        run: {
          id: r.run.id, role: r.run.role, channel: r.run.channelKey, slot_id: r.run.slotId, model: r.run.model, status: r.run.status, steps: r.run.steps,
          cost_usd: r.run.costUsd, error: r.run.error ? clip(r.run.error, 300) : null, started_at: new Date(r.run.startedAt).toISOString(),
          finished_at: r.run.finishedAt ? new Date(r.run.finishedAt).toISOString() : null,
        },
        steps: r.steps.slice(0, 60).map((s) => ({ idx: s.idx, type: s.type, tool: s.toolName, is_error: s.isError, duration_ms: s.durationMs, input: cut(s.input), output: cut(s.output) })),
        ...(r.steps.length > 60 ? { truncated: true } : {}),
        untrusted_fields: ['run.error', 'steps[].input', 'steps[].output'],
      };
    },
  });

  const listAgents = readTool({
    name: 'list_agents', title: 'List agents',
    description: 'The network\'s agents: handle (use it with talk_to_agent), name, kind, the channel it works for, its mode and whether it is paused.',
    inputSchema: schema({}),
    async call() {
      return { agents: (await p.agents()).map((a) => ({ handle: a.handle, name: clip(a.name, 80), kind: a.kind, channel: a.channel, mode: a.mode, paused: a.paused })), untrusted_fields: ['agents[].name'] };
    },
  });

  const readAgentChat = readTool({
    name: 'read_agent_chat', title: 'Read an agent chat',
    description: 'Read a chat with an agent: the agent\'s newest messages with their cards and drafts, and whether it is still answering. Use it after talk_to_agent returned "running", or to read a chat from the dashboard. Waits up to wait_seconds for a running turn to finish. get_draft shows one draft in full (its spec, preview and checks).',
    inputSchema: schema({
      chat_id: { type: 'string', description: 'Chat id from talk_to_agent.' },
      after_message_id: { type: 'integer', minimum: 0, description: 'Only messages after this id (next_after_message_id of the last read).' },
      wait_seconds: { type: 'integer', minimum: 0, maximum: 90, description: 'Wait for a running answer, up to this many seconds (default 0).' },
    }, ['chat_id']),
    async call(args) {
      const a = parseArgs(z.object({ chat_id: z.string().min(1).max(80), after_message_id: z.number().int().min(0).optional(), wait_seconds: z.number().int().min(0).max(90).optional() }), args);
      return d.chat.read({ chatId: a.chat_id, afterMessageId: a.after_message_id, waitSeconds: a.wait_seconds });
    },
  });

  const getDraft = readTool({
    name: 'get_draft', title: 'Get a draft',
    description: 'One draft an agent wrote in a chat (its id is in read_agent_chat or talk_to_agent): channel, status, the preview as it would read in Telegram, the spec, the checks (lint errors and warnings), the critic\'s verdict, and the post it was scheduled as, if any. A draft is a proposal: nothing is published from here; to schedule it, pass its spec to prepare_post.',
    inputSchema: schema({ draft_id: { type: 'string', description: 'Draft id from read_agent_chat or talk_to_agent (messages[].drafts[].id).' } }, ['draft_id']),
    async call(args) {
      const id = parseArgs(z.object({ draft_id: z.string().trim().min(1).max(80) }), args).draft_id;
      const draft = isUuid(id) && p.draft ? await p.draft(id) : null;
      if (!draft) refuse(`No draft ${clip(id, 60)}.`, 'draft ids come from read_agent_chat (messages[].drafts[].id)');
      if (!draft.channelKey.startsWith('@')) refuse(`${clip(draft.channelKey, 80)} is not a Telegram channel.`, 'the connector works with Telegram channels only');
      const tz = (await p.card(draft.channelKey))?.timezone ?? KYIV;
      const spec = (draft.spec && typeof draft.spec === 'object' ? draft.spec : {}) as { title?: unknown; format?: unknown };
      const issue = (i: { code: string; message: string }) => ({ code: i.code, message: clip(i.message, 300) });
      return {
        draft_id: draft.id, chat_id: draft.chatId, channel: draft.channelKey, status: draft.status,
        scheduled: draft.scheduledAt ? timeOut(draft.scheduledAt, tz) : null,
        format: typeof spec.format === 'string' ? spec.format : null, title: typeof spec.title === 'string' ? clip(spec.title, 200) : null,
        preview: draft.preview ? clip(draft.preview, PREVIEW_MAX) : null,
        spec: clipDeep(draft.spec),
        lint: draft.lint ? { ok: draft.lint.ok, errors: draft.lint.errors.slice(0, 20).map(issue), warnings: draft.lint.warnings.slice(0, 20).map(issue) } : null,
        critic: draft.critic ? { verdict: draft.critic.verdict, notes: clip(draft.critic.notes, 600) } : null,
        post_id: draft.slotId, published_message_id: draft.publishedPostId,
        link: draft.publishedPostId ? `https://t.me/${draft.channelKey.slice(1)}/${draft.publishedPostId}` : null,
        error: draft.error ? clip(draft.error, 300) : null,
        created_at: draft.createdAt.toISOString(), updated_at: draft.updatedAt.toISOString(),
        note: 'A draft is a proposal: nothing is published from it here. To schedule it, pass its spec to prepare_post (check_post first).',
        untrusted_fields: ['title', 'preview', 'spec', 'lint', 'critic', 'error'],
      };
    },
  });

  const listRecentPosts = readTool({
    name: 'list_recent_posts', title: 'List recent posts',
    description: 'The channel\'s most recently published posts, newest first, with time, title, format and the link. Use it to avoid repeating a topic.',
    inputSchema: schema({ channel: channelProp, limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Most posts to return (default 10).' } }, ['channel']),
    async call(args) {
      const a = parseArgs(z.object({ channel: z.string(), limit: z.number().int().min(1).max(30).default(10) }), args);
      const card = await cardOf(a.channel);
      const rows = await p.queries.recentPosts(card.channelKey, a.limit);
      return {
        channel: card.channelKey,
        posts: rows.map((r) => ({
          ...timeOut(r.postedAt, card.timezone), message_id: r.messageId, title: clip(r.title ?? '', 300), format: r.format, kind: r.strategyType,
          link: card.channelKey.startsWith('@') ? `https://t.me/${card.channelKey.slice(1)}/${r.messageId}` : null,
        })),
        untrusted_fields: ['posts[].title'],
      };
    },
  });

  const checkPost = readTool({
    name: 'check_post', title: 'Check a post',
    description: 'Run the channel\'s text checks (lint) on a post and show its preview, without saving anything and without any AI call. Use it before prepare_post to fix problems first.',
    inputSchema: schema({ channel: channelProp, post: postSchema() }, ['channel', 'post']),
    async call(args) {
      const a = parseArgs(z.object({ channel: z.string(), post: z.unknown() }), args);
      const channel = resolveChannel(a.channel, await knownKeys());
      return d.posts.check({ channel, post: a.post });
    },
  });

  return [listChannels, getChannel, listSchedule, getPost, getProblems, getLogs, getRun, listAgents, readAgentChat, getDraft, listRecentPosts, checkPost];
}

/** The `post` input of check_post, prepare_post and update_post (the editor's PostSpec). */
export function postSchema(): Record<string, unknown> {
  return {
    type: 'object',
    description: 'The post as a PostSpec. Required: format (text|photo|album|poll|quiz|video|carousel|longread), title (3-120 chars, internal), origin (external|library|original). Usual fields: body (blocks: {type:"lead"|"p"|"list"|"quote"|"heading"|..., text|items}), media [{url, alt?, credit?}], placement (above|below), hashtags (without #), source {url, label?}, cta {url, label}, buttons, poll {question, options, correct_index?}, slides (carousel), longread. Markup in text: **bold**, _italic_, [text](https://url). check_post shows what the channel\'s checks say.',
    properties: {
      format: { type: 'string', enum: ['text', 'photo', 'album', 'poll', 'quiz', 'video', 'carousel', 'longread'] },
      title: { type: 'string', description: 'Short internal title, 3-120 characters.' },
      origin: { type: 'string', enum: ['external', 'library', 'original'] },
      body: { type: 'array', items: { type: 'object' }, description: 'Text blocks, for example [{"type":"lead","text":"..."},{"type":"p","text":"..."}].' },
    },
    required: ['format', 'title', 'origin'],
    additionalProperties: true,
  };
}

// Re-exported for the facade and tests.
export { MESSAGE_MAX, zonedToUtc, addDays };
