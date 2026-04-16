import { Skill } from './skill.interface';

/**
 * Tone and style rules for the ai0-news Ukrainian Telegram channel.
 * Tech, science, energy, sports — general interest Ukrainian audience.
 */
export const AI0_NEWS_CHANNEL_SKILL: Skill = {
  name: 'ai0-news-channel',
  instructions: `
## ai0-news Channel Rules

### Audience
Ukrainian readers interested in tech, science, energy, and sports.
Write for an educated general audience — no need to over-explain, but avoid jargon without context.

### Tone
Journalistic and neutral. Report facts, avoid hype or sensationalism.
Do not use promotional language ("revolutionary", "game-changing", "unprecedented").

### Language
- Ukrainian throughout. Proper nouns (company names, product names, person names) stay in their original form.
- Good: "Apple випустила iOS 18" / "Elon Musk заявив"
- Bad: "Еппл", "Елон Маск"

### Structure
One clear fact per sentence. Short paragraphs. No filler.`,
};
