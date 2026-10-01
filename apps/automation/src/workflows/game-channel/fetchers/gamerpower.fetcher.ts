import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GameChannelItem } from '../types';
import { GAMERPOWER_GIVEAWAYS_URL, GAMERPOWER_PARAMS, mapGamerPowerGiveaways } from '../../../common/fetchers/apis/games.api';

@Injectable()
export class GamerPowerFetcher {
  private readonly logger = new Logger(GamerPowerFetcher.name);

  async fetch(): Promise<GameChannelItem[]> {
    try {
      const res = await axios.get(GAMERPOWER_GIVEAWAYS_URL, {
        params:  GAMERPOWER_PARAMS,
        timeout: 15_000,
      });

      return mapGamerPowerGiveaways(res.data, Date.now());
    } catch (err) {
      this.logger.warn(`GamerPower fetch failed: ${err.message}`);
      return [];
    }
  }
}
