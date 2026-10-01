import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelPausedForEditorError, TelegramEditorPublisher } from './telegram-editor.publisher';

function setup(responses: any[], paused = false) {
  const calls: Array<{ url: string; body: any }> = [];
  const channels = { resolveChannel: () => ({ chatId: '-100123', botToken: 'TOKEN' }), isPublishPausedFor: () => paused };
  const post = async (url: string, body: any) => {
    calls.push({ url, body });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { data: r };
  };
  return { calls, pub: new TelegramEditorPublisher(channels, post) };
}

test('sendMessage with large preview above text and keyboard', async () => {
  const { calls, pub } = setup([{ ok: true, result: { message_id: 11 } }]);
  const res = await pub.send('@c', [{ method: 'sendMessage', text: '<b>x</b>', preview: { url: 'https://i.example/a.jpg', showAboveText: true }, buttons: [[{ text: 'Go', url: 'https://x.example' }]] }]);
  assert.deepEqual(res, { messageIds: [11] });
  assert.equal(calls[0].url, 'https://api.telegram.org/botTOKEN/sendMessage');
  assert.deepEqual(calls[0].body.link_preview_options, { url: 'https://i.example/a.jpg', prefer_large_media: true, show_above_text: true });
  assert.deepEqual(calls[0].body.reply_markup, { inline_keyboard: [[{ text: 'Go', url: 'https://x.example' }]] });
  assert.equal(calls[0].body.parse_mode, 'HTML');
});

test('sendMessage without preview disables link preview', async () => {
  const { calls, pub } = setup([{ ok: true, result: { message_id: 1 } }]);
  await pub.send('@c', [{ method: 'sendMessage', text: 't', preview: null, buttons: [] }]);
  assert.deepEqual(calls[0].body.link_preview_options, { is_disabled: true });
  assert.equal(calls[0].body.reply_markup, undefined);
});

test('sendPhoto caption position, media group caption on first only', async () => {
  const { calls, pub } = setup([{ ok: true, result: { message_id: 2 } }, { ok: true, result: [{ message_id: 3 }, { message_id: 4 }] }]);
  await pub.send('@c', [{ method: 'sendPhoto', photo: 'https://i.example/p.jpg', caption: 'c', captionAboveMedia: true, buttons: [] }]);
  assert.equal(calls[0].body.show_caption_above_media, true);
  const r = await pub.send('@c', [{ method: 'sendMediaGroup', photos: ['https://i.example/1.jpg', 'https://i.example/2.jpg'], caption: 'cap' }]);
  assert.deepEqual(r.messageIds, [3]);
  assert.equal(calls[1].body.media[0].caption, 'cap');
  assert.equal(calls[1].body.media[1].caption, undefined);
});

test('quiz poll payload', async () => {
  const { calls, pub } = setup([{ ok: true, result: { message_id: 9 } }]);
  await pub.send('@c', [{ method: 'sendPoll', question: 'Q?', options: ['a', 'b'], quiz: true, correctIndex: 1, explanation: 'bo', anonymous: true }]);
  assert.deepEqual(calls[0].body.options, [{ text: 'a' }, { text: 'b' }]);
  assert.equal(calls[0].body.type, 'quiz');
  assert.equal(calls[0].body.correct_option_id, 1);
  assert.equal(calls[0].body.explanation, 'bo');
});

test('failure on first message throws; failure after first is partial success', async () => {
  const tgErr: any = new Error('400'); tgErr.response = { data: { description: 'Bad Request: can\'t parse entities' } };
  const a = setup([tgErr]);
  await assert.rejects(a.pub.send('@c', [{ method: 'sendMessage', text: 't', preview: null, buttons: [] }]), /can't parse entities/);
  const b = setup([{ ok: true, result: { message_id: 5 } }, { ok: false, description: 'POLL_ANSWERS_INVALID' }]);
  const r = await b.pub.send('@c', [
    { method: 'sendMessage', text: 't', preview: null, buttons: [] },
    { method: 'sendPoll', question: 'Q', options: ['a', 'b'], quiz: false, correctIndex: null, explanation: null, anonymous: true },
  ]);
  assert.deepEqual(r.messageIds, [5]);
  assert.match(r.partialError!, /POLL_ANSWERS_INVALID/);
});

test('paused channel throws before any call', async () => {
  const { calls, pub } = setup([], true);
  await assert.rejects(pub.send('@c', [{ method: 'sendMessage', text: 't', preview: null, buttons: [] }]), ChannelPausedForEditorError);
  assert.equal(calls.length, 0);
});
