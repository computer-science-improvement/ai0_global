import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { TelegramPublisher } from './telegram.publisher';

afterEach(() => mock.restoreAll());

function publisher() {
  const calls = { recorded: [] as string[], publications: [] as any[] };
  const p = new TelegramPublisher(
    {
      isPublishPausedFor: () => false,
      resolveChannel: () => ({ chatId: '-100', botToken: 'BOT' }),
    } as any,
    { recordPublish: (k: string) => { calls.recorded.push(k); } } as any,
    { publication: (e: any) => { calls.publications.push(e); } } as any,
    { isEnabled: () => false } as any,
  );
  return { p, calls };
}

/** sendPhoto / sendVideo succeed with message_id 7; the reply (sendMessage) fails. */
function replyFails() {
  const posted: string[] = [];
  mock.method(axios, 'post', async (url: string) => {
    posted.push(url.split('/').pop()!);
    if (url.endsWith('/sendMessage')) throw new Error('Bad Request: message to reply not found');
    return { data: { result: { message_id: 7 } } };
  });
  return posted;
}

const LONG = 'Довгий текст поста. '.repeat(10);

test('publishPrompt: a failed reply after a live photo returns the photo id (no throw)', async () => {
  const posted = replyFails();
  const { p, calls } = publisher();
  const id = await p.publishPrompt(
    { imageBuffer: Buffer.from('img'), caption: 'Підпис до фото, достатньо довгий', replyText: LONG },
    { id: '@c' },
  );
  assert.equal(id, '7');
  assert.deepEqual(posted, ['sendPhoto', 'sendMessage']);
  assert.deepEqual(calls.recorded, ['@c']);
});

test('publishVideo: a failed reply after a live video returns the video id (no throw)', async () => {
  replyFails();
  const { p, calls } = publisher();
  const id = await p.publishVideo(
    { videoUrl: 'https://v/x.mp4', caption: 'Підпис до відео, достатньо довгий', replyText: LONG },
    { id: '@c' },
  );
  assert.equal(id, '7');
  assert.deepEqual(calls.recorded, ['@c']);
});

test('publish tier 3 (photo + reply): a failed reply still records the publish and returns the photo id', async () => {
  const posted = replyFails();
  const { p, calls } = publisher();
  const text = 'а'.repeat(2100); // > 2048 visible chars → tier 3
  const id = await p.publish(
    { text, imageBuffer: Buffer.from('img'), source: 's', tags: [], title: 't' } as any,
    { id: '@c' },
  );
  assert.equal(id, '7');
  assert.deepEqual(posted, ['sendPhoto', 'sendMessage']);
  assert.deepEqual(calls.recorded, ['@c']);
  assert.equal(calls.publications.at(-1).status, 'success');
});

test('publishPrompt: a failed PHOTO still throws (nothing went live)', async () => {
  mock.method(axios, 'post', async () => { throw new Error('Bad Request: PHOTO_INVALID_DIMENSIONS'); });
  const { p, calls } = publisher();
  await assert.rejects(
    () => p.publishPrompt({ imageBuffer: Buffer.from('img'), caption: 'Підпис до фото, достатньо довгий' }, { id: '@c' }),
    /PHOTO_INVALID/,
  );
  assert.deepEqual(calls.recorded, []);
});
