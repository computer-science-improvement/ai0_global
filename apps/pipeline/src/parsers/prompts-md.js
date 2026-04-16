/**
 * Парсер MD-файлу з промптами: шукає "# ⭐ Prompts", парсить секції по ##,
 * відділяє description від ### Definition та витягує ```typescript блоки.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { fetchHtml } from '../lib/fetch.js';
import { saveRawJson } from '../lib/json.js';
import { cleanTitleOrDescription } from '../lib/text.js';

const PARSER_ID = 'prompts-md';
const URL =
  'https://raw.githubusercontent.com/pacholoamit/chatgpt-prompts/refs/heads/main/README.md';

/** Отримати текст: з файлу (шлях) або з URL */
async function getText(input) {
  if (!input) throw new Error('Потрібен шлях до .md файлу або URL');
  if (input.startsWith('http://') || input.startsWith('https://')) {
    return await fetchHtml(input);
  }
  const path = resolve(process.cwd(), input);
  if (!existsSync(path)) throw new Error(`Файл не знайдено: ${path}`);
  return readFileSync(path, 'utf8');
}

/** Парсинг MD за правилами з n8n. dataSourceUrl — URL/шлях, звідки взято текст (для поля source у кожного item). */
function parsePromptsMd(text, dataSourceUrl = null) {
  const startMarker = '# ⭐ Prompts';
  const startIndex = text.indexOf(startMarker);

  if (startIndex === -1) {
    return {
      source: 'prompts-md',
      error: "Marker '# ⭐ Prompts' not found",
      count: 0,
      items: [],
    };
  }

  const sourceSlice = text.slice(startIndex);

  const sectionRegex = /^##\s+(.+?)\s*\n([\s\S]*?)(?=^##\s+|\Z)/gm;
  const sections = [];
  let match;

  while ((match = sectionRegex.exec(sourceSlice)) !== null) {
    const title = match[1].trim();
    const rawContent = match[2].trim();

    let description = rawContent;
    let typescript = null;

    const defIndex = rawContent.indexOf('### Definition');
    if (defIndex !== -1) {
      description = rawContent.slice(0, defIndex).trim();

      const tsMatch = rawContent.match(/```typescript\s*([\s\S]*?)```/);
      if (tsMatch) {
        typescript = tsMatch[1].trim();
      }
    }

    sections.push({
      title: cleanTitleOrDescription(title),
      description: cleanTitleOrDescription(description),
      link: null,
      source: dataSourceUrl ?? null,
      category: null,
      extra: { typescript: typescript ?? null },
    });
  }

  return {
    source: 'prompts-md',
    count: sections.length,
    items: sections,
  };
}

async function run() {
  console.log('Джерело:', URL);
  const text = await getText(URL);
  const result = parsePromptsMd(text, URL);

  if (result.error) {
    console.warn(result.error);
  } else {
    console.log('Секцій:', result.count);
  }

  const writtenPath = saveRawJson('assets', PARSER_ID, result);
  console.log('Збережено:', writtenPath);
  return result;
}

export default run;
export { parsePromptsMd, getText };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
