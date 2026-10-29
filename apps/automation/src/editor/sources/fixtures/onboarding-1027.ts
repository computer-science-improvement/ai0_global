import type { CardSource } from '../../card';
import { PDR_URL } from '../../docs/testing/pdr-fixture';
import type { SourceFact, SourceProbeFact } from '../source-findings';

/**
 * Spec 076, the acceptance replays: the three channels of the 2026-10-27 onboarding, written by hand from what the stage showed.
 * Nothing here is generated or read from a database; each replay in `onboarding-1027.076.test.ts` builds its fakes from these.
 *
 * 1. @pdr_dev_channel: its only source is the road-rules page on zakon.rada.gov.ua, which answers nothing from the droplet.
 * 2. @ai0_prompts_dev: a card with no sources and one `library:nanobanana_prompts` series.
 * 3. @ai0_global: healthy feeds and a library series, which must not raise a false blocker.
 */

const HOUR = 3_600_000;
export const plusHours = (d: Date, hours: number): Date => new Date(d.getTime() + hours * HOUR);

// ── 1. @pdr_dev_channel ──────────────────────────────────────────────────────────────────────────────────────────────

/** The first read of the page that timed out. The next two came 2 h and 4 h later; the third is the strike. */
export const PDR_FIRST_TIMEOUT = new Date('2026-10-27T08:00:00Z');
export const PDR_TIMEOUT_AFTER_HOURS = [0, 2, 4] as const;
/** The morning the replay looks at the channel: a day after the strike was a few hours old. */
export const PDR_NOW = new Date('2026-10-27T12:30:00Z');

export const PDR_HOST = 'zakon.rada.gov.ua';
export const PDR_CHANNEL = '@pdr_dev_channel';
export const PDR_AGENT = 'pdr_dev_channel';
export const PDR_CREATED_AT = new Date('2026-10-25T09:00:00Z');
export const PDR_SOURCE: CardSource = { id: 'pdr_print', kind: 'url', ref: PDR_URL };
/** A planned slot's hint, as the planner writes it: the print page and the clause it is about. */
export const PDR_HINT = `${PDR_URL}#п.14.6`;
export const PDR_DATASET = 'pdr_rules';

/** What the server's probe said about the page: nothing came back. */
export const PDR_PROBE: SourceProbeFact = {
  ok: false, failure_class: 'timeout', items: null, newest_at: null, checked_at: '2026-10-27T12:15:00.000Z', detail: 'timed out twice (10 s)',
};

/** The fact the doctor's loader would build for it: the card's only source, so required. */
export const pdrFact = (o: Partial<SourceFact> = {}): SourceFact => ({
  url: PDR_URL, kind: 'url', origin: 'card', host: PDR_HOST, id: PDR_SOURCE.id, required: true, probe: PDR_PROBE,
  hostBlock: { reason: 'unreachable', until: plusHours(PDR_FIRST_TIMEOUT, 4 + 24).toISOString(), strikes: 1 },
  ...o,
});

// ── 2. @ai0_prompts_dev ──────────────────────────────────────────────────────────────────────────────────────────────

export const PROMPTS_CHANNEL = '@ai0_prompts_dev';
export const PROMPTS_AGENT = 'ai0_prompts_dev';
export const PROMPTS_DATASET = 'nanobanana_prompts';
export const PROMPTS_SERIES = 'Prompt of the day';
export const PROMPTS_PLAYBOOK = { series: [{ name: PROMPTS_SERIES, source: { kind: 'library', table: PROMPTS_DATASET }, active: true }], rules: [] };
export const PROMPTS_CREATED_AT = new Date('2026-10-22T09:00:00Z');
export const PROMPTS_NOW = new Date('2026-10-27T09:00:00Z');

/** The series' source, as a doctor fact: no address and no host. */
export const promptsFact = (): SourceFact => ({
  url: `library:${PROMPTS_DATASET}`, kind: 'library', origin: `series:${PROMPTS_SERIES}`, host: null, hostBlock: null,
});

// ── 3. @ai0_global ───────────────────────────────────────────────────────────────────────────────────────────────────

export const GLOBAL_CHANNEL = '@ai0_global';
export const GLOBAL_AGENT = 'ai0_global';
export const GLOBAL_NOW = new Date('2026-10-27T09:00:00Z');
/** Older than the 14 days in which an unread source is worth a hint. */
export const GLOBAL_CREATED_AT = new Date('2026-08-01T09:00:00Z');
export const GLOBAL_FEEDS: CardSource[] = [
  { id: 'marktechpost', kind: 'rss', ref: 'https://www.marktechpost.com/feed/' },
  { id: 'verge', kind: 'rss', ref: 'https://www.theverge.com/rss/index.xml' },
];
export const GLOBAL_PLAYBOOK = {
  series: [
    { name: 'AI news', source: { kind: 'feed', ref: 'https://www.marktechpost.com/feed/' }, active: true },
    { name: 'Prompt of the day', source: { kind: 'library', table: 'prompts' }, active: true },
  ],
  rules: [],
};

export const okProbe = (at: Date, newestHoursAgo = 3, items = 24): SourceProbeFact => ({
  ok: true, failure_class: null, items, newest_at: new Date(at.getTime() - newestHoursAgo * HOUR).toISOString(), checked_at: plusHours(at, -2).toISOString(),
  detail: `${items} items, newest ${newestHoursAgo} h ago`,
});

export const globalFacts = (): SourceFact[] => [
  ...GLOBAL_FEEDS.map((s): SourceFact => ({
    url: s.ref, kind: 'rss', origin: 'card', host: new URL(s.ref).hostname.replace(/^www\./, ''), hostBlock: null, id: s.id, probe: okProbe(GLOBAL_NOW),
  })),
  { url: 'library:prompts', kind: 'library', origin: 'series:Prompt of the day', host: null, hostBlock: null },
];

/** A feed's answer for the live gate: one item an hour old, so nothing is stale. */
export const freshRss = (now: Date, title: string, slug: string): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><item><title>${title}</title><link>https://news.example/${slug}</link>`
  + `<pubDate>${new Date(now.getTime() - HOUR).toUTCString()}</pubDate><description>d</description></item></channel></rss>`;
