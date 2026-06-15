import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TikTokContentClient } from './tiktok-content.client';

function build(over: any = {}) {
  const calls: any = { posts: [] };
  class TestClient extends TikTokContentClient {
    protected post(url: string, accessToken: string, body: any) {
      calls.posts.push({ url, accessToken, body });
      if (over.throw) throw new Error(over.throw);
      return Promise.resolve(over.response ?? { data: { publish_id: 'pub_1' }, error: { code: 'ok' } });
    }
  }
  return { client: new TestClient(), calls };
}

test('initPhotoPost returns publishId and forwards the token + body', async () => {
  const { client, calls } = build();
  const out = await client.initPhotoPost('TOK', { media_type: 'PHOTO' });
  assert.equal(out.publishId, 'pub_1');
  assert.ok(calls.posts[0].url.endsWith('/v2/post/publish/content/init/'));
  assert.equal(calls.posts[0].accessToken, 'TOK');
  assert.equal(calls.posts[0].body.media_type, 'PHOTO');
});

test('initPhotoPost throws on a non-ok error code (token not in message)', async () => {
  const { client } = build({ response: { data: {}, error: { code: 'invalid_params', message: 'bad url' } } });
  await assert.rejects(() => client.initPhotoPost('SECRET_TOK', {}), (e: any) => {
    assert.match(e.message, /bad url|invalid_params/);
    assert.doesNotMatch(e.message, /SECRET_TOK/);
    return true;
  });
});

test('fetchStatus returns status + failReason', async () => {
  const { client, calls } = build({ response: { data: { status: 'PROCESSING_UPLOAD', fail_reason: '' }, error: { code: 'ok' } } });
  const out = await client.fetchStatus('TOK', 'pub_1');
  assert.equal(out.status, 'PROCESSING_UPLOAD');
  assert.ok(calls.posts[0].url.endsWith('/v2/post/publish/status/fetch/'));
  assert.equal(calls.posts[0].body.publish_id, 'pub_1');
});
