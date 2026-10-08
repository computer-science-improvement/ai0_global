import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlaybookSchema, validatePlaybook } from '../network/playbook';
import { buildProposal, minimalPlaybook, proposalKey, type MigrationBinding, type ProposalCtx } from './proposal';
import { mapType, TYPE_RULES } from './type-mapping';
import { formatDryRun } from './dry-run';

const NOW = new Date('2030-01-15T10:00:00Z');
const ALL_TG = ['text', 'photo', 'album', 'carousel', 'poll', 'quiz', 'longread', 'video'];
const CATALOG = { tables: ['recipes', 'facts', 'quotes', 'prompts', 'on_this_day', 'pdr_questions', 'birthdays', 'assets'], feeds: [] as string[] };

function ctx(channelKey: string, over: Partial<ProposalCtx> = {}): ProposalCtx {
  const ref = `telegram:${channelKey}`;
  return {
    channelKey, agent: { id: 'a1', handle: 'agent' }, networkMode: 'single',
    resources: [{ ref, platform: 'telegram', tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 } }],
    allRefs: [ref], telegramFormats: ALL_TG,
    card: { postsPerDayMin: 2, postsPerDayMax: 4, formats: Object.fromEntries(ALL_TG.map((f) => [f, 1])) },
    active: null, activeVersion: null, catalog: CATALOG, history: new Map(), cronTz: 'Europe/Kyiv', now: NOW,
    ...over,
  };
}

/** The bindings of the repo's own config/channels.json (every real binding type). */
function configBindings(): Map<string, MigrationBinding[]> {
  const raw = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'config', 'channels.json'), 'utf8')) as {
    strategies: Array<{ id: string; type: string; channelId: string; schedule: string; params?: Record<string, unknown> }>;
  };
  const byChannel = new Map<string, MigrationBinding[]>();
  for (const s of raw.strategies) {
    byChannel.set(s.channelId, [...(byChannel.get(s.channelId) ?? []), {
      id: s.id, ext_id: s.id, type: s.type, schedule: s.schedule, params: s.params ?? {}, platform: 'telegram', resourceRef: `telegram:${s.channelId}`,
    }]);
  }
  return byChannel;
}

test('dry run of config/channels.json: every binding type maps, and the drafts validate', () => {
  const byChannel = configBindings();
  const types = new Set([...byChannel.values()].flat().map((b) => b.type));
  assert.deepEqual([...types].sort(), ['ai0-news', 'ai0-prompts', 'assets', 'game-channel', 'pdr-quiz', 'ua-news']);
  const outcome: Record<string, string> = {};
  let mapped = 0;
  let total = 0;
  for (const [key, bindings] of byChannel) {
    const p = buildProposal(bindings, ctx(key));
    assert.deepEqual(p.errors, [], `${key}: ${p.errors.join('; ')}`);
    assert.ok(p.body, key);
    PlaybookSchema.parse(p.body);
    assert.deepEqual(validatePlaybook(p.body!, [{ ref: `telegram:${key}`, platform: 'telegram' }], ALL_TG, { sources: CATALOG }), []);
    mapped += p.mapped;
    total += p.total;
    for (const o of p.bindings) {
      outcome[o.ext_id] = o.outcome === 'series' ? `series ${o.cadence} ${o.format} ${o.source}`
        : o.outcome === 'frequency' ? `frequency ${o.per_day} ${o.format} ${o.source}` : `unmappable ${o.reason}`;
    }
  }
  assert.deepEqual(outcome, {
    'ai0-news:ai0_news_dev':          'frequency 30 photo null',
    'ai0-prompts:ai0_prompts_dev':    'frequency 8 photo library:prompts',
    'game-channel:game_exchange_dev': 'frequency 30 photo api:gamerpower_giveaways',
    'pdr-quiz:main':                  'frequency 30 quiz library:pdr_questions',
    'ua-news:ai0_global_open_source': 'frequency 10 photo null',
    'ua-news:ai0_global_mcp':         'frequency 10 photo null',
    'ua-news:ai0_global_ai_agents':   'frequency 10 photo null',
    'assets:academy-openai':          'series daily@08:15,14:15,20:15 text library:assets/academy-openai',
    'assets:mcpservers':              'series daily@10:15,16:15,22:15 text library:assets/mcpservers',
    'assets:prompts-md':              'series daily@12:15,18:15 text library:assets/prompts-md',
  });
  assert.equal(mapped, total, 'every config binding maps (≥ 90 % required)');
});

