// secrets.service.ts — the app-facing wrapper around token-crypto. Holds the
// single master key (TOKEN_ENCRYPTION_KEY) read from config and exposes:
//   - encrypt / decrypt / maybeDecrypt for stored values, and
//   - resolveToken(), the BACKWARD-COMPAT bridge that prefers an encrypted DB
//     column (token_enc) but falls back to the legacy env-var-name model
//     (token_env → process.env) so existing prod accounts work with zero config.
//
// Secrets are returned to callers for in-memory use only. This service never
// logs a plaintext token, and errors deliberately omit the secret value.
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { encryptToken, decryptToken, isEncrypted, maybeDecrypt } from './token-crypto';

export const TOKEN_ENCRYPTION_KEY = 'TOKEN_ENCRYPTION_KEY';

@Injectable()
export class SecretsService {
  constructor(private readonly config: ConfigService) {}

  private key(): string | undefined {
    return this.config.get<string>(TOKEN_ENCRYPTION_KEY);
  }

  /** Encrypt a plaintext secret for storage. Requires the master key. */
  encrypt(plaintext: string): string {
    const key = this.key();
    if (!key) {
      throw new Error(
        `${TOKEN_ENCRYPTION_KEY} is not set — cannot store an encrypted token. ` +
        `Set it in .env to enable token encryption.`,
      );
    }
    return encryptToken(plaintext, key);
  }

  /** Decrypt a stored enc:v1 blob. Requires the master key. */
  decrypt(blob: string): string {
    const key = this.key();
    if (!key) {
      throw new Error(`${TOKEN_ENCRYPTION_KEY} is not set — cannot decrypt a stored token.`);
    }
    return decryptToken(blob, key);
  }

  /**
   * Decrypt if encrypted, else pass plaintext through (legacy). If the value
   * looks encrypted but no master key is configured, throw a clear error rather
   * than returning a useless ciphertext.
   */
  maybeDecrypt(value: string): string {
    const key = this.key();
    if (key) return maybeDecrypt(value, key);
    if (isEncrypted(value)) {
      throw new Error(
        `Found an encrypted token but ${TOKEN_ENCRYPTION_KEY} is not set — cannot decrypt.`,
      );
    }
    return value;
  }

  /**
   * Resolve a usable plaintext token, preserving backward compatibility:
   *   1. opts.enc present  → decrypt it (or pass through if somehow plaintext).
   *   2. else opts.env set → read that env var via the caller's ConfigService.get
   *      (this is the EXACT current behavior — unchanged when token_enc is null).
   *   3. else             → undefined.
   *
   * `configGet` is the caller's own ConfigService.get so env reads stay scoped
   * to the caller's config exactly as before.
   */
  resolveToken(
    opts: { enc?: string | null; env?: string | null },
    configGet: (k: string) => string | undefined,
  ): string | undefined {
    if (opts.enc) return this.maybeDecrypt(opts.enc);
    if (opts.env) return configGet(opts.env);
    return undefined;
  }
}
