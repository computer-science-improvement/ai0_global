import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Finding, Fix } from '../sysadmin/audit.types';
import { channelOfRefId, notifiable, notedElsewhere, readinessRefId } from './notify';
import { NOTHING_TO_FIX_UK, blockerLineUk, fixActionUk, fixFailureUk, readinessBodyUk, readinessSource, type ReadinessCardDeps } from './readiness-cards';
import { CH } from './testing/facts-fixture';
import { mkF } from './testing/fake-readiness';
import type { FixOutcome } from './readiness.service';
import type { ReadinessView } from './view';

/**
 * Spec 072 T7, FR-009, A9, A13, I9: the readiness card of the owner bot. The pool returns the joined row the SQL would; the
 * readiness service is a recording double.
 */

const STAMP = new Date('2026-10-20T23:59:00.000Z');
const SKILL_OFF: Fix = { kind: 'skill_disable', agent: 'fx072', skill: 's1' };
const HASHTAG: Fix = { kind: 'hashtag_min_zero', channel: CH };
const TOOLS: Fix = { kind: 'tools_allow_add', channel: CH, tools: ['web_fetch'] };

/** An error that has a one-tap fix. */
const fixable = (code: string, id: string, fix: Fix, label = `${code}:${id}`): Finding => {
  const f = mkF(code, 'error', { id, fix });
  return { ...f, subject: { ...f.subject, label } };
};
const plain = (code: string, id: string, label = `${code}:${id}`): Finding => {
  const f = mkF(code, 'error', { id });
  return { ...f, subject: { ...f.subject, label } };
};

interface Row { channel_key: string; findings: Finding[]; notified_blockers: string[]; notified_at: Date; launch_open: boolean }
const rowOf = (findings: Finding[], over: Partial<Row> = {}, stamped: Finding[] = findings): Row => ({
  channel_key: CH, findings, notified_blockers: stamped.filter((f) => f.severity === 'error').map((f) => f.key), notified_at: STAMP, launch_open: false, ...over,
});

function harness(rows: Row[], o: { agent?: string | null; fix?: Partial<FixOutcome>; blockersAfter?: number } = {}) {
  const sqls: string[] = [];
  const calls: unknown[][] = [];
  const view = (blockers: number) => ({ channelKey: CH, blockers } as unknown as ReadinessView);
  const deps: ReadinessCardDeps = {
    pool: { query: async (sql: string) => { sqls.push(sql); return { rows }; } } as any,
    readiness: {
      fix: async (key: string, sel: unknown, via: string) => {
        calls.push(['fix', key, sel, via]);
        return { applied: ['one'], failed: [], view: view(o.blockersAfter ?? 0), ...o.fix } as FixOutcome;
      },
      recheck: async (key: string, reason: string) => { calls.push(['recheck', key, reason]); return view(o.blockersAfter ?? 0); },
    } as any,
    agentOf: async () => (o.agent === undefined ? 'fx072' : o.agent),
  };
  return { src: readinessSource(deps), calls, sqls };
}

// ── the card ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('readiness card: the title counts the open stamped blockers with the Ukrainian plural', async () => {
  for (const [n, word] of [[1, 'блокер'], [2, 'блокери'], [4, 'блокери'], [5, 'блокерів'], [11, 'блокерів'], [21, 'блокер']] as const) {
    const fs = Array.from({ length: n }, (_, i) => plain('dataset_without_series', `d${i}`));
    const { src } = harness([rowOf(fs)]);
    const [item] = await src.waiting(new Date());
    assert.equal(item.title, `${CH}: ${n} ${word} готовності`);
  }
});

test('readiness card: at most five blocker lines, the rest as «…і ще N», then the one-tap summary', async () => {
  const fs = Array.from({ length: 8 }, (_, i) => plain('dataset_without_series', `d${i}`, `набір ${i}`));
  const { src } = harness([rowOf(fs)]);
  const [item] = await src.waiting(new Date());
  const lines = item.body!.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('• ')).length, 5);
  assert.match(lines[0], /^• .+ — набір 0$/);
  assert.ok(lines.includes('…і ще 3'));
  assert.equal(lines.at(-1), 'Виправлень в один дотик: 0. Решта — у панелі Readiness.');
  assert.doesNotMatch(item.body!, /Виправлю в один дотик/, 'nothing to fix: no list');
  assert.ok(item.body!.length <= 600);
  assert.equal(item.critical, false);
  assert.equal(item.since.toISOString(), STAMP.toISOString());
});

