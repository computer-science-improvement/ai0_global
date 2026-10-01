import type { AdReport, AdReportPoint, AdReportStage } from './ad-orders.types';

/** First 8 hex chars of the order id — short, stable utm_campaign. */
export function shortCampaign(orderId: string): string {
  return orderId.replace(/-/g, '').slice(0, 8);
}

/** Append ai0 UTM tags (utm_source=ai0, utm_medium=telegram, utm_campaign=<campaign>). Invalid URLs are returned unchanged. */
export function withUtm(url: string, campaign: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  u.searchParams.set('utm_source', 'ai0');
  u.searchParams.set('utm_medium', 'telegram');
  u.searchParams.set('utm_campaign', campaign);
  return u.toString();
}

const HOUR = 3600_000;

/** Which report a published post is due for at `now` (null = too early). */
export function reportStage(postedAt: Date, now: Date): AdReportStage | null {
  const age = now.getTime() - postedAt.getTime();
  if (age >= 72 * HOUR) return '72h';
  if (age >= 24 * HOUR) return '24h';
  return null;
}

export interface ReportSnapshot {
  capturedAt:     Date;
  views:          number | null;
  forwards:       number | null;
  reactionsTotal: number | null;
  replies:        number | null;
}

export interface ReportInput {
  stage:      AdReportStage;
  now:        Date;
  advertiser: string;
  channel:    { key: string; title: string | null; username: string | null; subscribers: number | null };
  post:       { messageId: number; postedAt: Date; format: string | null };
  snapshots:  ReportSnapshot[];
  /** The CTA / sponsor link as published, if any. */
  linkUrl:    string | null;
}

function handleOf(key: string, username: string | null): string | null {
  if (username?.trim()) return username.trim().replace(/^@/, '');
  return key.startsWith('@') && key.length > 1 ? key.slice(1) : null;
}

/** Pure: stats snapshots of one published ad → the advertiser report. */
export function buildAdReport(i: ReportInput): AdReport {
  const snaps = [...i.snapshots].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const latest = snaps.at(-1) ?? null;

  // One point per started hour since publication (the latest snapshot of that hour wins).
  const buckets = new Map<number, AdReportPoint>();
  for (const s of snaps) {
    const hours = Math.max(1, Math.ceil((s.capturedAt.getTime() - i.post.postedAt.getTime()) / HOUR));
    buckets.set(hours, { hours, views: s.views });
  }
  const curve = [...buckets.values()].sort((a, b) => a.hours - b.hours).slice(0, 96);

  const handle = handleOf(i.channel.key, i.channel.username);
  const views = latest?.views ?? null;
  const subs = i.channel.subscribers;
  return {
    stage:       i.stage,
    generatedAt: i.now.toISOString(),
    advertiser:  i.advertiser,
    channel:     { key: i.channel.key, title: i.channel.title, url: handle ? `https://t.me/${handle}` : null, subscribers: subs },
    post:        { url: handle ? `https://t.me/${handle}/${i.post.messageId}` : null, publishedAt: i.post.postedAt.toISOString(), format: i.post.format },
    metrics:     {
      views, forwards: latest?.forwards ?? null, reactions: latest?.reactionsTotal ?? null, replies: latest?.replies ?? null,
      capturedAt: latest ? latest.capturedAt.toISOString() : null,
    },
    reachRate:   views != null && subs ? Math.round((views / subs) * 1000) / 1000 : null,
    link:        i.linkUrl ? { url: i.linkUrl, utm: /[?&]utm_[a-z]+=/i.test(i.linkUrl) } : null,
    curve,
  };
}

/** The DM the owner approves to send the report link (never auto-sent). */
export function reportMessage(advertiser: string, url: string, stage: AdReportStage): string {
  return stage === '72h'
    ? `Вітаю! Фінальний звіт по рекламі «${advertiser}» (72 год після публікації): ${url}`
    : `Вітаю! Звіт по рекламі «${advertiser}» за першу добу: ${url}\nЗа цим же посиланням через 72 години буде фінальний звіт.`;
}
