import type { ContentLedger } from '../../data/content-ledger';
import type { EditorCard } from '../card';
import type { EditorSlot } from '../repo/editor-plans.repository';
import type { IdeaRow } from '../network/network.repository';
import type { HostFailures } from '../net/host-failures';
import { hostOf } from '../net/host-failures';
import { dateFromUrl, sourceAgeHours } from '../post/dates';

/**
 * Spec 061 FR-001: the slot pre-flight. What code already knows is checked before the executor is paid to discover it:
 * the slot's source is not spent in the content ledger (reference documents excepted, FR-002), is not older than the
 * channel's freshness limit, does not sit on a host blocked in `source_host_failures`, and the slot's format can be
 * produced here (a carousel needs slide hosting). A slot that fails is given one swap — the next accepted idea of the same
 * orchestrator that passes all four checks and fits the slot's resource and format — else it is skipped with a
 * `preflight_<reason>` code and a Ukrainian reason line. No LLM call is made either way.
 */

export const PREFLIGHT_CODES = ['preflight_source_used', 'preflight_stale', 'preflight_host_blocked', 'preflight_format_unavailable'] as const;
export type PreflightCode = typeof PREFLIGHT_CODES[number];

export interface PreflightProblem { code: PreflightCode; reason: string }

export type PreflightResult =
  | { ok: true; slot: EditorSlot; swapped?: { fromIdeaId: string | null; toIdeaId: string; problem: PreflightProblem } }
  | { ok: false; code: PreflightCode; reason: string; problem: PreflightProblem };

/** Formats that need slide hosting (Supabase storage): the Telegram carousel and the native carousels of the other platforms. */
const HOSTED_FORMAT = /carousel/i;

/** Can this format be produced here? (Today only the carousel depends on configuration: SUPABASE_CAROUSEL_BUCKET et al.) */
export function formatAvailable(format: string, env: (key: string) => string | undefined): { ok: true } | { ok: false; reason: string } {
  if (HOSTED_FORMAT.test(format)) {
    const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'SUPABASE_CAROUSEL_BUCKET'].filter((k) => !env(k)?.trim());
    if (missing.length) return { ok: false, reason: `формат «${format}» потребує хостингу слайдів, а ${missing.join(', ')} не задано` };
  }
  return { ok: true };
}

/** What the pre-flight needs from the idea pool. */
export interface PreflightIdeas {
  idea(id: string): Promise<IdeaRow | null>;
  /** Accepted ideas of one orchestrator, newest first. */
  accepted(agentId: string, limit: number): Promise<IdeaRow[]>;
  /** accepted → planned; false when somebody else took it first. */
  claim(ideaId: string): Promise<boolean>;
  /** The idea a slot gave up: back to the pool or closed, with the reason. */
  release(ideaId: string, to: 'accepted' | 'rejected', reason: string): Promise<void>;
}

export interface PreflightDeps {
  ledger:  Pick<ContentLedger, 'check'>;
  hosts:   Pick<HostFailures, 'blocked'>;
  ideas:   PreflightIdeas;
  /** Re-topic a slot from another idea (EditorPlansRepository.retopicSlot). */
  retopic: (slotId: string, patch: { ideaId: string; topic: string; angle: string | null; sourceHints: string[]; note: string }) => Promise<void>;
  env:     (key: string) => string | undefined;
  /** The freshness limit in hours of the slot's resource (the same one the critic and the audit use); null = none. */
  freshnessHours: (slot: EditorSlot, card: EditorCard) => Promise<number | null>;
  now?:    () => Date;
  log?:    (msg: string) => void;
}

const isHttp = (s: string): boolean => /^https?:\/\//i.test(s.trim());
const MAX_SWAP_CANDIDATES = 30;