test('readiness card: after the blockers it lists what one tap does for them, one line per distinct action, at most five', async () => {
  const fs = [
    fixable('series_source_contradicted', 'a', SKILL_OFF, 'a'),
    fixable('series_source_contradicted', 'b', { ...SKILL_OFF, skill: 's2' }, 'b'),
    fixable('hashtag_min_without_vocabulary', 'c', HASHTAG, 'c'),
    fixable('tools_missing_for_source', 'd', TOOLS, 'd'),
    fixable('tools_missing_for_source', 'd2', TOOLS, 'd2'),
    plain('dataset_without_series', 'e', 'e'),
  ];
  const { src } = harness([rowOf(fs)]);
  const [item] = await src.waiting(new Date());
  const body = item.body!;
  const at = body.indexOf('Виправлю в один дотик:');
  assert.ok(at > body.indexOf('• '), 'after the blocker lines');
  const block = body.slice(at).split('\n\n')[0].split('\n');
  assert.deepEqual(block, [
    'Виправлю в один дотик:',
    '• Вимкну скіл «s1»',
    '• Вимкну скіл «s2»',
    '• Поставлю мінімум хештегів 0',
    '• Додам web_fetch у дозволені інструменти картки',
  ], 'what the tap does, each subject named, the same action once');
  assert.ok(body.endsWith('Виправлень в один дотик: 5. Решта — у панелі Readiness.'), 'K counts every finding with a fix');
});

test('readiness card: K counts errors and warnings with a fix, not info rows; the buttons follow K', async () => {
  const warn = { ...mkF('formats_diverge', 'warn', { id: 'w', fix: HASHTAG }) };
  const info = mkF('material_low', 'info', { id: 'i', fix: TOOLS });
  {
    // The stamped set is the error only; the warning with a fix is Fix all's target too.
    const e = plain('dataset_without_series', 'e');
    const { src } = harness([rowOf([e, warn, info], {}, [e])]);
    const [item] = await src.waiting(new Date());
    assert.ok(item.body!.endsWith('Виправлень в один дотик: 1. Решта — у панелі Readiness.'), 'the warn counts, the info does not');
    assert.deepEqual(item.buttons.map((b) => b.key), ['fix', 'recheck', 'open']);
  }
  {
    const { src } = harness([rowOf([plain('dataset_without_series', 'e')])]);
    const [item] = await src.waiting(new Date());
    assert.deepEqual(item.buttons, [{ key: 'recheck', label: 'Перевірити' }, { key: 'open', label: 'Відкрити' }]);
  }
  {
    const { src } = harness([rowOf([fixable('hashtag_min_without_vocabulary', 'c', HASHTAG)])]);
    const [item] = await src.waiting(new Date());
    assert.deepEqual(item.buttons[0], { key: 'fix', label: 'Виправити все', confirm: 'Так, виправити' });
  }
});

test('readiness card: the body fits 600 characters with long texts and many fixes, and keeps the summary count', async () => {
  const long = 'дуже довга назва предмета, що не вміщується в один рядок картки '.repeat(3);
  const fs = [
    ...Array.from({ length: 6 }, (_, i) => fixable('series_source_contradicted', `s${i}`, { ...SKILL_OFF, skill: `s${i}` }, `${long}${i}`)),
    fixable('hashtag_min_without_vocabulary', 'h', HASHTAG, long),
    fixable('tools_missing_for_source', 't', TOOLS, long),
    fixable('series_source_not_required', 'r', { kind: 'series_source_require', channel: CH, series: 'Daily' }, long),
    fixable('config_conflict', 'c', { kind: 'conflicts_resolve', agent: 'fx072' }, long),
    fixable('formats_diverge', 'f', { kind: 'conflicts_resolve', agent: 'fx072', codes: ['x'] }, long),
  ];
  const { src } = harness([rowOf(fs)]);
  const [item] = await src.waiting(new Date());
  assert.ok(item.body!.length <= 600, `body is ${item.body!.length} characters`);
  assert.ok(item.body!.endsWith('Виправлень в один дотик: 11. Решта — у панелі Readiness.'));
  assert.match(item.body!, /…і ще \d+/);
});

