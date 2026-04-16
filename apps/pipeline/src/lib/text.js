/**
 * Очищення тексту: зайві кавички, HTML-сутності.
 */

/** Типографічні та звичайні кавички на початку/кінці рядка */
const WRAP_QUOTES = /^[\s\u201C\u201D\u201E\u201F""']+|[\s\u201C\u201D\u201E\u201F""']+$/g;

/** Розшифрувати типові HTML-сутності */
const ENTITIES = {
  '&#34;': '"',
  '&#39;': "'",
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
};

/**
 * Прибрати обгортання рядка в кавички (типографічні " " та звичайні " ').
 * @param {string} s
 * @returns {string}
 */
export function stripWrappingQuotes(s) {
  if (!s || typeof s !== 'string') return '';
  return s.replace(WRAP_QUOTES, '').trim();
}

/**
 * Замінити HTML-сутності на символи.
 * @param {string} s
 * @returns {string}
 */
export function decodeHtmlEntities(s) {
  if (!s || typeof s !== 'string') return '';
  let out = s;
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out;
}

/**
 * Очистити title або description: trim, decode entities, strip wrapping quotes.
 * @param {string} s
 * @returns {string}
 */
export function cleanTitleOrDescription(s) {
  if (!s || typeof s !== 'string') return '';
  let out = s.trim();
  out = decodeHtmlEntities(out);
  out = stripWrappingQuotes(out);
  return out;
}
