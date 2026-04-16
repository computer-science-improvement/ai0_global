/**
 * Run all parsers and write JSON files to data/.
 * Add new parsers here or in config and call them.
 */
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARSERS_DIR = join(__dirname, 'parsers');

async function runAll() {
  const files = readdirSync(PARSERS_DIR).filter(
    (f) => f.endsWith('.js') && !f.startsWith('_') && f !== 'example-parser.js'
  );
  const parsers = files;

  for (const name of parsers) {
    const mod = await import(`./parsers/${name}`);
    if (typeof mod.default === 'function') {
      console.log(`Running ${name}...`);
      await mod.default();
    }
  }
}

runAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
