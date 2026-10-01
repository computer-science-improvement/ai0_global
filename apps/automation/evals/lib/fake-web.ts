import type { RawGet } from '../../src/editor/net/safe-http';
import type { Lookup } from '../../src/editor/net/ssrf-guard';

export interface FixturePage {
  body:         string;
  contentType?: string;
  status?:      number;
}

/**
 * Deterministic "internet" for evals: only the fixture URLs exist, everything
 * else is a 404. Agents can still call web_fetch / fetch_feed / extract_images
 * exactly as in production — they just can't reach the real web.
 */
export class FakeWeb {
  readonly requests: string[] = [];
  private readonly pages = new Map<string, FixturePage>();

  constructor(pages: Record<string, FixturePage | string> = {}) {
    for (const [url, p] of Object.entries(pages)) this.add(url, p);
  }

  add(url: string, p: FixturePage | string): this {
    this.pages.set(normalize(url), typeof p === 'string' ? { body: p } : p);
    return this;
  }

  get urls(): string[] { return [...this.pages.keys()]; }

  readonly lookup: Lookup = async () => [{ address: '93.184.216.34', family: 4 }];

  readonly get: RawGet = async (url) => {
    this.requests.push(url);
    const p = this.pages.get(normalize(url));
    if (!p) return { status: 404, headers: { 'content-type': 'text/plain' }, data: 'not found' };
    const ct = p.contentType ?? (p.body.trimStart().startsWith('<?xml') || p.body.includes('<rss') ? 'application/rss+xml' : 'text/html; charset=utf-8');
    return { status: p.status ?? 200, headers: { 'content-type': ct }, data: p.body };
  };

  get http() { return { lookup: this.lookup, get: this.get }; }
}

function normalize(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.toString().replace(/\/$/, '');
  } catch { return u; }
}

export function rss(title: string, items: Array<{ title: string; link: string; description: string; date?: string; image?: string }>): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(title)}</title>${items.map((i) => `
  <item><title>${esc(i.title)}</title><link>${i.link}</link><description>${esc(i.description)}</description>
  <pubDate>${i.date ?? new Date().toUTCString()}</pubDate>${i.image ? `<enclosure url="${i.image}" type="image/jpeg"/>` : ''}</item>`).join('')}
</channel></rss>`;
}

export function article(o: { title: string; image?: string; paragraphs: string[]; description?: string }): string {
  return `<!doctype html><html><head><title>${o.title}</title>
<meta property="og:title" content="${o.title}">${o.description ? `<meta name="description" content="${o.description}">` : ''}
${o.image ? `<meta property="og:image" content="${o.image}">` : ''}</head>
<body><nav>Menu Home About</nav><article><h1>${o.title}</h1>${o.paragraphs.map((p) => `<p>${p}</p>`).join('')}
${o.image ? `<img src="${o.image}">` : ''}</article><footer>© Example</footer></body></html>`;
}
