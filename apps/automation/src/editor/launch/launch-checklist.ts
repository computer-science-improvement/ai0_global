import { refName } from '../steering/steering.repository';
import type { ChannelLaunch } from './launch.types';

/**
 * Spec 052 FR-002: the launch checklist — what only the owner can do and what code does, with the live state of each
 * step. Pure: the service gathers the facts (tracking, published posts, the network's other platforms, graduation and
 * promo progress) and this decides the states. English (the dashboard shows it).
 */

export const FIRST_POSTS = 3;

export type StepKey = 'bot_admin' | 'tracked' | 'references' | 'plan' | 'start' | 'first_posts' | 'cross_promo' | 'platforms' | 'graduation';
export type StepState = 'done' | 'waiting' | 'needs_you' | 'skipped' | 'failed' | 'optional';

export interface LaunchStep {
  key:    StepKey;
  who:    'owner' | 'code';
  state:  StepState;
  title:  string;
  detail: string | null;
  /** Where the owner fixes it (a Telegram link or a dashboard path). */
  link:   string | null;
}

export interface ChecklistFacts {
  /** The channel's tracking row: ours or not (null = not tracked). */
  tracked:   { isMine: boolean } | null;
  /** Posts of the channel published since Start. */
  published: number;
  /** The channel network's other platforms and their connection state (049). */
  platforms: Array<{ ref: string; platform: string; title: string | null; state: string | null }>;
  /** Graduation progress (T3), one line, when running. */
  graduation?: { state: StepState; detail: string } | null;
}

const BAD = new Set(['no_access', 'token_invalid', 'token_expiring']);

export function buildChecklist(l: ChannelLaunch, f: ChecklistFacts): LaunchStep[] {
  const started = l.status === 'running' || l.status === 'graduated';
  const bot = l.botState;
  const botOk = bot?.state === 'ok';
  const name = l.channelKey.replace(/^@/, '');
  const steps: LaunchStep[] = [];

  steps.push({
    key: 'bot_admin', who: 'owner', state: botOk ? 'done' : bot ? 'needs_you' : 'waiting',
    title: botOk ? `${bot!.bot ?? 'The bot'} is an administrator` : `Add ${bot?.bot ?? 'the bot'} to ${l.channelKey} as an administrator with "Post messages"`,
    detail: bot ? bot.detail : 'Checked within a minute', link: `https://t.me/${name}`,
  });

  steps.push({
    key: 'tracked', who: 'code', state: f.tracked?.isMine ? 'done' : 'waiting',
    title: f.tracked?.isMine ? 'Tracked as your channel' : 'Added to tracking as yours once the bot is an administrator',
    detail: f.tracked?.isMine ? 'Subscribers and post stats are collected' : null, link: null,
  });

  const refs = l.refs;
  const skipped = refs.filter((r) => r.status === 'skipped');
  const working = refs.filter((r) => ['queued', 'collecting', 'analyzing'].includes(r.status));
  steps.push({
    key: 'references', who: 'code',
    state: !refs.length ? 'skipped' : working.length ? 'waiting' : skipped.length === refs.length ? 'failed' : 'done',
    title: !refs.length ? 'No references: the plan comes from the brief' : working.length ? `Reading ${working.map((r) => refName(r.ref)).join(', ')}` : `References read: ${refs.filter((r) => r.status !== 'skipped').map((r) => refName(r.ref)).join(', ') || 'none'}`,
    detail: skipped.length ? `Skipped: ${skipped.map((r) => `${refName(r.ref)} (${r.reason ?? 'not read'})`).join('; ')}` : null, link: null,
  });

  const planState: StepState = l.status === 'failed' ? 'failed'
    : ['ready', 'running', 'graduated'].includes(l.status) ? 'done' : l.status === 'discarded' ? 'skipped' : 'waiting';
  steps.push({
    key: 'plan', who: 'code', state: planState,
    title: planState === 'done' ? 'Launch plan ready' : planState === 'failed' ? 'The plan failed' : l.status === 'analyzing' ? 'Making the plan' : 'The plan comes after the references',
    detail: l.status === 'failed' ? l.reason : null, link: null,
  });

  steps.push({
    key: 'start', who: 'owner',
    state: started ? 'done' : l.status === 'ready' ? (l.startRequested ? 'waiting' : 'needs_you') : 'waiting',
    title: started ? `Started ${l.startedAt ? new Date(l.startedAt).toISOString().slice(0, 10) : ''}: posts wait for your approval`.trim()
      : l.startRequested ? 'Starts as soon as the bot is an administrator' : 'Press Start: the plan is applied and the channel goes into approval mode',
    detail: l.status === 'ready' && l.reason ? l.reason : null, link: null,
  });

  steps.push({
    key: 'first_posts', who: 'code', state: !started ? 'waiting' : f.published >= FIRST_POSTS ? 'done' : 'waiting',
    title: f.published >= FIRST_POSTS ? `First ${FIRST_POSTS} posts published` : `First posts: ${Math.min(f.published, FIRST_POSTS)} of ${FIRST_POSTS} published`,
    detail: started && f.published < FIRST_POSTS ? 'Approve the waiting posts in Approvals or in the owner bot' : null, link: started ? '/app/approvals' : null,
  });

  const promo = l.promo;
  const scheduled = promo?.items.filter((i) => i.slotId) ?? [];
  steps.push({
    key: 'cross_promo', who: 'code',
    state: !promo ? 'waiting' : scheduled.length ? 'done' : 'skipped',
    title: !promo ? `Cross-promo from the network after the first ${FIRST_POSTS} posts`
      : scheduled.length ? `Cross-promo scheduled in ${scheduled.map((i) => refName(i.sourceRef)).join(', ')}` : 'No cross-promo from the network',
    detail: promo ? [promo.note, ...promo.items.filter((i) => i.error).map((i) => `${refName(i.sourceRef)}: ${i.error}`)].filter(Boolean).join('; ') || null : null,
    link: null,
  });

  const bad = f.platforms.filter((p) => p.state && BAD.has(p.state));
  steps.push({
    key: 'platforms', who: 'owner',
    state: !f.platforms.length ? 'optional' : bad.length ? 'needs_you' : 'done',
    title: !f.platforms.length ? 'Optional: connect Instagram, Facebook or Threads for this channel in Connections'
      : bad.length ? `Fix ${bad.map((p) => p.title ?? p.ref).join(', ')}` : `Other platforms connected: ${f.platforms.map((p) => p.platform).join(', ')}`,
    detail: bad.length ? bad.map((p) => `${p.ref}: ${p.state}`).join('; ') : null, link: '/app/connections',
  });

  steps.push({
    key: 'graduation', who: 'owner',
    state: l.status === 'graduated' ? 'done' : f.graduation?.state ?? 'waiting',
    title: l.status === 'graduated' ? 'Live: posts go out without approval' : 'Go live when the approvals show the agent writes well',
    detail: l.status === 'graduated' ? null : f.graduation?.detail ?? null, link: null,
  });
  return steps;
}
