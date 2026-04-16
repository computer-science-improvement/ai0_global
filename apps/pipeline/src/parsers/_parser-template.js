/**
 * TEMPLATE: новий парсер
 * Копіюй цей файл, замінюй значення позначені ← ЗМІНИТИ
 *
 * Checklist:
 *   1. PARSER_ID   — унікальна назва → буде ім'ям файлу data/<PARSER_ID>.json
 *   2. run()       — логіка отримання і парсингу даних
 *   3. result      — обов'язково поля: source, items[]
 *   4. Кожен item  — обов'язково поля: title, description; опційно: link, source, category, extra
 *   5. Додай скрипт у package.json: "parse:<name>": "node src/parsers/<name>.js"
 *   6. Якщо потрібно зберегти в assets — дані підхопить npm run load автоматично
 *      Якщо нова таблиця — також створи src/loaders/<name>.js
 *
 * Структура result.items (поля збігаються з колонками таблиці assets):
 *   title       {string}  — обов'язково
 *   description {string}  — обов'язково (може бути '')
 *   link        {string|null}  — URL для переходу (ChatGPT, mcpservers.org тощо)
 *   source      {string|null}  — URL сторінки-джерела (звідки скрапили)
 *   category    {string|null}  — категорія
 *   extra       {object|null}  — будь-які додаткові поля (зберігаються як JSONB)
 */
import { fetchHtml, fetchJson } from '../lib/fetch.js';
import { scrapeBySelectors } from '../lib/scrape.js';
import { saveJson } from '../lib/json.js';
import { cleanTitleOrDescription } from '../lib/text.js';

// ← ЗМІНИТИ: унікальна назва парсера
const PARSER_ID = 'my-parser';

async function run() {
  // ——— 1. ОТРИМАННЯ ДАНИХ ———
  // HTML-сторінка:
  const url  = 'https://example.com';             // ← ЗМІНИТИ
  const html = await fetchHtml(url);
  // Або JSON API:
  // const data = await fetchJson(url);

  // ——— 2. ПАРСИНГ ———
  // Варіант A — через scrapeBySelectors (CSS-селектори):
  const selectors = {
    items:       'article',     // ← ЗМІНИТИ: контейнер одного запису
    title:       'h2',          // ← ЗМІНИТИ
    description: '.desc',       // ← ЗМІНИТИ
    link:        'a[href]',     // ← ЗМІНИТИ (або видали якщо немає)
  };
  const raw  = scrapeBySelectors(html, selectors);
  const items = (raw.items ?? []).map((item) => ({
    title:       cleanTitleOrDescription(item.title ?? ''),
    description: cleanTitleOrDescription(item.description ?? ''),
    link:        item.link   ?? null,
    source:      url,
    category:    null,          // ← ЗМІНИТИ або видали
    extra:       null,          // ← ЗМІНИТИ або видали
  }));

  // Варіант B — власна логіка (розкоментуй і адаптуй):
  // const items = data.results.map((item) => ({
  //   title:       cleanTitleOrDescription(item.name ?? ''),
  //   description: cleanTitleOrDescription(item.body ?? ''),
  //   link:        item.url ?? null,
  //   source:      url,
  //   category:    item.tag ?? null,
  //   extra:       { raw: item },
  // }));

  // ——— 3. ЗБЕРЕЖЕННЯ JSON ———
  const result = { source: PARSER_ID, count: items.length, items };
  const writtenPath = saveJson(PARSER_ID, result);
  console.log('Saved:', writtenPath, '— items:', result.count);

  return result;
}

export default run;

// Запуск при виклику файлу напряму
run().catch((err) => { console.error(err); process.exit(1); });
