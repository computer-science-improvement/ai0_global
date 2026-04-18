import { Injectable, Inject, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { AiChatMessage } from './agents/agent.interface';
import { StructuredLoggerService } from '../logging/structured-logger.service';

export interface AiLogEntry {
  agent:      string;
  model:      string;
  status:     'success' | 'error';
  input:      AiChatMessage[];
  output?:    string | null;
  error?:     string | null;
  durationMs?: number;
}

@Injectable()
export class AiLoggerService {
  private readonly logger = new Logger(AiLoggerService.name);

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly structured: StructuredLoggerService,
  ) {}

  async log(entry: AiLogEntry): Promise<void> {
    // Winston: log full prompt + response as two separate lines for easy analysis
    try {
      this.structured.aiRequest({
        agent:    entry.agent,
        model:    entry.model,
        messages: entry.input,
      });
      this.structured.aiResponse({
        agent:      entry.agent,
        model:      entry.model,
        output:     entry.output ?? null,
        durationMs: entry.durationMs ?? 0,
        error:      entry.error ?? undefined,
      });
    } catch { /* never crash main flow */ }

    try {
      await this.pool.query(
        `INSERT INTO ai_logs (agent, model, status, input, output, error, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.agent,
          entry.model,
          entry.status,
          JSON.stringify(entry.input),
          entry.output ?? null,
          entry.error  ?? null,
          entry.durationMs ?? null,
        ],
      );
    } catch (err) {
      // Logging must never crash the main flow
      this.logger.error(`Failed to write ai_log: ${err.message}`);
    }
  }
}
