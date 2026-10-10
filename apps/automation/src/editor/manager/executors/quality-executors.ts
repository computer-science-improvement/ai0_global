import type { ResourceProfilesRepository } from '../../agents/resource-profile';
import type { EditorCard } from '../../card';
import type { NetworkRepository } from '../../network/network.repository';
import { MAX_PLAYBOOK_EXAMPLES, type Playbook, type PlaybookExample } from '../../network/playbook';
import { audienceCaps, DEFAULT_POLLS_PER_WEEK, DEFAULT_READER_QUESTIONS, isPollFormat, readerQuestions, type AudienceCaps } from '../../post/audience-asks';
import { findSlopPhrases, normalizeSlop } from '../../post/slop-phrases';
import type { EditorChannelsRepository } from '../../repo/editor-channels.repository';
import type { Directive } from '../directives.repository';
import { LOW_PASS_RATE, type ResourceQuality, type SqlQuality } from '../quality-digest';
import type { PlanObserver } from './plan-observer';
import { anchorRef, dryRunCheck, notExecutable, resolveTarget, round2 } from './playbook-change';
import type { Applied, CapCut, DirectiveExecutor, ExecContext, FormatMixChange, PlanResult, VerifyResult, VoiceFixChange, WeightCut } from './types';

/**
 * Spec 034 FR-006 (T4): the content-quality directive executors of the MANAGER (spec 025 framework).
 *
 * - `voice_fix` appends voice rules to the playbook and merges example posts: bad ones quote real posts the owner
 *   rejected or the critic flagged (with that note), good ones must pass the slop check. Not structural: examples
 *   never are (T5) and the rules are only appended (an edit or removal of a rule stays structural). Verified when
 *   the critic pass rate or the owner's rejections improve in the days after the change.
 * - `format_mix` lowers format weights (poll/quiz first), drops an unfitting format and lowers the resource's poll
 *   and reader-question caps — never raises anything (raising a cap stays the owner's). Dropping a format from a
 *   playbook section is structural and goes to the owner; on a single-channel card it applies at once. Verified
 *   when the next plans keep the dropped formats out, the poll cap and the lowered share.
 */

export interface QualityExecutorDeps {
  network:  Pick<NetworkRepository, 'applyDirectivePatch' | 'activePlaybook'>;
  channels: Pick<EditorChannelsRepository, 'get' | 'patchPlanning'>;
  profiles: Pick<ResourceProfilesRepository, 'formatOf' | 'patchFormat'>;
  quality:  Pick<SqlQuality, 'window'>;
  observer: PlanObserver;
  now?:     () => Date;
}

export const VOICE_FIX = {
  maxRules: 3, ruleMin: 10, ruleMax: 240, maxBad: 3, maxGood: 2, goodMin: 20, textMax: 1200, maxPlaybookRules: 30,
  /** Days after applying before the effect is judged; give up (not followed) after maxWaitDays without enough posts. */
  verifyDays: 3, maxWaitDays: 10, minJudged: 3,
  /** A pass-rate gain of at least this many points counts as an improvement. */
  passGainPts: 10,
};
export const FORMAT_MIX_VERIFY_PLANS = 3;
/** Examples a directive wrote carry this tag in `note`; they are the first to make room for new ones. */
export const MANAGER_EXAMPLE_TAG = '[@manager]';
const DAY_MS = 86_400_000;
const EPS = 1e-9;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const arr = (v: unknown): unknown[] | null => (v == null ? [] : Array.isArray(v) ? v : null);
const ruleKey = (r: string) => normalizeSlop(r).replace(/[^\p{L}\p{N} ]/gu, '');
const exampleKey = (e: Pick<PlaybookExample, 'text'>) => normalizeSlop(e.text).replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 400);

// ── voice_fix ────────────────────────────────────────────────────────────────

