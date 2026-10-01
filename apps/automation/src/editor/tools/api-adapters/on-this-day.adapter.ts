import { z } from 'zod';
import { byabbeUrl, mapByabbeEntries } from '../../../common/fetchers/apis/byabbe.api';
import { defineAdapter } from './types';

function kyivMonthDay(now: Date): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', month: 'numeric', day: 'numeric' }).formatToParts(now);
  return { month: Number(parts.find((x) => x.type === 'month')!.value), day: Number(parts.find((x) => x.type === 'day')!.value) };
}

/** Byabbe "On this day" (Wikipedia-based, English). Same API as the on-this-day strategy. */
export const onThisDayAdapter = defineAdapter({
  name: 'on_this_day',
  description: 'on_this_day — події, народження або смерті цього дня в історії (англ., з Вікіпедії). params: {kind?: events|births|deaths, month?: 1–12, day?: 1–31 (типово сьогодні, Київ), limit?: 1–30}',
  params: z.object({
    kind:  z.enum(['events', 'births', 'deaths']).default('events'),
    month: z.number().int().min(1).max(12).optional(),
    day:   z.number().int().min(1).max(31).optional(),
    limit: z.number().int().min(1).max(30).default(10),
  }).strict(),
  async fetch(p, ctx) {
    const today = kyivMonthDay(ctx.now());
    const month = p.month ?? today.month;
    const day = p.day ?? today.day;
    const data = await ctx.getJson(byabbeUrl(month, day, p.kind));
    const raw: any[] = data?.[p.kind] ?? [];
    return {
      items: mapByabbeEntries(raw, p.limit).map((e, i) => ({
        title: `${e.year}: ${e.description}`.slice(0, 200), summary: e.description || null,
        url: raw[i]?.wikipedia?.[0]?.wikipedia ?? null, image: null, date: e.year || null,
        extra: { kind: p.kind, month, day },
      })),
    };
  },
});
