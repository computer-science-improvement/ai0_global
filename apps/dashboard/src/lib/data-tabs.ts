// The tabs of /app/data/$key (`?tab=`); `items` has no `?tab=` in the URL. The route and `lib/reasons.ts` (a reason's link) share this list.

export const DATA_TABS = ['items', 'schema', 'imports'] as const;
export type DataTab = typeof DATA_TABS[number];

export const isDataTab = (v: unknown): v is DataTab => typeof v === 'string' && (DATA_TABS as readonly string[]).includes(v);
