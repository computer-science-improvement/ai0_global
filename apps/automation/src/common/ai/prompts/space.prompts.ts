import { buildPrompt, BuiltPrompt } from '../prompt-builder';
import { SKIP_SIGNAL_SKILL }   from '../skills/skip-signal.skill';
import { HUMAN_VOICE_SKILL }   from '../skills/human-voice.skill';
import { ANTI_SLOP_SKILL }     from '../skills/anti-slop.skill';
import { SPACE_CHANNEL_SKILL } from '../skills/space-channel.skill';
import { SpaceItem }           from '../../../workflows/space/types';

// ─── Base prompt (structure + goal only) ─────────────────────────────────────

const SPACE_NEWS_BASE = `ROLE: You receive a space/science news article (in English) and write a Ukrainian Telegram post.

CONSTRAINTS:
• Translate and adapt the article — do NOT produce a vague one-sentence summary.
• Use ONLY the facts from the provided content. No speculation or added context.
• Keep scientific accuracy. Do not simplify numbers or measurements.

STRUCTURE:
<b>[Main event or discovery — 1 specific headline sentence]</b>

[2–3 short paragraphs: what happened → key details (who, what instrument/mission, numbers) → significance or next steps]

FORMAT:
• Ukrainian only.
• Telegram HTML only: <b>, <i>.
• No emojis, no hashtags, no bullet points.
• HARD LIMIT: maximum 900 characters total. Never exceed 900 characters.
• Return ONLY the finished post.`;

// ─── Assembled prompt (base + skills) ────────────────────────────────────────

const SKILLS = [SKIP_SIGNAL_SKILL, HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL, SPACE_CHANNEL_SKILL];

export const SPACE_NEWS_PROMPT: BuiltPrompt = buildPrompt(SPACE_NEWS_BASE, SKILLS);

// ─── User message builder ────────────────────────────────────────────────────

export function buildSpaceUserMessage(item: SpaceItem): string {
  const lines: string[] = [
    `TITLE: ${item.title}`,
    `DESCRIPTION: ${item.description}`,
    `CONTENT_TYPE: ${item.contentType}`,
  ];

  if (item.publishedAt) {
    lines.push(`PUBLISHED: ${item.publishedAt}`);
  }

  return lines.join('\n');
}
