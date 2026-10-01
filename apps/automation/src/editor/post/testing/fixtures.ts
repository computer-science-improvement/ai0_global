import type { EditorCard } from '../../card';
import { PostSpec, PostSpecSchema } from '../post-spec';

export function makeCard(over: Partial<EditorCard> = {}): EditorCard {
  return {
    channelKey: '@chan', mode: 'shadow', title: 'Тест', language: 'uk', timezone: 'Europe/Kyiv',
    postsPerDayMin: 2, postsPerDayMax: 5, quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60, planHour: 6,
    brief: 'Канал про космос', formats: { text: 1, photo: 1, album: 0.5, poll: 0.3, quiz: 0.3 },
    hashtags: ['космос', 'nasa', 'фото'], hashtagMin: 1, hashtagMax: 3, footer: null,
    linkStyle: 'inline', emojiPolicy: 'sparse', skills: [], sources: [], toolsAllow: null,
    exploreRatio: 0.2, dailyBudgetUsd: null, models: {}, bannedTerms: [], crosspost: true,
    ...over,
  };
}

export function makeSpec(over: Partial<Record<keyof PostSpec, unknown>> = {}): PostSpec {
  return PostSpecSchema.parse({
    format: 'photo',
    title: 'Новий знімок туманності',
    origin: 'external',
    body: [
      { type: 'lead', text: 'Телескоп Вебб показав туманність Кільце' },
      { type: 'p', text: 'На знімку видно оболонки газу, які зоря скинула тисячі років тому.' },
    ],
    media: [{ url: 'https://images.nasa.gov/ring.jpg' }],
    hashtags: ['космос'],
    source: { url: 'https://nasa.gov/ring', label: 'NASA' },
    ...over,
  });
}
