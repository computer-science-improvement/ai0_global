import type { ChannelFacts, SkillFact } from '../facts.types';
import { makeFacts, mkPlaybook, mkSeries, mkSkill, promptSeries } from '../testing/facts-fixture';
import { AI0_GLOBAL_SKILLS, NANOBANANA_SKILL, PROMPTHERO_SKILL } from './real-skills-1027';

/**
 * Spec 072 T5, A1–A3, L10: the 10-27 onboarding review as three `ChannelFacts`, built by hand (the export has no card sources,
 * no tools lists, no pauses, no dataset stats). Source: `tmp/agent-export-20261026-2054.tar.gz`; only field values are copied,
 * no tokens and no other ids. Skill texts are data.
 *
 * REAL (copied from the export):
 *   - @ai0_prompts_dev: the card (mode live, language mixed, formats {photo: 1}, hashtags [], hashtag min 0 / max 3, sources [],
 *     tools_allow null); the series «Prompt» (name, brief, format photo, cadence daily@12:00,20:00, origin owner, locked,
 *     active); the texts of the skills prompthero-image-prompt-post (7a054c4f) and nanobanana-github-prompt-post (d3ef5edb).
 *   - @pdr_dev_channel: the card (mode live, language uk, formats {poll 0.6, text 0.1, photo 0.3}, hashtags [], sources [],
 *     tools_allow null); no series in the active playbook; the pdr_questions schema (roles, reuse `never`, post_requires `[]`);
 *     866 ledger uses, the last one on 2026-06-17 (so none in the last 28 days).
 *   - @ai0_global: the card (mode live, language uk, eight formats at 1, hashtags [], sources [], tools_allow null); the
 *     Telegram section of the active playbook; the series «AI-новини дня» and «MCP-сервер тижня» (briefs, cadences, `free`
 *     sources, `suggested`); its two enabled skills (post-promises-and-terms, prompts-chat-source); 83 `data://assets` ledger uses
 *     with no series on them (so no dataset fact: a binding is declared, never derived from the ledger).
 *
 * SYNTHETIC (the export does not hold it):
 *   - the Prompt series' source `{ kind: 'library', table: 'prompts' }` and `source_mode: 'required'` (A2; the export has
 *     none and `suggested`);
 *   - the skill `prompt-origin-synthetic` whose whole text is «Для рядків library став origin=original.» (A1; the real
 *     nanobanana v4 text does not trip `originWithSource`);
 *   - the `prompts` dataset: roles, 1200 rows of which 860 cannot be posted, `prompt_text` filled in 30 % of the rows, the 083
 *     `post_requires` rule `[['page_url'], ['prompt_text', 'media_url']]`;
 *   - the card source `{ kind: 'library', ref: 'pdr_questions' }` of @pdr_dev_channel and its 866 rows, all used (the dataset
 *     fact: 866 rows, 0 unused);
 *   - the open pause of «AI-новини дня» (cause `source_unreachable`, 3 skips);
 *   - the playbook sections of @ai0_prompts_dev and @pdr_dev_channel (the doctor only needs one to exist), the agents' ids and
 *     `now` (2026-10-27 08:00 UTC).
 */

export const PROMPTS_DEV = '@ai0_prompts_dev';
export const PDR_DEV = '@pdr_dev_channel';
export const AI0_GLOBAL = '@ai0_global';
export const REVIEW_NOW = new Date('2026-10-27T08:00:00.000Z');

/** The synthetic skill of A1: one sentence that pairs origin=original with a library row. */
export const ORIGIN_SYNTHETIC: SkillFact = mkSkill({
  id: 'prompt-origin-synthetic', name: 'prompt-origin-synthetic', description: 'Як ставити origin у постах з бази промптів', body: 'Для рядків library став origin=original.',
});

const asSkill = (s: { id: string; name: string; description: string; body: string; inline?: boolean }): SkillFact =>
  mkSkill({ id: s.id, name: s.name, description: s.description, body: s.body, inline: s.inline ?? false });

/** The 083 rule of the `prompts` dataset: a row passes with a page url, or with a prompt text or a picture (so the text may be empty). */
export const POST_REQUIRES_083 = [['page_url'], ['prompt_text', 'media_url']];
/** The 095 rule: a prompt text, and a picture. */
export const POST_REQUIRES_095 = [['prompt_text'], ['media_url']];

export const promptsDataset = (postRequires: string[][] = POST_REQUIRES_083) => ({
  id: 'ds-prompts', key: 'prompts', entity: 'image_prompt', version: 3,
  roles: { title: 'title', body: 'prompt_text', image: 'media_url', source_url: 'page_url' } as Record<string, string | string[]>,
  reusePolicy: { kind: 'never' } as const, postRequires,
  fillRate: { title: 1, page_url: 1, media_url: 0.9, prompt_text: 0.3 } as Record<string, number>,
  rows: 1200, notPostable: 860, unusedPostable: 340, used28: 38,
});

