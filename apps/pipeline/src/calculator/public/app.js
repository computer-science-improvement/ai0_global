const sliceEl = document.getElementById('slice');
const perDayEl = document.getElementById('perDay');
const resultEl = document.getElementById('result');
const errEl = document.getElementById('err');

function showErr(msg) {
  errEl.textContent = msg;
  errEl.classList.toggle('hidden', !msg);
}

function catLabel(c) {
  if (c == null || c === '') return 'без категорії';
  return String(c);
}

const MONTH_NAMES = [
  '', 'Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
  'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень',
];

function addOption(parent, value, text) {
  const o = document.createElement('option');
  o.value = JSON.stringify(value);
  o.textContent = text;
  parent.appendChild(o);
}

function addGroup(frag, label, items) {
  if (!items.length) return;
  const og = document.createElement('optgroup');
  og.label = label;
  items.forEach(({ value, text }) => addOption(og, value, text));
  frag.appendChild(og);
}

function buildOptions(meta) {
  const frag = document.createDocumentFragment();

  // ─── Assets ──────────────────────────────────────────
  if (meta.assetsTotal > 0) {
    const items = [
      { value: { table: 'assets', mode: 'all' }, text: `Усі assets — ${meta.assetsTotal}` },
      ...meta.assetsBySource.map((r) => ({
        value: { table: 'assets', mode: 'source', data_source: r.data_source },
        text: `${r.data_source} — ${r.count}`,
      })),
      ...meta.assetsByPair.map((r) => ({
        value: { table: 'assets', mode: 'pair', data_source: r.data_source, category: r.category },
        text: `${r.data_source} · ${catLabel(r.category)} — ${r.count}`,
      })),
    ];
    addGroup(frag, 'Assets', items);
  }

  // ─── Prompts ─────────────────────────────────────────
  if (meta.promptsTotal > 0) {
    const items = [
      { value: { table: 'prompts', mode: 'all' }, text: `Усі prompts — ${meta.promptsTotal}` },
      ...meta.promptsByCategory.map((r) => ({
        value: { table: 'prompts', mode: 'category', category: r.category },
        text: `${catLabel(r.category)} — ${r.count}`,
      })),
    ];
    addGroup(frag, 'Prompts (ai0-prompts)', items);
  }

  // ─── On This Day ─────────────────────────────────────
  if (meta.onThisDayTotal > 0) {
    const items = [
      { value: { table: 'on_this_day', mode: 'all' }, text: `Усі події — ${meta.onThisDayTotal}` },
      ...meta.onThisDayByMonth.map((r) => ({
        value: { table: 'on_this_day', mode: 'month', month: r.month },
        text: `${MONTH_NAMES[r.month] || r.month} — ${r.count}`,
      })),
    ];
    addGroup(frag, 'On This Day (свята)', items);
  }

  // ─── Articles ────────────────────────────────────────
  if (meta.articlesTotal > 0) {
    const items = [
      { value: { table: 'articles', mode: 'all' }, text: `Усі статті — ${meta.articlesTotal}` },
      ...meta.articlesByCategory.map((r) => ({
        value: { table: 'articles', mode: 'category', category: r.category },
        text: `${catLabel(r.category)} — ${r.count}`,
      })),
    ];
    addGroup(frag, 'Articles (статті)', items);
  }

  // ─── Jokes ───────────────────────────────────────────
  if (meta.jokesTotal > 0) {
    addGroup(frag, 'Jokes (жарти)', [
      { value: { table: 'jokes', mode: 'all' }, text: `Усі жарти — ${meta.jokesTotal}` },
    ]);
  }

  // ─── Quotes ──────────────────────────────────────────
  if (meta.quotesTotal > 0) {
    const items = [
      { value: { table: 'quotes', mode: 'all' }, text: `Усі цитати — ${meta.quotesTotal}` },
      ...meta.quotesByCategory.map((r) => ({
        value: { table: 'quotes', mode: 'category', category: r.category },
        text: `${catLabel(r.category)} — ${r.count}`,
      })),
    ];
    addGroup(frag, 'Quotes (цитати)', items);
  }

  // ─── Recipes ────────────────────────────────────────
  if (meta.recipesTotal > 0) {
    const items = [
      { value: { table: 'recipes', mode: 'all' }, text: `Усі рецепти — ${meta.recipesTotal}` },
      ...meta.recipesByCategory.map((r) => ({
        value: { table: 'recipes', mode: 'category', category: r.category },
        text: `${catLabel(r.category)} — ${r.count}`,
      })),
    ];
    addGroup(frag, 'Recipes (рецепти)', items);
  }

  return frag;
}

