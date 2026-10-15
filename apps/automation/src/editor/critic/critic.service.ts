import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import type { AgentBudget } from '../harness/budget.service';
import { defineTool } from '../harness/tool';
import type { EditorRole } from '../llm/llm.types';
import { resolveModel } from '../llm/model-registry';
import { readDefaultModel } from '../llm/model-defaults';
import type { VoicePrefs } from '../post/slop-lint';
import { SkillLibrary, type Skill } from '../skills/skill-library';
import { voiceCoreBody, voiceSettingsLine } from '../roles/voice';
import { styleSection } from '../post/style/resource-style';
import { CritiqueInput, decideVerdict, type Critique, type StoredCritic } from './critic';
import { criticSkillsSection, type CriticSkillsContext, type CriticSkillsRequest } from './critic-skills';
import { criticDatesLines, type CriticDates } from './critic-dates';
import { criticStoryLines, type CriticStoryContext } from '../story/story-context';

/** One attempt of the critic; a second attempt follows a timeout or an error (fail-safe, FR-004). */
export const CRITIC_TIMEOUT_MS = 90_000;
export const CRITIC_ATTEMPTS = 2;
const CRITIC_MAX_STEPS = 3;
export const CRITIC_SKILL = 'editor-critic-workflow';
/** Prompt caps: the critic sees the post in full, the context clipped. */
const CAP = { text: 6_000, spec: 3_000, source: 3_000, profile: 1_500, playbook: 2_000, prefs: 800, examples: 2_600 } as const;

/** What the critic reviews and the context it needs (spec 034 FR-004). */
export interface CriticRequest {
  /** The channel the run is accounted to (its card budget); null for none. */
  channelKey:   string | null;
  slotId:       string | null;
  /** `live` / `shadow` / `approve` for a slot; `draft` for a chat draft (advisory). */
  mode:         'live' | 'shadow' | 'approve' | 'draft';
  /** Model overrides and budget of the channel card (legacy `models.checker`, daily budget). */
  card?:        { models?: Partial<Record<EditorRole, string>>; dailyBudgetUsd?: number | null; mode?: string } | null;
  resourceRef:  string;
  platform:     string;
  format:       string;
  topic?:       string | null;
  angle?:       string | null;
  /** What the reader sees (plain text: caption, slides, poll). */
  text:         string;
  /** The post spec as written (JSON). */
  spec:         unknown;
  voice:        VoicePrefs;
  brief?:       string | null;
  profile?:     string | null;
  formatPrefs?: string | null;
  playbook?:    string | null;
  /** Spec 034 FR-008: the resource's example posts and warnings from the playbook (renderExamples), the reference. */
  examples?:    string | null;
  source?:      { url: string | null; excerpt: string | null } | null;
  /** Slop lint warnings (spec 034 T1): only the `slop_*` ones; the verdict rule counts these. */
  slopWarnings: Array<{ code: string; message: string }>;
  /** Spec 037 T6: every lint warning (hygiene, dates, style, … and the slop ones) for the prompt; absent = slopWarnings. */
  lintWarnings?: Array<{ code: string; message: string }>;
  /** Pass 2: the first verdict, so the critic sees what was asked. */
  previous?:    Pick<StoredCritic, 'verdict' | 'notes' | 'scores'> | null;
  /** Registry agent whose budget the critic run counts against (the executor's). */
  agent?:       AgentBudget | null;
  /** Spec 037 FR-012: what selects the writer's skills for the critic (resource tone skills, slot signals, skill view). */
  skills?:      CriticSkillsContext | null;
  /** Spec 037 T5: publish time in the resource zone, source date, first post of the story (critic-dates.ts). */
  dates?:       CriticDates | null;
  /** Spec 037 T2: the story's earlier posts (date, channel, lead, key facts) — the post must add, not repeat. */
  story?:       CriticStoryContext | null;
}

export type CriticResult =
  | { ok: true; critic: StoredCritic }
  | { ok: false; error: string; runIds: string[]; costUsd: number };

export interface CriticDeps {
  loop:          Pick<AgentLoop, 'run'>;
  env:           (key: string) => string | undefined;
  /** The owner's global default model (spec 035). */
  defaultModel?: () => Promise<string | null>;
  /** The owner's critic model (app_settings `ai.critic_model`, Models page); null → the normal resolution. */
  criticModel?:  () => Promise<string | null>;
  timeoutMs?:    number;
  now?:          () => Date;
}

