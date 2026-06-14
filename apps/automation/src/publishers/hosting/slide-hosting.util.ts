// Pure helpers for slide hosting — no framework, no I/O. Shared by the hosting
// service and its tests so the object-key scheme has a single source of truth.

/** Storage object key for slide `index` (0-based) under `keyPrefix`. 1-based filename. */
export function slideKey(keyPrefix: string, index: number): string {
  const prefix = keyPrefix.replace(/\/+$/, '');
  return `${prefix}/slide-${index + 1}.png`;
}

/** Content type of every slide — the renderer always emits PNG. */
export function slideContentType(): string {
  return 'image/png';
}
