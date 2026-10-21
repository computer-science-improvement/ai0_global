import type { EditorRole } from '../llm/llm.types';
import type { SlotPreview } from '../roles/preview-run';
import { localDate, zonedToUtc } from '../roles/time';
import type { SkillOverride } from '../skills/skill-overlay';
import type { Agent } from './agent.types';
import type { AgentsRepository } from './agents.repository';
import type { InboxItemInput, OwnerInbox } from './owner-inbox';
import { SELF_EDIT_REVIEW_DAYS } from './agent-skill-tools';
import type { PairwiseJudge } from './skill-probe-judge';
import type { ProbeSlotRef } from './skill-probe-samples';
import type { ProbeJudgement, ProbeRecord, ProbeSample, ProbeSide, ProbeVerdict, SideCritic } from './skill-probe.types';
import type { SkillStore, SkillVersionRow } from './skill-store';

export interface ProbeSettings {
  /** Probes per Kyiv day; 0 = probes are off. */
  perDay:    number;
  /** Recent posts a probe re-writes with the old and the new text. */
  samples:   number;
  /** One probe's cap (the dry runs and the judge), USD. */
  budgetUsd: number;
}

const num = (v: string | undefined, d: number, min: number, max: number, int = false): number => {
  const n = v == null || v.trim() === '' ? NaN : Number(v);
  const x = Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
  return int ? Math.round(x) : x;
};

/** The three settings (catalog.ts), read on every use so a change applies at once. */
export function probeSettings(env: (key: string) => string | undefined): ProbeSettings {
  return {
    perDay: num(env('SKILL_PROBE_PER_DAY'), 3, 0, 20, true),
    samples: num(env('SKILL_PROBE_SAMPLES'), 3, 1, 5, true),
    budgetUsd: num(env('SKILL_PROBE_BUDGET_USD'), 0.3, 0, 2),
  };
}

// ── the decision (code) ─────────────────────────────────────────────────────

/** Higher is better: what the critic made of the post. */
export const CRITIC_LADDER: Record<SideCritic, number> = { reject: 0, revise: 1, pass_with_edits: 2, pass: 3 };
const bad = (c: SideCritic) => c === 'reject' || c === 'revise';

export interface ProbeDecision {
  verdict: Extract<ProbeVerdict, 'adopted' | 'rejected' | 'inconclusive' | 'unprobed'>;
  reason:  string;
}

export const probeTally = (samples: ProbeSample[]) => ({
  wins: samples.filter((s) => s.judge.better === 'new').length,
  losses: samples.filter((s) => s.judge.better === 'old').length,
  ties: samples.filter((s) => s.judge.better === 'same').length,
});

/**
 * Spec 059 step 4. `samples` are the usable pairs (a pair where a side failed is not in it).
 *   reject        — the new side got a reject / revise the old one did not, or lost the judge in a majority;
 *   adopt         — the new side is never worse on the critic ladder, has no new reject, and wins or ties the judge in a
 *                   majority with at least one win;
 *   inconclusive  — anything else, and a probe the budget cut short (it adopts as today, with what was gathered);
 *   unprobed      — no usable pair at all.
 */
export function decideProbe(samples: ProbeSample[], o: { cut?: string | null; dropped?: number } = {}): ProbeDecision {
  const n = samples.length;
  if (!n) {
    return o.cut ? { verdict: 'inconclusive', reason: o.cut } : { verdict: 'unprobed', reason: `no usable pair of posts (${o.dropped ?? 0} dropped)` };
  }
  const { wins, losses, ties } = probeTally(samples);
  const tally = `the new text won ${wins}, tied ${ties}, lost ${losses} of ${n}`;
  if (o.cut) return { verdict: 'inconclusive', reason: `${o.cut}; ${tally}` };
  const newBad = samples.filter((s) => bad(s.new.critic) && !bad(s.old.critic));
  if (newBad.length) {
    return { verdict: 'rejected', reason: `the critic rated the new text's post ${newBad[0].new.critic} where the old text's post was ${newBad[0].old.critic}; ${tally}` };
  }
  if (losses > n / 2) return { verdict: 'rejected', reason: `the judge preferred the old text in most pairs; ${tally}` };
  const neverWorse = samples.every((s) => CRITIC_LADDER[s.new.critic] >= CRITIC_LADDER[s.old.critic]);
  if (neverWorse && wins >= 1 && wins + ties > n / 2) return { verdict: 'adopted', reason: tally };
  return { verdict: 'inconclusive', reason: `${tally}${neverWorse ? '' : '; the critic rated one post of the new text lower'}` };
}

