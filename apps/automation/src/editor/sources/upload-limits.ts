/**
 * Spec 076 FR-005 / A13: the size limits of an uploaded page. They live apart from `upload-page.ts` because `main.ts` imports
 * the body middleware (and so these constants) before the settings overlay runs, and `upload-page.ts` pulls in the document
 * parser; this file imports nothing. `upload-page.ts` re-exports both.
 */

/** The longest page text accepted (characters). The dashboard dialog mirrors this number. */
export const UPLOAD_PAGE_MAX_CHARS = 5_000_000;

/** The body limit of the upload route: 5 M Cyrillic characters are about 10 MB of UTF-8, plus JSON escapes. */
export const UPLOAD_BODY_LIMIT = 12 * 1024 * 1024;