test('readiness card: a line is the reason in Ukrainian and what it is about; a code with no entry falls back to the title', () => {
  assert.equal(blockerLineUk(plain('dataset_without_series', 'd', 'набір tips')), '• Набір даних є в картці каналу, але жодна серія не бере з нього матеріал — набір tips');
  const unknown = { ...plain('some_future_code', 'x', 'the thing'), title: 'A future problem.' };
  assert.equal(blockerLineUk(unknown), '• A future problem — the thing');
  assert.equal(blockerLineUk({ ...unknown, subject: { ...unknown.subject, label: '' } }), '• A future problem');
  assert.equal(readinessBodyUk([unknown], []).split('\n\n').at(-1), 'Виправлень в один дотик: 0. Решта — у панелі Readiness.');
});

test('W1 integration review: the main 10-27 blocker keeps its subject, with the real Ukrainian reason (87 characters)', () => {
  const f = fixable('series_source_contradicted', 'a', SKILL_OFF, 'Prompt: prompthero-image-prompt-post');
  const line = blockerLineUk(f);
  assert.ok(line.endsWith(' — Prompt: prompthero-image-prompt-post'), line);
  assert.ok(line.startsWith('• Скіл, правило чи настанова велить брати матеріал не з того джерела, яке вимагає серія'), line);
  assert.ok(line.length <= 140);
  // A long label is clipped to 40 characters; the reason gives way first, never the label.
  const long = blockerLineUk({ ...f, subject: { ...f.subject, label: 'Ранкова добірка: дуже-довга-назва-скіла-про-промпти-для-фото' } });
  const tail = long.slice(long.lastIndexOf(' — ') + 3);
  assert.ok(tail.startsWith('Ранкова добірка: дуже-довга') && tail.endsWith('…') && tail.length <= 41, tail);
});

test('W1 integration review: fix lines are the actions for the named blockers only; the summary still counts every fix', async () => {
  const contradiction = fixable('series_source_contradicted', 'a', { ...SKILL_OFF, skill: 'ai0-voice' }, 'prompts: ai0-voice');
  const tools = fixable('tools_missing_for_source', 'b', { kind: 'tools_allow_add', channel: CH, tools: ['query_data'] }, 'query_data');
  const probeFailed = fixable('source_probe_failed', 'c', { kind: 'host_proxy_add', host: 'rada.gov.ua', url: 'https://rada.gov.ua/x', sourceKind: 'url' }, 'rada.gov.ua');
  const { src } = harness([rowOf([contradiction, tools, probeFailed])]);
  const [item] = await src.waiting(new Date());
  const body = item.body!;
  assert.match(body, /— prompts: ai0-voice/);
  assert.ok(body.includes('Виправлю в один дотик:\n• Вимкну скіл «ai0-voice»\n• Додам query_data у дозволені інструменти картки\n\n'), body);
  assert.doesNotMatch(body, /rada\.gov\.ua|проксі/, 'the source the host note covers is neither named nor listed');
  assert.doesNotMatch(body, /Вимкніть|Дозвольте|Пусти/, 'no advice to the owner under «Виправлю»');
  assert.ok(body.endsWith('Виправлень в один дотик: 3. Решта — у панелі Readiness.'));
});

test('W1 integration review: every fix kind has a Ukrainian action, and a refusal code never reaches the owner', () => {
  const kinds: Fix[] = [
    { kind: 'skill_disable', agent: 'a', skill: 's' }, { kind: 'skill_inline_off', agent: 'a', skill: 's' }, { kind: 'memory_retire', channel: CH, id: 7 },
    { kind: 'conflicts_resolve', agent: 'a' }, { kind: 'tools_allow_add', channel: CH, tools: ['web_fetch'] }, { kind: 'hashtag_min_zero', channel: CH },
    { kind: 'series_resume', channel: CH, pauseId: 'p' }, { kind: 'series_source_require', channel: CH, series: 'Prompt' },
    { kind: 'source_drop', channel: CH, sourceId: 'feed1' }, { kind: 'host_proxy_add', host: 'x.example' },
  ];
  for (const k of kinds) {
    const uk = fixActionUk(k);
    assert.ok(uk && /[а-яіїєґ]/i.test(uk), k.kind);
    assert.doesNotMatch(uk!, /=|\b(?:skill_disable|tools_allow_add|host_proxy_add|source_drop)\b/, `${k.kind}: no internal tokens`);
  }
  assert.equal(fixActionUk({ kind: 'bind_dataset' } as unknown as Fix), null, 'a kind of a later spec has no line');
  assert.equal(fixFailureUk('source_still_failing: x.example is read through the proxy now, but https://x.example still fails'), 'Не вдалося виправити: сайт уже йде через проксі, але джерело досі не читається. Деталі — у панелі Readiness.');
  assert.doesNotMatch(fixFailureUk('something_new: English details'), /something_new|English/);
});

