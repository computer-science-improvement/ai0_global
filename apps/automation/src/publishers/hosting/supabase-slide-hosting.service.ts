// Supabase Storage implementation of SlideHostingService. Uploads PNG slides to a
// public bucket and returns public URLs Meta can fetch; deletes are best-effort.
// The Supabase client is built lazily; getStorage() is protected so tests inject
// a fake — no live network in unit tests. The service-role key is never logged.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SlideHostingService, HostedSlide } from './slide-hosting.service';
import { slideKey, slideContentType } from './slide-hosting.util';

@Injectable()
export class SupabaseSlideHostingService extends SlideHostingService {
  private readonly logger = new Logger(SupabaseSlideHostingService.name);
  private client?: SupabaseClient;

  constructor(private readonly env: ConfigService) {
    super();
  }

  private cfg(): { url?: string; key?: string; bucket?: string } {
    return {
      url:    this.env.get<string>('SUPABASE_URL'),
      key:    this.env.get<string>('SUPABASE_SERVICE_KEY'),
      bucket: this.env.get<string>('SUPABASE_CAROUSEL_BUCKET'),
    };
  }

  async available(): Promise<boolean> {
    const { url, key, bucket } = this.cfg();
    return Boolean(url && key && bucket);
  }

  // Returns `any`: @supabase/storage-js does not export the StorageFileApi type.
  /** Storage handle for `bucket`. Overridable in tests. */
  protected getStorage(bucket: string): any {
    if (!this.client) {
      const { url, key } = this.cfg();
      this.client = createClient(url!, key!);
    }
    return this.client.storage.from(bucket);
  }

  async upload(slides: Buffer[], keyPrefix: string): Promise<HostedSlide[]> {
    const { url, key, bucket } = this.cfg();
    if (!url || !key || !bucket) throw new Error('Slide hosting not configured');
    const storage = this.getStorage(bucket);

    const out: HostedSlide[] = [];
    for (let i = 0; i < slides.length; i++) {
      const path = slideKey(keyPrefix, i);
      const { error } = await storage.upload(path, slides[i], {
        contentType: slideContentType(),
        upsert: true,
      });
      if (error) throw new Error(`Slide ${i + 1} upload failed: ${error.message}`);
      const { data } = storage.getPublicUrl(path);
      out.push({ url: data.publicUrl, path });
    }
    return out;
  }

  async delete(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      const { bucket } = this.cfg();
      if (!bucket) return;
      const { error } = await this.getStorage(bucket).remove(paths);
      if (error) this.logger.warn(`Slide cleanup failed: ${error.message}`);
    } catch (e) {
      this.logger.warn(`Slide cleanup error: ${(e as Error).message}`);
    }
  }
}
