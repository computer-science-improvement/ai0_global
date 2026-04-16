import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GameChannelItem } from '../types';

const API = 'https://gamerpower.com/api';

interface GamerPowerItem {
  id:                number;
  title:             string;
  description:       string;
  instructions:      string;
  type:              string;
  platforms:         string;
  end_date:          string;
  gamerpower_url:    string;
  image:             string;
  published_date:    string;
  status:            string;
}

@Injectable()
export class GamerPowerFetcher {
  private readonly logger = new Logger(GamerPowerFetcher.name);

  async fetch(): Promise<GameChannelItem[]> {
    try {
      const res = await axios.get<GamerPowerItem[]>(`${API}/giveaways`, {
        params:  { 'sort-by': 'date', status: 'active' },
        timeout: 15_000,
      });

      const now = Date.now();
      return (res.data ?? [])
        .filter((g) => {
          if (String(g.status ?? '').toLowerCase() !== 'active') return false;
          if (!g.end_date || g.end_date === 'N/A') return true;
          const end = new Date(g.end_date.replace(' ', 'T')).getTime();
          return isNaN(end) || end > now;
        })
        .map((g) => ({
          type:         'giveaway' as const,
          title:        g.title,
          description:  g.description,
          source:       g.gamerpower_url,
          imageUrl:     g.image || null,
          publishedAt:  g.published_date,
          platform:     g.platforms,
          endDate:      g.end_date !== 'N/A' ? g.end_date : undefined,
          instructions: g.instructions,
        }));
    } catch (err) {
      this.logger.warn(`GamerPower fetch failed: ${err.message}`);
      return [];
    }
  }
}
