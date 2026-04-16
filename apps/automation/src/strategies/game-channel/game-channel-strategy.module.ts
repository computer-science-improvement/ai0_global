import { Module } from '@nestjs/common';
import { GameChannelStrategy }  from './game-channel.strategy';
import { GamerPowerFetcher }    from '../../workflows/game-channel/fetchers/gamerpower.fetcher';
import { EpicGamesFetcher }     from '../../workflows/game-channel/fetchers/epic-games.fetcher';
import { SteamDealsFetcher }    from '../../workflows/game-channel/fetchers/steam-deals.fetcher';
import { GameNewsFetcher }      from '../../workflows/game-channel/fetchers/game-news.fetcher';

@Module({
  providers: [
    GameChannelStrategy,
    GamerPowerFetcher,
    EpicGamesFetcher,
    SteamDealsFetcher,
    GameNewsFetcher,
  ],
  exports: [GameChannelStrategy],
})
export class GameChannelStrategyModule {}
