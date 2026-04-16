import { buildPrompt, BuiltPrompt } from '../prompt-builder';
import { HUMAN_VOICE_SKILL }       from '../skills/human-voice.skill';
import { ANTI_SLOP_SKILL }         from '../skills/anti-slop.skill';
import { MOVIES_CHANNEL_SKILL }    from '../skills/movies-channel.skill';
import { MovieItem }               from '../../../workflows/movies/types';

// ─── Base prompt ─────────────────────────────────────────────────────────────

const MOVIE_DESC_BASE = `ROLE: You receive an English overview of a movie or TV series and write a short Ukrainian description.

CONSTRAINTS:
• Translate and adapt the overview to Ukrainian. 2-3 sentences.
• Capture what makes the movie/series interesting — premise and one hook.
• Use ONLY the provided data. No new facts, assumptions, or spoilers.

FORMAT:
• Ukrainian only.
• Plain text, no HTML tags, no emojis, no hashtags.
• Maximum 200 characters.
• Return ONLY the description text, nothing else.`;

// ─── Assembled prompt (base + skills) ────────────────────────────────────────

const SKILLS = [HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL, MOVIES_CHANNEL_SKILL];

export const MOVIE_PROMPT: BuiltPrompt = buildPrompt(MOVIE_DESC_BASE, SKILLS);

// ─── User message builder ────────────────────────────────────────────────────

export function buildMovieUserMessage(item: MovieItem): string {
  const lines: string[] = [
    `TITLE: ${item.title}`,
    `ORIGINAL TITLE: ${item.originalTitle}`,
    `OVERVIEW: ${item.overview}`,
    `GENRES: ${item.genreNames.join(', ')}`,
  ];
  return lines.join('\n');
}

// ─── Programmatic post builder ───────────────────────────────────────────────

export function buildMoviePost(item: MovieItem, description: string): string {
  const year = item.releaseDate ? new Date(item.releaseDate).getFullYear() : '';
  const lines: string[] = [];

  lines.push(`<b>${item.title}</b>${year ? ` (${year})` : ''}`);
  lines.push('');

  if (description) lines.push(description);
  lines.push('');

  lines.push(`\u2B50 ${item.voteAverage}/10 (${item.voteCount.toLocaleString('en-US')} votes)`);
  if (item.genreNames.length) {
    lines.push(`\uD83C\uDFAC ${item.genreNames.join(', ')}`);
  }

  return lines.join('\n');
}
