import type { Pool } from 'pg';
import { EvalCase, runExecutor } from '../lib/case';
import { FakeWeb } from '../lib/fake-web';
import { createCard } from '../lib/seed';
import { check, isUkrainian, longestCommonRun, specText } from '../lib/graders';
import { DataStore } from '../../src/data/data-store';
import { kyivMonthDay, queryDataset } from '../../src/data/data-query';
import type { FieldDef } from '../../src/data/data.types';

/**
 * Spec 032 success criterion: agents read the schemas first and fetch only the fields they need.
 *
 * Two new datasets (no migration, no code): Ukrainian dishes with long histories and recipes, and a
 * distractor about cars. The slot asks for the story of a dish, so the executor must pick `eval_dishes`
 * from the catalog and fetch a few fields (name, region, history, photo), not the long recipe texts.
 *
 * Token comparison ("library data"): the characters of the rows the agent fetched with query_data versus
 * what today's search_library returns for the same dataset — 8 random rows, each with title, text (≤ 800),
 * image, url, category and every other field in `extra`. The hard check needs ≥ 50 % fewer; a soft check
 * also counts the catalog reads. Tokens are estimated as characters / 4 (only the ratio matters).
 */

const CH = '@eval_dishes';
const DISHES = 'eval_dishes';
const CARS = 'eval_car_facts';

const long = (s: string, n: number) => Array.from({ length: n }, () => s).join(' ');

const DISH_FIELDS: FieldDef[] = [
  { name: 'name', type: 'text', description: 'Назва страви українською', required: true, searchable: true },
  { name: 'region', type: 'enum', description: 'Регіон України, звідки походить страва', enum: ['Полтавщина', 'Київщина', 'Гуцульщина', 'Поділля', 'Слобожанщина'], filterable: true },
  { name: 'history', type: 'long_text', description: 'Історія походження страви: коли й де зʼявилась, легенди, звичаї (300–1500 символів)' },
  { name: 'ingredients', type: 'long_text', description: 'Інгредієнти з кількостями' },
  { name: 'recipe', type: 'long_text', description: 'Покроковий рецепт приготування' },
  { name: 'photo', type: 'image_url', description: 'Фото готової страви' },
  { name: 'source_name', type: 'text', description: 'Звідки запис' },
];

const DISH_ROWS = [
  { name: 'Полтавські галушки', region: 'Полтавщина', photo: 'https://food.example/img/halushky.jpg',
    history: `Галушки згадуються в полтавських переказах із XVIII століття. ${long('Їх варили в чумацьких обозах і на ярмарках, а в Полтаві 2006 року поставили памʼятник галушці.', 6)}` },
  { name: 'Банош', region: 'Гуцульщина', photo: 'https://food.example/img/banosh.jpg',
    history: `Банош — страва гуцульських пастухів, яку готували на вогні в полонинах. ${long('Кукурудзяну крупу варили на сметані, а чоловіки традиційно варили банош самі, без жінок.', 6)}` },
  { name: 'Київські котлети', region: 'Київщина', photo: 'https://food.example/img/kotlety.jpg',
    history: `Котлета по-київськи стала символом столичних ресторанів у середині XX століття. ${long('Рецепт із вершковим маслом усередині повʼязують із рестораном готелю «Континенталь».', 6)}` },
  { name: 'Подільські пироги', region: 'Поділля', photo: 'https://food.example/img/pyrohy.jpg',
    history: `Подільські печені пироги пекли на свята й обжинки. ${long('Кожна господиня мала свою начинку: від квасолі до сушених груш, і пироги дарували сусідам.', 6)}` },
  { name: 'Слобожанський куліш', region: 'Слобожанщина', photo: 'https://food.example/img/kulish.jpg',
    history: `Куліш — козацька польова каша, яку слобожани варили в казанах. ${long('Пшоно з салом і цибулею годувало козаків у походах, а згодом стало буденною стравою селян.', 6)}` },
  { name: 'Вареники з вишнями', region: 'Полтавщина', photo: 'https://food.example/img/varenyky.jpg',
    history: `Вареники з вишнями варили влітку, коли достигали сади. ${long('На Зелені свята їх подавали з медом, і за звичаєм перший вареник клали для предків.', 6)}` },
].map((r) => ({
  ...r,
  ingredients: long('борошно — 500 г; вода — 250 мл; сіль — дрібка; яйце — 1 шт.; масло вершкове — 50 г;', 4),
  recipe: long('Замісіть тісто, дайте йому відпочити 30 хвилин, розкачайте, сформуйте, відваріть у підсоленій воді 5–7 хвилин і подавайте зі сметаною.', 8),
  source_name: 'eval-fixture',
}));