test('the @ai0_global draft: three migrated series, unlocked, plus frequency notes; per day fits', () => {
  const p = buildProposal(configBindings().get('@ai0_global')!, ctx('@ai0_global'));
  const series = p.body!.series;
  assert.deepEqual(series.map((s) => [s.name, s.origin, s.locked, s.migrated_from, s.source_mode]), [
    ['assets:academy-openai', 'migration', false, 'assets:academy-openai', 'suggested'],
    ['assets:mcpservers', 'migration', false, 'assets:mcpservers', 'suggested'],
    ['assets:prompts-md', 'migration', false, 'assets:prompts-md', 'suggested'],
  ]);
  // 8 series instances a day + 3 × 10 news hints, capped at the Telegram 24.
  assert.equal(p.body!.platforms[0].per_day.max, 24);
  assert.equal(p.body!.rules.filter((r) => r.startsWith('Замість стратегії ua-news:')).length, 3);
  assert.match(p.rationale, /Strategy migration for @ai0_global: 6 of 6 enabled binding\(s\) mapped/);
  assert.match(p.rationale, /assets:academy-openai: 15 8,14,20 \* \* \* → daily@08:15,14:15,20:15 · assets → text \/ library:assets\/academy-openai/);
  assert.match(p.rationale, /ua-news:ai0_global_mcp: 0,30 9,12,15,18,21 \* \* \* → about 10\/day/);
});

test('dry-run text lists every binding and the summary', () => {
  const byChannel = configBindings();
  const channels = [...byChannel.entries()].map(([k, b]) => buildProposal(b, ctx(k)));
  const text = formatDryRun({ channels, orphans: ['tiktok-x'], mapped: 10, total: 11 });
  for (const b of [...byChannel.values()].flat()) assert.ok(text.includes(b.ext_id), b.ext_id);
  assert.match(text, /=== @pdr_dev_channel/);
  assert.match(text, /pdr-quiz:main \[pdr-quiz\] telegram:@pdr_dev_channel "\*\/30 8-22 \* \* \*" → frequency ~30\/day · quiz · library:pdr_questions/);
  assert.match(text, /tiktok-x: UNMAPPABLE/);
  assert.match(text, /Summary: 10 of 11 enabled binding\(s\) mapped \(91%\)\. Dry run: nothing was written\./);
});

test('a feed on the card becomes the series source; the ua-news brief keeps the feed URL', () => {
  const url = 'https://www.marktechpost.com/category/ai-agents/feed/';
  const p = buildProposal([{ id: 'x', ext_id: 'ua-news:x', type: 'ua-news', schedule: '0 9,18 * * *', params: { feedUrl: url, sourceName: 'marktechpost.com' }, platform: 'telegram', resourceRef: 'telegram:@c' }],
    ctx('@c', { catalog: { ...CATALOG, feeds: [url] } }));
  const s = p.body!.series[0];
  assert.deepEqual(s.source, { kind: 'feed', ref: url });
  assert.ok(s.brief.includes(url));
  const without = buildProposal([{ id: 'x', ext_id: 'ua-news:x', type: 'ua-news', schedule: '0 9,18 * * *', params: { feedUrl: url }, platform: 'telegram', resourceRef: 'telegram:@c' }], ctx('@c'));
  assert.equal(without.body!.series[0].source, undefined);
  assert.match(without.bindings[0].warnings.join(), /not on the channel card/);
});

