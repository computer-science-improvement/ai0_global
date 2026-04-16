/**
 * Example parser: fetches a URL and scrapes by selectors, writes JSON to data/.
 * Для нового парсера використовуй _parser-template.js.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchHtml } from '../lib/fetch.js';
import { scrapeBySelectors } from '../lib/scrape.js';
import { saveJson } from '../lib/json.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG_PATH = join(ROOT, 'config', 'selectors.example.json');

async function run() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const source = config.sources[0];
  const { id, url, selectors } = source;

  console.log(`Fetching ${url}...`);
  const html = await fetchHtml(url);
  const result = scrapeBySelectors(html, selectors);

  const outPath = saveJson(id, result);
  console.log(`Wrote ${outPath}`);
  return result;
}

export default run;

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
