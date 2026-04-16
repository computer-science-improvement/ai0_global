import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { OnThisDayItem, OnThisDayEvent } from '../types';

const BASE_URL = 'https://byabbe.se/on-this-day';

@Injectable()
export class ByabbeFetcher {
  private readonly logger = new Logger(ByabbeFetcher.name);

  async fetch(): Promise<OnThisDayItem | null> {
    try {
      const now = new Date();
      const month = now.getMonth() + 1;
      const day = now.getDate();

      const [eventsRes, birthsRes] = await Promise.all([
        axios.get(`${BASE_URL}/${month}/${day}/events.json`, { timeout: 15_000 }),
        axios.get(`${BASE_URL}/${month}/${day}/births.json`, { timeout: 15_000 }),
      ]);

      const rawEvents: any[] = eventsRes.data?.events ?? [];
      const rawBirths: any[] = birthsRes.data?.births ?? [];

      const events: OnThisDayEvent[] = rawEvents
        .slice(0, 5)
        .map((e) => ({
          year:        String(e.year ?? ''),
          description: e.description ?? e.wikipedia?.[0]?.title ?? '',
        }));

      const births: OnThisDayEvent[] = rawBirths
        .slice(0, 3)
        .map((b) => ({
          year:        String(b.year ?? ''),
          description: b.description ?? b.wikipedia?.[0]?.title ?? '',
        }));

      this.logger.debug(`Fetched ${events.length} events, ${births.length} births for ${month}/${day}`);

      return { events, births, deaths: [] };
    } catch (err) {
      this.logger.warn(`Byabbe fetch failed: ${err.message}`);
      return null;
    }
  }
}
