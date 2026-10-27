/**
 * Spec 067 FR-005 (T4): poster fit is decided by code. A library post is not news, so it may carry a fitting poster; an
 * off-topic poster is an error before publishing (the executor can still fix it) and a warning in the post audit, and its
 * message names the posters that fit or says none does; the code's decision (`news_no_poster` / `poster_fits` /
 * `none_fits`) is made for every post, with or without an image.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditCard, AuditContext, AuditPost } from './types';
import { isNewsPost, mediaCheck, posterDecisionOf } from './checks/media';
import { auditPostFromSpec } from './from-post-spec';
import { AI_POSTERS, fittingPosters, posterFitsTopic } from '../media/posters';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';
import { auditPostFromPlatformSpec } from '../../audit/post-audit';
import { PlatformPostSpecSchema } from '../../platform/platform-spec';
import { platformMediaFindings } from '../../platform/platform-media';
import { buildComposeTools } from '../../tools/compose-tools';

const POSTER = (id: string) => `https://prdruteophdbnypnikij.supabase.co/storage/v1/object/public/common/${id}.png`;
const NEWS_CARD: AuditCard = { timezone: 'Europe/Kyiv', style: { content_kind: 'news' } as AuditCard['style'] };
const META = { id: 's1', channel: 'ai0', publishedAt: '2026-10-27T10:00:00+02:00', timezone: 'Europe/Kyiv' };
const codes = (fs: Array<{ code: string; level: string }>) => fs.map((f) => `${f.code}:${f.level}`);
const ctx = (o: Partial<AuditContext> = {}): AuditContext => ({ previous: [], card: NEWS_CARD, ...o });

/** A library post about MCP that cites the row's own page (the review-4 shape: a library fact with a source URL). */
const mcp = (over: Record<string, unknown> = {}) => makeSpec({
  format: 'photo', origin: 'library', library_ref: 'data://facts/12', title: 'Що таке MCP-сервер',
  body: [
    { type: 'lead', text: 'MCP-сервер підключає AI-асистента до ваших сервісів.' },
    { type: 'p', text: 'Через MCP-сервер асистент читає календар і пошту, не виходячи з розмови.' },
  ],
  media: [{ url: POSTER('04-mcp-server') }], source: { url: 'https://modelcontextprotocol.io/introduction', label: 'MCP' }, hashtags: ['космос'], ...over,
});
const audit = (spec: ReturnType<typeof mcp>): AuditPost => auditPostFromSpec(spec, META);

test('fittingPosters: those posterFitsTopic accepts, best keyword hits first, catalogue order on ties; none for an unrelated topic', () => {
  const ids = (i: Parameters<typeof fittingPosters>[0]) => fittingPosters(i).map((p) => p.id);
  assert.deepEqual(ids({ head: ['Промпт для агента'], text: 'Один промпт на день.' }), ['01-prompt', '02-community-prompt', '08-agent'], 'prompt ×4 twice, then agent ×3');
  assert.deepEqual(ids({ head: ['Що таке MCP-сервер'], text: 'MCP-сервер підключає асистента до календаря. Асистент читає пошту.' }), ['04-mcp-server', '08-agent'], 'MCP in the head and the text beats «асистент» twice in the text');
  assert.deepEqual(ids({ head: ['Що таке MCP-сервер'], text: 'MCP-сервер підключає асистента до календаря.' }), ['04-mcp-server'], 'one passing mention is not the topic');
  assert.deepEqual(ids({ head: ['Погода у Львові'], text: 'Завтра дощ, сніг у Карпатах.' }), []);
  // The same stems as posterFitsTopic: whoever fits is returned and nobody else.
  const input = { head: ['Памʼять агента: як вона працює'], text: 'Агент памʼятає розмови.' };
  assert.deepEqual(fittingPosters(input).map((p) => p.id).sort(), AI_POSTERS.filter((p) => posterFitsTopic(p, input)).map((p) => p.id).sort());
  assert.ok(ids({ head: [null, undefined, '  '], text: '' }).length === 0, 'blank head parts are ignored');
});

