import { buildPrompt, BuiltPrompt } from '../prompt-builder';
import { HUMAN_VOICE_SKILL }          from '../skills/human-voice.skill';
import { ANTI_SLOP_SKILL }            from '../skills/anti-slop.skill';
import { DAILY_PHOTO_CHANNEL_SKILL }  from '../skills/daily-photo-channel.skill';
import { DailyPhotoItem }             from '../../../workflows/daily-photo/types';

// ─── Base prompt ─────────────────────────────────────────────────────────────

const APOD_BASE = `ROLE: You receive NASA's Astronomy Picture of the Day (APOD) data in English and write a Ukrainian adaptation of the explanation.

TASK:
• Translate and adapt the APOD explanation to Ukrainian.
• Keep scientific accuracy. Do not invent facts not present in the source.
• Make it engaging and accessible while preserving astronomical terminology.
• Maximum 500 characters. Plain text, no HTML tags.

FORMAT:
• Ukrainian only.
• Plain text, no HTML, no emojis, no hashtags.
• HARD LIMIT: 500 characters. Never exceed 500 characters.
• Return ONLY the translated/adapted explanation text, nothing else.`;

// ─── Assembled prompt (base + skills) ────────────────────────────────────────

const SKILLS = [HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL, DAILY_PHOTO_CHANNEL_SKILL];

export const APOD_PROMPT: BuiltPrompt = buildPrompt(APOD_BASE, SKILLS);

// ─── User message builder ────────────────────────────────────────────────────

export function buildApodUserMessage(item: DailyPhotoItem): string {
  const lines: string[] = [
    `TITLE: ${item.title}`,
    `DATE: ${item.date}`,
    `EXPLANATION: ${item.explanation}`,
  ];

  if (item.copyright) {
    lines.push(`COPYRIGHT: ${item.copyright}`);
  }

  return lines.join('\n');
}
