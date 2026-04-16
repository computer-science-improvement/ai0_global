import { buildPrompt, BuiltPrompt } from '../prompt-builder';
import { SKIP_SIGNAL_SKILL }          from '../skills/skip-signal.skill';
import { HUMAN_VOICE_SKILL }          from '../skills/human-voice.skill';
import { ANTI_SLOP_SKILL }            from '../skills/anti-slop.skill';
import { ON_THIS_DAY_CHANNEL_SKILL }  from '../skills/on-this-day-channel.skill';

// ─── Base prompt ─────────────────────────────────────────────────────────────

const ON_THIS_DAY_BASE = `ROLE: You receive a list of historical events and notable births that happened on this day, and write a Ukrainian Telegram post.

CONSTRAINTS:
• Use ONLY the provided data. No new facts, assumptions, or context.
• Do not remove or change factual meaning.

STRUCTURE:
<b>Цей день в історії — {day} {month_name_ua}</b>

[Events: each as a short paragraph — year + what happened, in Ukrainian]

[Notable births section, if space allows]

FORMAT:
• Ukrainian only.
• Telegram HTML only: <b>, <i>, <code>, <a href="...">.
• No emojis, no hashtags, no bullet points.
• HARD LIMIT: maximum 900 characters total. Never exceed 900 characters.
• Return ONLY the finished post.`;

// ─── Assembled prompt (base + skills) ────────────────────────────────────────

const SKILLS = [SKIP_SIGNAL_SKILL, HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL, ON_THIS_DAY_CHANNEL_SKILL];

export const ON_THIS_DAY_PROMPT: BuiltPrompt = buildPrompt(ON_THIS_DAY_BASE, SKILLS);

// ─── User message builder ────────────────────────────────────────────────────

export function buildOnThisDayUserMessage(
  events: { year: string; description: string }[],
  births: { year: string; description: string }[],
): string {
  const lines: string[] = [];

  lines.push('EVENTS:');
  for (const e of events) {
    lines.push(`- ${e.year}: ${e.description}`);
  }

  if (births.length) {
    lines.push('');
    lines.push('BIRTHS:');
    for (const b of births) {
      lines.push(`- ${b.year}: ${b.description}`);
    }
  }

  return lines.join('\n');
}