let repoLib: SkillLibrary | null = null;
function repoSkill(name: string): Skill | undefined {
  repoLib ??= new SkillLibrary();
  return repoLib.get(name);
}

const clip = (s: string | null | undefined, n: number): string => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function json(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * The critic's system prompt: its rubric (repo builtin, never an agent override), voice-core and (spec 037 FR-012,
 * with a request) the writer's skills for this post — resource tone, format and topic skills, compressed to rules
 * within CRITIC_SKILLS_BUDGET. Per resource, format and content type, so it caches across the posts of a resource.
 */
export function criticSystemPrompt(r?: CriticSkillsRequest | null): string {
  const rubric = repoSkill(CRITIC_SKILL)?.body
    ?? 'Оціни пост за шкалою 1–5 (ai_likeness, sense, voice, grounding, audience_asks, format_fit) і виклич submit_critique з вердиктом pass / revise / reject та короткими нотатками українською.';
  return [rubric, '', '## Голос мережі (voice-core): за цими правилами оцінюй ai_likeness і voice', voiceCoreBody(), ...(r ? criticSkillsSection(r).lines : [])].join('\n');
}

/** The critic's user prompt: the resource, the slot, the post, the source excerpt and the lint warnings. */
export function criticUserPrompt(r: CriticRequest): string {
  const s: string[] = [];
  s.push(`## Ресурс: ${r.resourceRef} (${r.platform})`);
  s.push(voiceSettingsLine(r.voice));
  // Spec 037 FR-008: the resource style sheet the post must follow (address, glossary, names, units, hashtags).
  s.push(...styleSection(r.voice?.style));
  if (r.brief) s.push(`Бриф каналу: ${clip(r.brief, CAP.profile)}`);
  if (r.profile) s.push('', '### Профіль ресурсу', clip(r.profile, CAP.profile));
  if (r.formatPrefs) s.push('', '### Форматування ресурсу (format_prefs)', clip(r.formatPrefs, CAP.prefs));
  if (r.playbook) s.push('', '### Плейбук: правила й приклади для цього ресурсу', clip(r.playbook, CAP.playbook));
  // Spec 034 FR-008: the owner-approved examples are the reference for voice and format_fit; a post that repeats a
  // "bad" pattern scores low on the matching criterion.
  if (r.examples) {
    s.push('', '### Приклади постів ресурсу (еталон власника)',
      'ДОБРЕ — так цей ресурс пише (оцінюй voice і format_fit відносно них); ПОГАНО — патерн, якого пост не має повторювати (повтор → відповідний бал ≤ 2).',
      clip(r.examples, CAP.examples));
  }
  if (r.profile && /Табу-теми/.test(r.profile)) s.push('', 'Табу-теми з профілю — це теми, про які ресурс не пише: пост на табу-тему → sense ≤ 2.');
  s.push('', '## Слот');
  s.push(`Формат: ${r.format}.${r.topic ? ` Тема: ${r.topic}.` : ''}${r.angle ? ` Кут: ${r.angle}.` : ''}`);
  if (r.dates) s.push(...criticDatesLines(r.dates));
  s.push(...criticStoryLines(r.story, r.dates?.timezone ?? 'Europe/Kyiv'));
  s.push('', '## Пост (що побачить читач)', clip(r.text, CAP.text) || '(порожньо)');
  s.push('', '### Специфікація поста (JSON)', clip(json(r.spec), CAP.spec));
  s.push('', '## Джерело');
  if (r.source?.url || r.source?.excerpt) {
    if (r.source.url) s.push(`URL: ${r.source.url}`);
    s.push(r.source.excerpt ? `Фрагмент, який читав автор:\n${clip(r.source.excerpt, CAP.source)}` : 'Фрагмента джерела немає — оціни grounding за перевірюваністю тверджень.');
  } else {
    s.push('Джерела немає — оціни grounding за перевірюваністю тверджень.');
  }
  s.push('', '## Попередження lint (AI-штампи, гумор і сленг, гігієна тексту та інші перевірки коду)');
  const lintWarnings = r.lintWarnings ?? r.slopWarnings;
  s.push(lintWarnings.length ? lintWarnings.map((w) => `- ${w.code}: ${w.message}`).join('\n') : '- немає');
  if (r.previous) {
    s.push('', '## Це переписаний пост', `Перший вердикт: ${r.previous.verdict}. Зауваження автору: ${r.previous.notes}`,
      'Перевір, чи виправлено саме це, і оціни пост заново повністю.');
  }
  s.push('', 'Оціни пост і виклич submit_critique один раз.');
  return s.join('\n');
}

