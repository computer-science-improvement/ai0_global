import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import axios, { AxiosRequestConfig } from 'axios';
import { RawItem } from '../types';
import { StructuredLoggerService } from '../logging/structured-logger.service';

const MICROLINK_URL = 'https://api.microlink.io';

@Injectable()
export class ImageResolverService implements OnModuleInit {
  private readonly logger = new Logger(ImageResolverService.name);
  private proxies: string[] = [];
  private proxyIndex = 0;

  constructor(private readonly structured: StructuredLoggerService) {}

  onModuleInit() {
    try {
      const path = join(__dirname, '..', '..', '..', 'config', 'proxies.json');
      const cfg  = JSON.parse(readFileSync(path, 'utf-8'));
      this.proxies = Array.isArray(cfg.list) ? cfg.list.filter(Boolean) : [];
      this.logger.log(`Loaded ${this.proxies.length} microlink proxy(s)`);
    } catch {
      this.logger.log('No proxies.json found — microlink will run without proxy');
    }
  }

  /** Resolve image: use item image if present, else try microlink */
  async resolve(item: RawItem): Promise<RawItem> {
    // Always prefer Microlink (og:image) — it's the official article cover
    const microlinkImage = await this.fetchFromMicrolink(item.source);
    if (microlinkImage) return { ...item, image: microlinkImage };

    // Fallback: image extracted from RSS/HTML content
    return item;
  }

  /** Download image as buffer */
  async download(url: string): Promise<Buffer | null> {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      return Buffer.from(res.data);
    } catch (err) {
      this.logger.warn(`Image download failed ${url}: ${err.message}`);
      return null;
    }
  }

  private async fetchFromMicrolink(sourceUrl: string): Promise<string | null> {
    // Try direct first, then each proxy on 429
    const attempts = [null, ...this.proxies]; // null = no proxy

    for (const proxy of attempts) {
      try {
        const config = this.buildConfig(proxy);
        const res    = await axios.get(MICROLINK_URL, {
          ...config,
          params:  { url: sourceUrl, palette: true },
          timeout: 10_000,
        });
        if (proxy) this.logger.debug(`microlink via proxy: ${proxy}`);

        const img = res.data?.data?.image;
        if (!img?.url) {
          this.structured.microlink({ url: sourceUrl, proxy, status: 'error', error: 'no image in response' });
          return null;
        }

        // Reject icons/logos — require a minimum size for article images
        const MIN_W = 400;
        const MIN_H = 200;
        if (img.width && img.height && (img.width < MIN_W || img.height < MIN_H)) {
          this.logger.debug(`microlink image too small (${img.width}×${img.height}) for ${sourceUrl} — skipping`);
          this.structured.microlink({
            url: sourceUrl, proxy, status: 'too_small',
            imageUrl: img.url, width: img.width, height: img.height,
          });
          return null;
        }

        this.structured.microlink({
          url: sourceUrl, proxy, status: 'success',
          imageUrl: img.url, width: img.width, height: img.height,
        });
        return img.url;
      } catch (err) {
        const status = err.response?.status;

        if (status === 429) {
          const via = proxy ?? 'direct';
          this.logger.warn(`microlink rate limit (${via}) for ${sourceUrl} — trying next`);
          this.structured.microlink({ url: sourceUrl, proxy, status: 'rate_limit', error: err.message });
          continue;
        }

        this.logger.warn(`microlink failed for ${sourceUrl}: ${err.message}`);
        this.structured.microlink({ url: sourceUrl, proxy, status: 'error', error: err.message });
        return null;
      }
    }

    this.logger.warn(`microlink exhausted all options for ${sourceUrl}`);
    return null;
  }

  private buildConfig(proxyUrl: string | null): AxiosRequestConfig {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    if (!proxyUrl) return { headers };

    try {
      // Supports two formats:
      //   ip:port:user:pass
      //   http://user:pass@ip:port
      let host: string, port: number, username: string, password: string;

      if (proxyUrl.startsWith('http')) {
        const url = new URL(proxyUrl);
        host     = url.hostname;
        port     = parseInt(url.port, 10);
        username = decodeURIComponent(url.username);
        password = decodeURIComponent(url.password);
      } else {
        const [h, p, u, pw] = proxyUrl.split(':');
        host     = h;
        port     = parseInt(p, 10);
        username = u;
        password = pw;
      }

      return {
        headers,
        proxy: { protocol: 'http', host, port, auth: { username, password } },
      };
    } catch {
      this.logger.warn(`Invalid proxy format: ${proxyUrl}`);
      return { headers };
    }
  }
}