/** @ai0_prompts_dev before the 10-27 fixes: two skills send the writer to other sources, a third marks library rows as original, and the text is mostly missing. */
export function promptsDevFacts(over: { skills?: SkillFact[]; postRequires?: string[][] } = {}): ChannelFacts {
  const ref = `telegram:${PROMPTS_DEV}`;
  return makeFacts({
    now: REVIEW_NOW, channelKey: PROMPTS_DEV, agentHandle: 'ai0_prompts_dev',
    card: { mode: 'live', title: null, language: 'mixed', formats: { photo: 1 }, hashtags: [], hashtagMin: 0, hashtagMax: 3, sources: [], toolsAllow: null },
    playbook: mkPlaybook([promptSeries({ resource_ref: ref })], { platforms: [{ resource_ref: ref, role: 'core', formats: { photo: 1 }, per_day: { min: 2, max: 2 } }] }),
    skills: over.skills ?? [asSkill(PROMPTHERO_SKILL), asSkill(NANOBANANA_SKILL), ORIGIN_SYNTHETIC],
    datasets: [promptsDataset(over.postRequires)],
  });
}

/** @pdr_dev_channel before the 10-27 fixes: every one of the 866 questions was used, and no series reads the dataset. */
export function pdrDevFacts(): ChannelFacts {
  const ref = `telegram:${PDR_DEV}`;
  return makeFacts({
    now: REVIEW_NOW, channelKey: PDR_DEV, agentHandle: 'pdr_dev_channel',
    card: {
      mode: 'live', title: null, language: 'uk', formats: { poll: 0.6, text: 0.1, photo: 0.3 }, hashtags: [], hashtagMin: 0, hashtagMax: 3, toolsAllow: null,
      sources: [{ id: 'src-pdr', kind: 'library', ref: 'pdr_questions' }],
    },
    playbook: mkPlaybook([], { platforms: [{ resource_ref: ref, role: 'core', formats: { poll: 0.6, text: 0.1, photo: 0.3 }, per_day: { min: 2, max: 6 } }] }),
    datasets: [{
      id: 'ds-pdr', key: 'pdr_questions', entity: 'quiz_question', version: 1,
      roles: { body: 'explanation', image: 'image_url', title: 'text', license: 'license', source_url: 'source_url', source_name: 'source_name' },
      reusePolicy: { kind: 'never' }, postRequires: null, fillRate: null,
      rows: 866, notPostable: 0, unusedPostable: 0, used28: 0,
    }],
  });
}

/** @ai0_global, the channel that worked: free-sourced series, no dataset, one synthetic pause. */
export function ai0GlobalFacts(): ChannelFacts {
  const ref = `telegram:${AI0_GLOBAL}`;
  const formats = { poll: 0.01, quiz: 0.05, text: 0.2, album: 0.1, photo: 0.25, video: 0.05, carousel: 0.1, longread: 0.2 };
  return makeFacts({
    now: REVIEW_NOW, channelKey: AI0_GLOBAL, agentHandle: 'ai_global',
    card: {
      mode: 'live', title: 'Айра', language: 'uk', hashtags: [], hashtagMin: 0, hashtagMax: 5, sources: [], toolsAllow: null,
      formats: { poll: 1, quiz: 1, text: 1, album: 1, photo: 1, video: 1, carousel: 1, longread: 1 },
    },
    playbook: mkPlaybook([
      mkSeries({
        name: 'AI-новини дня', resource_ref: ref, format: 'text', cadence: 'daily@12:00', source: { kind: 'free' }, source_mode: 'suggested', origin: 'agent', locked: false,
        brief: 'Щоденна добірка 2–3 головних новин ШІ. Джерела: 1) marktechpost (www.marktechpost.com) — не більше 2 постів на тиждень; 2) запасні першоджерела — офіційні блоги OpenAI/Google/Meta/Anthropic та huggingface.co/blog. Кожну цифру й назву звіряти з першоджерелом; посилання давати на першоджерело (блог компанії, Hugging Face, GitHub, arXiv). Якщо свіжого матеріалу немає — взяти запасне першоджерело, а не пропускати слот. Заголовок, 2–3 речення простими словами, одне посилання.',
      }),
      mkSeries({
        name: 'MCP-сервер тижня', resource_ref: ref, format: 'longread', cadence: 'weekly:wed@18:00', source: { kind: 'free' }, source_mode: 'suggested', origin: 'agent', locked: false,
        brief: 'Раз на тиждень — огляд нового MCP-сервера або AI-інструменту з marktechpost: що вміє, кому знадобиться, як спробувати. Матеріал — через fetch_feed з RSS marktechpost.',
      }),
    ], { platforms: [{ resource_ref: ref, role: 'core', formats, per_day: { min: 2, max: 6 }, hashtag_policy: { min: 0, max: 0, vocab: [] }, tone: 'Інформативний, лаконічний, uk' }] }),
    skills: AI0_GLOBAL_SKILLS.map(asSkill),
    pauses: [{
      id: 'pause-ai-news', channelKey: AI0_GLOBAL, key: 'series:AI-новини дня', label: 'AI-новини дня', cause: 'source_unreachable',
      reason: 'the source did not answer', streak: 3, pausedAt: new Date('2026-10-26T06:00:00.000Z'), resumedAt: null, resumedBy: null,
    }],
  });
}
