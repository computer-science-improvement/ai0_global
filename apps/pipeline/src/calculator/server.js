/**
 * Локальний калькулятор «скільки днів вистачить контенту».
 * Читає всі контентні таблиці з PostgreSQL.
 */
import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = parseInt(process.env.CALCULATOR_PORT || '3847', 10);

async function safeQuery(text) {
  try {
    const r = await pool.query(text);
    return r.rows;
  } catch (e) {
    if (e.code === '42P01') return [];
    throw e;
  }
}

async function fetchMeta() {
  const [
    assetsBySource,
    assetsByPair,
    promptsByCategory,
    onThisDayByMonth,
    articlesByCategory,
    jokesTotal,
    quotesByCategory,
    recipesByCategory,
  ] = await Promise.all([
    safeQuery(`
      select data_source, count(*)::int as count
      from assets group by data_source order by data_source
    `),
    safeQuery(`
      select data_source, category, count(*)::int as count
      from assets group by data_source, category order by data_source, category nulls last
    `),
    safeQuery(`
      select category, count(*)::int as count
      from prompts group by category order by category nulls last
    `),
    safeQuery(`
      select month, count(*)::int as count
      from on_this_day group by month order by month
    `),
    safeQuery(`
      select category, count(*)::int as count
      from articles group by category order by category nulls last
    `),
    safeQuery(`select count(*)::int as count from jokes`),
    safeQuery(`
      select category, count(*)::int as count
      from quotes group by category order by category nulls last
    `),
    safeQuery(`
      select category, count(*)::int as count
      from recipes group by category order by category nulls last
    `),
  ]);

  const sum = (rows) => rows.reduce((s, r) => s + r.count, 0);

  return {
    assetsTotal:       sum(assetsBySource),
    assetsBySource,
    assetsByPair,
    promptsTotal:      sum(promptsByCategory),
    promptsByCategory,
    onThisDayTotal:    sum(onThisDayByMonth),
    onThisDayByMonth,
    articlesTotal:     sum(articlesByCategory),
    articlesByCategory,
    jokesTotal:        jokesTotal[0]?.count ?? 0,
    quotesTotal:       sum(quotesByCategory),
    quotesByCategory,
    recipesTotal:      sum(recipesByCategory),
    recipesByCategory,
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath, contentType) {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const body = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/meta') {
    try {
      const meta = await fetchMeta();
      sendJson(res, 200, meta);
    } catch (e) {
      console.error(e);
      sendJson(res, 500, { error: String(e.message || e) });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendFile(res, join(PUBLIC, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/')) {
    const file = join(PUBLIC, url.pathname.slice(1));
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const ext = extname(file);
    const types = { '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
    if (types[ext]) {
      sendFile(res, file, types[ext]);
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Калькулятор контенту: http://127.0.0.1:${PORT}`);
});