/** Rules + examples merged into a body: rules appended once; examples new first, the directive's old ones make room. */
export function patchVoice(body: Playbook, c: Pick<VoiceFixChange, 'rules' | 'examples'>): Playbook {
  const have = new Set(body.rules.map(ruleKey));
  const rules = [...body.rules, ...c.rules.filter((r) => !have.has(ruleKey(r)))];
  const seen = new Set<string>();
  const merged: PlaybookExample[] = [];
  for (const e of [...c.examples, ...(body.examples ?? [])]) {
    const k = exampleKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(e);
  }
  const fresh = new Set(c.examples.map(exampleKey));
  while (merged.length > MAX_PLAYBOOK_EXAMPLES) {
    let i = merged.length - 1;
    while (i >= 0 && !(merged[i].note?.startsWith(MANAGER_EXAMPLE_TAG) && !fresh.has(exampleKey(merged[i])))) i--;
    if (i < 0) throw new Error(`examples_full: the playbook already has ${MAX_PLAYBOOK_EXAMPLES} examples of the owner`);
    merged.splice(i, 1);
  }
  return { ...body, rules, examples: merged };
}

/** Does the body hold the change (every rule and every example)? */
export function holdsVoice(body: Playbook | null | undefined, c: Pick<VoiceFixChange, 'rules' | 'examples'>): boolean {
  if (!body) return false;
  const rules = new Set(body.rules.map(ruleKey));
  const examples = new Set((body.examples ?? []).map(exampleKey));
  return c.rules.every((r) => rules.has(ruleKey(r))) && c.examples.every((e) => examples.has(exampleKey(e)));
}

/** directive_lock: a submitted body that drops one of the directive's rules undoes it (examples may rotate). */
export function revertsVoice(body: Playbook, c: Pick<VoiceFixChange, 'rules'>): boolean {
  const rules = new Set(body.rules.map(ruleKey));
  return c.rules.some((r) => !rules.has(ruleKey(r)));
}

function rateOf(q: ResourceQuality) {
  const judged = q.critic.pass + q.critic.revise + q.critic.reject;
  const decided = q.owner.approved + q.owner.rejected;
  return { judged, decided, pass: q.critic.pass_rate, rejection: q.owner.rejection_rate };
}

/** Did the resource's quality improve from `before` to `after`? (pass rate +10 points, fewer owner rejections, or clean). */
export function qualityImproved(before: ResourceQuality, after: ResourceQuality): boolean {
  const b = rateOf(before);
  const a = rateOf(after);
  if (a.pass != null && b.pass != null && (a.pass - b.pass) * 100 >= VOICE_FIX.passGainPts) return true;
  if (a.rejection != null && b.rejection != null && a.rejection < b.rejection - EPS) return true;
  const clean = (a.pass == null || a.pass >= LOW_PASS_RATE) && after.owner.rejected === 0 && after.critic.reject === 0;
  const wasBad = (b.pass != null && b.pass < LOW_PASS_RATE) || before.owner.rejected > 0 || before.critic.reject > 0;
  return clean && (wasBad || (b.pass == null && b.rejection == null));
}

