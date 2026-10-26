/** Spec 037 T4: the critic reads passages around the post's claims (title, date, ±400 chars), not the page head. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CriticGate, PAGE_CAP } from './critic-gate';
import { criticUserPrompt, type CriticRequest } from './critic.service';
import type { EditorTool } from '../harness/tool';
import { criticGroundingLines, groundingCheckOf } from './critic-passages';

const URL = 'https://www.marktechpost.com/2026/10/13/google-gemini-4-argon-api-release/';
const HEAD = 'Home AI News Research Tutorials Newsletter Subscribe. '.repeat(90); // ~4.8k chars of navigation, the old excerpt
const FACT = 'Google said Gemini 4 Argon accepts a 1M-token context window, while a single response is capped at 64K output tokens. '
  + 'On the Vals Index the model scores 68.90%, first among public models.';
const TAIL = 'Related: other news of the week. '.repeat(60);
/** ≈ 7.1k: a short page, which the critic gets whole (spec 067). */
const PAGE = `${HEAD}${FACT} ${TAIL}`;
/** > 12k: more than the critic is shown whole, so it reads the passages around the post's claims. */
const BIG = `${HEAD}${FACT} ${TAIL.repeat(5)}`;
const POST = 'Google зробив доступною для всіх модель Gemini 4 Argon.\n\nМодель пише тексти довжиною до 1 мільйона токенів за один запит. '
  + 'Argon очолює рейтинг Vals Index з результатом 68,90%.\n\n→ MarkTechPost';

function gateWith(seen: CriticRequest[], libraryText?: (ref: string) => Promise<string | null>, page = PAGE) {
  const gate = new CriticGate(
    {
      critic: { review: async (r: CriticRequest) => { seen.push(r); return { ok: false as const, error: 'x', runIds: [], costUsd: 0 }; } },
      plans: { updateSlot: async () => null as any },
      ...(libraryText ? { libraryText } : {}),
    },
    { slotId: 's1', channelKey: '@chan', mode: 'approve', resourceRef: 'telegram:@chan', platform: 'telegram', voice: {} },
  );
  const [fetch] = gate.wrapTools([{ name: 'web_fetch', execute: async () => ({
    url: URL, title: 'Google Releases Gemini 4 Argon to the API', text: page, published_at: '2026-10-13T16:20:00.000Z',
    primary_links: ['https://blog.google/technology/ai/gemini-4-argon/'],
  }) }] as unknown as EditorTool[]);
  return { gate, fetch };
}

const section = (prompt: string) => prompt.slice(prompt.indexOf('## Джерело'), prompt.indexOf('## Попередження lint')).trim();

test('067 snapshot: a short page comes whole — «чого тут немає — немає в джерелі», no passages', async () => {
  const seen: CriticRequest[] = [];
  const { gate, fetch } = gateWith(seen);
  await fetch.execute({ url: URL }, {} as any);
  await gate.check({ text: POST, spec: { source: { url: URL } }, format: 'text', warnings: [], publishAt: '2026-10-14T09:00:12Z', timezone: 'Europe/Kyiv' });
  const src = seen[0].source!;
  assert.equal(src.coverage, 'full');
  assert.deepEqual(src.passages, []);
  assert.equal(src.excerpt, null);
  const block = section(criticUserPrompt(seen[0]));
  assert.equal(block, [
    '## Джерело',
    `URL: ${URL}`,
    'Сторінка: «Google Releases Gemini 4 Argon to the API»; опублікована: вівторок, 13.10.2026 19:20 (Europe/Kyiv).',
    'Це весь текст сторінки: чого тут немає — немає в джерелі.',
    `Google Releases Gemini 4 Argon to the API\n${PAGE}`,
    '',
    '### Звірка чисел і дат кодом (з усіма прочитаними текстами, не лише з уривками вище)',
    'Знайдено в джерелі: «1 мільйона» (там: «1M»), «68,90%» (там: «68.90%»).',
    'Ці числа й дати є в джерелі, навіть якщо записані інакше (інша мова, формат дати, K/M, центи): не знижуй за них grounding і не пиши, що їх немає у фрагменті. Перевір лише, чи вони означають те саме, що в пості.',
  ].join('\n'));
});