test('a library post with a source URL is not news and may carry a fitting poster; the same post as external news may not', () => {
  const lib = audit(mcp());
  assert.equal(lib.fromLibrary, true, 'origin library / library_ref → fromLibrary');
  assert.equal(isNewsPost(lib, NEWS_CARD), false);
  assert.deepEqual(mediaCheck.run(lib, ctx({ prePublish: true })), [], 'MCP poster on an MCP library post: fine, before publishing too');
  assert.equal(posterDecisionOf(lib, NEWS_CARD), 'poster_fits');

  const external = audit(mcp({ origin: 'external', library_ref: undefined }));
  assert.equal(external.fromLibrary, undefined);
  assert.equal(isNewsPost(external, NEWS_CARD), true);
  assert.deepEqual(codes(mediaCheck.run(external, ctx())), ['poster_mismatch:error'], 'a poster on news stays an error whatever the context');
  assert.equal(posterDecisionOf(external, NEWS_CARD), 'news_no_poster');

  // A library_ref alone (origin says original) also marks it; a platform spec carries library_ref too.
  assert.equal(audit(mcp({ origin: 'original' })).fromLibrary, true);
  const ig = PlatformPostSpecSchema.parse({ format: 'ig_photo', title: 'Що таке MCP-сервер', caption: 'MCP-сервер підключає AI до сервісів.', source: { url: 'https://modelcontextprotocol.io/introduction' }, library_ref: 'data://facts/12', media: [{ url: POSTER('04-mcp-server') }] });
  const igPost = auditPostFromPlatformSpec(ig, { id: 'ig:1', channel: 'instagram:1', publishedAt: META.publishedAt, timezone: META.timezone });
  assert.equal(igPost.fromLibrary, true);
  assert.equal(isNewsPost(igPost, NEWS_CARD), false);
  const igNews = auditPostFromPlatformSpec({ ...ig, library_ref: undefined }, { id: 'ig:2', channel: 'instagram:1', publishedAt: META.publishedAt, timezone: META.timezone });
  assert.equal(igNews.fromLibrary, undefined);
  assert.equal(isNewsPost(igNews, NEWS_CARD), true);
});

test('an off-topic poster: an error before publishing, a warning in the audit; the message names the posters that fit', () => {
  const off = audit(mcp({ media: [{ url: POSTER('13-memory') }] }));
  const pre = mediaCheck.run(off, ctx({ prePublish: true }));
  assert.deepEqual(codes(pre), ['poster_mismatch:error']);
  assert.match(pre[0].message, /«Memory» \(use_for: памʼять агента\) не про тему поста «Що таке MCP-сервер»/);
  assert.match(pre[0].message, /для цієї теми підходить: «MCP server» \(use_for: MCP-сервер, підключення AI до сервісу\)/);
  assert.match(pre[0].message, /пост без зображення \(format text\)/);
  const weekly = mediaCheck.run(off, ctx());
  assert.deepEqual(codes(weekly), ['poster_mismatch:warning'], 'the weekly audit of published posts keeps the warning');
  assert.equal(weekly[0].message, pre[0].message);

  // The poster already on the post is not offered back; a topic no poster fits says text only.
  const none = audit(mcp({
    title: 'Лайфхаки для сну', body: [{ type: 'lead', text: 'Лягайте спати до півночі.' }, { type: 'p', text: 'Темна кімната й прохолодне повітря допомагають заснути.' }],
    media: [{ url: POSTER('08-agent') }],
  }));
  const f = mediaCheck.run(none, ctx({ prePublish: true }));
  assert.deepEqual(codes(f), ['poster_mismatch:error']);
  assert.match(f[0].message, /жоден постер мережі не підходить до цієї теми — пост без зображення \(format text\)/);
  assert.doesNotMatch(f[0].message, /підходить:/);
});

