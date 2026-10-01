// Byabbe "On this day" API: endpoints + pure response mapping. Shared by the
// legacy ByabbeFetcher (on-this-day strategy) and the editor fetch_api adapter.
import type { OnThisDayEvent } from '../../../workflows/on-this-day/types';

export const BYABBE_BASE = 'https://byabbe.se/on-this-day';

export type ByabbeKind = 'events' | 'births' | 'deaths';

export function byabbeUrl(month: number, day: number, kind: ByabbeKind): string {
  return `${BYABBE_BASE}/${month}/${day}/${kind}.json`;
}

/** First `limit` entries of a Byabbe list (`events`/`births`/`deaths`) as {year, description}. */
export function mapByabbeEntries(raw: any[] | null | undefined, limit: number): OnThisDayEvent[] {
  return (raw ?? [])
    .slice(0, limit)
    .map((e) => ({
      year:        String(e.year ?? ''),
      description: e.description ?? e.wikipedia?.[0]?.title ?? '',
    }));
}
