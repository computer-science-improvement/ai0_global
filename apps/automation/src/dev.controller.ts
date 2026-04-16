/**
 * Dev-only controller for manually triggering strategies.
 * Available only when NODE_ENV !== 'production'.
 *
 * GET /trigger/:strategyType   — run a strategy once for the first matching binding
 * GET /health                  — basic health check
 */
import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentStrategyRunner }   from './common/content-strategy/content-strategy.runner';
import { ContentStrategyRegistry } from './common/content-strategy/content-strategy.registry';
import { ChannelConfigService }    from './config/channel-config.service';

@Controller()
export class DevController {
  constructor(
    private readonly config:           ConfigService,
    private readonly strategyRunner:   ContentStrategyRunner,
    private readonly strategyRegistry: ContentStrategyRegistry,
    private readonly channelConfig:    ChannelConfigService,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', env: this.config.get('NODE_ENV', 'development') };
  }

  @Get('trigger/:type')
  async triggerStrategy(@Param('type') type: string) {
    if (this.config.get('NODE_ENV') === 'production') {
      throw new NotFoundException();
    }

    const strategy = this.strategyRegistry.get(type);
    if (!strategy) {
      throw new NotFoundException(`Strategy "${type}" not found`);
    }

    const bindings = this.channelConfig.resolveStrategyBindings();
    const binding = bindings.find((b) => b.type === type);
    if (!binding) {
      throw new NotFoundException(`No binding found for strategy "${type}"`);
    }

    // Run in background, return immediately
    this.strategyRunner
      .run(strategy, binding.channelId, binding.params, binding.id)
      .catch(console.error);

    return { triggered: type, channelId: binding.channelId, at: new Date().toISOString() };
  }
}
