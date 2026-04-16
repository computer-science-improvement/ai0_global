import axios from 'axios';

const DEFAULT_TIMEOUT = Number(process.env.FETCH_TIMEOUT) || 15000;

/**
 * Fetch HTML from a URL.
 * @param {string} url - URL to fetch
 * @param {object} options - { timeout, headers }
 * @returns {Promise<string>} HTML string
 */
export async function fetchHtml(url, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, headers = {} } = options;
  const response = await axios.get(url, {
    timeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ParserBot/1.0)',
      ...headers,
    },
    responseType: 'text',
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return response.data;
}

/**
 * Fetch raw response (for JSON APIs).
 * @param {string} url
 * @param {object} options
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const { timeout = DEFAULT_TIMEOUT } = options;
  const response = await axios.get(url, {
    timeout,
    headers: { 'Accept': 'application/json' },
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return response.data;
}