export async function resetDatasets(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM pending_actions WHERE kind = 'edit_data_schema' AND payload->>'dataset' = ANY($1::text[])`, [[DISHES, CARS]]);
  await pool.query(`DELETE FROM data_items WHERE schema_id IN (SELECT id FROM data_schemas WHERE key = ANY($1::text[]))`, [[DISHES, CARS]]);
  await pool.query(`DELETE FROM data_imports WHERE schema_id IN (SELECT id FROM data_schemas WHERE key = ANY($1::text[]))`, [[DISHES, CARS]]);
  await pool.query(`DELETE FROM data_schemas WHERE key = ANY($1::text[])`, [[DISHES, CARS]]);
}

export async function seedDatasets(pool: Pool): Promise<Map<string, string>> {
  const store = new DataStore(pool);
  await store.createSchema({
    key: DISHES, title: 'Українські страви з історією', entity: 'dish', status: 'active', language: 'uk', default_license: 'own',
    description: 'Традиційні страви українських регіонів: назва, регіон, історія походження, інгредієнти, рецепт і фото. Для постів про кухню, історію страв і рецептів.',
    suitable_for: 'кулінарні канали, історія і культура України', fields: DISH_FIELDS,
    roles: { title: 'name', body: 'history', image: 'photo', category: 'region' }, dedup_key: ['name'],
    reuse_policy: { kind: 'never' }, contains_personal_data: false,
  }, 'eval');
  await store.createSchema({
    key: CARS, title: 'Факти про автомобілі', entity: 'fact', status: 'active', language: 'uk', default_license: 'own',
    description: 'Короткі факти про історію автомобілів і автобрендів. Для автомобільних каналів.',
    suitable_for: 'автоканали', dedup_key: ['fact'], reuse_policy: { kind: 'never' }, contains_personal_data: false,
    fields: [{ name: 'fact', type: 'long_text', description: 'Факт', required: true }, { name: 'brand', type: 'text', description: 'Бренд', filterable: true }],
    roles: { title: 'brand', body: 'fact' },
  }, 'eval');
  const r = await store.upsert(DISHES, DISH_ROWS);
  if (r.inserted !== DISH_ROWS.length) throw new Error(`seed ${DISHES}: ${JSON.stringify([...r.rejected, ...r.invalid])}`);
  await store.upsert(CARS, [{ fact: 'Перший серійний автомобіль зібрали у 1886 році.', brand: 'Benz' }, { fact: 'Модель T випускали 19 років.', brand: 'Ford' }]);
  await store.refreshStats();
  const { rows } = await pool.query(`SELECT d.id::text, d.data->>'name' AS name FROM data_items d JOIN data_schemas s ON s.id = d.schema_id WHERE s.key = $1`, [DISHES]);
  return new Map(rows.map((x) => [`data://${DISHES}/${x.id}`, x.name]));
}

/** What today's search_library returns for this dataset: 8 rows, title + text ≤ 800 + every other field in extra. */
export async function searchLibraryBaselineChars(pool: Pool): Promise<number> {
  const schema = await new DataStore(pool).requireSchema(DISHES);
  const r = await queryDataset(pool, schema, { audience: 'owner', limit: 8, order: 'random', today: kyivMonthDay(), bodyChars: 800 });
  const items = r.rows.map((x: any) => ({
    id: x.id, title: x.title, text: x.body, image_url: x.image_url, url: x.url, category: x.category, extra: x.data, library_ref: x.ref,
  }));
  return JSON.stringify({ table: DISHES, items }).length;
}

interface ToolStep { tool_name: string; input: any; output: any }

