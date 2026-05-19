// apps/automation/src/discovery/teleads/teleads-mapper.ts
import { TeleAdsProduct } from './teleads.client';
import { UpsertInput } from '../repositories/candidate-channels.repository';

const AVATAR_SIZE_PREFERENCE = ['320x320', '600x600', '800x550', '150x150', 'base'];

export function mapTeleAdsProduct(p: TeleAdsProduct): UpsertInput {
  const prices = (p.prices ?? []).map(t => t.price).filter(v => Number.isFinite(v));
  const themes = (p.categories ?? []).map(c => c.slug).filter(Boolean);

  let avatar_url: string | null = null;
  const sizes = p.avatar?.media?.sizes;
  if (sizes) {
    for (const key of AVATAR_SIZE_PREFERENCE) {
      if (sizes[key]?.url) { avatar_url = sizes[key].url; break; }
    }
    if (!avatar_url) {
      const first = Object.values(sizes)[0];
      avatar_url = first?.url ?? null;
    }
  }

  return {
    source:      'teleads',
    external_id: String(p.id),
    slug:        p.slug,
    link:        p.link,
    title:       p.title,
    description: p.description ?? null,
    language:    p.language ?? null,
    themes,
    sex_ratio:   p.sex === 'enabled' && Number.isFinite(p.sex_ratio as number)
                   ? (p.sex_ratio as number)
                   : null,
    price_min:   prices.length ? Math.min(...prices) : null,
    price_max:   prices.length ? Math.max(...prices) : null,
    avatar_url,
    raw_payload: p,
  };
}
