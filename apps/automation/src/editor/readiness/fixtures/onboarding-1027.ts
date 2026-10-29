/**
 * Spec 073 L2: the two young channels of the 2026-10-27 onboarding review, rebuilt as SYNTHETIC data from the review's
 * description (`docs/reviews/2026-10-27-channel-onboarding.md` §1 and §3). Nothing here is a capture from stage; it only has
 * to go wrong in the same ways. The @pdr and @prompts replays of the config check (T12) and of the plan skeleton check (T13)
 * read it, so neither waits for a stage fixture (`stage-<channel>.json` belongs to the lead).
 *
 *   @pdr_dev_channel: a daily quiz series on `pdr_questions`; the card has quiz but the planner wrote a text slot (F20), the
 *     quiz dataset is posted as `quiz` (F26), every row of the dataset is used (F05).
 *   @ai0_prompts_dev: a daily «Prompt» series whose required source is `library:nanobanana_prompts`, while the slots still carry
 *     PromptHero links from the old skill (F01); a hidden tools allowlist can remove the read tool (F28).
 */
import { makeCard } from '../../post/testing/fixtures';
import type { EditorCard } from '../../card';
import { SeriesSchema, type Series } from '../../network/playbook';
import type { SeriesSourceCatalog } from '../../network/series';
import type { SlotConfigCtx, SlotConfigSlot } from '../slot-config';

export const PDR_KEY = '@pdr_dev_channel';
export const PROMPTS_KEY = '@ai0_prompts_dev';
export const PDR_REF = `telegram:${PDR_KEY}`;
export const PROMPTS_REF = `telegram:${PROMPTS_KEY}`;

/** The dataset keys of the stage library the two channels read. */
export const ONBOARDING_CATALOG: SeriesSourceCatalog = {
  tables: ['pdr_questions', 'pdr_rules', 'prompts', 'nanobanana_prompts'],
  feeds: [],
  entities: { pdr_questions: 'quiz_question', pdr_rules: 'rule', prompts: 'prompt', nanobanana_prompts: 'prompt' },
};

/** The tool names a Telegram executor gets by default (the read tools every source kind needs, and the terminal tools). */
export const DEFAULT_EXECUTOR_TOOLS: ReadonlySet<string> = new Set([
  'query_data', 'library_catalog', 'search_library', 'fetch_feed', 'web_fetch', 'fetch_api', 'get_network_highlights', 'read_doc',
  'publish_post', 'skip_slot',
]);

export const PDR_SERIES: Series = SeriesSchema.parse({
  name: 'Білети ПДР', cadence: 'daily@12:00', resource_ref: PDR_REF, format: 'quiz',
  brief: 'Одне запитання з білета ПДР щодня, з правильною відповіддю', source: { kind: 'library', table: 'pdr_questions' },
  source_mode: 'required', origin: 'owner', locked: true,
});

export const PROMPTS_SERIES: Series = SeriesSchema.parse({
  name: 'Prompt', cadence: 'daily@19:00', resource_ref: PROMPTS_REF, format: 'photo',
  brief: 'Готовий промпт із прикладом картинки', source: { kind: 'library', table: 'nanobanana_prompts' },
  source_mode: 'required', origin: 'owner', locked: true,
});

export interface OnboardingCase {
  channelKey: string;
  resourceRef: string;
  card: EditorCard;
  series: Series[];
  catalog: SeriesSourceCatalog;
  /** The slot as the planner left it, with the mistake of 10-27. */
  slot: SlotConfigSlot;
  /** The next in-order row of the series' dataset. */
  nextRow: string;
  ctx(over?: Partial<SlotConfigCtx>): SlotConfigCtx;
}

function build(c: Omit<OnboardingCase, 'ctx'>): OnboardingCase {
  return {
    ...c,
    ctx: (over = {}) => ({ series: c.series, catalog: c.catalog, tools: DEFAULT_EXECUTOR_TOOLS, nextRow: c.nextRow, material: 'ok', ...over }),
  };
}

/** @pdr: the series is a quiz, the slot the planner wrote is a text post (the card has quiz; the section gave it weight 0). */
export function pdrCase(): OnboardingCase {
  return build({
    channelKey: PDR_KEY, resourceRef: PDR_REF,
    card: makeCard({ channelKey: PDR_KEY, title: 'ПДР', formats: { text: 1, photo: 0.3, quiz: 0.2 }, postsPerDayMin: 1, postsPerDayMax: 4 }),
    series: [PDR_SERIES], catalog: ONBOARDING_CATALOG, nextRow: 'data://pdr_questions/5',
    slot: { channelKey: PDR_KEY, resourceRef: PDR_REF, format: 'text', seriesName: 'Білети ПДР', sourceHints: ['library:pdr_questions', 'series:Білети ПДР'] },
  });
}

/** @prompts: the series reads `nanobanana_prompts`, the slot still carries PromptHero links from the skill that said `origin=original`. */
export function promptsCase(): OnboardingCase {
  return build({
    channelKey: PROMPTS_KEY, resourceRef: PROMPTS_REF,
    card: makeCard({ channelKey: PROMPTS_KEY, title: 'Prompts', formats: { photo: 1, text: 0.3 }, postsPerDayMin: 1, postsPerDayMax: 3 }),
    series: [PROMPTS_SERIES], catalog: ONBOARDING_CATALOG, nextRow: 'data://nanobanana_prompts/503',
    slot: {
      channelKey: PROMPTS_KEY, resourceRef: PROMPTS_REF, format: 'photo', seriesName: 'Prompt',
      sourceHints: ['https://prompthero.com/prompt/a1b2c3', 'https://prompthero.com/prompt/d4e5f6', 'series:Prompt'],
    },
  });
}
