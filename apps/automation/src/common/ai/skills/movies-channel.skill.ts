import { Skill } from './skill.interface';

/**
 * Tone and style rules for a Ukrainian movies/series Telegram channel.
 * Audience: movie and series fans who follow trends and new releases.
 */
export const MOVIES_CHANNEL_SKILL: Skill = {
  name: 'movies-channel',
  instructions: `
## Movies Channel Rules

### Audience
Readers are Ukrainian movie and series fans. They follow new releases, trending titles, and industry news.
Write engaging short descriptions that capture what makes a movie or series interesting.

### Names and terms
Movie and series titles stay in original language — never translate or transliterate.
Director and actor names: use standard Ukrainian transliteration for well-known figures (e.g., Крістофер Нолан, Тімоті Шаламе).
Less known names: keep in original.

### Tone
Informative, brief, direct. Describe what the movie/series is about and what makes it notable.
Do not use "must-watch", "masterpiece", "legendary", "iconic" or similar cliches.
Do not use "recommend", "worth watching", "don't miss" — let the facts speak.

### Length
Descriptions: 2-3 sentences max. Capture the premise and one hook.
No spoilers. No plot summaries beyond the basic premise.`,
};
