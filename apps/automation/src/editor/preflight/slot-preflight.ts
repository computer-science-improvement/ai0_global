import type { ContentLedger, LedgerVerdict } from '../../data/content-ledger';
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
 *
 * Spec 068 FR-006: a library slot is judged too. Its material hints are URLs, `data://` / `library://` rows and
 * `library:<table>[/<category>]` datasets (`series:` and `directive:` are labels, not material; any other kind — `feed:`,
 * `api:`, `network_highlights:` — cannot be judged here and counts as usable). A row that is missing, inactive or lacks what
 * its dataset needs for posting (`post_requires`) is `preflight_no_material`; a spent one is `preflight_source_used`; an
 * empty dataset on the resource is `preflight_no_material`. The slot fails only when every material hint fails.
 * FR-007: `assessPlanned` runs the same checks on a slot the planner is about to store, without the swap.
 */

export const PREFLIGHT_CODES = ['preflight_no_material', 'preflight_source_used', 'preflight_stale', 'preflight_host_blocked', 'preflight_format_unavailable'] as const;
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

/** What the pre-flight needs to judge library material (the data store); optional: without it a row / dataset hint cannot be judged and passes. */
export interface PreflightMaterial {
  /** The store row behind a `data://` or `library://` ref (a legacy alias resolves through legacy_ref); null = no such row. */
  row(ref: string): Promise<{ active: boolean; postable: boolean; missing: string[] } | null>;
  /** Postable rows of a dataset not yet used on the resource; null = unknown (not a dataset, or it could not be counted). */
  unposted(resourceRef: string, dataset: string): Promise<number | null>;
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
  /** Spec 068 FR-006: library rows and datasets. */
  material?: PreflightMaterial;
  hosts:   Pick<HostFailures, 'blocked'>;
  ideas:   PreflightIdeas;
  /** Re-topic a slot from another idea (EditorPlansRepository.retopicSlot). */
  retopic: (slotId: string, patch: { ideaId: string; topic: string; angle: string | null; sourceHints: string[]; note: string }) => Promise<void>;
  env:     (key: string) => string | undefined;
  /** The freshness limit in hours of the slot's resource (the same one the critic and the audit use); null = none. */
  freshnessHours: (slot: Pick<EditorSlot, 'channelKey' | 'resourceRef'>, card: EditorCard) => Promise<number | null>;
  now?:    () => Date;
  log?:    (msg: string) => void;
}

const isHttp = (s: string): boolean => /^https?:\/\//i.test(s.trim());
const MAX_SWAP_CANDIDATES = 30;

/** Labels the planner and the series guard add to a slot: not material, left out before the checks. */
const LABEL_HINT = /^(series|directive):/i;
const ROW_HINT = /^(data|library):\/\//i;
/** `library:<table>` or `library:<table>/<category>` (a dataset, not a row). */
const DATASET_HINT = /^library:([a-z][a-z0-9_]*)(?:\/.*)?$/i;

/** The slot as the plan-time check sees it: what a planned (not yet stored) slot carries. */
export type PlannedSlotLike = Pick<EditorSlot, 'channelKey' | 'format' | 'sourceHints'>
  & Partial<Pick<EditorSlot, 'id' | 'resourceRef' | 'topicMode' | 'ideaId' | 'seriesName' | 'kind' | 'promo' | 'treatment'>>;

