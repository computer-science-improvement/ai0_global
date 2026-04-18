import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import * as winston from 'winston';
import 'winston-daily-rotate-file';

export type LogCategory =
  | 'rss'
  | 'ai_request'
  | 'ai_response'
  | 'db'
  | 'publication'
  | 'microlink'
  | 'http'
  | 'error';

export interface StructuredLogEntry {
  category:   LogCategory;
  level?:     'info' | 'warn' | 'error' | 'debug';
  message:    string;
  strategy?:  string;
  channelId?: string;
  source?:    string;
  /** Any additional structured data */
  data?:      Record<string, unknown>;
}

/**
 * Central structured logger that writes JSON log lines to daily-rotated
 * files under `apps/automation/logs/`. Each log line has a `category`
 * field so the LogAnalyzer can filter/analyze specific streams.
 *
 * Categories:
 *   rss           — items fetched from RSS sources
 *   ai_request    — full prompt sent to an AI agent
 *   ai_response   — raw response returned from an AI agent
 *   db            — DB reads relevant to publication (pre-publish state)
 *   publication   — actual Telegram/social publish attempts + result
 *   microlink     — microlink.io calls (with proxy info)
 *   http          — outbound axios/http calls (with proxy info)
 *   error         — unexpected errors that break a pipeline
 */
@Injectable()
export class StructuredLoggerService implements OnModuleInit {
  private readonly fallback = new Logger(StructuredLoggerService.name);
  private logger!: winston.Logger;
  private logsDir!: string;

  onModuleInit() {
    // Resolve logs dir — prefer repo-root /logs/automation when running via docker,
    // fall back to apps/automation/logs for local dev.
    const preferred = join(__dirname, '..', '..', '..', 'logs');
    this.logsDir = preferred;
    try {
      if (!existsSync(this.logsDir)) mkdirSync(this.logsDir, { recursive: true });
    } catch (err: any) {
      this.fallback.warn(`Could not create logs dir ${this.logsDir}: ${err.message}`);
    }

    const jsonFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    );

    const makeRotate = (filename: string) =>
      new (winston.transports as any).DailyRotateFile({
        dirname:       this.logsDir,
        filename:      `${filename}-%DATE%.log`,
        datePattern:   'YYYY-MM-DD',
        maxSize:       '20m',
        maxFiles:      '7d',
        zippedArchive: false,
      });

    this.logger = winston.createLogger({
      level:  'debug',
      format: jsonFormat,
      transports: [
        makeRotate('combined'),
        // A separate "errors" file makes quick triage easier
        new (winston.transports as any).DailyRotateFile({
          dirname:       this.logsDir,
          filename:      `errors-%DATE%.log`,
          datePattern:   'YYYY-MM-DD',
          level:         'warn',
          maxSize:       '10m',
          maxFiles:      '14d',
          zippedArchive: false,
        }),
      ],
    });

    this.fallback.log(`Structured logs dir: ${this.logsDir}`);
  }

  get logsDirectory(): string {
    return this.logsDir;
  }

  log(entry: StructuredLogEntry): void {
    if (!this.logger) return;
    const { level, category, message, ...rest } = entry;
    this.logger.log({
      level:    level ?? 'info',
      category,
      message,
      ...rest,
    });
  }

  // Convenience helpers — keep call sites terse
  rss(data: { source: string; count: number; titles?: string[]; tags?: string[] }): void {
    this.log({ category: 'rss', message: `RSS ${data.source}: ${data.count} items`, source: data.source, data });
  }

  aiRequest(data: {
    agent: string; model: string; messages: unknown; temperature?: number; maxTokens?: number;
  }): void {
    this.log({ category: 'ai_request', message: `${data.agent}/${data.model} → request`, data });
  }

  aiResponse(data: {
    agent: string; model: string; output: string | null; durationMs: number; error?: string;
  }): void {
    this.log({
      level:   data.error ? 'error' : 'info',
      category: 'ai_response',
      message: `${data.agent}/${data.model} ← ${data.error ? 'ERROR' : 'response'} (${data.durationMs}ms)`,
      data,
    });
  }

  db(data: { op: string; table: string; channelId?: string; rowCount?: number; detail?: unknown }): void {
    this.log({
      category:  'db',
      message:   `DB ${data.op} ${data.table}${data.rowCount != null ? ` → ${data.rowCount} rows` : ''}`,
      channelId: data.channelId,
      data,
    });
  }

  publication(data: {
    channelId: string; strategy?: string; source?: string; title?: string;
    text?: string; imageUrl?: string | null; messageId?: string; status: 'success' | 'failure' | 'blocked';
    error?: string;
  }): void {
    this.log({
      level:     data.status === 'success' ? 'info' : 'error',
      category:  'publication',
      message:   `publish[${data.status}] ${data.channelId}${data.title ? `: ${data.title}` : ''}`,
      channelId: data.channelId,
      strategy:  data.strategy,
      source:    data.source,
      data,
    });
  }

  microlink(data: {
    url: string; proxy: string | null; status: 'success' | 'rate_limit' | 'error' | 'too_small';
    imageUrl?: string | null; width?: number; height?: number; error?: string;
  }): void {
    this.log({
      level:    data.status === 'success' ? 'info' : 'warn',
      category: 'microlink',
      message:  `microlink[${data.status}] ${data.url}${data.proxy ? ` via ${data.proxy}` : ''}`,
      source:   data.url,
      data,
    });
  }

  http(data: {
    method: string; url: string; proxy?: string | null; status?: number; durationMs?: number; error?: string;
  }): void {
    this.log({
      level:    data.error || (data.status != null && data.status >= 400) ? 'warn' : 'debug',
      category: 'http',
      message:  `${data.method} ${data.url}${data.proxy ? ` [proxy]` : ''}${data.status ? ` → ${data.status}` : ''}`,
      data,
    });
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log({ level: 'error', category: 'error', message, data });
  }
}