export function voiceFixExecutor(d: QualityExecutorDeps): DirectiveExecutor<VoiceFixChange> {
  const now = () => (d.now ?? (() => new Date()))();
  return {
    kind: 'voice_fix',
    plan(dir, ctx): PlanResult<VoiceFixChange> {
      const p = (dir.params ?? {}) as Record<string, unknown>;
      const anchor = anchorRef(ctx);
      if (!ctx.card || !ctx.net || !anchor) return notExecutable('в оркестратора немає картки каналу — виконати нічого');
      const ref = str(p.resource_ref) || anchor;
      if (!ctx.net.resources.some((r) => r.ref === ref)) return notExecutable(`ресурс ${ref} не в мережі @${ctx.orch.handle} (є: ${ctx.net.resources.map((r) => r.ref).join(', ')})`);
      if (!ctx.playbook) return notExecutable('плейбука ще немає — voice_fix пише правила й приклади в плейбук; дай пораду advice');
      const section = ctx.playbook.platforms.find((s) => s.resource_ref === ref);
      if (!section) return notExecutable(`у плейбуку @${ctx.orch.handle} немає секції ${ref}`);

      const rulesIn = arr(p.rules);
      const badIn = arr(p.bad_slot_ids);
      const goodIn = arr(p.good_examples);
      if (!rulesIn || !badIn || !goodIn) return notExecutable('rules, bad_slot_ids і good_examples — масиви');
      if (rulesIn.length > VOICE_FIX.maxRules) return notExecutable(`rules: не більше ${VOICE_FIX.maxRules}`);
      if (badIn.length > VOICE_FIX.maxBad) return notExecutable(`bad_slot_ids: не більше ${VOICE_FIX.maxBad}`);
      if (goodIn.length > VOICE_FIX.maxGood) return notExecutable(`good_examples: не більше ${VOICE_FIX.maxGood}`);

      const rules: string[] = [];
      for (const r of rulesIn) {
        const t = str(r);
        if (t.length < VOICE_FIX.ruleMin || t.length > VOICE_FIX.ruleMax) return notExecutable(`правило «${t.slice(0, 40)}»: ${VOICE_FIX.ruleMin}–${VOICE_FIX.ruleMax} символів`);
        rules.push(`Голос (${ref}): ${t}`);
      }
      const evidence = (ctx.evidence ?? []).filter((x) => x.ref === ref);
      const examples: PlaybookExample[] = [];
      const slots: string[] = [];
      for (const id of badIn) {
        const post = evidence.find((x) => x.slotId === str(id));
        if (!post) {
          const avail = evidence.slice(0, 5).map((x) => `${x.slotId} (${x.source === 'owner' ? 'відхилив власник' : 'критик'}: ${x.note.slice(0, 60)})`).join('; ');
          return notExecutable(`пост ${str(id) || '—'} не серед відхилених власником чи позначених критиком постів ${ref} за 14 днів${avail ? ` (є: ${avail})` : ' (таких немає)'}`);
        }
        slots.push(post.slotId);
        examples.push({
          format: post.format, text: post.text.slice(0, VOICE_FIX.textMax), verdict: 'bad', resource_ref: ref,
          note: `${MANAGER_EXAMPLE_TAG} ${post.source === 'owner' ? 'Власник відхилив' : 'Критик'}: ${post.note}`.slice(0, 300),
        });
      }
      const caps = ctx.audience?.[ref]?.caps ?? audienceCaps(null);
      const firstFormat = Object.entries(section.formats).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'text';
      for (const g of goodIn) {
        const o = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>;
        const text = str(o.text);
        if (text.length < VOICE_FIX.goodMin || text.length > VOICE_FIX.textMax) return notExecutable(`добрий приклад: ${VOICE_FIX.goodMin}–${VOICE_FIX.textMax} символів`);
        const slop = findSlopPhrases(text);
        if (slop.length) return notExecutable(`добрий приклад має AI-штампи: ${slop.slice(0, 5).map((h) => `«${h}»`).join(', ')} — перепиши без них`);
        const qs = readerQuestions(text);
        if (qs.length > caps.questionsPerDay) return notExecutable(`добрий приклад має ${qs.length} питань до читачів — ліміт ресурсу ${caps.questionsPerDay}`);
        const format = str(o.format) || firstFormat;
        if (!(section.formats[format] > 0)) return notExecutable(`формату ${format} немає в секції ${ref} (є: ${Object.keys(section.formats).filter((f) => section.formats[f] > 0).join(', ')})`);
        examples.push({ format, text, verdict: 'good', resource_ref: ref, note: `${MANAGER_EXAMPLE_TAG} ${str(o.note)}`.trim().slice(0, 300) });
      }
      if (!rules.length && !examples.length) return notExecutable('вкажи rules, bad_slot_ids або good_examples');

      const prev = ctx.playbook;
      const change: VoiceFixChange = {
        kind: 'voice_fix', op: 'voice_fix', target: 'playbook', channel_key: ctx.net.anchorKey, resource_ref: ref,
        rules, examples, evidence_slots: slots, structural: false, reasons: [],
      };
      if (holdsVoice(prev, change)) return notExecutable('ці правила й приклади вже є в плейбуку');
      const newRules = rules.filter((r) => !prev.rules.some((x) => ruleKey(x) === ruleKey(r)));
      if (prev.rules.length + newRules.length > VOICE_FIX.maxPlaybookRules) return notExecutable(`у плейбуку вже ${prev.rules.length} правил — ліміт ${VOICE_FIX.maxPlaybookRules}`);
      let next: Playbook;
      try { next = patchVoice(prev, change); } catch (err: any) { return notExecutable(`прикладів уже ${MAX_PLAYBOOK_EXAMPLES} від власника — нових не додати (${err?.message ?? err})`); }
      // Validation of the new body; the appended rules are not a structural change (they only add a voice line).
      const check = dryRunCheck(ctx, prev, { ...next, rules: prev.rules });
      if ('error' in check) return check;
      return {
        ...change,
        reasons: [`${ref}: +${newRules.length} voice rule(s), +${examples.filter((e) => e.verdict === 'bad').length} bad / +${examples.filter((e) => e.verdict === 'good').length} good example(s)`],
      };
    },
    async apply(change, dir): Promise<Applied> {
      const r = await d.network.applyDirectivePatch(dir.toAgentId, dir.id,
        (active) => (holdsVoice(active, change) ? null : patchVoice(active, change)),
        `Directive voice_fix (${dir.id.slice(0, 8)}): ${change.reasons.join('; ') || change.resource_ref}`);
      if ('error' in r) throw new Error('no active playbook');
      const pb = await d.network.activePlaybook(dir.toAgentId);
      if (!pb || !holdsVoice(pb.body, change)) throw new Error('the active playbook does not hold the voice change after the write');
      return { noop: r.noop, playbookId: pb.id, version: pb.version };
    },
    /**
     * Verified when the critic pass rate (+10 points) or the owner's rejection rate improves over the days after
     * the change compared with the 7 days before. Pending until 3 days passed and ≥ 3 posts were judged; a rule
     * removed from the active playbook is a violation.
     */
    async verify(dir: Directive): Promise<VerifyResult> {
      const c = dir.change as VoiceFixChange | null;
      if (!c || c.op !== 'voice_fix' || !dir.appliedAt) return { verified: false, adherence: 'not_followed', detail: { reason: 'no change recorded' } };
      const t = now();
      const at = dir.appliedAt;
      const days = (t.getTime() - at.getTime()) / DAY_MS;
      const pb = await d.network.activePlaybook(dir.toAgentId);
      if (c.rules.length && pb && revertsVoice(pb.body, c)) return { verified: false, adherence: 'violated', detail: { reason: 'a voice rule was removed from the active playbook' } };
      if (days < VOICE_FIX.verifyDays) return { pending: true };
      const [before, after] = await Promise.all([
        d.quality.window(c.resource_ref, new Date(at.getTime() - 7 * DAY_MS), at),
        d.quality.window(c.resource_ref, at, t),
      ]);
      const a = rateOf(after);
      const b = rateOf(before);
      const detail = {
        resource_ref: c.resource_ref, days: Math.round(days * 10) / 10,
        before: { judged: b.judged, pass_rate: b.pass, decided: b.decided, rejection_rate: b.rejection },
        after: { judged: a.judged, pass_rate: a.pass, decided: a.decided, rejection_rate: a.rejection },
      };
      if (a.judged + a.decided < VOICE_FIX.minJudged) {
        if (days < VOICE_FIX.maxWaitDays) return { pending: true, detail };
        return { verified: false, adherence: 'not_followed', detail: { ...detail, reason: 'too few posts after the change' } };
      }
      const ok = qualityImproved(before, after);
      return { verified: ok, adherence: ok ? 'followed' : 'not_followed', detail };
    },
  };
}