function countForSlice(meta, slice) {
  if (!slice || !slice.table) return 0;

  if (slice.mode === 'all') {
    const key = slice.table === 'on_this_day' ? 'onThisDayTotal'
      : slice.table + 'Total';
    return meta[key] ?? 0;
  }

  // Table-specific lookups
  if (slice.table === 'assets') {
    if (slice.mode === 'source') {
      return meta.assetsBySource.find((x) => x.data_source === slice.data_source)?.count ?? 0;
    }
    if (slice.mode === 'pair') {
      return meta.assetsByPair.find(
        (x) => x.data_source === slice.data_source && (x.category ?? null) === (slice.category ?? null)
      )?.count ?? 0;
    }
  }

  if (slice.table === 'prompts' && slice.mode === 'category') {
    return meta.promptsByCategory.find((x) => (x.category ?? null) === (slice.category ?? null))?.count ?? 0;
  }

  if (slice.table === 'on_this_day' && slice.mode === 'month') {
    return meta.onThisDayByMonth.find((x) => x.month === slice.month)?.count ?? 0;
  }

  if (slice.table === 'articles' && slice.mode === 'category') {
    return meta.articlesByCategory.find((x) => (x.category ?? null) === (slice.category ?? null))?.count ?? 0;
  }

  if (slice.table === 'quotes' && slice.mode === 'category') {
    return meta.quotesByCategory.find((x) => (x.category ?? null) === (slice.category ?? null))?.count ?? 0;
  }

  if (slice.table === 'recipes' && slice.mode === 'category') {
    return meta.recipesByCategory.find((x) => (x.category ?? null) === (slice.category ?? null))?.count ?? 0;
  }

  return 0;
}

function renderResult(total, perDay) {
  if (total === 0) {
    resultEl.innerHTML = '<p class="muted">Немає записів для обраного варіанту.</p>';
    return;
  }
  if (!perDay || perDay < 1) {
    resultEl.innerHTML = '<p class="muted">Вкажи постів на день (мінімум 1).</p>';
    return;
  }
  const fullDays = Math.floor(total / perDay);
  const remainder = total % perDay;
  const approx = (total / perDay).toFixed(1);

  resultEl.innerHTML = `
    <p class="big">${fullDays} дн.</p>
    <p class="detail">Записів у вибірці: <strong>${total}</strong> · ${perDay} пост/день</p>
    <p class="detail">Після повних днів залишиться <strong>${remainder}</strong> постів (неповний день).</p>
    <p class="detail">Середня тривалість (десятково): ~${approx} дн.</p>
  `;
}

let metaCache = null;

async function init() {
  try {
    const res = await fetch('/api/meta');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.json();
    metaCache = meta;

    sliceEl.innerHTML = '';
    const opts = buildOptions(meta);
    if (!opts.childNodes.length) {
      sliceEl.innerHTML = '<option value="">Немає даних</option>';
      sliceEl.disabled = true;
      showErr('У базі немає таблиць з даними або вони порожні.');
      return;
    }
    sliceEl.appendChild(opts);
    sliceEl.disabled = false;
    showErr('');
    update();
  } catch (e) {
    showErr("Не вдалося з'єднатися з API. Запусти сервер: pnpm run calculator");
    sliceEl.innerHTML = '<option value="">Помилка</option>';
  }
}

function update() {
  if (!metaCache) return;
  let slice = null;
  try {
    slice = JSON.parse(sliceEl.value);
  } catch {
    slice = null;
  }
  const perDay = parseInt(perDayEl.value, 10);
  const total = countForSlice(metaCache, slice);
  renderResult(total, perDay);
}

sliceEl.addEventListener('change', update);
perDayEl.addEventListener('input', update);

init();
