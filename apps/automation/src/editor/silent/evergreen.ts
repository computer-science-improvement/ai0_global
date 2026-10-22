import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import type { AgentLoopResult } from '../harness/agent-loop';
import type { EditorTool } from '../harness/tool';
import type { InboxItemInput, OwnerInbox } from '../agents/owner-inbox';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import type { EvergreenRequest } from '../roles/editor-runner.service';
import { parseResourceRef } from '../agents/agent.types';
import { localDate, localTimeLabel, zonedToUtc } from '../roles/time';
import { isRescued, PublishProbe, type SlotFailure } from './fallback-ladder';
import { errText } from '../../common/err-text';

/**
 * Spec 037 FR-010 (T10): the evergreen step of the fallback ladder (decision 9, owner 15.10: allowed).
 *
 * When the slot's main post failed (critic reject, lint / guard) and the next candidate and the lighter format did
 * not get out, the writer gets one more run for an EVERGREEN post: an explainer, guide, glossary or roundup within the
 * channel topic, without a date anchor. It goes through everything a post goes through (lint with the integrity
 * checks, the publish guards with the story registry, the critic with the resource skills of T12):
 *   • ≤ EDITOR_EVERGREEN_PER_DAY (default 1) evergreen per channel per local day — an evergreen run counts even when
 *     the critic threw it away (no second evergreen spend that day); 0 switches the step off;
 *   • the post is marked `story.kind = evergreen` by code (EvergreenProbe), so the story registry keeps its topic for
 *     30 days (`story_repeat` blocks a repeat) and a live publish lands in published_posts as strategy_type
 *     'evergreen' (counted apart in Analytics and the MANAGER digest);
 *   • a rejected / skipped evergreen leaves the slot skipped with the MAIN post's reason (the runner);
 *   • a slot rescued by evergreen still gets an Inbox note with the main post's reason (`evergreen_fallback`).
 * Telegram channels only (the registry and the analytics category are Telegram's).
 */

export const DEFAULT_EVERGREEN_PER_DAY = 1;
export const EVERGREEN_INBOX_KIND = 'evergreen_fallback';
/** published_posts.strategy_type of a live evergreen post. */
export const EVERGREEN_STRATEGY = 'evergreen';
/** The KPI samples leave evergreen fillers out (spec 037 FR-013 seam, next to T2's repost filter). */
export const EVERGREEN_KPI_SAMPLE_FILTER = `strategy_type IS DISTINCT FROM '${EVERGREEN_STRATEGY}'`;

/** EDITOR_EVERGREEN_PER_DAY: evergreen posts per channel per day (0 = off; default 1). */
export function evergreenPerDay(env: (k: string) => string | undefined): number {
  const raw = env('EDITOR_EVERGREEN_PER_DAY');
  const n = raw == null || raw.trim() === '' ? DEFAULT_EVERGREEN_PER_DAY : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_EVERGREEN_PER_DAY;
}

/** Is this a post spec the writer (or the code) marked evergreen? */
export const isEvergreenSpec = (spec: unknown): boolean => (spec as any)?.story?.kind === 'evergreen';

/**
 * The agent's publish / lint input with `story.kind = evergreen`: the key (topic) and reason stay, the follow-up,
 * decision and event fields go (an evergreen post continues no story and announces nothing).
 */
export function asEvergreenInput(input: unknown): unknown {
  const i = input as any;
  if (!i || typeof i !== 'object' || !i.spec || typeof i.spec !== 'object' || Array.isArray(i.spec)) return input;
  const st = i.spec.story && typeof i.spec.story === 'object' ? i.spec.story : {};
  const story: Record<string, unknown> = { kind: 'evergreen' };
  if (typeof st.key === 'string') story.key = st.key;
  if (typeof st.reason === 'string') story.reason = st.reason;
  return { ...i, spec: { ...i.spec, story } };
}

const MARKED = new Set(['publish_post', 'lint_post', 'preview_post']);