test('posterDecisionOf: news / fits / none fits, for a post with or without an image', () => {
  const noImage = audit(mcp({ media: [], format: 'text' }));
  assert.equal(noImage.imageUrls, undefined);
  assert.equal(posterDecisionOf(noImage, NEWS_CARD), 'poster_fits', 'the decision does not need an image');
  const sleep = audit(mcp({ title: 'Лайфхаки для сну', body: [{ type: 'lead', text: 'Лягайте спати до півночі.' }], media: [], format: 'text' }));
  assert.equal(posterDecisionOf(sleep, NEWS_CARD), 'none_fits');
  const news = audit(mcp({ origin: 'external', library_ref: undefined, media: [], format: 'text', title: 'Anthropic випустила нову модель', body: [{ type: 'lead', text: 'Anthropic випустила нову модель.' }] }));
  assert.equal(posterDecisionOf(news, NEWS_CARD), 'news_no_poster');
  assert.equal(posterDecisionOf(news, { style: { content_kind: 'explainer' } as AuditCard['style'] }), 'poster_fits', 'an explainer resource: not news (the model topic fits «Fine-tune / Model»)');
});

test('lintPost: prePublish makes the off-topic poster an error, without it a warning; a fitting poster on a library post is clean', () => {
  const card = { ...makeCard(), style: { content_kind: 'news' } } as ReturnType<typeof makeCard>;
  const off = mcp({ media: [{ url: POSTER('13-memory') }] });
  const pre = lintPost(off, card, { ctx: { prePublish: true } });
  assert.ok(pre.errors.some((e) => e.code === 'poster_mismatch' && /«MCP server»/.test(e.message)), JSON.stringify(pre.errors));
  const drafting = lintPost(off, card, {});
  assert.ok(!drafting.errors.some((e) => e.code === 'poster_mismatch'));
  assert.ok(drafting.warnings.some((w) => w.code === 'poster_mismatch'));
  const fits = lintPost(mcp(), card, { ctx: { prePublish: true } });
  assert.ok(![...fits.errors, ...fits.warnings].some((x) => x.code === 'poster_mismatch'), JSON.stringify([...fits.errors, ...fits.warnings]));
});

test('lint_post tool: an executor sees what publish_post will refuse (error); the chat composer keeps the warning', async () => {
  const tool = buildComposeTools().find((t) => t.name === 'lint_post')!;
  const card = { ...makeCard(), style: { content_kind: 'news' } };
  const spec = mcp({ media: [{ url: POSTER('13-memory') }] });
  const run = (role: string): Promise<any> => tool.execute({ spec } as any, { runId: 'r', role, channelKey: '@chan', extras: { card } } as any);
  const executor = await run('executor');
  assert.equal(executor.error, 'lint_failed');
  assert.ok(executor.details.some((d: string) => d.startsWith('poster_mismatch:')));
  const composer = await run('composer');
  assert.ok(!composer.error, JSON.stringify(composer.details));
  assert.ok(composer.warnings.some((w: { code: string }) => w.code === 'poster_mismatch'));
});

test('platformMediaFindings: an off-topic poster blocks; the decision comes back for every post', () => {
  const style = { content_kind: 'news' };
  const off = PlatformPostSpecSchema.parse({ format: 'ig_photo', title: 'Що таке MCP-сервер', caption: 'MCP-сервер підключає AI до сервісів.', library_ref: 'data://facts/12', media: [{ url: POSTER('13-memory') }] });
  const r = platformMediaFindings(off, { resourceRef: 'instagram:1', style });
  assert.deepEqual(r.errors.map((e) => e.code), ['poster_mismatch']);
  assert.match(r.errors[0].message, /«MCP server»/);
  assert.equal(r.poster, 'poster_fits');
  const text = PlatformPostSpecSchema.parse({ format: 'th_text', title: 'Лайфхаки для сну', caption: 'Лягайте спати до півночі.', library_ref: 'data://facts/3' });
  assert.deepEqual(platformMediaFindings(text, { resourceRef: 'threads:1', style }), { errors: [], warnings: [], poster: 'none_fits' });
  const news = PlatformPostSpecSchema.parse({ format: 'th_text', title: 'Новина', caption: 'Valve оновила гру.', source: { url: 'https://store.steampowered.com/news/app/123/view/456' } });
  assert.equal(platformMediaFindings(news, { resourceRef: 'threads:1', style }).poster, 'news_no_poster');
});
