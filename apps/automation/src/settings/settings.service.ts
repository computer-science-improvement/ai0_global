import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class SettingsService {
  constructor(private readonly config: ConfigService) {}

  get() {
    return {
      telegram: {
        trackingEnabled:      this.config.get('TRACKING_ENABLED') === 'true',
        trackingShareSession: this.config.get('TELEGRAM_TRACKING_SHARE_SESSION') === 'true',
        statsPostAgeDays:     parseInt(this.config.get('STATS_POST_AGE_DAYS') ?? '30', 10),
        postingCooldownMin:   parseInt(this.config.get('POSTING_COOLDOWN_MIN') ?? '20', 10),
        fetchTimeoutMs:       parseInt(this.config.get('FETCH_TIMEOUT') ?? '15000', 10),
      },
      ai: {                                  // booleans only — NEVER return the key values
        anthropic:  !!this.config.get('ANTHROPIC_API_KEY'),
        perplexity: !!this.config.get('PERPLEXITY_API_KEY'),
        openai:     !!this.config.get('OPENAI_API_KEY'),
        grok:       !!this.config.get('GROK_API_KEY'),
      },
    };
  }
}
