import { Module }    from '@nestjs/common';
import { WikipediaModule }                  from '../../integrations/wikipedia/wikipedia.module';
import { MotivationBiographyStrategy }      from './motivation-biography.strategy';
import { MotivationBiographyRepository }   from './motivation-biography.repository';
import { ClaudeAgent }                      from '../../common/ai/agents/claude.agent';
import { PostValidator }                    from '../../common/ai/validators/post.validator';
import { ReviewAgent }                      from '../../common/ai/agents/review.agent';

@Module({
  imports:   [WikipediaModule],
  providers: [
    MotivationBiographyStrategy,
    MotivationBiographyRepository,
    ClaudeAgent,
    PostValidator,
    ReviewAgent,
  ],
  exports: [MotivationBiographyStrategy],
})
export class MotivationBiographyStrategyModule {}