/**
 * The pre-publish critic (spec 034 FR-004): one AgentLoop run as the `checker`
 * role with a single terminal tool. Its spend lands in the usage ledger as
 * `editor.checker` (the loop's attribution) and counts against the channel,
 * agent and blocking caps like every editor call. Never throws: a timeout, an
 * error or a run without a verdict is retried once, then reported as
 * `{ ok: false }` — the caller decides what that means for the post (never a
 * silent publish).
 */
export class CriticService {
  constructor(private readonly d: CriticDeps) {}

  async review(r: CriticRequest): Promise<CriticResult> {
    const [defaultModel, criticModel] = await Promise.all([readDefaultModel(this.d.defaultModel), readDefaultModel(this.d.criticModel)]);
    const model = resolveModel('checker', this.d.env, r.card?.models ?? null, { agentModel: criticModel, defaultModel });
    const tool = defineTool({
      name: 'submit_critique',
      description: 'Віддати оцінку поста (завершує роботу): оцінки 1–5 за шістьма осями, вердикт pass / revise / reject і короткі нотатки українською.',
      kind: 'terminal', roles: ['checker'],
      input: CritiqueInput,
      execute: async (c) => ({ ok: true, ...c }),
    });
    const system = criticSystemPrompt(r);
    const user = criticUserPrompt(r);
    const runIds: string[] = [];
    let cost = 0;
    let error = 'no verdict';
    for (let attempt = 1; attempt <= CRITIC_ATTEMPTS; attempt++) {
      let res: AgentLoopResult;
      try {
        res = await this.withTimeout(this.d.loop.run({
          role: 'checker', channelKey: r.channelKey, slotId: r.slotId, model, system, user, tools: [tool],
          maxSteps: CRITIC_MAX_STEPS, channelBudgetUsd: r.card?.dailyBudgetUsd ?? null, agent: r.agent ?? null,
          // Usage attribution (spec 029): the target resource and whether the slot is a shadow one.
          extras: {
            card: { mode: r.mode === 'shadow' ? 'shadow' : 'live' },
            ...(r.platform !== 'telegram' ? { platformSlot: { resourceRef: r.resourceRef, mode: r.mode === 'shadow' ? 'shadow' : 'live' } } : {}),
          },
        }));
      } catch (err: any) {
        error = err?.message ?? String(err);
        continue;
      }
      if (res.runId) runIds.push(res.runId);
      cost += res.totals?.costUsd ?? 0;
      if (res.terminalTool === 'submit_critique' && res.terminalResult) {
        const parsed = CritiqueInput.safeParse(res.terminalResult);
        if (parsed.success) return { ok: true, critic: this.store(parsed.data, r, model.model, res.runId, cost) };
        error = 'invalid verdict';
        continue;
      }
      error = `${res.status}${res.error ? `: ${res.error}` : ''}`;
      // A cap or a disabled editor will not change in a second: no retry, the caller holds the post.
      if (res.status === 'budget_exceeded' || res.status === 'disabled') break;
    }
    return { ok: false, error: error.slice(0, 500), runIds, costUsd: cost };
  }

  private store(c: Critique, r: CriticRequest, model: string, runId: string | null, cost: number): StoredCritic {
    const slop = r.slopWarnings.map((w) => w.code);
    const d = decideVerdict(c, slop);
    return {
      verdict: d.verdict, scores: c.scores, notes: c.notes.trim(), model_verdict: c.verdict, reason: d.reason,
      pass: r.previous ? 2 : 1, slop_warnings: slop, model, run_id: runId, cost_usd: Number(cost.toFixed(6)),
      at: (this.d.now ?? (() => new Date()))().toISOString(),
    };
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    const ms = this.d.timeoutMs ?? CRITIC_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`critic timed out after ${ms}ms`)), ms); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
