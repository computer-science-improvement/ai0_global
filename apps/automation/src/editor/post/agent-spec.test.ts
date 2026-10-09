import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentPostSpecSchema, coerceAgentSpec, PostSpecSchema } from './post-spec';
import { AgentPlatformPostSpecSchema } from '../platform/platform-spec';

const base = { format: 'photo', title: 'YNAB MCP', origin: 'external', body: [{ type: 'lead', text: 'Тест поста' }] };
const IMG = 'https://prdruteophdbnypnikij.supabase.co/storage/v1/object/public/common/04-mcp-server.png';

test('the plain PostSpecSchema drops unknown fields silently (why agent inputs need their own schema)', () => {
  const r = PostSpecSchema.parse({ ...base, image: IMG, source_url: 'https://github.com/a/b' });
  assert.deepEqual([r.media.length, r.source], [0, undefined]);
});

test('agent spec: picture and source aliases land in media / source; media URL strings become objects; duplicates collapse', () => {
  for (const k of ['image', 'image_url', 'imageUrl', 'photo', 'picture', 'media_url', 'img']) {
    const r = AgentPostSpecSchema.parse({ ...base, [k]: IMG, source_url: 'https://github.com/calebl/ynab-mcp-server' });
    assert.deepEqual(r.media, [{ url: IMG }], k);
    assert.equal(r.source?.url, 'https://github.com/calebl/ynab-mcp-server');
  }
  assert.deepEqual(AgentPostSpecSchema.parse({ ...base, media: [IMG], image: IMG }).media, [{ url: IMG }]);
  assert.equal(AgentPostSpecSchema.parse({ ...base, source: 'https://x.example/a' }).source?.url, 'https://x.example/a');
  assert.deepEqual(AgentPostSpecSchema.parse({ ...base, format: 'text' }).media, [], 'no alias, no media key: the default stays');
  assert.deepEqual(coerceAgentSpec('x'), 'x');
});

test('agent spec: any other unknown field is an error that names it', () => {
  const r = AgentPostSpecSchema.safeParse({ ...base, caption: 'текст' });
  assert.equal(r.success, false);
  assert.match(JSON.stringify(r.error!.issues), /caption/);
});

test('agent spec: the model still sees every PostSpec field, now with additionalProperties: false', () => {
  const js = z.toJSONSchema(z.object({ spec: AgentPostSpecSchema }), { io: 'input', unrepresentable: 'any' }) as any;
  assert.ok(js.properties.spec.properties.media && js.properties.spec.properties.source && js.properties.spec.properties.body);
  assert.equal(js.properties.spec.additionalProperties, false);
});

test('platform agent spec: aliases map to media; `link` stays the real link field', () => {
  const r = AgentPlatformPostSpecSchema.parse({ format: 'ig_photo', title: 'MCP', caption: 'Підпис', image_url: IMG, link: { url: 'https://x.example' } });
  assert.equal(r.media[0].url, IMG);
  assert.equal(r.link?.url, 'https://x.example');
  assert.equal(AgentPlatformPostSpecSchema.safeParse({ format: 'ig_photo', title: 'MCP', body: [] }).success, false);
});

test('agent spec: a picture or source URL written without https:// (as kept in memory) gets the scheme', () => {
  const r = AgentPostSpecSchema.parse({ ...base, image: 'prdruteophdbnypnikij.supabase.co/storage/v1/object/public/common/04-mcp-server.png', source: { url: 'github.com/calebl/ynab-mcp-server' } });
  assert.equal(r.media[0].url, IMG);
  assert.equal(r.source?.url, 'https://github.com/calebl/ynab-mcp-server');
  assert.equal(AgentPostSpecSchema.safeParse({ ...base, image: 'not a url' }).success, false);
});
