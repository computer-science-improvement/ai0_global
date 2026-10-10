import { createHash } from 'crypto';
import type { AgentBudget } from '../harness/budget.service';
import { isToolError, type EditorTool, type ToolContext, type ToolError } from '../harness/tool';
import type { InboxItemInput } from '../agents/owner-inbox';
import type { EditorPlansRepository } from '../repo/editor-plans.repository';
import type { VoicePrefs } from '../post/slop-lint';
import type { EditorRole } from '../llm/llm.types';
import { criticLine, slopCodes, type StoredCritic } from './critic';
import { CRITIC_TIMEOUT_MS, type CriticRequest, type CriticService } from './critic.service';

/** Publish tools wait for the critic (two attempts) and then for the send itself. */
export const PUBLISH_TOOL_TIMEOUT_MS = 2 * CRITIC_TIMEOUT_MS + 60_000;

/** Extra turns the AgentLoop grants after a `critic_revise`, so a revise near the step limit still ends in publish or skip. */
export const CRITIC_REVISE_GRANT_STEPS = 2;

/** What a publish tool hands the critic: the reader-visible text, the spec and the lint warnings (slop ones are kept). */
export interface CriticPost {
  text:     string;
  spec:     unknown;
  format:   string;
  warnings: ReadonlyArray<{ code: string; message: string }>;
}

/**
 * The gate's answer to a publish tool:
 * - `proceed`: store / publish / create the approval card (the verdict is already on the slot);
 * - `revise`: return `result` (a tool error with the notes) — the executor rewrites once;
 * - `halt`: the slot is already `skipped` (reject) or `failed` (critic error); return `result` to end the run.
 */
export type CriticGateOutcome =
  | { kind: 'proceed'; critic: StoredCritic }
  | { kind: 'revise'; critic: StoredCritic; result: ToolError & { _grantSteps: number } }
  | { kind: 'halt'; critic: StoredCritic; result: Record<string, unknown> };

export interface CriticGateDeps {
  critic: Pick<CriticService, 'review'>;
  plans:  Pick<EditorPlansRepository, 'updateSlot'>;
  inbox?: (i: InboxItemInput) => Promise<unknown>;
  /** Text of a library / data row behind `library_ref` (the critic's source excerpt). */
  libraryText?: (ref: string) => Promise<string | null>;
}

/** The slot and resource context of one executor run (built by the runner). */
export interface CriticGateContext {
  slotId:       string;
  channelKey:   string;
  mode:         'live' | 'shadow' | 'approve';
  resourceRef:  string;
  platform:     string;
  topic?:       string | null;
  angle?:       string | null;
  card?:        { models?: Partial<Record<EditorRole, string>>; dailyBudgetUsd?: number | null } | null;
  voice:        VoicePrefs;
  brief?:       string | null;
  profile?:     string | null;
  formatPrefs?: string | null;
  playbook?:    string | null;
  agent?:       AgentBudget | null;
  /** The orchestrator the Inbox item belongs to. */
  inboxAgentId?: string | null;
}

const SOURCE_CAP = 4_000;

const normUrl = (u: string): string => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
const hashOf = (v: unknown): string => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');

/** The gate of one run, kept in ctx.extras.critic. */
export function criticGateOf(ctx: ToolContext): CriticGate | null {
  const g = ctx.extras?.critic;
  return g instanceof CriticGate ? g : null;
}

/**
 * Spec 034 FR-004: the pre-publish critic of one executor run. Publish tools
 * call `check` after every deterministic guard passed and before anything is
 * stored, sent or put up for approval:
 *
 * - pass → proceed;
 * - revise (first pass) → a `critic_revise` tool error with the notes; the
 *   executor rewrites exactly once in the same run (the loop grants 2 turns);
 * - revise (second pass) → live / shadow: rejected; approval: proceeds to the
 *   owner with the notes on the card (`final: true`);
 * - reject → the slot is skipped (`critic_rejected: …`);
 * - critic error / timeout / blocking cap (after one retry) → live / shadow:
 *   the slot fails with an Inbox entry, nothing is published; approval: the
 *   card is created with `verdict: 'error'` (the owner decides; never auto-approved).
 *
 * The verdict, scores and notes are written to `editor_slots.critic`.
 */
