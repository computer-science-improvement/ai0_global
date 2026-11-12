/** An OAuth failure with its RFC 6749 / 7591 error code and HTTP status. */
export class OAuthError extends Error {
  constructor(readonly status: number, readonly code: string, readonly description: string) {
    super(`${code}: ${description}`);
  }
  body(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