export class SlotPreflight {
  constructor(private readonly d: PreflightDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /**
   * Checks the slot and swaps its idea once if it fails. Never throws: a failing check passes the slot on to the executor
   * (the pre-flight saves money, it must not stop a post by its own fault).
   */
  async run(slot: EditorSlot, card: EditorCard): Promise<PreflightResult> {
    try {
      return await this.runChecked(slot, card);
    } catch (err: any) {
      this.d.log?.(`preflight ${slot.id}: ${err?.message ?? err} — the slot runs`);
      return { ok: true, slot };
    }
  }

  private async runChecked(slot: EditorSlot, card: EditorCard): Promise<PreflightResult> {
    // A reserved (sponsored) or promo slot has a fixed post; a derived slot is formatted from its source slot's post.
    if (slot.kind === 'reserved' || slot.promo || slot.treatment === 'duplicate' || slot.treatment === 'adapt') return { ok: true, slot };
    const idea = slot.ideaId ? await this.d.ideas.idea(slot.ideaId) : null;
    const problem = await this.assess(slot, card, idea, slot.sourceHints ?? []);
    if (!problem) return { ok: true, slot };
    // A missing format is not cured by another idea of the same format; a series slot has its own source rule.
    if (problem.code === 'preflight_format_unavailable' || !idea || slot.seriesName) return this.fail(slot, idea, problem);
    const swap = await this.swap(slot, card, idea);
    if (!swap) return this.fail(slot, idea, problem);
    await this.d.ideas.release(idea.id, 'rejected', `preflight: ${problem.reason}`).catch(() => {});
    return { ok: true, slot: swap.slot, swapped: { fromIdeaId: idea.id, toIdeaId: swap.idea.id, problem } };
  }

  private async fail(slot: EditorSlot, _idea: IdeaRow | null, problem: PreflightProblem): Promise<PreflightResult> {
    return { ok: false, code: problem.code, reason: problem.reason, problem };
  }

  /** The first failing check of a slot's material (null = it may run). `idea` is the pool idea behind `sources`, when there is one. */
  private async assess(slot: EditorSlot, card: EditorCard, idea: IdeaRow | null, sources: string[]): Promise<PreflightProblem | null> {
    const fmt = formatAvailable(slot.format, this.d.env);
    if (!fmt.ok) return { code: 'preflight_format_unavailable', reason: fmt.reason };
    // A live slot picks its item from the feeds at run time (the live scan already skips an empty feed).
    if (slot.topicMode === 'live') return null;
    const all = sources.map((s) => s.trim()).filter(Boolean);
    const urls = all.filter(isHttp);
    // Library refs and other non-URL sources cannot be judged here: the publish guards still stop a repeat.
    if (!urls.length || urls.length < all.length) return null;

    const ref = slot.resourceRef ?? `telegram:${slot.channelKey}`;
    const limit = await this.d.freshnessHours(slot, card).catch(() => null);
    const problems: PreflightProblem[] = [];
    for (const url of urls) {
      const p = await this.assessUrl(url, ref, slot, idea, limit);
      if (!p) return null; // one usable source is enough: the executor picks it
      problems.push(p);
    }
    // All sources are out: report the most informative reason (spent, then stale, then blocked).
    const order: PreflightCode[] = ['preflight_source_used', 'preflight_stale', 'preflight_host_blocked'];
    problems.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    return problems[0];
  }

  private async assessUrl(url: string, ref: string, slot: EditorSlot, idea: IdeaRow | null, limit: number | null): Promise<PreflightProblem | null> {
    const hit = await this.d.ledger.check(ref, url, { waiting: true, excludeSlotId: slot.id });
    if (hit.used) {
      const when = hit.at ? ` ${hit.at.toISOString().slice(0, 10)}` : '';
      const where = hit.slotId ? ` у слоті ${hit.slotId}` : '';
      const what = hit.status === 'waiting' ? 'уже чекає на публікацію' : hit.status === 'error' ? 'позначене як непридатне' : `уже використано${when}${where}`;
      return { code: 'preflight_source_used', reason: `джерело ${url.split('#')[0]} ${what}` };
    }
    if (limit != null) {
      const day = dateFromUrl(url);
      const at = this.now().toISOString();
      const age = day ? sourceAgeHours(day, at) : idea ? sourceAgeHours(idea.createdAt.toISOString(), at) : null;
      if (age != null && age > limit) {
        return { code: 'preflight_stale', reason: `джерело ${url} застаріло: ${Math.round(age)} год при межі ${limit} год${day ? '' : ' (від появи ідеї)'}` };
      }
    }
    const host = hostOf(url);
    const block = host ? await this.d.hosts.blocked(host, 'page') : null;
    // A one-hour timeout block is a slow site, not a dead one (spec 061 FR-004): it must not reject the idea, so the slot goes on.
    if (block && block.reason !== 'timeout') {
      return { code: 'preflight_host_blocked', reason: `сайт ${block.host} заблокований до ${block.until.toISOString().slice(0, 16)}Z — джерело ${url} недоступне` };
    }
    return null;
  }

  /** One swap: the next accepted idea of the same orchestrator that passes every check and fits the slot's resource and format. */
  private async swap(slot: EditorSlot, card: EditorCard, from: IdeaRow): Promise<{ idea: IdeaRow; slot: EditorSlot } | null> {
    const ref = slot.resourceRef ?? `telegram:${slot.channelKey}`;
    const now = this.now();
    const pool = (await this.d.ideas.accepted(from.agentId, MAX_SWAP_CANDIDATES))
      .filter((i) => i.id !== from.id && i.expiresAt.getTime() > now.getTime()
        && i.variants.some((v) => v.resource_ref === ref && v.format === slot.format));
    for (const cand of pool) {
      if (await this.assess(slot, card, cand, cand.sources)) continue;
      if (!(await this.d.ideas.claim(cand.id))) continue;
      const note = `preflight_swap: ідея «${from.title.slice(0, 60)}» → «${cand.title.slice(0, 60)}»`;
      await this.d.retopic(slot.id, { ideaId: cand.id, topic: cand.title, angle: cand.angle, sourceHints: cand.sources, note });
      return { idea: cand, slot: { ...slot, ideaId: cand.id, topic: cand.title, angle: cand.angle, sourceHints: cand.sources, lintWarnings: [...(slot.lintWarnings ?? []), note] } };
    }
    return null;
  }
}

/** The slot error of a pre-flight skip: the code, then the Ukrainian reason line (what the skip classifiers and the Inbox read). */
export function preflightSkipError(code: PreflightCode, reason: string): string {
  return `${code}: ${reason}`.slice(0, 500);
}