test('snapshot: the critic prompt\'s source block of a big page — title, date and the passage around «1 мільйона» / «68,90%», not the head', async () => {
  const seen: CriticRequest[] = [];
  const { gate, fetch } = gateWith(seen, undefined, BIG);
  await fetch.execute({ url: URL }, {} as any);
  await gate.check({ text: POST, spec: { source: { url: URL } }, format: 'text', warnings: [], publishAt: '2026-10-14T09:00:12Z', timezone: 'Europe/Kyiv' });
  const block = section(criticUserPrompt(seen[0]));
  const passage = seen[0].source!.passages![0].text;
  const { size, chars } = seen[0].source!.read!;
  assert.equal(seen[0].source!.coverage, 'read');
  assert.equal(block, [
    '## Джерело',
    `URL: ${URL}`,
    'Сторінка: «Google Releases Gemini 4 Argon to the API»; опублікована: вівторок, 13.10.2026 19:20 (Europe/Kyiv).',
    `Що автор прочитав у документі (${chars} з ${size} знаків); ось уривки навколо чисел і назв поста (±400 знаків) — звір із ними кожне число й факт, зокрема що саме число означає:`,
    `[1] про «1 мільйона», «68,90%», «Gemini 4 Argon», «Vals Index»:\n${passage}`,
    'Чого тут немає, автор не читав — це не доказ, що факту немає в джерелі: став grounding 3 з приміткою, не ≤ 2. Підстава для ≤ 2 — лише число, якого немає у цих частинах і яке код не знайшов у жодному прочитаному тексті.',
    '',
    '### Звірка чисел і дат кодом (з усіма прочитаними текстами, не лише з уривками вище)',
    'Знайдено в джерелі: «1 мільйона» (там: «1M»), «68,90%» (там: «68.90%»).',
    'Ці числа й дати є в джерелі, навіть якщо записані інакше (інша мова, формат дати, K/M, центи): не знижуй за них grounding і не пиши, що їх немає у фрагменті. Перевір лише, чи вони означають те саме, що в пості.',
  ].join('\n'));
  assert.match(passage, /^…/);
  assert.match(passage, /1M-token context window, while a single response is capped at 64K output tokens/);
  assert.match(passage, /scores 68\.90%/);
  assert.ok(passage.length < 1_400, `${passage.length}`);
  assert.ok(!block.includes(HEAD.slice(0, 400)), 'the page head is not what the critic reads');
});

test('nothing of the post in a big page: the critic is told so and gets the start of what was read', async () => {
  const seen: CriticRequest[] = [];
  const { gate, fetch } = gateWith(seen, undefined, BIG);
  await fetch.execute({ url: URL }, {} as any);
  await gate.check({ text: 'Інша історія без чисел.', spec: { source: { url: URL } }, format: 'text', warnings: [], publishAt: '2026-10-14T09:00:12Z', timezone: 'Europe/Kyiv' });
  const block = section(criticUserPrompt(seen[0]));
  assert.match(block, /Чисел і назв поста у прочитаному не знайдено/);
  assert.match(block, /Початок прочитаного:\nGoogle Releases Gemini 4 Argon to the API\nHome AI News/);
  assert.ok(block.length < 4_500, `the head is clipped: ${block.length}`);
});

test('groundingSources: the page text (≤ 60k), the aggregator\'s primary links and the library row', async () => {
  const seen: CriticRequest[] = [];
  const { gate, fetch } = gateWith(seen, async (ref) => (ref === 'library://facts/7' ? 'Факт: 42 відсотки.' : null));
  await fetch.execute({ url: URL }, {} as any);
  const s = await gate.groundingSources({ library_ref: 'library://facts/7' });
  assert.equal(s.length, 2);
  assert.equal(s[0].url, URL);
  assert.ok(s[0].text!.includes(FACT));
  assert.ok(s[0].text!.length <= PAGE_CAP);
  assert.deepEqual(s[0].primaryLinks, ['https://blog.google/technology/ai/gemini-4-argon/']);
  assert.deepEqual(s[1], { url: 'library://facts/7', text: 'Факт: 42 відсотки.' });
  assert.deepEqual(gate.sources().map((x) => Object.keys(x).sort()), [['publishedAt', 'title', 'url']], 'sources() keeps its T5 shape');
});

test('037: the critic is told which numbers and dates code found in the sources and how the source writes them', () => {
  const post = 'Роздача триває до 19 жовтня, 23:59 UTC. Ціна без знижки — 1 799 грн.';
  const g = groundingCheckOf(post, [{ url: 'https://store.example/game', text: 'Free to keep. Offer ends 10/19/2026 11:59 PM UTC.' }],
    { publishedAt: '2026-10-15T09:00:00Z', timezone: 'Europe/Kyiv' });
  assert.ok(g);
  assert.deepEqual(g!.found.map((f) => [f.text, f.as]), [['19 жовтня', '10/19/2026']]);
  assert.deepEqual(g!.missing, ['1 799 грн']);
  const lines = criticGroundingLines(g).join('\n');
  assert.match(lines, /Знайдено в джерелі: «19 жовтня» \(там: «10\/19\/2026»\)/);
  assert.match(lines, /не знижуй за них grounding/);
  assert.match(lines, /Не знайдено в жодному прочитаному тексті: «1 799 грн»/);
  assert.match(lines, /підказка коду, а не доказ/, '063: a missing number is a hint, quote the passage');
  assert.deepEqual(criticGroundingLines(null), []);
  assert.equal(groundingCheckOf('Без чисел.', [{ url: 'u', text: 'x' }]), null);
});

test('063: the critic reads lint warnings as hints to verify, not as proof; spelled-out numbers count as found', () => {
  const g = groundingCheckOf('Стартап залучив понад $1 млрд і підтримав SB 53.', [{ url: 'u', text: 'It has raised over a billion dollars and backed Senate Bill 53.' }],
    { publishedAt: '2026-10-15T09:00:00Z', timezone: 'Europe/Kyiv' });
  assert.deepEqual(g!.missing, []);
  assert.deepEqual(g!.found.map((f) => [f.text, f.as]), [['$1 млрд', 'a billion'], ['SB 53', 'Senate Bill 53']]);
});
