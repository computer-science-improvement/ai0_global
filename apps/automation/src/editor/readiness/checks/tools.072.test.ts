import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardSource, EditorCard } from '../../card';
import { makeFacts, mkPlaybook, mkSeries, promptSeries } from '../testing/facts-fixture';
import { SOURCE_TOOLS, toolsCheck } from './tools';

/** Spec 072 FR-003.3, A8, A29, I13: a source needs a read tool the run will not have. */

const run = (init: Parameters<typeof makeFacts>[0]) => toolsCheck.run(makeFacts(init));
const rss: CardSource = { id: 'feed1', kind: 'rss', ref: 'https://example.com/feed.xml' } as CardSource;
const url: CardSource = { id: 'u1', kind: 'url', ref: 'https://example.com/page' } as CardSource;
const libSource: CardSource = { id: 'l1', kind: 'library', ref: 'tips' } as CardSource;
const feedSeries = (over: Record<string, unknown> = {}) => mkSeries({ name: 'Feed', source: { kind: 'feed', ref: 'feed1' }, ...over });

test('a library series with the card list leaving out the reading tools is an error with the tools_allow_add fix', () => {
  const [x, ...rest] = run({ card: { toolsAllow: ['web_fetch', 'send_post'] }, playbook: mkPlaybook([promptSeries()]) });
  assert.equal(rest.length, 0);
  assert.equal(x.check, 'tools_missing_for_source');
  assert.equal(x.severity, 'error');
  assert.equal(x.area, 'channel');
  assert.deepEqual(x.subject, { type: 'tool', id: 'query_data', label: 'query_data', agent: 'fx072', channel: '@fx072' });
  assert.deepEqual(x.fix, { kind: 'tools_allow_add', channel: '@fx072', tools: ['query_data'] });
  assert.equal(x.link, '/app/editor/%40fx072');
  assert.match(x.detail, /series «Prompt» \(library:prompts\) needs query_data or search_library/);
  assert.match(x.detail, /missing from the card's tool list/);
  assert.deepEqual((x.evidence as any).needed_by, ['series «Prompt» (library:prompts)']);
});

test('either of the two library tools is enough (any of), and so is either feed tool', () => {
  assert.deepEqual(run({ card: { toolsAllow: ['search_library'] }, playbook: mkPlaybook([promptSeries()]) }), []);
  assert.deepEqual(run({ card: { toolsAllow: ['query_data'] }, playbook: mkPlaybook([promptSeries()]) }), []);
  assert.deepEqual(run({ card: { toolsAllow: ['web_fetch'], sources: [rss] }, playbook: mkPlaybook([feedSeries()]) }), []);
  assert.equal(run({ card: { toolsAllow: ['fetch_feed'], sources: [rss] }, playbook: mkPlaybook([feedSeries()]) }).length, 0);
});

test('no limit on the run, or an empty list, is no finding', () => {
  assert.deepEqual(run({ card: { toolsAllow: null }, playbook: mkPlaybook([promptSeries()]) }), []);
  assert.deepEqual(run({ card: { toolsAllow: [] }, playbook: mkPlaybook([promptSeries()]) }), []);
  assert.deepEqual(run({ card: { toolsAllow: null }, loadoutTools: [], playbook: mkPlaybook([promptSeries()]) }), []);
});

test('a card source alone is a warning', () => {
  const [x] = run({ card: { toolsAllow: ['query_data'], sources: [rss] } });
  assert.equal(x.severity, 'warn');
  assert.equal(x.subject.id, 'fetch_feed');
  assert.deepEqual(x.fix, { kind: 'tools_allow_add', channel: '@fx072', tools: ['fetch_feed'] });
  assert.match(x.detail, /the card source rss:https:\/\/example\.com\/feed\.xml needs fetch_feed or web_fetch/);
});

test('each kind of source asks for its own tool: url web_fetch, api fetch_api, library query_data', () => {
  const tools = (card: Partial<EditorCard>) => run({ card }).map((f) => f.subject.id).sort();
  assert.deepEqual(tools({ toolsAllow: ['x'], sources: [url] }), ['web_fetch']);
  assert.deepEqual(tools({ toolsAllow: ['x'], sources: [{ id: 'a1', kind: 'api', ref: 'nasa_apod' } as CardSource] }), ['fetch_api']);
  assert.deepEqual(tools({ toolsAllow: ['x'], sources: [libSource] }), ['query_data']);
  assert.deepEqual(tools({ toolsAllow: ['x'], sources: [] }), []);
  assert.deepEqual(Object.keys(SOURCE_TOOLS).sort(), ['api', 'feed', 'library', 'url']);
});

test('an api series needs fetch_api, a feed series fetch_feed', () => {
  const out = run({ card: { toolsAllow: ['x'], sources: [rss] }, playbook: mkPlaybook([mkSeries({ name: 'Apod', source: { kind: 'api', source: 'nasa_apod' } }), feedSeries()]) });
  assert.deepEqual(out.map((f) => `${f.severity}:${f.subject.id}`).sort(), ['error:fetch_api', 'error:fetch_feed']);
});

test('one missing tool needed by two sources is one finding, an error when a series is among them (A8)', () => {
  const out = run({ card: { toolsAllow: ['x'], sources: [rss] }, playbook: mkPlaybook([feedSeries()]) });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'error');
  assert.equal((out[0].evidence as any).needed_by.length, 2);
  assert.match(out[0].detail, /need fetch_feed or web_fetch/);
});