test('every one of the 18 strategy types has a rule; the spec mapping holds', () => {
  assert.equal(Object.keys(TYPE_RULES).length, 18);
  const m = (type: string, params: Record<string, unknown> = {}) => mapType(type, params, 'telegram', ALL_TG, CATALOG);
  const short = (type: string, params?: Record<string, unknown>) => {
    const r = m(type, params);
    return r.ok ? `${r.format} ${r.source ? JSON.stringify(r.source) : '-'} ${r.mode}` : `x ${r.reason}`;
  };
  assert.equal(short('quotes'), 'text {"kind":"library","table":"quotes"} suggested');
  assert.equal(short('facts'), 'photo {"kind":"library","table":"facts"} suggested');
  assert.equal(short('pdr-quiz'), 'quiz {"kind":"library","table":"pdr_questions"} required');
  assert.equal(short('recipes'), 'photo {"kind":"library","table":"recipes"} suggested');
  assert.equal(short('recipe-carousel'), 'carousel {"kind":"library","table":"recipes"} suggested');
  assert.equal(short('ai0-prompts', { provider: 'midjourney' }), 'photo {"kind":"library","table":"prompts","category":"midjourney"} suggested');
  assert.equal(short('curated-prompts', { mediaType: 'image' }), 'photo {"kind":"library","table":"prompts","category":"image"} suggested');
  assert.equal(short('assets', { dataSource: 'mcpservers' }), 'text {"kind":"library","table":"assets","category":"mcpservers"} suggested');
  assert.equal(short('birthday-strategy'), 'photo {"kind":"library","table":"birthdays","today_only":true} suggested');
  assert.equal(short('on-this-day'), 'photo {"kind":"library","table":"on_this_day","today_only":true} suggested');
  assert.equal(short('ai0-news'), 'photo - suggested');
  assert.equal(short('game-channel', { sources: ['epic'] }), 'photo {"kind":"api","source":"epic_free_games","params":{}} suggested');
  assert.equal(short('space-news'), 'photo {"kind":"api","source":"spaceflight_news","params":{}} suggested');
  assert.equal(short('daily-photo'), 'photo {"kind":"api","source":"nasa_apod","params":{}} suggested');
  assert.equal(short('movies'), 'photo {"kind":"api","source":"tmdb_trending","params":{}} suggested');
  assert.equal(short('network-digest'), 'text {"kind":"network_highlights","scope":"network"} suggested');
  assert.equal(short('topic-digest', { strategyTypes: ['ai0-news'] }), 'text {"kind":"network_highlights","scope":"network"} suggested');
  assert.match(short('nope'), /^x strategy type "nope" has no agent equivalent/);
});

test('native formats on Meta and TikTok; formats off on the card and missing datasets are unmappable reasons', () => {
  assert.equal((mapType('recipes', {}, 'instagram', ['ig_photo', 'ig_carousel'], CATALOG) as any).format, 'ig_photo');
  assert.equal((mapType('recipe-carousel', {}, 'facebook', ['fb_text', 'fb_photo', 'fb_album', 'fb_link'], CATALOG) as any).format, 'fb_album');
  assert.equal((mapType('quotes', {}, 'threads', ['th_text', 'th_image', 'th_carousel'], CATALOG) as any).format, 'th_text');
  assert.equal((mapType('recipes', {}, 'tiktok', ['tt_photo'], CATALOG) as any).format, 'tt_photo');
  assert.match((mapType('quotes', {}, 'instagram', ['ig_photo', 'ig_carousel'], CATALOG) as any).reason, /instagram has no text format/);
  assert.match((mapType('pdr-quiz', {}, 'telegram', ['text', 'photo'], CATALOG) as any).reason, /format quiz is off on the channel card/);
  assert.match((mapType('pdr-quiz', {}, 'telegram', ALL_TG, { tables: [], feeds: [] }) as any).reason, /dataset pdr_questions is not in the library/);
  const soft = mapType('recipes', {}, 'telegram', ALL_TG, { tables: [], feeds: [] });
  assert.ok(soft.ok && soft.source === null && soft.warnings[0].includes('not in the library'));
});

