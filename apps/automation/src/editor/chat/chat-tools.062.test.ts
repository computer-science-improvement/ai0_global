/**
 * Spec 062 T2: lint_post / preview_post on the real draft, made-up media URLs, save_draft that merges instead of replacing,
 * "this turn" in the stop text, the data-question rule and fill_pct for every catalog field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { buildComposeTools } from '../tools/compose-tools';
import { buildComposerTools, MAX_LINT_RETRIES, type ComposerExtras } from './composer-tools';
import { ChatPostSpecSchema, mergeDraftSpec, omittedSpecKeys } from './draft-spec-merge';
import { isMadeUpMediaUrl, madeUpMediaUrls } from '../post/made-up-media';
import { toToolSpec } from '../harness/tool';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { catalogEntry } from '../../data/data-catalog';
import { DATA_QUESTION_RULE } from './chat-format';
import { buildComposerSystemPrompt } from '../roles/prompts';
import { buildBuilderPrompt } from '../agents/agent-prompts';
import { SkillLibrary } from '../skills/skill-library';

const UUID = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-18T09:00:00Z');

// ── FR-004 ──────────────────────────────────────────────────────────────────

test('made-up media: example hosts, placeholder/example path segments and file names', () => {
  for (const u of [
    'https://cdn.prompthero.com/placeholder.jpg', 'https://example.com/a.jpg', 'https://cdn.example.org/x/y.png', 'https://i.example/1.jpg',
    'https://site.com/images/placeholder/1.png', 'https://site.com/img/example-1.jpg', 'https://site.com/img/Image_Placeholder.PNG',
  ]) assert.equal(isMadeUpMediaUrl(u), true, u);
  for (const u of [
    'https://images.nasa.gov/ring.jpg', 'https://examples.nasa.gov/a.jpg', 'https://site.com/img/examplesque.jpg', 'https://site.com/placeholders-list.html?x=1', 'not a url',
  ]) assert.equal(isMadeUpMediaUrl(u), false, u);
  assert.deepEqual(madeUpMediaUrls({ media: [{ url: 'https://example.com/a.jpg' }, { url: 'https://images.nasa.gov/ring.jpg' }], slides: [{ image: 'https://x.com/placeholder.png' }] }),
    ['https://example.com/a.jpg', 'https://x.com/placeholder.png']);
});

const STORED = makeSpec({ title: 'Збережена чернетка' });
const ctx: any = { runId: 'r', role: 'composer', channelKey: '@chan', extras: { card: makeCard() } };
const lintTools = (drafts?: any) => Object.fromEntries(buildComposeTools(drafts ? { drafts } : {}).map((t) => [t.name, t]));

test('lint_post / preview_post with draft_id check the stored spec; given fields override it', async () => {
  const seen: string[] = [];
  const tools = lintTools({ get: async (id: string) => { seen.push(id); return id === UUID ? { spec: STORED } : null; } });
  const l: any = await tools.lint_post.execute({ draft_id: UUID }, ctx);
  assert.equal(l.ok, true);
  assert.deepEqual(seen, [UUID]);
  const p: any = await tools.preview_post.execute({ draft_id: UUID }, ctx);
  assert.match(p.preview, /<b>Телескоп|Збережена/);
  // The given fields win over the draft's: a bad hashtag overrides the stored (clean) list.
  const over: any = await tools.lint_post.execute({ draft_id: UUID, spec: { hashtags: ['точно_не_зі_словника_каналу_'.repeat(2)] } }, ctx);
  assert.ok(over.error === 'invalid_args' || over.ok === false, JSON.stringify(over));
  assert.equal(((await tools.lint_post.execute({ draft_id: '00000000-0000-4000-8000-0000000000ff' }, ctx)) as any).error, 'draft_not_found');
});

test('lint_post: draft_id without drafts, and neither spec nor draft_id, are errors by name', async () => {
  const tools = lintTools();
  assert.equal(((await tools.lint_post.execute({ draft_id: UUID }, ctx)) as any).error, 'draft_id_unavailable');
  assert.equal(((await tools.lint_post.execute({}, ctx)) as any).error, 'invalid_args');
  assert.equal(((await tools.preview_post.execute({}, ctx)) as any).error, 'invalid_args');
  assert.equal(tools.lint_post.keepOnError, true);
});

test('lint_post / preview_post refuse a made-up media URL with invalid_media_url, also on top of a stored draft', async () => {
  const tools = lintTools({ get: async () => ({ spec: STORED }) });
  const bad = { media: [{ url: 'https://cdn.prompthero.com/placeholder.jpg' }] };
  for (const name of ['lint_post', 'preview_post']) {
    const r: any = await tools[name].execute({ spec: { ...STORED, ...bad } }, ctx);
    assert.equal(r.error, 'invalid_media_url', name);
    assert.match(r.details, /placeholder\.jpg/);
    assert.equal(((await tools[name].execute({ draft_id: UUID, spec: bad }, ctx)) as any).error, 'invalid_media_url', `${name} with draft_id`);
  }
});

// ── FR-006 ──────────────────────────────────────────────────────────────────

function saveSetup(stored: any = makeSpec({ title: 'Стара назва' })) {
  const saves: any[] = [];
  const bad = { ok: false, errors: [{ code: 'not_ukrainian', message: 'x' }], warnings: [] };
  const draft = (spec: any) => ({ id: UUID, chatId: 'c1', channelKey: '@chan', spec, preview: 'p', lint: { ok: true, errors: [], warnings: [] }, status: 'draft', scheduledAt: null, slotId: null, publishedPostId: null, error: null, createdAt: NOW, updatedAt: NOW }) as any;
  const drafts: any = {
    get: async () => draft(stored),
    save: async (i: any) => { saves.push(i); return { ok: true, draft: draft(i.spec), card: makeCard({ channelKey: '@chan' }), lint: i.spec.title === 'FAIL' ? bad : { ok: true, errors: [], warnings: [] } }; },
    publish: async () => ({}), schedule: async () => ({}), cancel: async () => ({}), list: async () => [],
  };
  const tool = buildComposerTools({ drafts, repo: { myChannels: async () => [] } as any }).find((t) => t.name === 'save_draft')!;
  const extras: ComposerExtras = { chat: { chatId: 'c1', channelKey: null }, userIntent: false };
  const run = async (args: any) => {
    const parsed = tool.input.safeParse(args);
    assert.ok(parsed.success, JSON.stringify((parsed as any).error?.issues));
    return tool.execute(parsed.data, { runId: 'r', role: 'composer', channelKey: null, extras: extras as any }) as Promise<any>;
  };
  return { run, saves, tool };
}

// What the model re-sends when it only edits the text: no media, no source.
const { media: _m, source: _s, ...TEXT_ONLY } = makeSpec({ title: 'Нова назва' }) as any;

test('save_draft with draft_id keeps the keys the model left out (the media field is no longer dropped)', async () => {
  const s = saveSetup();
  const r = await s.run({ channel: '@chan', draft_id: UUID, spec: TEXT_ONLY });
  assert.equal(r.draft_id, UUID);
  const saved = s.saves[0].spec;
  assert.equal(saved.title, 'Нова назва', 'the sent key is the new one');
  assert.deepEqual(saved.media, makeSpec().media, 'the omitted media stays as stored');
  assert.deepEqual(saved.source, makeSpec().source);
  assert.deepEqual(r.kept_from_draft.sort(), ['media', 'source']);
});

test('save_draft: an explicit null clears a key, an explicit [] replaces it, a new draft is never merged', async () => {
  const s = saveSetup();
  await s.run({ channel: '@chan', draft_id: UUID, spec: { ...TEXT_ONLY, media: null, source: null } });
  assert.deepEqual(s.saves[0].spec.media, [], 'null clears (the schema default)');
  assert.equal(s.saves[0].spec.source, undefined);
  await s.run({ channel: '@chan', draft_id: UUID, spec: { ...TEXT_ONLY, media: [] } });
  assert.deepEqual(s.saves[1].spec.media, []);
  assert.deepEqual(s.saves[1].spec.source, makeSpec().source, 'source was omitted this time');
  const fresh = saveSetup();
  const r = await fresh.run({ channel: '@chan', spec: TEXT_ONLY });
  assert.deepEqual(fresh.saves[0].spec.media, [], 'no draft_id: the spec is what was sent');
  assert.equal(r.kept_from_draft, undefined);
});

test('save_draft: a media alias counts as sending media; a spec that did not come through the schema is saved as is', async () => {
  const s = saveSetup();
  await s.run({ channel: '@chan', draft_id: UUID, spec: { ...TEXT_ONLY, image_url: 'https://images.nasa.gov/other.jpg' } });
  assert.deepEqual(s.saves[0].spec.media, [{ url: 'https://images.nasa.gov/other.jpg' }]);
  const direct = await s.tool.execute({ channel: '@chan', draft_id: UUID, spec: makeSpec({ title: 'Прямий виклик' }) } as any,
    { runId: 'r', role: 'composer', channelKey: null, extras: { chat: { chatId: 'c1', channelKey: null }, userIntent: false } as any });
  assert.equal((direct as any).draft_id, UUID);
  assert.equal(s.saves[1].spec.title, 'Прямий виклик');
});

test('mergeDraftSpec only restores omitted keys the draft has, and names what changed', () => {
  const stored = { format: 'photo', title: 'T', media: [{ url: 'https://a.example/1.jpg' }], hashtags: [] };
  const m = mergeDraftSpec(stored, { format: 'photo', title: 'N', media: [], hashtags: [] }, ['media', 'hashtags', 'source']);
  assert.deepEqual(m.kept, ['media'], 'hashtags are equal, source is not stored');
  assert.deepEqual(m.spec.media, stored.media);
  assert.deepEqual(mergeDraftSpec(null, { a: 1 }, ['a']), { spec: { a: 1 }, kept: [] });
  assert.deepEqual(omittedSpecKeys(makeSpec()), [], 'a spec that did not come through the schema');
  assert.ok(omittedSpecKeys(ChatPostSpecSchema.parse(TEXT_ONLY)).includes('media'));
});

test('the chat spec schema still shows the model every PostSpec field', () => {
  const js = z.toJSONSchema(z.object({ spec: ChatPostSpecSchema }), { io: 'input', unrepresentable: 'any' }) as any;
  assert.ok(js.properties.spec.properties.media && js.properties.spec.properties.source && js.properties.spec.properties.body);
  assert.equal(js.properties.spec.additionalProperties, false);
  const t = buildComposerTools({ drafts: {} as any, repo: {} as any }).find((x) => x.name === 'save_draft')!;
  assert.match(toToolSpec(t).description, /null очищає поле/);
});

test('the lint-stuck texts say «у цьому ході»', async () => {
  const s = saveSetup();
  let last: any;
  for (let k = 0; k < MAX_LINT_RETRIES; k++) last = await s.run({ channel: '@chan', draft_id: UUID, spec: { ...TEXT_ONLY, title: 'FAIL' } });
  assert.match(last.stop, /у цьому ході/);
  const blocked = await s.run({ channel: '@chan', draft_id: UUID, spec: { ...TEXT_ONLY, title: 'FAIL' } });
  assert.equal(blocked.error, 'lint_stuck');
  assert.match(blocked.details, /у цьому ході/);
});

// ── FR-005 ──────────────────────────────────────────────────────────────────

test('the composer and @ai0 prompts carry the data-question rule', () => {
  assert.match(DATA_QUESTION_RULE, /query_data \(3 рядки\)/);
  const composer = buildComposerSystemPrompt({ now: NOW, card: null, hasCard: false, memory: [], skills: new SkillLibrary() });
  assert.ok(composer.includes(DATA_QUESTION_RULE));
  const builder = buildBuilderPrompt({ now: NOW, skills: new SkillLibrary(), agentsSummary: '' });
  assert.ok(builder.includes(DATA_QUESTION_RULE));
});

test('library_catalog: every listed field has fill_pct once the stats exist; without stats none is claimed', () => {
  const schema: any = {
    key: 'prompts', title: 'Prompts', description: 'd', entity: 'prompt', suitable_for: 's', language: 'en', default_license: 'x', reuse_policy: { kind: 'once' },
    contains_personal_data: false, roles: {}, status: 'active',
    fields: [
      { name: 'title', type: 'text', description: 'Title' }, { name: 'prompt_text', type: 'long_text', description: 'Prompt' },
      { name: 'media_url', type: 'text', description: 'Picture' }, { name: 'tags', type: 'text', description: 'Tags' },
    ],
  };
  const withStats = catalogEntry(schema, { rows: 10, fill_rate: { title: 1, tags: 0.25 }, stats_at: '2026-10-22T00:05:00.000Z' });
  assert.deepEqual(withStats.fields.map((f) => [f.name, f.fill_pct]), [['title', 100], ['prompt_text', 0], ['media_url', 0], ['tags', 25]]);
  const noStats = catalogEntry(schema, { rows: 10 });
  assert.ok(noStats.fields.every((f) => f.fill_pct === undefined));
});
