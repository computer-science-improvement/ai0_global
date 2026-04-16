/**
 * One-time login helper for pdr-online.com.ua
 *
 * Opens a VISIBLE browser window. Log in manually, then press Enter here.
 * Saves cookies + localStorage to auth.json for reuse by the scraper.
 *
 * Run: npx tsx apps/pipeline/src/tools/additional-data/scripts/pdr-login.ts
 */

import { chromium } from 'playwright';
import * as path    from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const AUTH_FILE = path.join(__dirname, '..', '..', '..', 'data', 'normalized', 'pdr', 'auth.json');

async function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('\n✅  Виконай вхід у браузері, потім натисни Enter тут...\n', () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  console.log('Відкриваю браузер для ручного входу на pdr-online.com.ua...');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();

  await page.goto('https://pdr-online.com.ua/testi/testi-po-biletah/?ticket=1');

  await waitForEnter();

  // Save session
  await context.storageState({ path: AUTH_FILE });
  console.log(`\n✅  Сесію збережено: ${AUTH_FILE}`);

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
