// Abstract slide-hosting interface used as a NestJS DI token. Publishers and the
// carousel strategy depend on this, never on a concrete backend, so the storage
// backend (Supabase today) can be swapped without touching consumers.

/** A hosted slide: a public URL Meta can fetch + the storage path for deletion. */
export interface HostedSlide {
  url:  string;
  path: string;
}

export abstract class SlideHostingService {
  /** True when storage credentials and bucket are all configured. */
  abstract available(): Promise<boolean>;

  /**
   * Upload `slides` as slide-1.png … slide-N.png under `keyPrefix`. Returns one
   * HostedSlide per input buffer, in the same order. Throws on any upload failure
   * (the caller logs and aborts the publish — no partial carousel).
   */
  abstract upload(slides: Buffer[], keyPrefix: string): Promise<HostedSlide[]>;

  /**
   * Best-effort delete by storage path. Never throws — a failed cleanup must not
   * turn an already-successful publish into a failure.
   */
  abstract delete(paths: string[]): Promise<void>;
}