// ── format_mix ───────────────────────────────────────────────────────────────

const CAP_FIELDS = ['polls_per_week', 'questions_to_readers_per_day'] as const;
type CapField = typeof CAP_FIELDS[number];
const CAP_DEFAULT: Record<CapField, number> = { polls_per_week: DEFAULT_POLLS_PER_WEEK, questions_to_readers_per_day: DEFAULT_READER_QUESTIONS };
const capNow = (c: AudienceCaps, f: CapField): number | null => (f === 'polls_per_week' ? c.pollsPerWeek : c.questionsPerDay);

/** The formats map with the cuts applied (a cut to 0 removes the format). */
export function cutFormats(formats: Record<string, number>, cuts: readonly WeightCut[]): Record<string, number> {
  const out = { ...formats };
  for (const c of cuts) {
    if (c.after <= 0) delete out[c.format];
    else out[c.format] = c.after;
  }
  return out;
}

export function formatsHold(formats: Record<string, number> | null | undefined, cuts: readonly WeightCut[]): boolean {
  if (!formats) return false;
  return cuts.every((c) => (c.after <= 0 ? !(formats[c.format] > 0) : Math.abs((formats[c.format] ?? 0) - c.after) < EPS));
}

function patchMix(body: Playbook, c: FormatMixChange): Playbook {
  if (!body.platforms.some((s) => s.resource_ref === c.resource_ref)) throw new Error(`section ${c.resource_ref} is gone from the active playbook`);
  return {
    ...body,
    platforms: body.platforms.map((s) => {
      if (s.resource_ref !== c.resource_ref) return s;
      const reasons = s.format_reasons ? Object.fromEntries(Object.entries(s.format_reasons).filter(([f]) => !c.drop.includes(f))) : s.format_reasons;
      return { ...s, formats: cutFormats(s.formats, c.weights), ...(reasons ? { format_reasons: reasons } : {}) };
    }),
  };
}

