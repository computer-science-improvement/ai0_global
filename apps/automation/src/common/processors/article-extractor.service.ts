import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';

/**
 * Extracts article body text from a full HTML page.
 * Tries common article selectors in priority order, falls back to <body>.
 * Strips nav, header, footer, scripts, ads before extracting text.
 */
@Injectable()
export class ArticleExtractorService {
  private readonly logger = new Logger(ArticleExtractorService.name);

  private readonly ARTICLE_SELECTORS = [
    'article',
    '[class*="article-body"]',
    '[class*="article-content"]',
    '[class*="post-body"]',
    '[class*="post-content"]',
    '[class*="entry-content"]',
    '[class*="news-body"]',
    '[class*="news-content"]',
    '[class*="page-content"]',
    '[itemprop="articleBody"]',
    'main',
  ];

  private readonly NOISE_SELECTORS = [
    'nav', 'header', 'footer', 'aside',
    'script', 'style', 'noscript',
    '[class*="menu"]', '[class*="sidebar"]',
    '[class*="banner"]', '[class*="ad"]',
    '[class*="social"]', '[class*="share"]',
    '[class*="related"]', '[class*="recommend"]',
    '[class*="cookie"]', '[class*="popup"]',
    '[class*="subscribe"]', '[class*="newsletter"]',
    '[id*="menu"]', '[id*="sidebar"]', '[id*="footer"]', '[id*="header"]',
  ];

  extract(html: string, sourceUrl?: string): string | null {
    try {
      const $ = cheerio.load(html);

      // Remove noise elements
      this.NOISE_SELECTORS.forEach((sel) => $(sel).remove());

      // Try article selectors in order
      for (const sel of this.ARTICLE_SELECTORS) {
        const el = $(sel).first();
        if (el.length) {
          const text = this.toText($, el);
          if (text.length >= 100) {
            return text;
          }
        }
      }

      // Fallback: full body
      const bodyText = this.toText($, $('body'));
      if (bodyText.length >= 100) {
        return bodyText;
      }

      this.logger.warn(`Could not extract article content${sourceUrl ? ` from ${sourceUrl}` : ''}`);
      return null;
    } catch (err) {
      this.logger.warn(`Article extraction failed: ${err.message}`);
      return null;
    }
  }

  private toText($: cheerio.CheerioAPI, el: cheerio.Cheerio<cheerio.AnyNode>): string {
    return el
      .text()
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
