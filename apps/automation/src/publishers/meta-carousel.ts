// meta-carousel.ts — pure, dependency-free helpers for carousel/album publishing.
// Safe to unit-test (no I/O). Used by the Meta publishers' publishCarousel methods.

/** Throw when a carousel has too few (<2) or too many (>max) items. */
export function assertCarouselSize(count: number, max: number, platform: string): void {
  if (count < 2 || count > max) {
    throw new Error(`${platform} carousel needs 2–${max} images, got ${count}`);
  }
}

/** Comma-joined child container ids for the CAROUSEL parent's `children` param. */
export function joinChildren(ids: string[]): string {
  return ids.join(',');
}

/** JSON for Facebook feed `attached_media`: [{"media_fbid":"<id>"}, …]. */
export function fbAttachedMedia(fbids: string[]): string {
  return JSON.stringify(fbids.map(id => ({ media_fbid: id })));
}
