import { Module, Global } from '@nestjs/common';
import { RssFetcherService }    from './fetchers/rss-fetcher.service';
import { HttpFetcherService }   from './fetchers/http-fetcher.service';
import { ContentCleanerService }    from './processors/content-cleaner.service';
import { ArticleExtractorService }  from './processors/article-extractor.service';
import { ImageResolverService }     from './processors/image-resolver.service';
import { AiLoggerService }      from './ai/ai-logger.service';
import { ClaudeAgent }          from './ai/agents/claude.agent';
import { ReviewAgent }          from './ai/agents/review.agent';
import { PostValidator }        from './ai/validators/post.validator';
import { OpenAiAgent }          from './ai/agents/openai.agent';
import { PerplexityAgent }      from './ai/agents/perplexity.agent';
import { GrokAgent }            from './ai/agents/grok.agent';
import { SummarizerService }    from './ai/summarizer.service';
import { FormatterService }     from './ai/formatter.service';
import { PostGenerationAgent }  from './ai/post-generation.agent';
import { DedupService }              from './dedup/dedup.service';
import { SemanticDedupService }      from './dedup/semantic-dedup.service';
import { TopicRouterService }        from './routing/topic-router.service';
import { BotLoggerService }          from './logger/bot-logger.service';
import { ContentStrategyRunner }     from './content-strategy/content-strategy.runner';
import { ContentStrategyRegistry }   from './content-strategy/content-strategy.registry';
import { DestinationResolver }       from './content-strategy/destination-resolver.service';
import { GroupFanOutService }        from './content-strategy/group-fanout.service';
import { RunTracer }                 from './observability/run-tracer.service';
import { RecipeCarouselRendererService } from './carousel/recipe-carousel-renderer.service';

const VALIDATORS = [
  PostValidator,
];

const AGENTS = [
  AiLoggerService,
  ClaudeAgent,
  ReviewAgent,
  OpenAiAgent,
  PerplexityAgent,
  GrokAgent,
];

const SERVICES = [
  RssFetcherService,
  HttpFetcherService,
  ContentCleanerService,
  ArticleExtractorService,
  ImageResolverService,
  SummarizerService,
  FormatterService,
  PostGenerationAgent,
  DedupService,
  SemanticDedupService,
  TopicRouterService,
  BotLoggerService,
  ContentStrategyRunner,
  ContentStrategyRegistry,
  DestinationResolver,
  GroupFanOutService,
  RunTracer,
  RecipeCarouselRendererService,
];

@Global()
@Module({
  providers: [...VALIDATORS, ...AGENTS, ...SERVICES],
  exports:   [...VALIDATORS, ...AGENTS, ...SERVICES],
})
export class CommonModule {}