test('two different missing tools are two findings with different keys', () => {
  const out = run({ card: { toolsAllow: ['x'], sources: [url, rss] } });
  assert.deepEqual(out.map((f) => f.subject.id).sort(), ['fetch_feed', 'web_fetch']);
  assert.notEqual(out[0].key, out[1].key);
});

test('a free series, a series without source and an inactive series need no tool (A29)', () => {
  const out = run({
    card: { toolsAllow: ['x'] },
    playbook: mkPlaybook([
      mkSeries({ name: 'Free', source: { kind: 'free' } }), mkSeries({ name: 'None' }),
      mkSeries({ name: 'Net', source: { kind: 'network_highlights' } }), promptSeries({ name: 'Off', active: false }),
    ]),
  });
  assert.deepEqual(out, []);
});

test('the loadout is the cause: no fix and the link is the loadout tab', () => {
  const [x] = run({ card: { toolsAllow: null }, loadoutTools: ['web_fetch', 'send_post'], playbook: mkPlaybook([promptSeries()]) });
  assert.equal(x.severity, 'error');
  assert.equal(x.fix, undefined);
  assert.equal(x.link, '/app/agents/fx072?tab=loadout');
  assert.match(x.detail, /missing from the executor's loadout/);
});

test('both lists lack the tool: adding it to the card would not help, so the loadout comes first', () => {
  const [x] = run({ card: { toolsAllow: ['web_fetch', 'a'] }, loadoutTools: ['web_fetch', 'b'], playbook: mkPlaybook([promptSeries()]) });
  assert.equal(x.fix, undefined);
  assert.equal(x.link, '/app/agents/fx072?tab=loadout');
});

test('the card list is the cause while the loadout holds only the other library tool: the fix adds that one', () => {
  const [x] = run({ card: { toolsAllow: ['web_fetch'] }, loadoutTools: ['web_fetch', 'search_library'], playbook: mkPlaybook([promptSeries()]) });
  assert.deepEqual(x.fix, { kind: 'tools_allow_add', channel: '@fx072', tools: ['search_library'] });
  assert.equal(x.subject.id, 'query_data', 'the finding is still keyed by the main tool');
});

test('an empty intersection (the (none) sentinel) is a finding without a fix', () => {
  const f = makeFacts({ card: { toolsAllow: ['a'] }, loadoutTools: ['b'], playbook: mkPlaybook([promptSeries()]) });
  assert.deepEqual(f.effectiveTools, ['(none)']);
  const [x] = toolsCheck.run(f);
  assert.equal(x.severity, 'error');
  assert.equal(x.fix, undefined);
});

test('with the loadout as the cause and no agent, the link falls back to the card editor', () => {
  const f = makeFacts({ card: { toolsAllow: null }, loadoutTools: ['web_fetch'], playbook: mkPlaybook([promptSeries()]) });
  const [x] = toolsCheck.run({ ...f, agent: null });
  assert.equal(x.link, '/app/editor/%40fx072');
  assert.equal(x.subject.agent, undefined);
});
