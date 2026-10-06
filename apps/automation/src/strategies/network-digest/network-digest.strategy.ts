// network-digest — daily "what our network published" post with t.me deep
// links, ranked by views-per-hour. The network's own cross-promo engine and
// the home of the "Партнер дайджесту" sponsor slot (monetization M1).
//
// Custom execute() ON PURPOSE: the generic runner pipeline pushes post.text
// through the AI ReviewAgent whose 1024-token output cap would truncate a
// multi-link digest (and an AI pass can mangle URLs). The digest is
// deterministic HTML assembled from titles that already passed review in
// their source strategies, so it publishes directly. Dedup goes through the
// shared posted_news ledger with a date-keyed sentinel URL, making reruns
// the same day per-channel no-ops.
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { DedupService }            from '../../common/dedup/dedup.service';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { Skill } from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy, StrategyFetchResult, StrategyParams, StrategyPost,
} from '../../common/content-strategy/content-strategy.interface';
import { NetworkDigestRepository } from './network-digest.repository';
import { DigestSponsorsRepository } from '../../payments/digest-sponsors.repository';
import { resolveDigestSponsor } from './digest-sponsor';
import { DigestItem, SponsorSlot, kyivDate, renderDigest } from '../../common/digests/digest-format';
import { pickNetworkHighlights } from '../../common/digests/digest-selection';

interface NetworkDigestParams {
  windowHours: number;
  maxItems: number;
  minItems: number;
  includeChannels?: string[];
  showSubsDelta: boolean;
  headerTitle: string;
  ctaText: string | null;
  sponsor: SponsorSlot | null;
}

export function normalizeParams(params: StrategyParams): NetworkDigestParams {
  const p = params as Record<string, unknown>;
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  const sponsor = p.sponsor as { text?: unknown; url?: unknown } | null | undefined;
  const maxItems = Math.min(Math.max(num(p.maxItems, 8), 3), 8);
  return {
    windowHours: Math.min(Math.max(num(p.windowHours, 24), 1), 24 * 7),
    maxItems,
    // minItems > maxItems could never be satisfied → the digest would never post.
    minItems:    Math.min(Math.max(num(p.minItems, 3), 1), maxItems),
    includeChannels: Array.isArray(p.includeChannels) && p.includeChannels.length > 0
      ? p.includeChannels.filter((c): c is string => typeof c === 'string')
      : undefined,
    showSubsDelta: p.showSubsDelta !== false,
    headerTitle: typeof p.headerTitle === 'string' && p.headerTitle.trim()
      ? p.headerTitle.trim()
      : 'Мережа ai0: головне за день',
    ctaText: typeof p.ctaText === 'string' && p.ctaText.trim()
      ? p.ctaText.trim()
      : '🔥 Було корисно — поділись дайджестом',
    sponsor: sponsor && typeof sponsor.text === 'string' && typeof sponsor.url === 'string'
      ? { text: sponsor.text, url: sponsor.url }
      : null,
  };
}

@Injectable()
export class NetworkDigestStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(NetworkDigestStrategy.name);

  readonly type = 'network-digest';

  constructor(
    private readonly registry:     ContentStrategyRegistry,
    private readonly repo:         NetworkDigestRepository,
    private readonly dedup:        DedupService,
    private readonly telegram:     TelegramPublisher,
    private readonly notifier:     TelegramNotifier,
    private readonly publications: PublicationsRepository,
    @Optional() private readonly sponsors?: DigestSponsorsRepository,
  ) {}

  onModuleInit() {
    this.registry.register(this);
  }

  getSkills(_params: StrategyParams): Skill[] { return []; }
  async fetch(_params: StrategyParams, _channelId: string): Promise<StrategyFetchResult | null> { return null; }
  async generate(_data: StrategyFetchResult, _params: StrategyParams): Promise<StrategyPost | 'SKIP_POST' | null> { return null; }

  async execute(channelId: string, rawParams: StrategyParams): Promise<void> {
    const params = normalizeParams(rawParams);
    const now = new Date();

    // One digest per channel per Kyiv day — posted_news sentinel URL.
    const sourceUrl = `digest://network/${channelId}/${kyivDate(now)}`;
    const title = `network digest ${kyivDate(now)}`;
    const unposted = await this.dedup.filterUnposted(
      [{ title, content: null, image: null, source: sourceUrl, tags: ['digest'], isoDate: now.toISOString() }],
      channelId,
    );
    if (!unposted.length) {
      this.logger.log(`Digest already posted today for ${channelId}`);
      return;
    }

    const rows = await this.repo.postsInWindow(params.windowHours, params.includeChannels);
    if (rows.length < params.minItems) {
      this.logger.log(`Only ${rows.length} posts in window (< ${params.minItems}) — skipping digest`);
      return;
    }

    // Drop posts from channels that can't be deep-linked BEFORE taking the
    // top N — otherwise high-ranked private-channel posts eat the slots and
    // renderDigest silently renders fewer (or zero) lines.
    const items: DigestItem[] = pickNetworkHighlights(rows, now, params.maxItems);

    let statsLine: string | null = null;
    if (params.showSubsDelta) {
      const delta = await this.repo.subsDelta(params.windowHours);
      const deltaPart = delta !== 0 ? `${delta > 0 ? '+' : ''}${delta.toLocaleString('uk-UA')} підписників · ` : '';
      statsLine = `Мережа за добу: ${deltaPart}${rows.length} постів`;
    }

    // Paid digest_sponsor order for today (spec 008 T006) wins over the static param.
    const sponsor = await resolveDigestSponsor(this.sponsors, channelId, kyivDate(now), params.sponsor, (m) => this.logger.warn(m));

    const { text, itemsUsed } = renderDigest({
      header: params.headerTitle,
      items,
      statsLine,
      ctaText: params.ctaText,
      sponsor: sponsor.slot,
    });

    if (itemsUsed < params.minItems) {
      this.logger.warn(`Only ${itemsUsed} items fit/linkable (< ${params.minItems}) — skipping digest`);
      return;
    }

    try {
      const messageId = await this.telegram.publish(
        { text, source: sourceUrl, tags: ['digest'], title },
        { id: channelId },
      );
      await this.dedup.markPosted(sourceUrl, title, channelId, 'digest');
      await this.notifier.notifyPublished(channelId, messageId);
      await this.publications.insert({
        channelId, messageId,
        sourceUrl, title,
        strategyType: this.type,
        tags: ['digest'],
      });
      if (sponsor.orderId && this.sponsors) {
        await this.sponsors.markPublished(sponsor.orderId, channelId, messageId)
          .catch((e: any) => this.logger.warn(`sponsor order ${sponsor.orderId} not marked published: ${e?.message ?? e}`));
      }
      // No crossPost fan-out: the digest is t.me deep links — dead weight on
      // Meta surfaces. Telegram-only by design.
      this.logger.log(`Published network digest (${itemsUsed} items) to ${channelId}`);
    } catch (err: any) {
      this.logger.error(`Digest publish failed: ${err.message}`);
      await this.notifier.notifyFailed(channelId, err.message, sourceUrl);
    }
  }
}
