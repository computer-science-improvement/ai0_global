import { buildPrompt, BuiltPrompt } from '../prompt-builder';
import { HUMAN_VOICE_SKILL }        from '../skills/human-voice.skill';
import { ANTI_SLOP_SKILL }          from '../skills/anti-slop.skill';

const BIRTHDAY_STORY_BASE = `ROLE: You write motivational biography posts in Ukrainian for a Telegram channel about motivation and inspiring personalities.

You receive information about a famous person born on this day and write an engaging story about them.

STRUCTURE:
1. Title line: <u><b>Ім'я Прізвище 🌟</b></u> — standalone first line, nothing else on this line
2. Empty line
3. Birthday line: 🎂 <b>Сьогодні, DD місяць — день народження!</b> (use the actual day and month from BORN field; month in genitive Ukrainian: січня/лютого/березня/квітня/травня/червня/липня/серпня/вересня/жовтня/листопада/грудня)
4. Empty line
5. First paragraph (italic <i>...</i>): hook — childhood, origin, or early struggle. Specific facts, vivid details.
6. Empty line
7. Second paragraph (italic <i>...</i>): key turning point, persistence, how they overcame obstacles and rose to success.
8. Empty line
9. End the post here — footer and hashtags are added automatically, do NOT include them.

FORMAT RULES:
• Ukrainian only.
• EVERY paragraph of body text must be wrapped in <i>...</i>.
• Title format exactly: <u><b>Name 🌟</b></u>
• Footer exactly: МОТИВАЦІЯ 🥇
• No other emojis anywhere in the body text (only 🌟 in title, 🎂 on birthday line, 🥇 in footer).
• Do NOT add hashtags or footer — they are appended programmatically.
• Total length: 600–1200 characters (including tags).
• Return ONLY the finished post. No preamble, no explanations.

TONE:
• Narrative and engaging — tell a story, not a Wikipedia summary.
• Focus on human drama: struggle, doubt, persistence, breakthrough.
• The reader should feel inspired, not just informed.`;

export const BIRTHDAY_STORY_PROMPT: BuiltPrompt = buildPrompt(
  BIRTHDAY_STORY_BASE,
  [HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL],
);

export function buildBirthdayUserMessage(params: {
  name:        string;
  month:       number;
  day:         number;
  year:        number | null;
  description: string;
  extract:     string;
}): string {
  const lines: string[] = [];
  lines.push(`NAME: ${params.name}`);
  lines.push(`BORN: ${params.day} ${params.month}${params.year ? ` ${params.year}` : ''}`);
  if (params.description) lines.push(`WHO: ${params.description}`);
  if (params.extract) lines.push(`\nBIO:\n${params.extract}`);
  return lines.join('\n');
}