/** Why a ledger hit stops a source, in Ukrainian (what the executor's skip reason and the planner's refusal say). */
export function usedWhy(hit: Extract<LedgerVerdict, { used: true }>): string {
  const when = hit.at ? ` ${hit.at.toISOString().slice(0, 10)}` : '';
  const where = hit.slotId ? ` у слоті ${hit.slotId}` : '';
  if (hit.status === 'passed') return 'пропущене в цьому колі — з нього не вийшов пост; повернеться в наступному колі'; // spec 071
  return hit.status === 'waiting' ? 'уже чекає на публікацію' : hit.status === 'error' ? 'позначене як непридатне' : `уже використано${when}${where}`;
}

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
    // A missing format is not cured by another idea of the same format; a series slot has its own source rule; a slot that carries
    // a manager directive (`directive:<id>`, an experiment quota) would lose the hint and the angle in a swap, so it fails instead.
    if (problem.code === 'preflight_format_unavailable' || !idea || slot.seriesName || (slot.sourceHints ?? []).some((h) => /^directive:/i.test(h.trim()))) {
      return this.fail(slot, idea, problem);
    }
    const swap = await this.swap(slot, card, idea);
    if (!swap) return this.fail(slot, idea, problem);
    await this.d.ideas.release(idea.id, 'rejected', `preflight: ${problem.reason}`).catch(() => {});
    return { ok: true, slot: swap.slot, swapped: { fromIdeaId: idea.id, toIdeaId: swap.idea.id, problem } };
  }

  private async fail(slot: EditorSlot, _idea: IdeaRow | null, problem: PreflightProblem): Promise<PreflightResult> {
    return { ok: false, code: problem.code, reason: problem.reason, problem };
  }

  /** The first failing check of a slot's material (null = it may run). `idea` is the pool idea behind `sources`, when there is one. */
  private async assess(slot: PlannedSlotLike, card: EditorCard, idea: IdeaRow | null, sources: string[]): Promise<PreflightProblem | null> {
    const fmt = formatAvailable(slot.format, this.d.env);
    if (!fmt.ok) return { code: 'preflight_format_unavailable', reason: fmt.reason };
    // A live slot picks its item from the feeds at run time (the live scan already skips an empty feed).
    if (slot.topicMode === 'live') return null;
    const all = sources.map((s) => s.trim()).filter((s) => s && !LABEL_HINT.test(s));
    const material = all.filter((h) => isHttp(h) || ROW_HINT.test(h) || DATASET_HINT.test(h));
    // Any other kind (feed:, api:, network_highlights:) cannot be judged here, so the rest does not stop the slot.
    if (!material.length || material.length < all.length) return null;

    const ref = slot.resourceRef ?? `telegram:${slot.channelKey}`;
    const limit = material.some(isHttp) ? await this.d.freshnessHours(slot, card).catch(() => null) : null;
    const problems: PreflightProblem[] = [];
    for (const hint of material) {
      const p = isHttp(hint) ? await this.assessUrl(hint, ref, slot, idea, limit)
        : ROW_HINT.test(hint) ? await this.assessRow(hint, ref, slot)
        : await this.assessDataset(DATASET_HINT.exec(hint)![1], ref);
      if (!p) return null; // one usable source is enough: the executor picks it
      problems.push(p);
    }
    // All sources are out: report the most informative reason (nothing to post, spent, stale, then blocked).
    const order: PreflightCode[] = ['preflight_no_material', 'preflight_source_used', 'preflight_stale', 'preflight_host_blocked'];
    problems.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    return problems[0];
  }

  /**
   * A `data://<dataset>/<id>` or `library://<table>/<id>` row: it must exist, be active and carry what its dataset needs for
   * posting (`post_requires`); then the content ledger says whether it was already used (or waits) on this resource.
   * Without the data store wired the row cannot be judged and passes. (Spec 071 adds its round text beside the used reason.)
   */
  private async assessRow(hint: string, ref: string, slot: PlannedSlotLike): Promise<PreflightProblem | null> {
    if (!this.d.material) return null;
    const row = await this.d.material.row(hint);
    if (!row) return { code: 'preflight_no_material', reason: `рядок ${hint} не знайдено` };
    if (!row.active) return { code: 'preflight_no_material', reason: `рядок ${hint} не активний` };
    if (!row.postable) return { code: 'preflight_no_material', reason: `рядок ${hint} без ${row.missing.length ? row.missing.join(', ') : 'потрібних полів'}` };
    const hit = await this.d.ledger.check(ref, hint, { waiting: true, excludeSlotId: slot.id });
    return hit.used ? { code: 'preflight_source_used', reason: `рядок ${hint} ${usedWhy(hit)}` } : null;
  }

  /** `library:<table>[/<category>]`: the dataset must have a postable row not yet used on this resource (the category is ignored: conservative). */
  private async assessDataset(table: string, ref: string): Promise<PreflightProblem | null> {
    if (!this.d.material) return null;
    const n = await this.d.material.unposted(ref, table);
    return n === 0 ? { code: 'preflight_no_material', reason: `у датасеті ${table} немає непублікованих рядків для ${ref}` } : null;
  }

  private async assessUrl(url: string, ref: string, slot: PlannedSlotLike, idea: IdeaRow | null, limit: number | null): Promise<PreflightProblem | null> {
    const hit = await this.d.ledger.check(ref, url, { waiting: true, excludeSlotId: slot.id });
    if (hit.used) return { code: 'preflight_source_used', reason: `джерело ${url.split('#')[0]} ${usedWhy(hit)}` };
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

  /**
   * Spec 068 FR-007: the same checks on a slot the planner is about to store (no idea swap, nothing is written). A reserved,
   * promo or derived slot has a fixed post and is not judged. Never throws: a failing check lets the plan through.
   */
  async assessPlanned(slot: PlannedSlotLike, card: EditorCard): Promise<PreflightProblem | null> {
    try {
      if (slot.kind === 'reserved' || slot.promo || slot.treatment === 'duplicate' || slot.treatment === 'adapt') return null;
      const idea = slot.ideaId ? await this.d.ideas.idea(slot.ideaId) : null;
      return await this.assess(slot, card, idea, slot.sourceHints ?? []);
    } catch (err: any) {
      this.d.log?.(`preflight (plan) ${slot.channelKey}: ${err?.message ?? err} — the slot is not judged`);
      return null;
    }
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
