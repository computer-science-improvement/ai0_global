// NASA APOD: endpoint + pure response mapping. Shared by the legacy
// NasaApodFetcher (daily-photo strategy) and the editor fetch_api adapter.
import type { DailyPhotoItem } from '../../../workflows/daily-photo/types';

export const APOD_URL = 'https://api.nasa.gov/planetary/apod';

/** One APOD response object → item, or null for non-image days (videos, interactive). */
export function mapApod(data: any): DailyPhotoItem | null {
  if (!data || data.media_type !== 'image') return null;
  return {
    title:       data.title,
    explanation: data.explanation,
    imageUrl:    data.url,
    hdUrl:       data.hdurl ?? null,
    date:        data.date,
    mediaType:   data.media_type,
    copyright:   data.copyright ?? null,
  };
}

/** Public APOD page of a date (YYYY-MM-DD → https://apod.nasa.gov/apod/apYYMMDD.html). */
export function apodPageUrl(date: string): string {
  return `https://apod.nasa.gov/apod/ap${date.replace(/-/g, '').slice(2)}.html`;
}
