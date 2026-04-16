import { buildPrompt, BuiltPrompt } from '../prompt-builder';
import { SKIP_SIGNAL_SKILL }   from '../skills/skip-signal.skill';
import { HUMAN_VOICE_SKILL }   from '../skills/human-voice.skill';
import { ANTI_SLOP_SKILL }     from '../skills/anti-slop.skill';
import { GAMING_CHANNEL_SKILL } from '../skills/gaming-channel.skill';
import { GameChannelItem }     from '../../../workflows/game-channel/types';

// ─── Base prompts (structure + goal only) ────────────────────────────────────

const GIVEAWAY_BASE = `ROLE: You receive data about a free game giveaway and write a Telegram post in Ukrainian.

CONSTRAINTS:
• Use ONLY the provided data. No new facts, assumptions, or context.
• Do not remove or change factual meaning.

STRUCTURE:
<b>[What is free + platform — 1 sentence]</b>

[2–3 sentences: what the game is + how to claim, written as prose]

[If END_DATE is present and not "N/A": "Доступно до: {date}"]

FORMAT:
• Ukrainian only.
• Telegram HTML only: <b>, <i>, <code>, <a href="...">.
• No emojis, no hashtags, no bullet points.
• HARD LIMIT: maximum 900 characters total. Never exceed 900 characters.
• Return ONLY the finished post.`;

const DEAL_BASE = `ROLE: You receive an English description of a game and write a short Ukrainian summary.

CONSTRAINTS:
• Use ONLY the provided description. No new facts or assumptions.
• 1–2 sentences only. Describe what the game is and what makes it notable.
• Do not mention price, discount, platform, or rating — that is added separately.

FORMAT:
• Ukrainian only.
• Plain text, no HTML tags, no emojis, no hashtags.
• Maximum 200 characters.
• Return ONLY the description text, nothing else.`;

const NEWS_BASE = `ROLE: You receive a gaming news article (in English) and write a Ukrainian Telegram post.

CONSTRAINTS:
• Translate and adapt — do NOT produce a vague one-sentence summary.
• Use ONLY the facts from the provided content.
• Do not add opinions, background, or speculation.

STRUCTURE:
<b>[Main event — 1 specific sentence]</b>

[3–4 short paragraphs: what happened → key details → numbers/dates → consequence or context]

FORMAT:
• Ukrainian only.
• Telegram HTML only: <b>, <i>, <code>, <a href="...">.
• No emojis, no hashtags, no bullet points.
• HARD LIMIT: maximum 900 characters total. Never exceed 900 characters.
• Return ONLY the finished post.`;

// ─── Assembled prompts (base + skills) ───────────────────────────────────────

const SKILLS = [SKIP_SIGNAL_SKILL, HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL, GAMING_CHANNEL_SKILL];

export const GAME_PROMPTS: Record<GameChannelItem['type'], BuiltPrompt> = {
  giveaway: buildPrompt(GIVEAWAY_BASE, SKILLS),
  deal:     buildPrompt(DEAL_BASE,     SKILLS),
  news:     buildPrompt(NEWS_BASE,     SKILLS),
};

// ─── User message builder ─────────────────────────────────────────────────────

export function buildGameChannelUserMessage(item: GameChannelItem): string {
  const lines: string[] = [`TITLE: ${item.title}`];

  if (item.description) lines.push(`DESCRIPTION: ${item.description}`);

  if (item.type === 'giveaway') {
    if (item.instructions) lines.push(`HOW TO CLAIM: ${item.instructions}`);
    if (item.platform)     lines.push(`PLATFORM: ${item.platform}`);
    lines.push(`END_DATE: ${item.endDate ?? 'N/A'}`);
  }

  // For deals, AI only needs title + description to generate a short summary.
  // All metadata (price, rating, specs) is added programmatically.

  return lines.join('\n');
}

/**
 * Build the final deal post programmatically.
 * AI-generated description is inserted into a fixed template.
 */
export function buildDealPost(item: GameChannelItem, description: string): string {
  const lines: string[] = [];

  lines.push(`<b>${item.title} зі знижкою ${item.discount}%</b>`);
  lines.push('');

  if (description) lines.push(description);
  lines.push('');

  if (item.salePrice && item.origPrice) {
    const discountTag = item.discount ? ` — знижка ${item.discount}%` : '';
    lines.push(`Ціна: ${item.salePrice} (було ${item.origPrice})${discountTag}`);
  }
  if (item.reviewScore) {
    const count = item.reviewCount
      ? ` (${item.reviewCount.toLocaleString('en-US')})`
      : '';
    lines.push(`Рейтинг: ${item.reviewScore}${count}`);
  }
  if (item.genres?.length) {
    lines.push(`Жанр: ${item.genres.join(', ')}`);
  }
  if (item.minRam || item.minStorage) {
    const parts: string[] = [];
    if (item.minRam)     parts.push(`RAM: ${item.minRam}`);
    if (item.minStorage) parts.push(`Диск: ${item.minStorage}`);
    lines.push(parts.join(' | '));
  }

  return lines.join('\n');
}
