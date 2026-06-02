/**
 * Save the two GitHub prompt-repo READMEs locally so the parser can run
 * deterministically/offline. Network lives here only.
 */
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = join(__dirname, '..', 'raw-data', 'raw-data', 'prompts-github');

const SOURCES = [
  { name: 'nanobanana', url: 'https://raw.githubusercontent.com/ZeroLu/awesome-nanobanana-pro/main/README.md' },
  { name: 'seedance',   url: 'https://raw.githubusercontent.com/ZeroLu/awesome-seedance/main/README.md' },
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const s of SOURCES) {
    const res = await fetch(s.url);
    if (!res.ok) throw new Error(`Fetch ${s.name} failed: ${res.status} ${res.statusText}`);
    const md = await res.text();
    const out = join(OUT_DIR, `${s.name}.md`);
    await writeFile(out, md, 'utf-8');
    console.log(`Saved ${s.name}: ${md.length} bytes → ${out}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
