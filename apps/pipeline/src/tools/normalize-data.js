/**
 * Нормалізує JSON у data/ до єдиної структури: source, count, items[]
 * Кожен item: title, description, link, source, category, extra
 * Для mcpservers також зберігається поле name (назва запису).
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data', 'raw', 'assets');

const FILES = ['academy-openai.json', 'prompts-md.json', 'mcpservers.json'];

function normalizeAcademy(data) {
  const items = (data.items || []).map((i) => ({
    title: i.case ?? i.title ?? '',
    description: i.prompt ?? i.description ?? '',
    link: i.link ?? null,
    source: i.source ?? null,
    category: i.category ?? null,
    extra: i.extra && (i.extra.case != null || i.extra.prompt != null) ? i.extra : { case: i.case ?? i.title, prompt: i.prompt ?? i.description },
  }));
  return { source: 'academy-openai', count: items.length, items };
}

function normalizePromptsMd(data) {
  const raw = data.sections || data.items || [];
  const items = raw.map((s) => ({
    title: s.title ?? '',
    description: s.description ?? '',
    link: s.link ?? null,
    source: s.source ?? null,
    category: s.category ?? null,
    extra: s.extra && s.extra.typescript != null ? s.extra : { typescript: s.typescript ?? null },
  }));
  return { source: 'prompts-md', count: items.length, items };
}

function normalizeMcpservers(data) {
  const raw = data.items || [];
  const items = raw.map((i) => {
    const name = i.name ?? i.title ?? '';
    return {
      name,
      title: name,
      description: i.description ?? '',
      link: i.link ?? null,
      source: i.source ?? null,
      category: i.category ?? null,
      extra: i.extra ?? {},
    };
  });
  const categories = [...new Set(items.map((i) => i.category).filter(Boolean))];
  return { source: 'mcpservers', count: items.length, categories, items };
}

const normalizers = {
  'academy-openai.json': normalizeAcademy,
  'prompts-md.json': normalizePromptsMd,
  'mcpservers.json': normalizeMcpservers,
};

for (const file of FILES) {
  const path = join(DATA_DIR, file);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const fn = normalizers[file];
  if (!fn) continue;
  const out = fn(raw);
  writeFileSync(path, JSON.stringify(out, null, 2), 'utf8');
  console.log(`${file}: ${out.count} items`);
}

console.log('Done.');