/** The evergreen run's probe: records the publish errors like every step and marks the post evergreen first. */
export class EvergreenProbe extends PublishProbe {
  override wrap(tools: EditorTool[]): EditorTool[] {
    return super.wrap(tools.map((t) => !MARKED.has(t.name) ? t : { ...t, execute: (input: any, ctx: any) => t.execute(asEvergreenInput(input), ctx) }));
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The slot as the evergreen run sees it: a fixed slot whose topic is the channel's own (the critic judges against it). */
export function evergreenSlot(slot: EditorSlot, card: Pick<EditorCard, 'brief'>): EditorSlot {
  const brief = (card.brief ?? '').trim();
  // Not a live slot any more: the evergreen post needs no fresh feed item.
  const { topicMode: _live, liveSpec: _spec, ...fixed } = slot;
  return {
    ...fixed,
    sourceHints: [], isExperiment: false, ideaId: null,
    topic: `Вічнозелений пост у темі каналу${brief ? ` (${clip(brief, 160)})` : ''}: пояснення, гайд, глосарій або добірка`,
    angle: 'Без привʼязки до дати й новин: пост, що буде корисним і через місяць',
  };
}

/** The writer's instruction for the evergreen run (Ukrainian: the executor's language). */
export function evergreenNote(i: { failure: SlotFailure; original: Pick<EditorSlot, 'topic' | 'format'>; format: string }): string {
  const why = i.failure.kind === 'critic_reject' ? 'критик відхилив пост' : i.failure.kind === 'lint' ? 'пост не пройшов lint' : `пост не пройшов перевірку (${i.failure.code})`;
  return [
    `## Запасний крок (evergreen): основний пост слота («${clip(i.original.topic, 120)}») не вийшов — ${why}.`,
    'Напиши ВІЧНОЗЕЛЕНИЙ пост у темі каналу: пояснення, гайд, глосарій або добірка. Не новина і не продовження історії.',
    '- Тему бери з тематики каналу; не повторюй теми з блоку «Активні історії» (evergreen-теми — 30 днів), інакше story_repeat.',
    '- Без привʼязки до дати: жодних «щойно», «сьогодні», «новина», «вчора», «на цьому тижні», дат подій і «нещодавно вийшло».',
    '- Числа й твердження — лише з джерела, яке ти прочитав (source.url або library_ref). Без джерела — жодних конкретних чисел, відсотків, сум, дат.',
    '- Якщо писав за сторінкою — дай її в source.url (довідка, документація, енциклопедія), не головну сторінку сайту.',
    '- story: { kind: "evergreen", key: "тема-латиницею" } — код усе одно позначить пост як evergreen.',
    `- Формат: ${i.format}. Зображення — лише постер з ai_posters, якщо його use_for збігається з темою поста; інакше без зображення.`,
    '- Це останній запасний крок слота: якщо гідної теми немає — skip_slot з причиною.',
  ].join('\n');
}

/** The Inbox note of a slot an evergreen post filled: the main post's reason stays visible. */
export function evergreenInboxItem(i: { slot: EditorSlot; card: Pick<EditorCard, 'channelKey' | 'timezone'>; failure: SlotFailure; status: string; agentId?: string | null }): InboxItemInput & { refType: string; refId: string } {
  const ref = `telegram:${i.card.channelKey}`;
  return {
    agentId: i.agentId ?? null, kind: EVERGREEN_INBOX_KIND, severity: 'info', refType: 'editor_slot', refId: i.slot.id,
    title: `Evergreen post filled the ${localTimeLabel(i.slot.scheduledAt, i.card.timezone)} slot on ${ref}`,
    body: [
      `The main post of the slot ("${clip(i.slot.topic, 120)}") did not go out: ${clip(i.failure.reason, 400)}`,
      `An evergreen post (no date anchor) took its place (${i.status.replace(/_/g, ' ')}); every fallback step is on the slot.`,
      'Several evergreen posts a week mean the channel lacks fresh sources: check the feeds and the critic notes on /app/editor.',
    ].join('\n'),
  };
}

/** The local-day window of a slot in the channel's zone. */
function dayWindow(slot: EditorSlot, tz: string): [Date, Date] {
  const start = zonedToUtc(localDate(slot.scheduledAt, tz), '00:00', tz);
  return [start, new Date(start.getTime() + 86_400_000)];
}

/**
 * SQL: the channel's evergreen posts and evergreen runs of a local day — a written slot whose spec is evergreen, or a
 * slot whose fallback ladder ran an evergreen step (even a rejected one). The slot being laddered is left out.
 */
export const EVERGREEN_DAY_COUNT_SQL = `SELECT COUNT(*)::int AS n FROM editor_slots s
  WHERE s.channel_key = $1 AND s.kind = 'content' AND s.resource_ref IS NULL AND s.id <> $4::uuid
    AND s.scheduled_at >= $2 AND s.scheduled_at < $3
    AND ((s.status IN ('published','shadowed','awaiting_approval','approved') AND s.post_spec->'story'->>'kind' = 'evergreen')
      OR jsonb_path_exists(COALESCE(s.fallback, '{}'::jsonb), '$.steps[*] ? (@.step == "evergreen" && @.outcome != "unavailable")'))`;

export interface EvergreenStepDeps {
  pool:    Pick<Pool, 'query'>;
  plans:   Pick<EditorPlansRepository, 'getSlot'>;
  /** EDITOR_EVERGREEN_PER_DAY (0 = off). */
  perDay:  number;
  inbox?:  Pick<OwnerInbox, 'postOnce'>;
  log?:    (m: string) => void;
}

/** `EditorRunnerDeps.fallbackEvergreen`: the cap, the writer's instruction, the run and the Inbox note. */
export class EvergreenStep {
  constructor(private readonly d: EvergreenStepDeps) {}

  /** Evergreen posts / runs of the slot's channel on the slot's local day. */
  async usedToday(slot: EditorSlot, card: Pick<EditorCard, 'channelKey' | 'timezone'>): Promise<number> {
    const [from, to] = dayWindow(slot, card.timezone);
    const { rows } = await this.d.pool.query(EVERGREEN_DAY_COUNT_SQL, [card.channelKey, from, to, slot.id]);
    return Number(rows[0]?.n ?? 0);
  }

  async run(req: EvergreenRequest): Promise<AgentLoopResult | null> {
    const { slot, card, failure } = req;
    if (this.d.perDay <= 0) return null;
    if (slot.resourceRef && parseResourceRef(slot.resourceRef)?.platform !== 'telegram') return null;
    if (slot.treatment === 'duplicate' || slot.treatment === 'adapt') return null;
    if (await this.usedToday(slot, card) >= this.d.perDay) return null;
    const res = await req.run({ slot: evergreenSlot(slot, card), note: evergreenNote({ failure, original: slot, format: slot.format }) });
    const after = await this.d.plans.getSlot(slot.id).catch(() => null);
    if (after && isRescued(after.status) && isEvergreenSpec(after.postSpec) && this.d.inbox) {
      await this.d.inbox.postOnce(evergreenInboxItem({ slot, card, failure, status: after.status }))
        .catch((e) => this.d.log?.(`evergreen inbox note failed: ${errText(e)}`));
    }
    return res;
  }
}
