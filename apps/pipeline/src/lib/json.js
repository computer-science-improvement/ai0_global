/**
 * Допоміжні функції для роботи з JSON у data/
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
const LIFECYCLE_STAGES = ['raw', 'normalized', 'generated', 'publish-ready'];

/**
 * Повертає повний шлях до файлу в data/
 * @param {string} filename - ім'я без .json або з .json
 * @returns {string}
 */
export function getDataPath(filename) {
  const name = filename.endsWith('.json') ? filename : `${filename}.json`;
  return join(DATA_DIR, name);
}

/** Повертає повний шлях до файлу в data/{subdir}/ */
export function getDataSubPath(subdir, filename) {
  const name = filename.endsWith('.json') ? filename : `${filename}.json`;
  return join(DATA_DIR, subdir, name);
}

/** Повертає повний шлях до файлу в data/{stage}/{subdir}/ */
export function getLifecyclePath(stage, subdir, filename) {
  if (!LIFECYCLE_STAGES.includes(stage)) {
    throw new Error(`Unknown lifecycle stage: ${stage}`);
  }
  const name = filename.endsWith('.json') ? filename : `${filename}.json`;
  return join(DATA_DIR, stage, subdir, name);
}

/**
 * Зберігає дані у JSON у папку data/
 * @param {string} filename - ім'я файлу (наприклад "my-parser" або "my-parser.json")
 * @param {object|array} data - об'єкт або масив для збереження
 * @param {object} options - { pretty?: boolean } — pretty: true для відступів (за замовчуванням true)
 * @returns {string} шлях до записаного файлу
 */
export function saveJson(filename, data, options = {}) {
  const { pretty = true } = options;
  const path = getDataPath(filename);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Зберігає дані у JSON у папку data/{subdir}/ */
export function saveJsonTo(subdir, filename, data, options = {}) {
  const { pretty = true } = options;
  const path = getDataSubPath(subdir, filename);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Зберігає дані у JSON у папку data/raw/{subdir}/ */
export function saveRawJson(subdir, filename, data, options = {}) {
  const { pretty = true } = options;
  const path = getLifecyclePath('raw', subdir, filename);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Зберігає дані у JSON у папку data/normalized/{subdir}/ */
export function saveNormalizedJson(subdir, filename, data, options = {}) {
  const { pretty = true } = options;
  const path = getLifecyclePath('normalized', subdir, filename);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Зберігає дані у JSON у папку data/generated/{subdir}/ */
export function saveGeneratedJson(subdir, filename, data, options = {}) {
  const { pretty = true } = options;
  const path = getLifecyclePath('generated', subdir, filename);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Зберігає дані у JSON у папку data/publish-ready/{subdir}/ */
export function savePublishReadyJson(subdir, filename, data, options = {}) {
  const { pretty = true } = options;
  const path = getLifecyclePath('publish-ready', subdir, filename);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileSync(path, content, 'utf8');
  return path;
}

/**
 * Читає JSON з data/
 * @param {string} filename - ім'я файлу (без .json або з .json)
 * @returns {object|array}
 */
export function readJson(filename) {
  const path = getDataPath(filename);
  if (!existsSync(path)) {
    throw new Error(`File not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Перевіряє, чи існує файл у data/
 * @param {string} filename
 * @returns {boolean}
 */
export function hasJson(filename) {
  return existsSync(getDataPath(filename));
}