// ── which blockers the card names ────────────────────────────────────────────────────────────────────────────────

test('readiness card: only the stamped blockers that are still open are named; none left = not waiting', async () => {
  const a = plain('dataset_without_series', 'a');
  const b = plain('series_source_contradicted', 'b');
  const c = plain('config_conflict', 'c');
  {
    const { src } = harness([rowOf([a, b, c], {}, [a, b])]);
    const [item] = await src.waiting(new Date());
    assert.match(item.title, /2 блокери/, 'c is not in the stamp');
  }
  {
    const { src } = harness([rowOf([b, c], {}, [a, b])]);
    const [item] = await src.waiting(new Date());
    assert.match(item.title, /1 блокер /, 'a was fixed meanwhile');
  }
  {
    const { src } = harness([rowOf([c], {}, [a, b])]);
    assert.deepEqual(await src.waiting(new Date()), [], 'the stamped blockers are gone');
  }
  {
    const warn = mkF('material_low', 'warn', { id: 'w' });
    const { src } = harness([rowOf([warn], { notified_blockers: [warn.key] })]);
    assert.deepEqual(await src.waiting(new Date()), [], 'a warning is not a blocker');
  }
  {
    const { src } = harness([]);
    assert.deepEqual(await src.waiting(new Date()), []);
  }
});

test('readiness card: blockers another note covers are not named (I9)', async () => {
  const keep = plain('dataset_without_series', 'a');
  const covered = [plain('source_probe_failed', 'p'), plain('series_paused', 's'), plain('series_paused_by_owner', 'o'), plain('pause_cause_gone', 'g')];
  const botNotAdmin = plain('bot_not_admin', 'bot');
  {
    const { src } = harness([rowOf([keep, ...covered, botNotAdmin])]);
    const [item] = await src.waiting(new Date());
    assert.match(item.title, /2 блокери/, 'the other one and the bot (no launch open)');
    assert.match(item.body!, /Бот не може публікувати в каналі — /);
    assert.doesNotMatch(item.body!, /Серію призупинила|Title of source_probe_failed/, 'what another note covers is not named');
  }
  {
    const { src } = harness([rowOf([keep, ...covered, botNotAdmin], { launch_open: true })]);
    const [item] = await src.waiting(new Date());
    assert.match(item.title, /1 блокер /, 'with a launch open the bot is the launch card\'s');
    assert.doesNotMatch(item.body!, /Бот не може публікувати/);
  }
  {
    const { src } = harness([rowOf([...covered, botNotAdmin], { launch_open: true })]);
    assert.deepEqual(await src.waiting(new Date()), []);
  }
});

test('readiness card: the query reads the stored rows of the sweep set that hold a stamp', async () => {
  const { src, sqls } = harness([]);
  await src.waiting(new Date());
  assert.equal(sqls.length, 1);
  assert.match(sqls[0], /FROM channel_readiness r/);
  assert.match(sqls[0], /r\.blockers > 0/);
  assert.match(sqls[0], /jsonb_array_length\(r\.notified_blockers\) > 0/);
  assert.match(sqls[0], /c\.mode IN \('approve', 'live'\)/, 'the sweep set');
  assert.match(sqls[0], /channel_launches/);
});

// ── the id, the path ─────────────────────────────────────────────────────────────────────────────────────────────

test('readiness card: the refId changes with the blocker set and with the day of the stamp, and with nothing else', async () => {
  const a = plain('dataset_without_series', 'a');
  const b = plain('series_source_contradicted', 'b');
  const id = async (r: Row) => (await harness([r]).src.waiting(new Date()))[0].refId;
  const base = await id(rowOf([a, b]));
  assert.match(base, /^@fx072\|[0-9a-f]{8}\|20261020$/);
  assert.equal(await id(rowOf([a, b], { notified_blockers: [b.key, a.key] })), base, 'the order of the set does not matter');
  assert.equal(await id(rowOf([a, b], { launch_open: true })), base, 'nor does the launch');
  assert.notEqual(await id(rowOf([a, b], {}, [a])), base, 'a different set is a new card');
  assert.notEqual((await id(rowOf([a, b], { notified_at: new Date('2026-10-21T00:01:00.000Z') }))), base, 'the next day is a new card');
  assert.equal((await id(rowOf([a, b], { notified_at: new Date('2026-10-20T00:00:00.000Z') }))).split('|')[2], '20261020');
  assert.equal(channelOfRefId(base), CH);
  assert.equal(readinessRefId(CH, [b.key, a.key], STAMP), base);
});

