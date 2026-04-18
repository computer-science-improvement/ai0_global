import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PerplexityAgent } from './agents/perplexity.agent';
import { ClaudeAgent } from './agents/claude.agent';
import { ArticleExtractorService } from '../processors/article-extractor.service';
import { RawItem } from '../types';

@Injectable()
export class SummarizerService {
  private readonly logger = new Logger(SummarizerService.name);

  constructor(
    private readonly perplexity: PerplexityAgent,
    private readonly claude:     ClaudeAgent,
    private readonly extractor:  ArticleExtractorService,
  ) {}

  /**
   * Extract key facts from article content using Perplexity.
   * Returns null if content is too short or the agent is inactive.
   */
  async extractFacts(item: RawItem): Promise<string | null> {
    const content = item.content ?? '';
    if (content.length < 100) return null;

    if (!this.perplexity.available) {
      this.logger.warn('Perplexity agent not available — skipping fact extraction');
      return null;
    }

    return this.perplexity.chat([
      {
        role: 'system',
        content: [
          'You are a strict Data Extraction Engine.',
          'Your goal is to extract key facts from the provided text content.',
          '',
          'RULES:',
          '1. USE ONLY THE PROVIDED TEXT. Do not search for new information.',
          '2. If the provided text is empty, an error message, or less than 100 characters -> Output ONLY: SKIP_POST',
          '3. Extract specific numbers, names, locations, and direct quotes.',
          '4. Output format: A structured summary in Ukrainian.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `ANALYZE THIS CONTENT:\n"""\n${content}\n"""`,
          `METADATA:\nSource: ${item.source}\nDate: ${item.isoDate ?? 'NOT PROVIDED'}`,
          'TASK:\nExtract the key facts in this format:\n- MAIN EVENT: (What happened in 1 sentence)\n- KEY DETAILS: (Bullet points with numbers, dates, names)\n- QUOTES: (Important direct speech if any)\n- CONTEXT: (Background info mentioned in the text)',
        ].join('\n\n'),
      },
    ]);
  }

  /**
   * Fetch and summarize an article by URL using Perplexity's web retrieval.
   * Returns null if the agent is unavailable or the request fails.
   */
  /**
   * Use Perplexity web search to retrieve key facts about an article by URL.
   * Called when RSS content is too short to format.
   * Returns null if the agent is unavailable or the request fails.
   */
  async fetchByUrl(url: string): Promise<string | null> {
    if (!this.perplexity.available) {
      this.logger.warn('Perplexity agent not available — skipping URL fetch');
      return null;
    }

    return this.perplexity.chat([
      {
        role: 'system',
        content: [
          'You are a helpful news research assistant.',
          'Your goal is to gather as much factual information as possible about the given URL or topic.',
          '',
          'RULES:',
          '1. Search the web and retrieve the article content or related coverage from the given URL.',
          '2. If the page itself is unavailable, fall back to SIMILAR coverage from other sources about the SAME event or topic — extract facts from there.',
          '3. Only output SKIP_POST if you literally cannot find ANY information about the topic (extremely rare).',
          '4. Extract specific numbers, names, locations, dates, and direct quotes when available.',
          '5. Output format: A structured summary in Ukrainian. Prefer being useful over being safe — partial info is better than SKIP_POST.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Article URL: ${url}`,
          '',
          'TASK:',
          'Gather key facts (from the URL OR related coverage if needed) in this format:',
          '- MAIN EVENT: (What happened in 1 sentence)',
          '- KEY DETAILS: (Bullet points with numbers, dates, names)',
          '- QUOTES: (Important direct speech if any)',
          '- CONTEXT: (Background info)',
        ].join('\n'),
      },
    ]);
  }

  /**
   * Fallback when Perplexity can't fetch an article (SKIP_POST / unavailable):
   * do a plain HTTP GET of the URL, extract article body with cheerio, then
   * ask Claude Haiku to produce the same structured summary Perplexity would.
   * Returns null if HTTP fetch fails or extraction yields nothing usable.
   */
  async fetchAndExtract(url: string): Promise<string | null> {
    // 1. Raw HTTP fetch
    let html: string;
    try {
      const res = await axios.get<string>(url, {
        timeout: 15_000,
        maxRedirects: 5,
        responseType: 'text',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/123.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,uk;q=0.8',
        },
      });
      html = typeof res.data === 'string' ? res.data : String(res.data);
    } catch (err: any) {
      this.logger.warn(`fetchAndExtract HTTP failed for ${url}: ${err.message}`);
      return null;
    }

    // 2. Extract article body
    const body = this.extractor.extract(html, url);
    if (!body || body.length < 200) {
      this.logger.warn(`fetchAndExtract: no usable article body for ${url} (${body?.length ?? 0} chars)`);
      return null;
    }

    // 3. Trim to avoid huge prompts (Haiku has 200K ctx but we don't need more than ~8K chars)
    const MAX_INPUT = 8000;
    const trimmed   = body.length > MAX_INPUT ? body.slice(0, MAX_INPUT) + '…' : body;

    // 4. Haiku — same output contract as fetchByUrl
    if (!this.claude.available) {
      this.logger.warn('Claude agent not available for fetchAndExtract summarization');
      return null;
    }

    const summary = await this.claude.chat(
      [
        {
          role: 'system',
          content: [
            'You are a news extraction engine.',
            'Given the raw text of an article, pull out the key facts.',
            'Output ONLY the structured summary — no preamble, no apology, no SKIP_POST.',
            'Output language: Ukrainian.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Source URL: ${url}`,
            '',
            `ARTICLE TEXT:`,
            `"""`,
            trimmed,
            `"""`,
            '',
            'Extract in this format:',
            '- MAIN EVENT: (What happened in 1 sentence)',
            '- KEY DETAILS: (Bullet points with numbers, dates, names)',
            '- QUOTES: (Important direct speech if any)',
            '- CONTEXT: (Background info mentioned in the article)',
          ].join('\n'),
        },
      ],
      { maxTokens: 1024 },
    );

    if (!summary || summary.trim().length < 80) {
      this.logger.warn(`fetchAndExtract: Haiku returned empty/short summary for ${url}`);
      return null;
    }
    return summary;
  }

  isValidSummary(text: string | null): boolean {
    if (!text || !text.trim()) return false;
    if (text.includes('SKIP_POST')) return false;
    if (text === 'I cannot') return false;
    if (text === 'I appreciate') return false;
    if (text.includes('language model')) return false;
    return true;
  }
}
