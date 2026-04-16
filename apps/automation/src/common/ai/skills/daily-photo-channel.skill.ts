import { Skill } from './skill.interface';

/**
 * Tone and style rules for a Ukrainian astronomy / daily photo Telegram channel.
 * Audience: people who love astronomy and beautiful space imagery.
 */
export const DAILY_PHOTO_CHANNEL_SKILL: Skill = {
  name: 'daily-photo-channel',
  instructions: `
## Daily Photo Channel Rules

### Audience
Readers love astronomy and beautiful space imagery. They come for visual wonder and fascinating stories about the cosmos.
Translate scientific explanations to be accessible but accurate in Ukrainian.

### Names and terms
Keep proper astronomical names (nebulae, galaxies, missions, spacecraft, telescopes) in their standard internationally recognized form.
Ukrainian verbs and sentence structure, original proper nouns.
Good: "Телескоп James Webb зафіксував туманність Carina"
Bad: "Джеймс Вебб", "Каріна"

### Tone
Make it feel like a fascinating story about the cosmos.
Not a dry scientific report. Not a breathless pop-science article.
An informed narrator sharing something beautiful and remarkable.

### Scientific accuracy
Never simplify to the point of being wrong.
If the source says "supernova remnant" do not call it "explosion in space."
Keep distances, dates, catalog numbers when they add value.`,
};
