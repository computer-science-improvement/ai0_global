// Tiny inline-SVG icon set. Stroke-based, sized at the call site, takes
// currentColor — so a parent's `color` value drives the glyph color.
// Replaces the emoji icons in the sidebar (which read as full-color on a
// monochrome canvas) without pulling in lucide-react as a new dependency.

import type { SVGProps } from 'react';

type IconName =
  | 'channels' | 'discovery' | 'graph' | 'recommendations'
  | 'bots' | 'strategies' | 'cron' | 'telegraph'
  | 'chevron-left' | 'chevron-right' | 'plus'
  | 'trash' | 'refresh' | 'check' | 'x' | 'pencil'
  | 'play' | 'pause' | 'sparkle' | 'warning' | 'info';

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...rest }: Props) {
  const common = {
    width: size, height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  };

  switch (name) {
    // Sidebar glyphs — kept abstract on purpose; the labels carry meaning.
    case 'channels':
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      );
    case 'discovery':
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      );
    case 'graph':
      return (
        <svg {...common}>
          <circle cx="5"  cy="6"  r="2" />
          <circle cx="19" cy="6"  r="2" />
          <circle cx="12" cy="18" r="2" />
          <path d="M6.7 7.5 10.5 16.5M17.3 7.5 13.5 16.5M7 6h10" />
        </svg>
      );
    case 'recommendations':
      return (
        <svg {...common}>
          <path d="M12 3 14 9h6l-5 4 2 7-5-4-5 4 2-7-5-4h6z" />
        </svg>
      );
    case 'bots':
      return (
        <svg {...common}>
          <rect x="4"  y="8"  width="16" height="12" rx="3" />
          <circle cx="9"  cy="14" r="1.3" />
          <circle cx="15" cy="14" r="1.3" />
          <path d="M12 4v4M9 4h6" />
        </svg>
      );
    case 'strategies':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case 'cron':
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
        </svg>
      );
    case 'telegraph':
      return (
        <svg {...common}>
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M14 3v5h5M9 13h6M9 17h6" />
        </svg>
      );

    // Chrome
    case 'chevron-left':
      return <svg {...common}><path d="m14 6-6 6 6 6" /></svg>;
    case 'chevron-right':
      return <svg {...common}><path d="m10 6 6 6-6 6" /></svg>;
    case 'plus':
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case 'trash':
      return (
        <svg {...common}>
          <path d="M4 7h16" />
          <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
          <path d="M10 11v6M14 11v6" />
        </svg>
      );
    case 'refresh':
      return (
        <svg {...common}>
          <path d="M20 4v6h-6" />
          <path d="M4 20v-6h6" />
          <path d="M20 10A8 8 0 0 0 6.3 6.3L4 8.5" />
          <path d="M4 14a8 8 0 0 0 13.7 3.7L20 15.5" />
        </svg>
      );
    case 'check':
      return <svg {...common}><path d="m5 12 5 5 9-11" /></svg>;
    case 'x':
      return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    case 'pencil':
      return (
        <svg {...common}>
          <path d="M16 4 20 8" />
          <path d="M4 20v-4l12-12 4 4-12 12H4z" />
        </svg>
      );
    case 'play':
      return <svg {...common}><path d="M7 4v16l13-8z" /></svg>;
    case 'pause':
      return <svg {...common}><path d="M7 4v16M17 4v16" /></svg>;
    case 'sparkle':
      return (
        <svg {...common}>
          <path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l4.2 4.2M14.2 14.2l4.2 4.2M5.6 18.4l4.2-4.2M14.2 9.8l4.2-4.2" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <path d="M12 3 2 20h20L12 3z" />
          <path d="M12 10v5M12 18v.01" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8v.01" />
        </svg>
      );
  }
}
