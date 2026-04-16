import { Injectable, Logger } from '@nestjs/common';
import { PerplexityAgent } from './agents/perplexity.agent';
import { RawItem } from '../types';

@Injectable()
export class SummarizerService {
  private readonly logger = new Logger(SummarizerService.name);

  constructor(private readonly perplexity: PerplexityAgent) {}

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
          'You are a strict Data Extraction Engine.',
          'Your goal is to extract key facts from the article at the provided URL.',
          '',
          'RULES:',
          '1. Search the web and retrieve the article content from the given URL.',
          '2. If the page is unavailable, behind a paywall, or has no article content -> Output ONLY: SKIP_POST',
          '3. Extract specific numbers, names, locations, and direct quotes.',
          '4. Output format: A structured summary in Ukrainian.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Article URL: ${url}`,
          '',
          'TASK:',
          'Extract the key facts in this format:',
          '- MAIN EVENT: (What happened in 1 sentence)',
          '- KEY DETAILS: (Bullet points with numbers, dates, names)',
          '- QUOTES: (Important direct speech if any)',
          '- CONTEXT: (Background info mentioned in the article)',
        ].join('\n'),
      },
    ]);
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