export class CriticGate {
  private passes = 0;
  private first: StoredCritic | null = null;
  /** The spec that already proceeded: a retry of the same post after a later error is not reviewed again. */
  private proceeded: { hash: string; critic: StoredCritic } | null = null;
  private readonly fetched = new Map<string, string>();

  constructor(private readonly d: CriticGateDeps, readonly c: CriticGateContext) {}

  /** Wrap the run's read tools so the critic sees the source text the executor read (web_fetch, fetch_feed). */
  wrapTools(tools: EditorTool[]): EditorTool[] {
    return tools.map((t) => {
      if (t.name !== 'web_fetch' && t.name !== 'fetch_feed') return t;
      return {
        ...t,
        execute: async (input: any, ctx: ToolContext) => {
          const out = await t.execute(input, ctx);
          try { if (!isToolError(out)) this.remember(t.name, input, out); } catch { /* capture is best-effort */ }
          return out;
        },
      };
    });
  }

  private remember(tool: string, input: any, out: any): void {
    if (tool === 'web_fetch') {
      const text = [out?.title, out?.description, out?.text].filter((x) => typeof x === 'string' && x.trim()).join('\n');
      for (const u of [input?.url, out?.url]) if (typeof u === 'string' && text) this.fetched.set(normUrl(u), text.slice(0, SOURCE_CAP));
      return;
    }
    for (const it of Array.isArray(out?.items) ? out.items : []) {
      if (typeof it?.link !== 'string') continue;
      const text = [it.title, it.date ? `(${it.date})` : null, it.snippet].filter(Boolean).join(' ');
      if (text && !this.fetched.has(normUrl(it.link))) this.fetched.set(normUrl(it.link), text.slice(0, SOURCE_CAP));
    }
  }

  private async source(spec: any): Promise<CriticRequest['source']> {
    const url: string | null = typeof spec?.source?.url === 'string' ? spec.source.url : null;
    let excerpt = url ? this.fetched.get(normUrl(url)) ?? null : null;
    if (!excerpt && typeof spec?.library_ref === 'string' && this.d.libraryText) {
      excerpt = await this.d.libraryText(spec.library_ref).catch(() => null);
    }
    if (!url && !excerpt) return null;
    return { url: url ?? (typeof spec?.library_ref === 'string' ? spec.library_ref : null), excerpt: excerpt ? excerpt.slice(0, SOURCE_CAP) : null };
  }

