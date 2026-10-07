import type { PostSpec } from '../post/post-spec';
import type { PreparedMedia } from '../post/render-telegram';
import { longreadToTelegraph } from '../post/render-telegraph';
import type { TelegraphNode } from '../../publishers/telegraph.service';

export interface SlideImage { title: string; text: string; image: Buffer | null }

export interface MediaPrepDeps {
  /** Satori renderer (RecipeCarouselRendererService.renderSlides). */
  renderSlides(slides: SlideImage[]): Promise<Buffer[]>;
  /** SlideHostingService: public URLs Telegram (and Meta) can fetch. */
  hosting: {
    available(): Promise<boolean>;
    upload(slides: Buffer[], keyPrefix: string): Promise<Array<{ url: string; path: string }>>;
    delete(paths: string[]): Promise<void>;
  };
  /** TelegraphService.createPage (active telegraph_accounts row). */
  createPage(args: { title: string; nodes: TelegraphNode[] }): Promise<{ url: string; path: string }>;
  /** SSRF-guarded image download; null when the image cannot be used (the slide gets a plain background). */
  fetchImage(url: string): Promise<Buffer | null>;
  /**
   * Spec 024 FR-007: keeps a source slot's hosted slides while its derived
   * slots are pending (MediaHolds); true = held, not deleted now.
   */
  holds?: { holdIfDerived(slotId: string, paths: string[], urls: string[]): Promise<boolean> };
}

export interface PreparedPublish {
  prepared: PreparedMedia;
  /** Drop hosted slides once Telegram and the cross-posts have ingested them. Never throws. */
  cleanup(): Promise<void>;
}

export const NEEDS_PREPARE: ReadonlySet<string> = new Set(['carousel', 'longread']);

const keySafe = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/**
 * The async "prepare media" stage of a LIVE publish_post (spec 009 T002). It is
 * the only place where the editor uploads files or creates Telegraph pages, and
 * it runs after every guard has passed; shadow mode and previews never call it.
 * Throws on failure so publish_post can return a recoverable error.
 */
export class EditorMediaPreparer {
  constructor(private readonly d: MediaPrepDeps) {}

  async prepare(spec: PostSpec, key: { channelKey: string; slotId: string }): Promise<PreparedPublish> {
    const noop = async () => {};
    if (spec.format === 'carousel') {
      const slides = spec.slides ?? [];
      if (slides.length < 2) throw new Error('carousel needs 2–10 slides');
      return this.hostSlides(slides, key);
    }
    if (spec.format === 'longread') {
      if (!spec.longread) throw new Error('longread spec has no article');
      const page = await this.d.createPage({
        title: spec.longread.title,
        nodes: longreadToTelegraph(spec.longread, { coverUrl: spec.media[0]?.url, source: spec.source }),
      });
      return { prepared: { longreadUrl: page.url }, cleanup: noop };
    }
    return { prepared: {}, cleanup: noop };
  }

  /** Render and host 1–10 slides (carousels here; native platform posts in spec 019). */
  async hostSlides(slides: Array<{ title: string; text: string; image?: string }>, key: { channelKey: string; slotId: string }): Promise<PreparedPublish> {
    if (!slides.length) throw new Error('no slides to render');
    if (!(await this.d.hosting.available())) throw new Error('slide hosting is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY / SUPABASE_CAROUSEL_BUCKET)');
    const images = await Promise.all(slides.map((s) => (s.image ? this.d.fetchImage(s.image).catch(() => null) : Promise.resolve(null))));
    const pngs = await this.d.renderSlides(slides.map((s, i) => ({ title: s.title, text: s.text, image: images[i] })));
    const hosted = await this.d.hosting.upload(pngs, `editor/${keySafe(key.channelKey)}/${keySafe(key.slotId)}`);
    return {
      prepared: { slideUrls: hosted.map((h) => h.url) },
      cleanup: async () => {
        try {
          const paths = hosted.map((h) => h.path);
          if (this.d.holds && await this.d.holds.holdIfDerived(key.slotId, paths, hosted.map((h) => h.url)).catch(() => false)) return;
          await this.d.hosting.delete(paths);
        } catch { /* best-effort */ }
      },
    };
  }
}
