import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { OnThisDayItem } from '../types';
import { byabbeUrl, mapByabbeEntries } from '../../../common/fetchers/apis/byabbe.api';

@Injectable()
export class ByabbeFetcher {
  private readonly logger = new Logger(ByabbeFetcher.name);

  async fetch(): Promise<OnThisDayItem | null> {
    try {
      const now = new Date();
      const month = now.getMonth() + 1;
      const day = now.getDate();

      const [eventsRes, birthsRes] = await Promise.all([
        axios.get(byabbeUrl(month, day, 'events'), { timeout: 15_000 }),
        axios.get(byabbeUrl(month, day, 'births'), { timeout: 15_000 }),
      ]);

      const events = mapByabbeEntries(eventsRes.data?.events, 5);
      const births = mapByabbeEntries(birthsRes.data?.births, 3);

      this.logger.debug(`Fetched ${events.length} events, ${births.length} births for ${month}/${day}`);

      return { events, births, deaths: [] };
    } catch (err) {
      this.logger.warn(`Byabbe fetch failed: ${err.message}`);
      return null;
    }
  }
}
