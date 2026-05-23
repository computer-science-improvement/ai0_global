// apps/dashboard/src/components/ChannelAvatar.tsx
//
// Circular avatar for a tracked channel. Private channels rarely have a
// fetchable photo URL on our side, so we fall back to a deterministic
// monogram (first letter of title / username / channel_key) on a tinted
// surface. Color picked from the seed string so the same channel always
// gets the same color across renders.

interface Props {
  /** Display name — used to pick the letter + color seed. */
  name:    string | null | undefined;
  /** Optional image URL. When null/empty, renders the monogram. */
  src?:    string | null;
  /** Pixel size. Defaults to 48px. */
  size?:   number;
  /** Optional title for hover tooltip. */
  title?:  string;
}

// Six accent backgrounds tuned for the dark canvas — each pairs a soft
// translucent fill with an ink-readable letter color.
const PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: 'rgba(106, 76, 245, 0.20)',  fg: '#a896f8' },  // violet
  { bg: 'rgba(212, 77, 240, 0.20)',  fg: '#e29bf3' },  // magenta
  { bg: 'rgba(255, 122, 61, 0.18)',  fg: '#ffae87' },  // orange
  { bg: 'rgba(255, 85, 119, 0.18)',  fg: '#ff99ad' },  // coral
  { bg: 'rgba(0, 153, 255, 0.20)',   fg: '#7ac6ff' },  // accent blue
  { bg: 'rgba(34, 197, 94, 0.18)',   fg: '#86d99f' },  // green
];

/** djb2 hash → palette index. Deterministic; doesn't need crypto. */
function pickColor(seed: string): { bg: string; fg: string } {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function ChannelAvatar({ name, src, size = 48, title }: Props) {
  const seed   = (name ?? '?').toString();
  const letter = seed.replace(/^[#@-]/, '').trim().slice(0, 1).toUpperCase() || '?';
  const color  = pickColor(seed);

  if (src) {
    return (
      <img
        src={src}
        alt=""
        title={title}
        style={{
          width: size, height: size,
          borderRadius: '9999px',
          objectFit: 'cover',
          flexShrink: 0,
          background: color.bg,
        }}
        onError={(e) => {
          // If the image 404s, fall back to monogram by hiding it.
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }

  return (
    <div
      title={title}
      style={{
        width: size, height: size,
        borderRadius: '9999px',
        background: color.bg,
        color: color.fg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: Math.round(size * 0.42),
        fontWeight: 600,
        letterSpacing: '-0.02em',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {letter}
    </div>
  );
}
