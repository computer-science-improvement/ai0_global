import { Module } from '@nestjs/common';
import { PdrQuizStrategy }    from './pdr-quiz.strategy';
import { PdrQuizRepository }  from './pdr-quiz.repository';

@Module({
  providers: [PdrQuizStrategy, PdrQuizRepository],
  exports:   [PdrQuizStrategy],
})
export class PdrQuizStrategyModule {}