test('readiness card: Відкрити goes to the agent\'s overview, or to the editor page when the channel has no agent', async () => {
  const f = plain('dataset_without_series', 'a');
  {
    const [item] = await harness([rowOf([f])]).src.waiting(new Date());
    assert.equal(item.path, '/app/agents/fx072?tab=overview&readiness=1');
  }
  {
    const [item] = await harness([rowOf([f])], { agent: null }).src.waiting(new Date());
    assert.equal(item.path, '/app/editor/%40fx072');
  }
});

// ── the buttons ──────────────────────────────────────────────────────────────────────────────────────────────────

test('readiness card act(fix): applies Fix all through the telegram path and says how many and how many blockers are left', async () => {
  const { src, calls } = harness([], { fix: { applied: ['a', 'b'] }, blockersAfter: 1 });
  const out = await src.act(`${CH}|abcd1234|20261020`, 'fix');
  assert.match(out, /^✅ Виправлено: 2\. Блокерів лишилось: 1 · /);
  assert.deepEqual(calls, [['fix', CH, undefined, 'telegram']]);
});

test('readiness card act(fix): partial success adds the failures; nothing applied is a refusal; nothing fixable says so', async () => {
  {
    const { src } = harness([], { fix: { applied: ['a'], failed: [{ code: 'x', error: 'e1' }, { code: 'y', error: 'e2' }] }, blockersAfter: 3 });
    assert.match(await src.act(`${CH}|x|20261020`, 'fix'), /^✅ Виправлено: 1\. Блокерів лишилось: 3; не вдалося: 2 · /);
  }
  {
    const { src } = harness([], { fix: { applied: [], failed: [{ code: 'x', error: 'permission_denied' }] } });
    await assert.rejects(src.act(`${CH}|x|20261020`, 'fix'), (err: Error) => err.message === 'Не вдалося виправити. Деталі — у панелі Readiness.');
    const proxy = harness([], { fix: { applied: [], failed: [{ code: 'source_probe_failed', error: 'proxy_not_configured: zakon.rada.gov.ua' }] } });
    await assert.rejects(proxy.src.act(`${CH}|x|20261020`, 'fix'), (err: Error) => err.message === 'Не вдалося виправити: проксі не налаштовано в Settings. Деталі — у панелі Readiness.');
  }
  {
    const { src } = harness([], { fix: { applied: [], failed: [] } });
    await assert.rejects(src.act(`${CH}|x|20261020`, 'fix'), new RegExp(NOTHING_TO_FIX_UK));
  }
});

test('readiness card act(recheck): looks again as the owner and reports the blockers left', async () => {
  {
    const { src, calls } = harness([], { blockersAfter: 3 });
    assert.match(await src.act(`${CH}|x|20261020`, 'recheck'), /^Блокерів: 3 · /);
    assert.deepEqual(calls, [['recheck', CH, 'owner']]);
  }
  {
    const { src } = harness([], { blockersAfter: 0 });
    assert.match(await src.act(`${CH}|x|20261020`, 'recheck'), /^✅ Блокерів немає · /);
  }
  await assert.rejects(harness([]).src.act(`${CH}|x|20261020`, 'nope'), /unknown button nope/);
});

// ── notify.ts ────────────────────────────────────────────────────────────────────────────────────────────────────

test('notifiable: open errors only, minus auto_fixed rows and what another note covers', () => {
  const fs: Finding[] = [
    plain('dataset_without_series', 'a'), mkF('material_low', 'warn', { id: 'w' }), mkF('auto_fixed', 'error', { id: 'af' }),
    plain('series_paused', 'p'), plain('source_probe_failed', 's'), plain('bot_not_admin', 'b'),
  ];
  assert.deepEqual(notifiable(fs, { launchOpen: false }).map((f) => f.check), ['dataset_without_series', 'bot_not_admin']);
  assert.deepEqual(notifiable(fs, { launchOpen: true }).map((f) => f.check), ['dataset_without_series']);
  assert.equal(notedElsewhere({ check: 'bot_not_admin' }, { launchOpen: true }), true);
  assert.equal(notedElsewhere({ check: 'bot_not_admin' }, { launchOpen: false }), false);
});