  async check(post: CriticPost): Promise<CriticGateOutcome> {
    const hash = hashOf(post.spec);
    if (this.proceeded?.hash === hash) return { kind: 'proceed', critic: this.proceeded.critic };

    const slop = slopCodes(post.warnings);
    const r = await this.d.critic.review({
      channelKey: this.c.channelKey, slotId: this.c.slotId, mode: this.c.mode, card: this.c.card ?? null,
      resourceRef: this.c.resourceRef, platform: this.c.platform, format: post.format, topic: this.c.topic, angle: this.c.angle,
      text: post.text, spec: post.spec, voice: this.c.voice, brief: this.c.brief, profile: this.c.profile,
      formatPrefs: this.c.formatPrefs, playbook: this.c.playbook, source: await this.source(post.spec),
      slopWarnings: post.warnings.filter((w) => slop.includes(w.code)).map((w) => ({ code: w.code, message: w.message })),
      previous: this.first, agent: this.c.agent ?? null,
    });
    this.passes++;
    const history = this.first ? [{
      verdict: this.first.verdict, scores: this.first.scores, notes: this.first.notes, reason: this.first.reason, pass: this.first.pass, at: this.first.at,
    }] : undefined;

    if (!r.ok) {
      const critic: StoredCritic = {
        verdict: 'error', scores: null, notes: `Критик не відповів: ${r.error}`, model_verdict: null, reason: r.error,
        pass: this.passes, slop_warnings: slop, model: null, run_id: r.runIds.at(-1) ?? null, cost_usd: Number(r.costUsd.toFixed(6)),
        at: new Date().toISOString(), ...(history ? { history } : {}),
      };
      if (this.c.mode === 'approve') {
        // The owner reviews every waiting post anyway: the card shows the critic error and is never auto-approved.
        return this.proceed(hash, critic);
      }
      await this.d.plans.updateSlot(this.c.slotId, { status: 'failed', error: `critic_failed: ${r.error}`.slice(0, 500), critic });
      await this.inbox(
        `Critic unavailable: a ${this.c.platform} post was held`,
        `The pre-publish critic did not answer for slot ${this.c.slotId} (${this.c.resourceRef}): ${r.error}. `
        + 'Nothing was published; the slot is marked failed. Check the critic model and the budget caps on /app/models and /app/spend.',
      );
      return { kind: 'halt', critic, result: { ok: true, failed: 'critic_failed', details: r.error } };
    }

    const critic: StoredCritic = { ...r.critic, ...(history ? { history } : {}) };
    if (critic.verdict === 'pass') return this.proceed(hash, critic);

    if (critic.verdict === 'revise' && this.passes === 1) {
      this.first = critic;
      await this.d.plans.updateSlot(this.c.slotId, { critic });
      const after = this.c.mode === 'approve'
        ? 'Якщо й друга версія не пройде — пост піде власнику разом із цими зауваженнями.'
        : 'Друге «revise» пропускає слот.';
      return {
        kind: 'revise', critic,
        result: {
          error: 'critic_revise',
          details: {
            notes: critic.notes, scores: critic.scores, reason: critic.reason,
            instruction: `Критик просить переписати пост. Виправ саме ці зауваження і виклич ${this.c.platform === 'telegram' ? 'publish_post' : 'publish_platform_post'} ще раз — це єдина спроба. ${after} Якщо пост не врятувати — skip_slot з причиною.`,
          },
          _grantSteps: CRITIC_REVISE_GRANT_STEPS,
        },
      };
    }

    if (critic.verdict === 'revise' && this.c.mode === 'approve') {
      return this.proceed(hash, { ...critic, final: true });
    }

    // reject, or a second revise in live / shadow.
    const second = critic.verdict === 'revise';
    const stored: StoredCritic = second ? { ...critic, reason: `second_revise: ${critic.reason}` } : critic;
    await this.d.plans.updateSlot(this.c.slotId, {
      status: 'skipped', error: `critic_rejected: ${second ? 'second revise — ' : ''}${criticLine(critic)}`.slice(0, 500), critic: stored,
    });
    return { kind: 'halt', critic: stored, result: { ok: true, skipped: true, critic_rejected: true, verdict: critic.verdict, notes: critic.notes } };
  }

  private async proceed(hash: string, critic: StoredCritic): Promise<CriticGateOutcome> {
    await this.d.plans.updateSlot(this.c.slotId, { critic });
    this.proceeded = { hash, critic };
    return { kind: 'proceed', critic };
  }

  private async inbox(title: string, body: string): Promise<void> {
    if (!this.d.inbox) return;
    try {
      await this.d.inbox({
        agentId: this.c.inboxAgentId ?? null, kind: 'critic_failed', severity: 'action', title, body, refType: 'slot', refId: this.c.slotId,
        alert: { title: `🧐 Критик не відповів — пост у ${this.c.resourceRef} не вийшов`, body: `Слот ${this.c.slotId}: ${body.slice(0, 300)}` },
      });
    } catch { /* the failed slot is what matters */ }
  }
}

/** A short summary for a publish tool's success result (the trace shows it next to the step). */
export function criticSummary(c: StoredCritic): Record<string, unknown> {
  return { verdict: c.verdict, scores: c.scores, notes: c.notes, pass: c.pass, ...(c.final ? { final: true } : {}) };
}