test('network rules: a Meta binding in a legacy_duplicate network or on an unusable resource is unmappable; independent maps it', () => {
  const ig = 'instagram:11111111-1111-1111-1111-111111111111';
  const b: MigrationBinding = { id: 'i', ext_id: 'recipes:ig', type: 'recipes', schedule: '0 12 * * *', params: {}, platform: 'instagram', resourceRef: ig };
  const igRes = { ref: ig, platform: 'instagram' as const, tz: 'Europe/Kyiv', quiet: { start: 23, end: 8 } };
  const legacy = buildProposal([b], ctx('@c', { networkMode: 'legacy_duplicate', resources: [...ctx('@c').resources, igRes], allRefs: ['telegram:@c', ig] }));
  assert.match((legacy.bindings[0] as any).reason, /legacy_duplicate/);
  assert.equal(legacy.body, null);
  const unusable = buildProposal([b], ctx('@c', { networkMode: 'independent', allRefs: ['telegram:@c', ig] }));
  assert.match((unusable.bindings[0] as any).reason, /not usable/);
  const indep = buildProposal([b], ctx('@c', { networkMode: 'independent', resources: [...ctx('@c').resources, igRes], allRefs: ['telegram:@c', ig] }));
  assert.deepEqual(indep.errors, []);
  const sec = indep.body!.platforms.find((p) => p.resource_ref === ig)!;
  assert.deepEqual([sec.role, sec.formats, sec.per_day], ['discovery', { ig_photo: 1 }, { min: 0, max: 1 }]);
  assert.equal(indep.body!.series[0].format, 'ig_photo');
});

test('the active playbook is the base: existing series stay, a name clash gets a suffix, a re-migration is refused per binding', () => {
  const base = minimalPlaybook({ channelKey: '@c', card: { postsPerDayMin: 1, postsPerDayMax: 3, formats: { photo: 1, text: 1 } }, telegramFormats: ALL_TG });
  const active = PlaybookSchema.parse({ ...base, series: [
    { name: 'recipes:a', cadence: 'daily@09:00', resource_ref: 'telegram:@c', format: 'photo', brief: 'Власна серія агента з рецептами' },
    { name: 'Old', cadence: 'daily@10:00', resource_ref: 'telegram:@c', format: 'photo', brief: 'Мігрована раніше серія', origin: 'migration', migrated_from: 'facts:c' },
  ] });
  const p = buildProposal([
    { id: '1', ext_id: 'recipes:a', type: 'recipes', schedule: '0 19 * * *', params: {}, platform: 'telegram', resourceRef: 'telegram:@c' },
    { id: '2', ext_id: 'facts:c', type: 'facts', schedule: '0 11 * * *', params: {}, platform: 'telegram', resourceRef: 'telegram:@c' },
  ], ctx('@c', { active, activeVersion: 3 }));
  assert.deepEqual(p.body!.series.map((s) => s.name), ['recipes:a', 'Old', 'recipes:a (2)']);
  assert.match((p.bindings.find((b) => b.ext_id === 'facts:c') as any).reason, /already migrated/);
  assert.equal(p.active_version, 3);
  assert.notEqual(proposalKey(p), proposalKey({ ...p, active_version: 4 }));
});

test('no agent → no draft; a binding without a destination is unmappable', () => {
  const p = buildProposal([{ id: '1', ext_id: 'x', type: 'recipes', schedule: '0 9 * * *', params: {}, platform: 'telegram', resourceRef: null }], ctx('@c'));
  assert.match((p.bindings[0] as any).reason, /no resolvable destination/);
  assert.equal(p.body, null);
});