export const executorPicksDataset: EvalCase = {
  id: 'executor-picks-dataset', role: 'executor', channel: CH,
  title: 'Вибір датасету з каталогу і лише потрібні поля (spec 032)',
  web: () => new FakeWeb(),
  async execute(ctx) {
    await resetDatasets(ctx.pool);
    const refs = await seedDatasets(ctx.pool);
    await createCard(ctx.pool, {
      channelKey: CH, title: 'Смак історії', brief: 'Українська кухня: одна страва на день — звідки вона, яка в неї історія і чим вона особлива. Коротко, живо, з фото.',
      formats: { photo: 1, text: 0.4 }, hashtags: ['кухня', 'історія', 'страва'], hashtagMin: 1, hashtagMax: 2,
      sources: [{ id: 'library', kind: 'library', ref: 'library_catalog' }],
    });
    const r = await runExecutor(ctx, CH, { format: 'photo', topic: 'Страва дня: історія походження однієї української страви', hints: ['library'] });
    const { rows: steps } = await ctx.pool.query<ToolStep>(
      `SELECT tool_name, input, output FROM editor_run_steps WHERE run_id = $1 AND type = 'tool' ORDER BY idx`, [r.res.runId]);
    const calls = (name: string) => steps.filter((s) => s.tool_name === name);
    const size = (xs: ToolStep[]) => xs.reduce((n, s) => n + JSON.stringify(s.output ?? '').length, 0);
    const queries = calls('query_data');
    const catalogIdx = steps.findIndex((s) => s.tool_name === 'library_catalog');
    const queryIdx = steps.findIndex((s) => s.tool_name === 'query_data');
    const fieldCounts = queries.map((q) => (Array.isArray(q.input?.fields) ? q.input.fields.length : 99));
    const rowsChars = size(queries) + size(calls('search_library'));
    const catalogChars = size(calls('library_catalog'));
    const baseline = await searchLibraryBaselineChars(ctx.pool);
    const tok = (c: number) => Math.round(c / 4);
    const pct = (c: number) => (baseline ? Math.round((1 - c / baseline) * 100) : 0);
    const spec = r.spec;
    const dish = spec?.library_ref ? refs.get(spec.library_ref) : undefined;
    const text = spec ? specText(spec) : '';
    const history = DISH_ROWS.find((x) => x.name === dish)?.history ?? '';
    return {
      runId: r.res.runId, status: r.res.status, terminalTool: r.res.terminalTool, post: r.post, toolErrors: r.toolErrors, toolsUsed: r.toolsUsed,
      checks: [
        check('shadowed (publish_post ok)', r.after.status === 'shadowed', r.after.status),
        check('read library_catalog before query_data', catalogIdx >= 0 && queryIdx > catalogIdx, r.toolsUsed.join(' → ')),
        check(`picked ${DISHES} (not the distractor)`, queries.some((q) => q.input?.schema === DISHES) && !queries.some((q) => q.input?.schema === CARS),
          queries.map((q) => q.input?.schema).join(', ') || 'no query_data'),
        check('≤ 5 fields per query_data call', queries.length > 0 && fieldCounts.every((n) => n <= 5), fieldCounts.join(', ') || 'no query_data'),
        check('library_ref = data:// ref of a seeded dish', !!dish, spec?.library_ref),
        check('origin library', spec?.origin === 'library', spec?.origin),
        check('library data ≥ 50 % fewer tokens than search_library', baseline > 0 && rowsChars > 0 && rowsChars <= baseline * 0.5,
          `rows ≈ ${tok(rowsChars)} tokens vs search_library ≈ ${tok(baseline)} (${pct(rowsChars)} % fewer)`),
        check('incl. catalog reads still ≥ 50 % fewer', baseline > 0 && rowsChars + catalogChars <= baseline * 0.5,
          `rows + catalog ≈ ${tok(rowsChars + catalogChars)} tokens vs ≈ ${tok(baseline)} (${pct(rowsChars + catalogChars)} % fewer)`, true),
        check('no legacy search_library', calls('search_library').length === 0, undefined, true),
        check('Ukrainian', isUkrainian(text)),
        check('history retold, not copied (longest run < 80)', longestCommonRun(text, history) < 80, `${longestCommonRun(text, history)} chars`, true),
      ],
      judge: spec ? { channelBrief: 'Українська кухня: історія страв', slotTopic: 'Страва дня: історія походження', sourceText: history, post: r.post } : undefined,
    };
  },
};

export const DATA_CASES = [executorPicksDataset];
