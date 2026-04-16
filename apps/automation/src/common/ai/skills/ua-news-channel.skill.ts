import { Skill } from './skill.interface';

/**
 * Tone and style rules for Ukrainian tech-news channels.
 * Used by ua-news strategy for dev.ua, speka.ua, itc.ua feeds.
 */
export const UA_NEWS_CHANNEL_SKILL: Skill = {
  name: 'ua-news-channel',
  instructions: `
## ua-news Channel Rules

### Audience
Ukrainian readers interested in tech, startups, gadgets, and IT industry.

### Tone
Journalistic and neutral. Report facts clearly.
No hype ("революційний", "неймовірний", "game-changing").
No advertising language.

### Language
- Ukrainian throughout.
- Proper nouns (company names, product names, person names) stay in original form.
- Good: "Apple випустила iOS 18", "Elon Musk заявив"
- Bad: "Еппл", "Елон Маск"

### Structure
- One clear fact per sentence. Short paragraphs. No filler.
- Keep the summary concise — up to 800 characters.
- Preserve key numbers, dates, names from the original.`,
};