// ── one preview → one side of a sample ──────────────────────────────────────

const PREVIEW_KEEP = 600;

/** A finished dry run as a side of a sample; null = the run gave nothing to compare (failed, skipped, the critic did not answer). */
export function sideOf(p: SlotPreview): ProbeSide | null {
  if (p.status === 'ready') {
    const critic = p.critic?.verdict ?? 'pass';
    if (critic === 'error') return null;
    const text = p.preview ?? '';
    return { critic, lint: p.warnings.length, chars: text.length, preview: text ? text.slice(0, PREVIEW_KEEP) : null };
  }
  // The critic stopped the post (revise twice / reject): there is no text, but the verdict is the evidence.
  if (p.status === 'rejected' && p.critic && (p.critic.verdict === 'reject' || p.critic.verdict === 'revise')) {
    return { critic: p.critic.verdict, lint: 0, chars: 0, preview: null };
  }
  return null;
}

// ── the probe ───────────────────────────────────────────────────────────────

export interface SkillProbeDeps {
  skills:   Pick<SkillStore, 'probing' | 'get' | 'adoptVersion' | 'rejectVersion' | 'probesSince' | 'listForAgent'>;
  agents:   Pick<AgentsRepository, 'get'>;
  inbox:    Pick<OwnerInbox, 'post'>;
  settings: () => ProbeSettings;
  /** The latest slots of the agent's scope that the skill matters to (spec 059 step 1). */
  pick:     (agent: Agent, skillName: string, limit: number) => Promise<ProbeSlotRef[]>;
  /** One dry run of a written slot, with the proposed skill text for this run only (`override`) or as it is live. */
  run:      (slotId: string, o: { override: SkillOverride | null; maxCostUsd: number }) => Promise<SlotPreview>;
  judge:    PairwiseJudge;
  /** The resource's brief, profile and rules, short — what the judge weighs the posts against. */
  judgeContext?: (slotId: string) => Promise<string | null>;
  /** Writes an `avoid` memory entry for the agent's channel (best effort). */
  remember?: (agent: Agent, text: string, evidence: unknown) => Promise<void>;
  /** Random numbers in [0, 1): decides which post is shown as A (injectable for tests). */
  rng?:     () => number;
  now?:     () => Date;
  log?:     (msg: string) => void;
}

export interface ProbeRunSummary { adopted: number; rejected: number; inconclusive: number; unprobed: number; deferred: number }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const usd = (n: number) => `$${n.toFixed(2)}`;

/**
 * Spec 059: tries each skill self-edit that waits as `probing` on a few recent posts of the agent's scope before it
 * goes live. For every sample slot the executor writes the post twice as a dry run (the live skill text, then the
 * proposed one for this run only), a pairwise judge compares the two in random order, and code decides: adopt, reject
 * or inconclusive (live as before). Nothing is published or stored on a slot. A probe that cannot run adopts as today.
 */
export class SkillProbe {
  private busy = false;

