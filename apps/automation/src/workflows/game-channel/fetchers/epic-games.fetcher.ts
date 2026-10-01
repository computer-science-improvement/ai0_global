import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { GameChannelItem } from '../types';
import { EPIC_FREE_GAMES_PARAMS, EPIC_FREE_GAMES_URL, mapEpicFreeGames } from '../../../common/fetchers/apis/games.api';

@Injectable()
export class EpicGamesFetcher {
  private readonly logger = new Logger(EpicGamesFetcher.name);

  async fetch(): Promise<GameChannelItem[]> {
    try {
      const res = await axios.get(EPIC_FREE_GAMES_URL, {
        params:  EPIC_FREE_GAMES_PARAMS,
        timeout: 15_000,
      });

      return mapEpicFreeGames(res.data?.data?.Catalog?.searchStore?.elements, Date.now());
    } catch (err) {
      this.logger.warn(`Epic Games fetch failed: ${err.message}`);
      return [];
    }
  }
}
