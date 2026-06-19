// recipe-caption-parts.ts — the single source of truth for a recipe post's
// caption, broken into labelled, source-tagged PARTS. Both the publisher and
// the dashboard Post-Preview render from these parts via renderParts(), so the
// preview is byte-identical to what publishes.
//
// Defaults reproduce the previous output exactly; an operator can override the
// editable parts (cta / hashtags / intro / outro / tgLinkLabel) per binding via
// `params.metaCaption`. Recipe-derived parts (title / category / macros) are
// read-only — they come from the recipe row.
import type { RecipeRow } from '../recipes/recipes.repository';
import type { DestinationPlatform } from '../../common/content-strategy/publish-destination';
import { macrosLine } from './recipe-carousel.map';
import { recipeHashtags } from '../../common/content-strategy/meta-caption.util';

export interface MetaCaptionOverrides {
  cta?:         string;
  hashtags?:    string[];
  intro?:       string;
  outro?:       string;
  tgLinkLabel?: string;
}

export type PartSource = 'recipe' | 'computed' | 'static' | 'generated' | 'custom';

export interface CaptionPart {
  key:       string;
  label:     string;
  source:    PartSource;
  value:     string;
  /** Platforms this part renders on. */
  platforms: DestinationPlatform[];
  /** Whether the operator can override this part via params.metaCaption. */
  editable:  boolean;
}

const DEFAULT_CTA = 'Повний рецепт — гортай 👉';
const DEFAULT_TG_LABEL = '📲 Більше рецептів у Telegram:';

const ALL:  DestinationPlatform[] = ['telegram', 'instagram', 'facebook', 'threads'];
const META: DestinationPlatform[] = ['instagram', 'facebook', 'threads'];
const LINK: DestinationPlatform[] = ['facebook', 'threads'];

/**
 * Build the ordered caption parts for a recipe. `telegramLink` is the resolved
 * group channel link (or null when the group has no public @username).
 */
export function buildRecipeCaptionParts(
  row: RecipeRow,
  opts: { overrides?: MetaCaptionOverrides; telegramLink?: string | null } = {},
): CaptionPart[] {
  const o = opts.overrides ?? {};
  const category = row.category ?? '';
  const hashtags = (o.hashtags && o.hashtags.length ? o.hashtags : recipeHashtags(category));
  const tgLabel = o.tgLinkLabel ?? DEFAULT_TG_LABEL;

  const parts: CaptionPart[] = [
    { key: 'intro',    label: 'Intro',         source: 'custom',    value: o.intro ?? '',                         platforms: ALL,  editable: true },
    { key: 'title',    label: 'Title',         source: 'recipe',    value: row.title_uk ?? '',                    platforms: ALL,  editable: false },
    { key: 'category', label: 'Category',      source: 'recipe',    value: category ? `🍽️ ${category}` : '',      platforms: ALL,  editable: false },
    { key: 'macros',   label: 'Macros',        source: 'computed',  value: macrosLine(row),                        platforms: ALL,  editable: false },
    { key: 'cta',      label: 'Call to action',source: o.cta != null ? 'custom' : 'static', value: o.cta ?? DEFAULT_CTA, platforms: ALL, editable: true },
    { key: 'outro',    label: 'Outro',         source: 'custom',    value: o.outro ?? '',                         platforms: ALL,  editable: true },
    { key: 'hashtags', label: 'Hashtags',      source: o.hashtags?.length ? 'custom' : 'generated', value: hashtags.map((h) => `#${h}`).join(' '), platforms: META, editable: true },
    { key: 'tgLink',   label: 'Telegram link', source: 'generated', value: opts.telegramLink ? `${tgLabel} ${opts.telegramLink}` : '', platforms: LINK, editable: true },
  ];
  return parts;
}

/** Render the parts that apply to `platform`, in order, skipping empty values. */
export function renderParts(parts: CaptionPart[], platform: DestinationPlatform): string {
  return parts
    .filter((p) => p.platforms.includes(platform) && p.value.trim() !== '')
    .map((p) => p.value)
    .join('\n\n');
}