  constructor(private readonly d: SkillProbeDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  /** Probes the waiting versions, oldest first, within the day's cap. Never throws. */
  async run(): Promise<ProbeRunSummary> {
    const out: ProbeRunSummary = { adopted: 0, rejected: 0, inconclusive: 0, unprobed: 0, deferred: 0 };
    if (this.busy) return out;
    this.busy = true;
    try {
      const now = this.now();
      const s = this.d.settings();
      const dayStart = zonedToUtc(localDate(now, 'Europe/Kyiv'), '00:00', 'Europe/Kyiv');
      let done = await this.d.skills.probesSince(dayStart);
      for (const v of await this.d.skills.probing()) {
        try {
          const off = s.perDay <= 0 ? 'probes are switched off' : s.budgetUsd <= 0 ? 'the probe budget is 0' : null;
          if (!off && done >= s.perDay) { out.deferred++; continue; }
          const r = await this.probeOne(v, s, off);
          if (!r) continue;
          out[r.verdict]++;
          if (r.verdict === 'adopted' || r.verdict === 'rejected' || r.verdict === 'inconclusive') done++;
        } catch (err: any) {
          this.d.log?.(`skill probe of version ${v.id} failed: ${err?.message ?? err}`);
        }
      }
    } finally {
      this.busy = false;
    }
    return out;
  }

  /** Probes one waiting version and applies the decision. Null = it was decided or replaced meanwhile. */
  private async probeOne(v: SkillVersionRow & { agentId: string; skillName: string }, s: ProbeSettings, off: string | null): Promise<ProbeRecord | null> {
    const agent = await this.d.agents.get(v.agentId);
    const live = await this.d.skills.get(v.skillId);
    if (!agent || !live) return null;
    const started = this.now();
    const unprobed = (reason: string): ProbeRecord => ({ verdict: 'unprobed', reason, samples: [], costUsd: 0, at: started.toISOString() });

    let record: ProbeRecord;
    if (off) {
      record = unprobed(off);
    } else {
      const entry = (await this.d.skills.listForAgent([agent.id])).find((e) => e.skill.id === v.skillId);
      const writerReads = !!entry?.enabled && (entry.skill.appliesTo.includes('executor') || v.appliesTo.includes('executor') || entry.inline);
      if (!writerReads) {
        record = unprobed('the writer does not read this skill (off, or not for the executor role)');
      } else {
        const slots = await this.d.pick(agent, v.skillName, s.samples);
        record = slots.length ? await this.probeSlots(v, slots, s) : unprobed('no recent published or approved posts of this scope to re-write');
      }
    }

    if (record.verdict === 'rejected') {
      if (!(await this.d.skills.rejectVersion(v.skillId, v.version, record))) return null;
      await this.notify(agent, v, live.currentVersion, record);
      await this.rememberRejection(agent, v, record);
    } else {
      const reviewAt = new Date(this.now().getTime() + SELF_EDIT_REVIEW_DAYS * 86_400_000);
      if (!(await this.d.skills.adoptVersion(v.skillId, v.version, { from: ['probing'], probe: record, reviewAt }))) return null;
      await this.notify(agent, v, live.currentVersion, record);
    }
    return record;
  }

  private async probeSlots(v: SkillVersionRow & { skillName: string }, slots: ProbeSlotRef[], s: ProbeSettings): Promise<ProbeRecord> {
    const override: SkillOverride = { name: v.skillName, description: v.description, appliesTo: v.appliesTo as EditorRole[], body: v.body };
    const rng = this.d.rng ?? Math.random;
    const samples: ProbeSample[] = [];
    let spent = 0;
    let dropped = 0;
    let cut: string | null = null;
    const left = () => s.budgetUsd - spent;
    const stop = () => { cut ??= `the probe budget ${usd(s.budgetUsd)} ran out`; };

    for (const slot of slots) {
      if (left() <= 0.0005) { stop(); break; }
      const oldP = await this.runSafe(slot.slotId, null, left());
      spent += oldP.costUsd;
      if (left() <= 0.0005) { stop(); break; }
      const newP = await this.runSafe(slot.slotId, override, left());
      spent += newP.costUsd;
      const o = sideOf(oldP);
      const n = sideOf(newP);
      if (!o || !n) {
        dropped++;
        if ([oldP, newP].some((p) => /budget_exceeded/.test(p.reason ?? ''))) stop();
        continue;
      }
      const judgement = await this.judgePair(slot, v.skillName, { old: o, new: n }, { old: oldP, new: newP }, rng, left());
      spent += judgement.costUsd;
      samples.push({ slotId: slot.slotId, topic: clip(slot.topic, 200), old: o, new: n, judge: judgement.judge });
    }
    const d = decideProbe(samples, { cut, dropped });
    return { verdict: d.verdict, reason: d.reason, samples, ...(dropped ? { dropped } : {}), costUsd: Number(spent.toFixed(6)), at: this.now().toISOString() };
  }

  /** A run that throws is a failed preview, not a crashed probe. */
  private async runSafe(slotId: string, override: SkillOverride | null, maxCostUsd: number): Promise<SlotPreview> {
    try {
      return await this.d.run(slotId, { override, maxCostUsd });
    } catch (err: any) {
      const t = this.now().toISOString();
      return { status: 'failed', platform: null, preview: null, spec: null, critic: null, reason: `probe run failed: ${String(err?.message ?? err).slice(0, 200)}`, warnings: [], runId: null, costUsd: 0, startedAt: t, finishedAt: t };
    }
  }

  /** One pair: decided by code when a side has no post, else by the judge with the posts in random order. */
  private async judgePair(
    slot: ProbeSlotRef, skill: string, sides: { old: ProbeSide; new: ProbeSide }, previews: { old: SlotPreview; new: SlotPreview },
    rng: () => number, maxCostUsd: number,
  ): Promise<{ judge: ProbeJudgement; costUsd: number }> {
    const code = (better: ProbeJudgement['better'], why: string): { judge: ProbeJudgement; costUsd: number } => ({ judge: { better, reasons: [why], risks: [], by: 'code' }, costUsd: 0 });
    if (!sides.old.preview && !sides.new.preview) return code('same', 'the critic stopped both posts');
    if (!sides.old.preview) return code('new', 'the critic stopped the post written with the old text');
    if (!sides.new.preview) return code('old', 'the critic stopped the post written with the new text');

    const oldIsA = rng() < 0.5;
    const side = (p: ProbeSide, full: SlotPreview) => ({ text: full.preview ?? p.preview ?? '', critic: p.critic, lint: p.lint, chars: p.chars });
    const a = oldIsA ? side(sides.old, previews.old) : side(sides.new, previews.new);
    const b = oldIsA ? side(sides.new, previews.new) : side(sides.old, previews.old);
    const context = this.d.judgeContext ? await this.d.judgeContext(slot.slotId).catch(() => null) : null;
    const r = await this.d.judge.compare(
      { skill, topic: slot.topic, platform: previews.new.platform ?? 'telegram', format: slot.format, context, a, b },
      { channelKey: slot.channelKey, maxCostUsd });
    if (!r.ok) return { judge: { better: 'same', reasons: [`the judge did not answer: ${r.error}`], risks: [], by: 'judge' }, costUsd: r.costUsd };
    const pick = r.verdict.better === 'same' ? 'same' : (r.verdict.better === 'A') === oldIsA ? 'old' : 'new';
    return { judge: { better: pick, reasons: r.verdict.reasons, risks: r.verdict.risks, by: 'judge' }, costUsd: r.costUsd };
  }

  // ── the owner's note ──────────────────────────────────────────────────────

  private async notify(agent: Agent, v: SkillVersionRow & { skillName: string }, liveBefore: number, r: ProbeRecord): Promise<void> {
    try {
      await this.d.inbox.post(probeNote(agent, { id: v.skillId, name: v.skillName }, v.version, liveBefore, r, v.reason));
    } catch (err: any) {
      this.d.log?.(`skill probe note for version ${v.id} failed: ${err?.message ?? err}`);
    }
  }

  private async rememberRejection(agent: Agent, v: SkillVersionRow & { skillName: string }, r: ProbeRecord): Promise<void> {
    if (!this.d.remember) return;
    const why = probeReasons(r, 'old').slice(0, 2).join('; ') || r.reason || '';
    const text = `Не повторювати зміну скіла «${v.skillName}»: ${v.reason ?? ''} — перевірка на ${r.samples.length} недавніх постах показала, що вона не краща: ${why}`.slice(0, 400);
    try {
      await this.d.remember(agent, text, {
        source: 'skill_probe', skill: v.skillName, skillId: v.skillId, version: v.version, versionId: v.id,
        verdict: r.verdict, reason: r.reason, ...probeTally(r.samples), why: probeReasons(r, 'old').slice(0, 3),
      });
    } catch { /* the memory note is best-effort */ }
  }
}

/** The judge's reasons for a side: the pairs it won (`better` = the side's name), without repeats. */
export function probeReasons(r: Pick<ProbeRecord, 'samples'>, winner: 'old' | 'new'): string[] {
  const loser = winner === 'new' ? 'old' : 'new';
  const own = r.samples.filter((s) => s.judge.better === winner).flatMap((s) => s.judge.reasons);
  const other = r.samples.filter((s) => s.judge.better === loser).flatMap((s) => s.judge.reasons);
  return [...new Set([...own, ...other])];
}

/** The Inbox item of a probed version: English in the dashboard, Ukrainian in the Telegram alert. */
export function probeNote(
  agent: Pick<Agent, 'id' | 'handle'>, skill: { id: string; name: string }, version: number, liveBefore: number, r: ProbeRecord, proposalReason: string | null,
): InboxItemInput {
  const name = skill.name;
  const n = r.samples.length;
  const { wins, losses, ties } = probeTally(r.samples);
  const h = agent.handle;
  const why = (w: 'old' | 'new') => probeReasons(r, w).slice(0, 3);
  const whyList = (w: 'old' | 'new') => (why(w).length ? `\nWhy: ${why(w).map((x) => clip(x, 220)).join(' · ')}` : '');
  const whyListUa = (w: 'old' | 'new') => (why(w).length ? `\nЧому: ${why(w).map((x) => clip(x, 220)).join(' · ')}` : '');
  const tally = `${n} post${n === 1 ? '' : 's'} (old text vs new): the new text won ${wins}, tied ${ties}, lost ${losses}. Cost ${usd(r.costUsd)}.`;
  const tallyUa = `${n} пост${n === 1 ? '' : 'ах'} (старий текст проти нового): новий виграв ${wins}, нічия ${ties}, програв ${losses}. Вартість ${usd(r.costUsd)}.`;
  const base = { agentId: agent.id, kind: 'skill_probe', refType: 'skill', refId: skill.id } as const;
  switch (r.verdict) {
    case 'adopted':
      return {
        ...base, severity: 'info',
        title: `✅ @${h}: skill "${name}" v${version} passed the check and is live`,
        body: `Tried on ${tally}${whyList('new')}\nIt is under the usual 7-day KPI review. Roll back: agent page → Skills → versions.`,
        alert: {
          title: `✅ @${h}: скіл «${name}» v${version} пройшов перевірку й діє`,
          body: `Перевірено на ${tallyUa}${whyListUa('new')}\nДалі — звичайний 7-денний перегляд KPI. Відкат: сторінка агента → Skills → версії.`,
        },
      };
    case 'rejected':
      return {
        ...base, severity: 'info',
        title: `🚫 @${h}: skill "${name}" v${version} rejected by the check, v${liveBefore} stays live`,
        body: `Tried on ${tally}\n${r.reason ?? ''}${whyList('old')}\nReason for the change: ${proposalReason ?? '—'}\nAdopt anyway: agent page → Skills → versions → the rejected version.`,
        alert: {
          title: `🚫 @${h}: скіл «${name}» v${version} відхилено перевіркою, діє v${liveBefore}`,
          body: `Перевірено на ${tallyUa}${whyListUa('old')}\nПричина зміни була: ${proposalReason ?? '—'}\nЗастосувати все одно: сторінка агента → Skills → версії.`,
        },
      };
    case 'inconclusive':
      return {
        ...base, severity: 'info',
        title: `⚖️ @${h}: check of skill "${name}" v${version} inconclusive, the new text is live`,
        body: `${r.reason ?? ''}${n ? `\nTried on ${tally}` : ''}\nIt is under the usual 7-day KPI review. Roll back: agent page → Skills → versions.`,
        alert: {
          title: `⚖️ @${h}: перевірка скіла «${name}» v${version} непереконлива, новий текст діє`,
          body: `${n ? `Перевірено на ${tallyUa}\n` : ''}Далі — звичайний 7-денний перегляд KPI. Відкат: сторінка агента → Skills → версії.`,
        },
      };
    default:
      return {
        ...base, severity: 'info',
        title: `✏️ @${h}: skill "${name}" v${version} applied without a check`,
        body: `Not checked on posts: ${r.reason ?? ''}.\nIt is under the usual 7-day KPI review. Roll back: agent page → Skills → versions.`,
        alert: {
          title: `✏️ @${h}: скіл «${name}» v${version} застосовано без перевірки`,
          body: `Перевірити на постах не вдалося (${r.reason ?? ''}). Далі — звичайний 7-денний перегляд KPI. Відкат: сторінка агента → Skills → версії.`,
        },
      };
  }
}
