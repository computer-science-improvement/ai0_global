import type { AdFormat, PublicAdPrice } from './ad-orders.types';

export const AD_FORMAT_LABELS: Record<AdFormat, string> = {
  post:           'рекламний пост',
  pin_24h:        'пост із закріпом на 24 год',
  digest_sponsor: 'партнер щоденного дайджесту',
};

const uah = (n: number) => `${n.toLocaleString('uk-UA').replace(/[\u00a0\u202f]/g, ' ')} грн`;

/** Deterministic Ukrainian price list (prices are facts — never written by a model). */
export function formatPriceList(prices: PublicAdPrice[]): string {
  const byChannel = new Map<string, PublicAdPrice[]>();
  for (const p of prices) byChannel.set(p.channelKey, [...(byChannel.get(p.channelKey) ?? []), p]);
  return [...byChannel.entries()].map(([channel, list]) => [
    channel,
    ...list.map((p) => `• ${AD_FORMAT_LABELS[p.format]}: ${uah(p.priceUah)}${p.note ? ` (${p.note})` : ''}`),
  ].join('\n')).join('\n\n');
}

/** Normalize a channel mention from a DM ("@Chan", "t.me/chan", "chan") to a comparable handle. */
export function channelHandle(s: string): string {
  return s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^t\.me\//, '').replace(/^@/, '').replace(/\/.*$/, '');
}

/** Prices of the channel the advertiser named, or every active price when nothing matches. */
export function pricesForInquiry(prices: PublicAdPrice[], mentioned?: string | null): PublicAdPrice[] {
  if (mentioned) {
    const want = channelHandle(mentioned);
    const hit = prices.filter((p) => channelHandle(p.channelKey) === want);
    if (hit.length) return hit;
  }
  return prices;
}

/** The reply the triage agent drafts for an ad inquiry (owner approves before it is sent). */
export function priceListReply(prices: PublicAdPrice[]): string {
  return [
    'Вітаю! Дякую за інтерес до реклами в нашій мережі.',
    '',
    'Актуальний прайс:',
    formatPriceList(prices),
    '',
    'Усі рекламні пости позначаються #реклама. Через 24 і 72 години після публікації надсилаємо звіт: перегляди, пересилання, реакції.',
    'Напишіть, будь ласка, канал, формат і бажану дату — підготую рахунок.',
  ].join('\n');
}
