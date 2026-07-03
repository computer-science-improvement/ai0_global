// topic-digest — daily niche digest ("Технології за день: головне") that
// recaps OUR OWN already-published news posts with t.me deep links. Items
// come from published_posts filtered by source strategy types, so it never
// competes with the single-post strategies for dedup and never exports
// traffic — every line links back into the network.
//
// AI is used ONLY to rewrite titles into tight one-liners, with a hard
// fallback to the original titles: the digest must ship even when the AI is
// down, returns garbage, or breaks the JSON contract. Custom execute() for
// the same reason as network-digest (ReviewAgent's 1024-token cap would
// truncate multi-link HTML).
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ContentStrategyRegistry } from '../../common/content-strategy/content-strategy.registry';
import { DedupService }            from '../../common/dedup/dedup.service';
import { TelegramPublisher }       from '../../publishers/telegram.publisher';
import { TelegramNotifier }        from '../../publishers/telegram-notifier.service';
import { PublicationsRepository }  from '../../stats/publications.repository';
import { ClaudeAgent }             from '../../common/ai/agents/claude.agent';
import { buildPrompt }             from '../../common/ai/prompt-builder';
import { HUMAN_VOICE_SKILL }       from '../../common/ai/skills/human-voice.skill';
import { ANTI_SLOP_SKILL }         from '../../common/ai/skills/anti-slop.skill';
import { Skill } from '../../common/ai/skills/skill.interface';
import {
  ContentStrategy, StrategyFetchResult, StrategyParams, StrategyPost,
} from '../../common/content-strategy/content-strategy.interface';
import { TopicDigestRepository } from './topic-digest.repository';
import {
  DigestItem, SponsorSlot, kyivDate, renderDigest, truncate,
} from '../network-digest/digest-format.util';

const REWRITE_BASE = `ROLE: Ти редактор українського Telegram-дайджесту.
Отримаєш JSON-масив [{i, title}] із заголовками сьогоднішніх постів.
Перепиши КОЖЕН заголовок одним стислим реченням українською (до 90 символів),
збережи всі факти й власні назви, без клікбейту.
Поверни СТРОГО JSON-масив [{"i": <число>, "line": "<речення>"}] і нічого більше.`;

interface TopicDigestParams {
  windowHours: number;
  maxItems: number;
  minItems: number;
  strategyTypes: string[];
  sourceChannels?: string[];
  headerTopicLabel: string;
  rewriteWithAi: boolean;
  sponsor: SponsorSlot | null;
}

function normalizeParams(params: StrategyParams): TopicDigestParams {
  const p = params as Record<string, unknown>;
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length > 0 ? v.filter((s): s is string => typeof s === 'string') : undefined;
  const sponsor = p.sponsor as { text?: unknown; url?: unknown } | null | undefined;
  return {
    windowHours: Math.min(Math.max(num(p.windowHours, 24), 1), 24 * 7),
    maxItems:    Math.min(Math.max(num(p.maxItems, 7), 3), 8),
    minItems:    Math.max(num(p.minItems, 3), 1),
    strategyTypes: strArr(p.strategyTypes) ?? ['ai0-news', 'ua-news'],
    sourceChannels: strArr(p.sourceChannels),
    headerTopicLabel: typeof p.headerTopicLabel === 'string' && p.headerTopicLabel.trim()
      ? p.headerTopicLabel.trim()
      : 'Технології',
    rewriteWithAi: p.rewriteWithAi !== false,
    sponsor: sponsor && typeof sponsor.text === 'string' && typeof sponsor.url === 'string'
      ? { text: sponsor.text, url: sponsor.url }
      : null,
  };
}

/** Parse the AI rewrite reply; return null on ANY contract violation. */
export function parseRewrite(reply: string | null, count: number): Map<number, string> | null {
  if (!reply) return null;
  try {
    const jsonStart = reply.indexOf('[');
    const jsonEnd = reply.lastIndexOf(']');
    if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
    const arr = JSON.parse(reply.slice(jsonStart, jsonEnd + 1));
    if (!Array.isArray(arr)) return null;
    const map = new Map<number, string>();
    for (const e of arr) {
      if (typeof e?.i === 'number' && typeof e?.line === 'string' && e.line.trim()) {
        map.set(e.i, truncate(e.line.trim(), 90));
      }
    }
    return map.size === count ? map : null;
  } catch {
    return null;
  }
}

@Injectable()
export class TopicDigestStrategy implements ContentStrategy, OnModuleInit {
  private readonly logger = new Logger(TopicDigestStrategy.name);

  readonly type = 'topic-digest';

  constructor(
    private readonly registry:     ContentStrategyRegistry,
    private readonly repo:         TopicDigestRepository,
    private readonly dedup:        DedupService,
    private readonly telegram:     TelegramPublisher,
    private readonly notifier:     TelegramNotifier,
    private readonly publications: PublicationsRepository,
    private readonly claude:       ClaudeAgent,
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

    const sourceUrl = `digest://topic/${channelId}/${kyivDate(now)}`;
    const title = `topic digest ${kyivDate(now)}`;
    const unposted = await this.dedup.filterUnposted(
      [{ title, content: null, image: null, source: sourceUrl, tags: ['digest'], isoDate: now.toISOString() }],
      channelId,
    );
    if (!unposted.length) {
      this.logger.log(`Topic digest already posted today for ${channelId}`);
      return;
    }

    const rows = await this.repo.postsInWindow(
      params.windowHours, params.strategyTypes, params.sourceChannels,
    );
    if (rows.length < params.minItems) {
      this.logger.log(`Only ${rows.length} posts in window (< ${params.minItems}) — skipping topic digest`);
      return;
    }

    const picked = rows.slice(-params.maxItems); // newest tail, chronological
    const lines = await this.rewriteLines(picked.map((r) => r.title), params.rewriteWithAi);

    const items: DigestItem[] = picked.map((r, i) => ({
      ...r,
      title: lines[i] ?? r.title,
    }));

    const { text, itemsUsed } = renderDigest({
      header: `${params.headerTopicLabel} за день: головне`,
      items,
      statsLine: null,
      ctaText: null,
      sponsor: params.sponsor,
    });

    if (itemsUsed < params.minItems) {
      this.logger.warn(`Only ${itemsUsed} items fit/linkable (< ${params.minItems}) — skipping topic digest`);
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
        channelId, messageId, sourceUrl, title,
        strategyType: this.type, tags: ['digest'],
      });
      this.logger.log(`Published topic digest (${itemsUsed} items) to ${channelId}`);
    } catch (err: any) {
      this.logger.error(`Topic digest publish failed: ${err.message}`);
      await this.notifier.notifyFailed(channelId, err.message, sourceUrl);
    }
  }

  /** AI one-liner rewrites with a hard fallback to the original titles. */
  private async rewriteLines(titles: string[], useAi: boolean): Promise<(string | null)[]> {
    if (!useAi || !this.claude.available) return titles.map(() => null);
    const prompt = buildPrompt(REWRITE_BASE, [HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL]);
    const payload = JSON.stringify(titles.map((t, i) => ({ i, title: t })));
    const reply = await this.claude.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user',   content: payload },
      ],
      { maxTokens: 1500 },
    );
    const map = parseRewrite(reply, titles.length);
    if (!map) {
      this.logger.warn('AI rewrite unavailable/invalid — using original titles');
      return titles.map(() => null);
    }
    return titles.map((_, i) => map.get(i) ?? null);
  }
}
