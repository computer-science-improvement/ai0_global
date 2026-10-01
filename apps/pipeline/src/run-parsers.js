/**
 * Run all parsers and write JSON files to data/.
 * Every parsers/*.js with a default export is run, except templates
 * (`_*.js`, example-parser.js) and node:test files (`*.test.js`).
 */
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARSERS_DIR = join(__dirname, 'parsers');

/** True for files run-parsers should import and run. */
export function isParserFile(name) {
  return name.endsWith('.js')
    && !name.endsWith('.test.js')
    && !name.startsWith('_')
    && name !== 'example-parser.js';
}

async function runAll() {
  const parsers = readdirSync(PARSERS_DIR).filter(isParserFile);

  for (const name of parsers) {
    const mod = await import(`./parsers/${name}`);
    if (typeof mod.default === 'function') {
      console.log(`Running ${name}...`);
      await mod.default();
    }
  }
}

// Run only when invoked directly (`pnpm run parse`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