/** directive_lock: a body that raises a cut weight again or brings a dropped format back undoes the directive. */
export function revertsMix(body: Playbook, c: Pick<FormatMixChange, 'resource_ref' | 'weights'>): boolean {
  const s = body.platforms.find((x) => x.resource_ref === c.resource_ref);
  if (!s) return false;
  return c.weights.some((w) => (s.formats[w.format] ?? 0) > w.after + EPS);
}

export function formatMixExecutor(d: QualityExecutorDeps): DirectiveExecutor<FormatMixChange> {
  return {
    kind: 'format_mix',
    plan(dir, ctx: ExecContext): PlanResult<FormatMixChange> {
      const p = (dir.params ?? {}) as Record<string, unknown>;
      const anchor = anchorRef(ctx);
      if (!ctx.card || !ctx.net || !anchor) return notExecutable('в оркестратора немає картки каналу — виконати нічого');
      const ref = str(p.resource_ref) || anchor;
      if (!ctx.net.resources.some((r) => r.ref === ref)) return notExecutable(`ресурс ${ref} не в мережі @${ctx.orch.handle} (є: ${ctx.net.resources.map((r) => r.ref).join(', ')})`);
      const weightsIn = p.weights == null ? {} : p.weights;
      if (typeof weightsIn !== 'object' || Array.isArray(weightsIn)) return notExecutable('weights — обʼєкт {формат: нова нижча вага 0–1}');
      const dropIn = arr(p.drop);
      if (!dropIn) return notExecutable('drop — масив форматів');

      // Caps: only lower, never above the default, never an owner-locked field.
      const aud = ctx.audience?.[ref] ?? { caps: audienceCaps(null), locks: [] };
      const caps: FormatMixChange['caps'] = {};
      for (const f of CAP_FIELDS) {
        if (p[f] == null) continue;
        const v = Number(p[f]);
        if (!Number.isInteger(v) || v < 0) return notExecutable(`${f} — ціле число ≥ 0`);
        if (aud.locks.includes(f)) return notExecutable(`${f} на ${ref} заблокував власник`);
        const cur = capNow(aud.caps, f);
        if (v > CAP_DEFAULT[f] || (cur != null && v >= cur)) {
          return notExecutable(`${f}: format_mix лише знижує ліміт (зараз ${cur ?? 'без ліміту'}, не вище ${CAP_DEFAULT[f]}); підвищити може лише власник`);
        }
        caps[f] = { before: cur, after: v } satisfies CapCut;
      }

      const wantCuts = Object.keys(weightsIn as object).length > 0 || dropIn.length > 0;
      let target: FormatMixChange['target'] = 'resource';
      let cuts: WeightCut[] = [];
      const drop: string[] = [];
      let prev: Playbook | null = null;
      if (wantCuts) {
        const t = resolveTarget(ctx, ref);
        if ('error' in t) return t;
        target = t.target;
        const formats = t.target === 'playbook' ? t.section.formats : t.card.formats;
        for (const [f, raw] of Object.entries(weightsIn as Record<string, unknown>)) {
          const w = Number(raw);
          const before = formats[f] ?? 0;
          if (!(before > 0)) return notExecutable(`формату ${f} немає на ${ref} (є: ${Object.keys(formats).filter((x) => formats[x] > 0).join(', ')})`);
          if (!Number.isFinite(w) || w < 0 || w > 1) return notExecutable(`вага ${f} — число 0–1`);
          const after = round2(w);
          if (after >= before - EPS) return notExecutable(`format_mix лише знижує вагу (${f} зараз ${before}); підвищити — format_shift`);
          cuts.push({ format: f, before, after });
        }
        for (const raw of dropIn) {
          const f = str(raw);
          const before = formats[f] ?? 0;
          if (!(before > 0)) return notExecutable(`формату ${f || '—'} немає на ${ref}`);
          cuts = cuts.filter((c) => c.format !== f);
          cuts.push({ format: f, before, after: 0 });
        }
        drop.push(...cuts.filter((c) => c.after <= 0).map((c) => c.format));
        if (!Object.values(cutFormats(formats, cuts)).some((w) => w > 0)) return notExecutable('хоча б один формат має лишитися');
        if (t.target === 'playbook') prev = ctx.playbook;
      }
      if (!cuts.length && !Object.keys(caps).length) {
        return notExecutable('вкажи weights (нижчі ваги), drop (формат, що не пасує), polls_per_week або questions_to_readers_per_day — лише зниження');
      }
      const change: FormatMixChange = {
        kind: 'format_mix', op: 'format_mix', target, channel_key: ctx.net.anchorKey, resource_ref: ref,
        weights: cuts, drop, caps, structural: false, reasons: [],
      };
      if (prev) {
        const next = patchMix(prev, change);
        const check = dryRunCheck(ctx, prev, next);
        if ('error' in check) return check;
      }
      // A format dropped from a playbook section changes the format set: the owner decides. Lowering weights and
      // caps (and a drop on a single-channel card) apply at once.
      const structural = target === 'playbook' && drop.length > 0;
      const reasons = [
        ...cuts.map((c) => (c.after <= 0 ? `${ref}: drop ${c.format}` : `${ref}: weight of ${c.format} ${c.before} → ${c.after}`)),
        ...Object.entries(caps).map(([f, c]) => `${ref}: ${f} ${c!.before ?? 'no cap'} → ${c!.after}`),
      ];
      return { ...change, structural, reasons };
    },
    async apply(change, dir): Promise<Applied> {
      let noop = true;
      let playbookId: string | undefined;
      let version: number | undefined;
      if (change.weights.length && change.target === 'playbook') {
        const holds = (b: Playbook) => formatsHold(b.platforms.find((s) => s.resource_ref === change.resource_ref)?.formats, change.weights);
        const r = await d.network.applyDirectivePatch(dir.toAgentId, dir.id, (active) => (holds(active) ? null : patchMix(active, change)),
          `Directive format_mix (${dir.id.slice(0, 8)}): ${change.reasons.join('; ')}`);
        if ('error' in r) throw new Error('no active playbook');
        const pb = await d.network.activePlaybook(dir.toAgentId);
        if (!pb || !holds(pb.body)) throw new Error('the active playbook does not hold the format change after the write');
        noop = noop && r.noop;
        playbookId = pb.id;
        version = pb.version;
      } else if (change.weights.length && change.target === 'card') {
        const card = await d.channels.get(change.channel_key);
        if (!card) throw new Error(`card ${change.channel_key} is gone`);
        if (!formatsHold(card.formats, change.weights)) {
          await d.channels.patchPlanning(change.channel_key, { formats: cutFormats(card.formats, change.weights) });
          if (!formatsHold((await d.channels.get(change.channel_key) as EditorCard | null)?.formats, change.weights)) throw new Error('the card does not hold the format change after the update');
          noop = false;
        }
      }
      const capPatch: Record<string, number> = {};
      if (Object.keys(change.caps).length) {
        const cur = await d.profiles.formatOf(change.resource_ref);
        for (const [f, c] of Object.entries(change.caps)) {
          if ((cur.prefs as Record<string, unknown>)[f] !== c!.after) capPatch[f] = c!.after;
        }
      }
      if (Object.keys(capPatch).length) {
        const r = await d.profiles.patchFormat(change.resource_ref, capPatch, { by: 'agent', agentId: dir.toAgentId, reason: `directive format_mix ${dir.id.slice(0, 8)}` });
        if ('error' in r && r.error !== 'no_change') throw new Error(`${r.error}: ${JSON.stringify((r as any).details ?? '')}`);
        if (!('error' in r)) noop = false;
      }
      return { noop, ...(playbookId ? { playbookId, version } : {}) };
    },
    /**
     * Over the next 3 plan days: a dropped format planned again → violated; poll + quiz slots over the new weekly
     * cap → violated; a lowered weight whose share did not fall → not followed.
     */
    async verify(dir: Directive): Promise<VerifyResult> {
      const c = dir.change as FormatMixChange | null;
      if (!c || c.op !== 'format_mix' || !dir.appliedAt) return { verified: false, adherence: 'not_followed', detail: { reason: 'no change recorded' } };
      const after = await d.observer.plans(c.channel_key, { after: dir.appliedAt, limit: FORMAT_MIX_VERIFY_PLANS });
      const mine = after.flatMap((p) => p.slots.filter((s) => s.ref === c.resource_ref));
      const dropped = mine.filter((s) => c.drop.includes(s.format)).length;
      const polls = mine.filter((s) => isPollFormat(s.format)).length;
      const lowered = c.weights.filter((w) => w.after > 0).map((w) => w.format);
      const share = (xs: Array<{ format: string }>) => (xs.length ? xs.filter((s) => lowered.includes(s.format)).length / xs.length : 0);
      const detail: Record<string, unknown> = { plan_days: after.map((p) => p.planDate), slots: mine.length, dropped_planned: dropped, polls };
      if (dropped > 0) return { verified: false, adherence: 'violated', detail };
      const cap = c.caps.polls_per_week?.after;
      if (cap != null && polls > cap) return { verified: false, adherence: 'violated', detail: { ...detail, polls_per_week: cap } };
      if (after.length < FORMAT_MIX_VERIFY_PLANS) return { pending: true, detail };
      if (lowered.length) {
        const before = (await d.observer.plans(c.channel_key, { before: dir.appliedAt, limit: FORMAT_MIX_VERIFY_PLANS })).flatMap((p) => p.slots.filter((s) => s.ref === c.resource_ref));
        const sa = share(mine);
        const sb = before.length ? share(before) : null;
        const ok = sa === 0 || (sb != null && sa < sb);
        return { verified: ok, adherence: ok ? 'followed' : 'not_followed', detail: { ...detail, share: round2(sa), share_before: sb == null ? null : round2(sb) } };
      }
      return { verified: true, adherence: 'followed', detail };
    },
  };
}
