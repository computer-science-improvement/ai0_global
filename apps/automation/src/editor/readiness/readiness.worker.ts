import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { READINESS_SERVICE } from './readiness.controller';
import type { ReadinessService } from './readiness.service';

/**
 * Spec 072 FR-006: the sweep. Every ten minutes the channel doctor looks at each channel in approve or live mode and each channel
 * with an open launch, one at a time. It runs nothing when the editor is off, and a sweep that is still running is not started
 * twice. It costs no model call.
 */
@Injectable()
export class ReadinessWorker {
  private readonly logger = new Logger('Readiness');
  private running = false;

  constructor(
    @Inject(READINESS_SERVICE) private readonly svc: ReadinessService,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/10 * * * *', { name: 'readiness-sweep' })
  async tick(): Promise<void> {
    if (this.config.get<string>('EDITOR_ENABLED') !== 'true' || this.running) return;
    this.running = true;
    try {
      const r = await this.svc.sweep();
      if (r.failed) this.logger.warn(`readiness sweep: ${r.checked} checked, ${r.failed} failed`);
    } catch (err: any) {
      this.logger.warn(`readiness sweep failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }
}
