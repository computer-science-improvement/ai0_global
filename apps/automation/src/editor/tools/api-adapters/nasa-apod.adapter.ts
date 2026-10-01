import { z } from 'zod';
import { APOD_URL, apodPageUrl, mapApod } from '../../../common/fetchers/apis/nasa-apod.api';
import { clip, defineAdapter } from './types';

/** NASA Astronomy Picture of the Day. Key: NASA_API_KEY (falls back to DEMO_KEY, like the daily-photo strategy). */
export const nasaApodAdapter = defineAdapter({
  name: 'nasa_apod',
  description: 'nasa_apod — астрофото дня NASA (заголовок, пояснення англ., зображення, автор). params: {date?: "YYYY-MM-DD"}',
  params: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
  async fetch({ date }, ctx) {
    const data = await ctx.getJson(APOD_URL, { api_key: ctx.env('NASA_API_KEY') || 'DEMO_KEY', date });
    const page = data?.date ? apodPageUrl(String(data.date)) : null;
    const item = mapApod(data);
    if (!item) {
      return {
        items: data?.title ? [{
          title: String(data.title), summary: clip(data.explanation), url: page, image: null, date: data.date ?? null,
          extra: { media_type: data.media_type ?? null, media_url: data.url ?? null },
        }] : [],
        note: `APOD цього дня не зображення (media_type: ${data?.media_type ?? '?'})`,
      };
    }
    return {
      items: [{
        title: item.title, summary: clip(item.explanation, 1500), url: page, image: item.imageUrl, date: item.date,
        extra: { hd_image: item.hdUrl, copyright: item.copyright },
      }],
    };
  },
});
