/**
 * TEMPLATE: новий лоадер
 * Копіюй цей файл, замінюй значення позначені ← ЗМІНИТИ
 *
 * Checklist:
 *   1. LOADER_ID     — унікальна назва (використовується в логах і npm скрипті)
 *   2. SOURCE_DIR    — де лежать JSON-файли з даними
 *   3. TABLE         — назва таблиці в БД
 *   4. COLUMNS       — колонки таблиці в порядку вставки
 *   5. CONFLICT_TARGET — унікальний ключ для дедублікації
 *   6. mapRow()      — маппінг одного запису JSON → рядок таблиці
 *   7. Якщо нова таблиця — додай міграцію в database/migrations/
 *   8. Додай скрипт у package.json: "load:<name>": "node src/loaders/<name>.js"
 */
import 'dotenv/config';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadRows } from '../lib/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ← ЗМІНИТИ: шлях до папки з JSON-файлами
const SOURCE_DIR = join(__dirname, '..', 'data');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

// ← ЗМІНИТИ: назва таблиці
const TABLE = 'my_table';

// ← ЗМІНИТИ: список колонок у порядку вставки (повинні збігатись з ключами в mapRow)
const COLUMNS = ['id', 'title', 'category'];

// ← ЗМІНИТИ: ON CONFLICT target — колонка або комбінація з унікальним індексом
// Один ключ:           '(id)'
// Комбінований ключ:   '(source, title)'
const CONFLICT_TARGET = '(id)';

// ← ЗМІНИТИ: маппінг одного JSON-запису → об'єкт із ключами з COLUMNS
function mapRow(item) {
  return {
    id:       item.id,
    title:    item.title ?? '',
    category: item.category ?? null,
  };
}

async function load() {
  const files = (await readdir(SOURCE_DIR)).filter((f) => f.endsWith('.json'));

  if (LIMIT) console.log(`Test mode: first ${LIMIT} items per file\n`);

  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const file of files) {
    const raw = await readFile(join(SOURCE_DIR, file), 'utf-8');
    let data;
    try { data = JSON.parse(raw); } catch { console.warn(`Skip ${file}: invalid JSON`); continue; }

    // ← ЗМІНИТИ якщо структура файлу інша (наприклад data.items, data.results тощо)
    let rows = Array.isArray(data) ? data : (data.items ?? []);
    if (!rows.length) { console.log(`Skip ${file}: no rows`); continue; }

    const totalInFile = rows.length;
    if (LIMIT) rows = rows.slice(0, LIMIT);

    rows = rows.map(mapRow);

    console.log(`Loading ${LIMIT ? rows.length + '/' + totalInFile : rows.length} rows from ${file} -> ${TABLE}`);
    const { inserted, skipped } = await loadRows(TABLE, rows, { columns: COLUMNS, conflictTarget: CONFLICT_TARGET });
    totalInserted += inserted;
    totalSkipped  += skipped;
    console.log(`  inserted: ${inserted}, skipped (duplicates): ${skipped}`);
  }

  console.log(`\nDone. Total inserted: ${totalInserted}, skipped: ${totalSkipped}`);
  await pool.end();
}

load().catch((err) => { console.error(err); process.exit(1); });
