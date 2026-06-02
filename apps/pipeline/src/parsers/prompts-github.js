/**
 * Parser: raw-data/prompts-github/{nanobanana,seedance}.md → normalized prompts.
 *
 * Markdown shape (both repos):
 *   ## N. Category
 *   ### N.M. Title
 *   *italic description*
 *   <img src="..."> (image)  OR  bare https://github.com/user-attachments/assets/... line (video)
 *   **Prompt:**
 *   ```[lang]
 *   <prompt text>
 *   ```
 *   *Source: ...*
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR   = join(__dirname, '..', 'raw-data', 'raw-data', 'prompts-github');
const OUT_FILE  = join(__dirname, '..', 'data', 'normalized', 'prompts-github', 'prompts.json');

const REPO_URL = {
  nanobanana: 'https://github.com/ZeroLu/awesome-nanobanana-pro',
  seedance:   'https://github.com/ZeroLu/awesome-seedance',
};

export function cleanCategory(s) {
  return String(s).replace(/^\s*\d+(\.\d+)*\.?\s*/, '').trim();
}

export function cleanTitle(s) {
  return String(s).replace(/^\s*\d+(\.\d+)*\.?\s*/, '').trim();
}

function extractMedia(bodyLines) {
  for (const line of bodyLines) {
    const img = line.match(/<img[^>]*\ssrc=["']([^"']+)["']/i);
    if (img) return { media_url: img[1], media_type: 'image' };
  }
  for (const line of bodyLines) {
    const vid = line.trim().match(/^(https:\/\/github\.com\/user-attachments\/assets\/\S+)$/i);
    if (vid) return { media_url: vid[1], media_type: 'video' };
  }
  return null;
}

function extractPrompt(bodyLines) {
  let inBlock = false;
  const buf = [];
  for (const line of bodyLines) {
    if (!inBlock && /^```/.test(line.trim())) { inBlock = true; continue; }
    if (inBlock && /^```/.test(line.trim()))  { break; }
    if (inBlock) buf.push(line);
  }
  const text = buf.join('\n').trim();
  return text || null;
}

function extractSource(bodyLines) {
  const line = bodyLines.find((l) => /^\*?\s*Source:/i.test(l.trim()));
  if (!line) return null;
  const handle = line.match(/@[\w]+/);          // prefer an @handle
  if (handle) return handle[0];
  return line.replace(/^\*?\s*Source:\s*/i, '').replace(/[*]/g, '').trim() || null;
}

/** Parse one README's markdown into normalized prompt records. */
export function parseReadme(md, provider) {
  const lines = md.split('\n');
  let category = null;
  const entries = [];
  let cur = null;

  const flush = () => { if (cur) { entries.push(cur); cur = null; } };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h2) { flush(); category = cleanCategory(h2[1]); continue; }
    if (h3) { flush(); cur = { title: cleanTitle(h3[1]), category, body: [] }; continue; }
    if (cur) cur.body.push(line);
  }
  flush();

  const seen = new Set();
  const rows = [];
  for (const e of entries) {
    const media  = extractMedia(e.body);
    const prompt = extractPrompt(e.body);
    if (!media || !prompt) continue;            // skip non-prompt sections / malformed
    if (seen.has(media.media_url)) continue;    // dedup
    seen.add(media.media_url);
    rows.push({
      id:            media.media_url,
      provider,
      category:      e.category,
      title:         e.title,
      prompt_text:   prompt,
      source:        extractSource(e.body),
      media_url:     media.media_url,
      media_type:    media.media_type,
      prompt_source: REPO_URL[provider],
      page_url:      media.media_url,
    });
  }
  return rows;
}

async function main() {
  const all = [];
  for (const provider of ['nanobanana', 'seedance']) {
    const md = await readFile(join(RAW_DIR, `${provider}.md`), 'utf-8');
    const rows = parseReadme(md, provider);
    console.log(`${provider}: ${rows.length} prompts`);
    all.push(...rows);
  }
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify({ prompts: all }, null, 2), 'utf-8');
  console.log(`Total ${all.length} → ${OUT_FILE}`);
}

if (process.argv[1] && process.argv[1].endsWith('prompts-github.js')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
