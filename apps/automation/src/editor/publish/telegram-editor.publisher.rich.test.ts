import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramEditorPublisher } from './telegram-editor.publisher';
import { classifyRichRejection, MemoryRichCapability, RICH_UNSUPPORTED_TTL_MS } from './rich-capability';
import { renderTelegram, type TgRichMessage } from '../post/render-telegram';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { sendRendered } from './publish-spec';

// Spec 033 T2: fake-HTTP tests of the rich send / edit path, the HTML retry and the capability flag.

const NOW = new Date('2026-10-08T12:00:00Z');

function setup(responses: any[], cap = new MemoryRichCapability()) {
  const calls: Array<{ url: string; body: any }> = [];
  const logs: string[] = [];
  const channels = { resolveChannel: () => ({ chatId: '-100123', botToken: 'TOKEN' }), isPublishPausedFor: () => false };
  const post = async (url: string, body: any) => {
    calls.push({ url, body });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { data: r };
  };
  return { calls, logs, cap, pub: new TelegramEditorPublisher(channels, post, { richCapability: cap, log: (m) => logs.push(m), now: () => NOW }) };
}

/** An axios-style HTTP error carrying the Bot API answer. */
function httpError(status: number, description: string): Error {
  const e: any = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: { ok: false, error_code: status, description } };
  return e;
}

const spec = makeSpec({
  format: 'text', media: [], cta: { url: 'https://x.example', label: 'Більше' },
  body: [
    { type: 'lead', text: 'Три смартфони до 20 000 грн' },
    { type: 'heading', text: 'Порівняння' },
    { type: 'table', header: ['Модель', 'Ціна'], rows: [['A55', '15 999']] },
    { type: 'olist', items: ['Бюджет', 'Камера'] },
  ],
});
const richMsg = () => renderTelegram(spec, makeCard()).messages[0] as TgRichMessage;

test('rich send: sendRichMessage with rich_message.blocks and the keyboard; nothing else is sent', async () => {
  const { calls, pub } = setup([{ ok: true, result: { message_id: 42 } }]);
  const m = richMsg();
  const res = await pub.send('@c', [m]);
  assert.deepEqual(res, { messageIds: [42] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/botTOKEN/sendRichMessage');
  assert.deepEqual(calls[0].body, {
    chat_id: '-100123',
    rich_message: { blocks: m.blocks },
    reply_markup: { inline_keyboard: [[{ text: 'Більше', url: 'https://x.example' }]] },
  });
  assert.equal('parse_mode' in calls[0].body, false);
});

test('a Bad Request on the rich message → one HTML retry; the result says fallback html; no flag for a size error', async () => {
  const { calls, cap, logs, pub } = setup([httpError(400, 'Bad Request: rich message is too long'), { ok: true, result: { message_id: 43 } }]);
  const m = richMsg();
  const res = await pub.send('@c', [m]);
  assert.deepEqual(res, { messageIds: [43], fallback: 'html', fallbackReason: '400: Bad Request: rich message is too long' });
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['sendRichMessage', 'sendMessage']);
  assert.equal(calls[1].body.text, m.fallback.method === 'sendMessage' ? m.fallback.text : null);
  assert.equal(calls[1].body.parse_mode, 'HTML');
  assert.equal(await cap.isUnsupported('@c', NOW), false);
  assert.match(logs[0], /sendRichMessage rejected \(rejected: 400/);
});

test('a hard "unsupported" answer → HTML retry and the channel is flagged for 7 days; then the fallback goes directly', async () => {
  const { calls, cap, pub } = setup([
    httpError(400, 'Bad Request: rich messages are not supported in this chat'), { ok: true, result: { message_id: 50 } },
    { ok: true, result: { message_id: 51 } },
  ]);
  const first = await pub.send('@c', [richMsg()]);
  assert.equal(first.fallback, 'html');
  assert.equal(await cap.isUnsupported('@c', NOW), true);
  assert.equal(cap.until.get('@c'), NOW.getTime() + RICH_UNSUPPORTED_TTL_MS);
  assert.equal(await cap.isUnsupported('@c', new Date(NOW.getTime() + RICH_UNSUPPORTED_TTL_MS + 1)), false, 'the flag expires after 7 days');

  const second = await pub.send('@c', [richMsg()]);
  assert.deepEqual(second, { messageIds: [51], fallback: 'html', fallbackReason: 'rich messages are flagged unsupported for this channel' });
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['sendRichMessage', 'sendMessage', 'sendMessage']);
});

test('an unknown method (older Bot API server, 404) counts as unsupported', async () => {
  const { cap, pub } = setup([httpError(404, 'Not Found: method not found'), { ok: true, result: { message_id: 7 } }]);
  assert.equal((await pub.send('@c', [richMsg()])).fallback, 'html');
  assert.equal(await cap.isUnsupported('@c', NOW), true);
});

test('a network error / 429 / 5xx is not retried as HTML (the rich message may be out) and nothing is flagged', async () => {
  for (const err of [new Error('timeout of 30000ms exceeded'), httpError(429, 'Too Many Requests: retry after 5'), httpError(502, 'Bad Gateway')]) {
    const { calls, cap, pub } = setup([err]);
    await assert.rejects(pub.send('@c', [richMsg()]), /Telegram sendRichMessage failed/);
    assert.equal(calls.length, 1);
    assert.equal(await cap.isUnsupported('@c', NOW), false);
  }
});

test('the HTML retry failing too throws (nothing went out)', async () => {
  const { pub } = setup([httpError(400, 'Bad Request: unsupported block'), httpError(400, 'Bad Request: chat not found')]);
  await assert.rejects(pub.send('@c', [richMsg()]), /chat not found/);
});

test('rich intro + poll: the poll still follows the fallback intro', async () => {
  const quiz = makeSpec({ format: 'quiz', media: [], body: spec.body, poll: { question: 'Котрий дешевший?', options: ['A55', 'Pixel'], correct_index: 0 } });
  const r = renderTelegram(quiz, makeCard());
  const { calls, pub } = setup([httpError(400, 'Bad Request: RICH_MESSAGE_INVALID'), { ok: true, result: { message_id: 1 } }, { ok: true, result: { message_id: 2 } }]);
  const res = await pub.send('@c', r.messages);
  assert.deepEqual(res.messageIds, [1, 2]);
  assert.equal(res.fallback, 'html');
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['sendRichMessage', 'sendMessage', 'sendPoll']);
});

test('rich edit: editMessageText with rich_message; a rejection edits with the HTML text instead', async () => {
  const ok = setup([{ ok: true, result: true }]);
  const m = richMsg();
  assert.deepEqual(await ok.pub.edit('@c', 42, m), { sent: 'rich' });
  assert.equal(ok.calls[0].url, 'https://api.telegram.org/botTOKEN/editMessageText');
  assert.deepEqual(ok.calls[0].body, {
    chat_id: '-100123', message_id: 42, rich_message: { blocks: m.blocks },
    reply_markup: { inline_keyboard: [[{ text: 'Більше', url: 'https://x.example' }]] },
  });

  const bad = setup([httpError(400, 'Bad Request: rich messages are not supported'), { ok: true, result: true }]);
  const res = await bad.pub.edit('@c', 42, m);
  assert.equal(res.sent, 'html');
  assert.equal(bad.calls[1].url.split('/').pop(), 'editMessageText');
  assert.equal(bad.calls[1].body.parse_mode, 'HTML');
  assert.equal(bad.calls[1].body.message_id, 42);
  assert.equal(await bad.cap.isUnsupported('@c', NOW), true);
});

test('HTML edits: text via editMessageText, a photo caption via editMessageCaption; polls cannot be edited', async () => {
  const { calls, pub } = setup([{ ok: true, result: true }, { ok: true, result: true }]);
  await pub.edit('@c', 1, { method: 'sendMessage', text: '<b>x</b>', preview: null, buttons: [] });
  await pub.edit('@c', 2, { method: 'sendPhoto', photo: 'https://i.example/a.jpg', caption: 'c', captionAboveMedia: false, buttons: [] });
  assert.deepEqual(calls.map((c) => c.url.split('/').pop()), ['editMessageText', 'editMessageCaption']);
  assert.deepEqual(calls[1].body, { chat_id: '-100123', message_id: 2, caption: 'c', parse_mode: 'HTML', show_caption_above_media: false });
  await assert.rejects(pub.edit('@c', 3, { method: 'sendPoll', question: 'q', options: ['a', 'b'], quiz: false, correctIndex: null, explanation: null, anonymous: true }), /cannot be edited/);
});

test('classifyRichRejection', () => {
  assert.equal(classifyRichRejection(new Error('socket hang up')), null);
  assert.equal(classifyRichRejection(httpError(500, 'Internal')), null);
  assert.equal(classifyRichRejection(httpError(429, 'Too Many Requests')), null);
  assert.equal(classifyRichRejection(httpError(400, 'Bad Request: message is too long'))?.kind, 'rejected');
  assert.equal(classifyRichRejection(httpError(400, 'Bad Request: chat not found'))?.kind, 'rejected');
  assert.equal(classifyRichRejection(httpError(400, 'Bad Request: method is not supported for channels'))?.kind, 'unsupported');
  assert.equal(classifyRichRejection(httpError(404, 'Not Found'))?.kind, 'unsupported');
  assert.equal(classifyRichRejection({ telegram: { ok: false, description: 'RICH_MESSAGE_UNSUPPORTED' } })?.kind, 'unsupported');
});

test('approval invariant (031): the stored render (JSON round trip) is sent unchanged; the fallback is recorded as a warning', async () => {
  const rendered = renderTelegram(spec, makeCard());
  const stored = JSON.parse(JSON.stringify({ messages: rendered.messages, primary: rendered.primary }));
  const { calls, pub } = setup([httpError(400, 'Bad Request: rich messages are not supported'), { ok: true, result: { message_id: 9 } }]);
  const sent: unknown[] = [];
  const res = await sendRendered({
    plans: { insertPublication: async () => 77 },
    publisher: { send: async (k, msgs) => { sent.push(...msgs); return pub.send(k, msgs); } },
    recordPublish: () => {},
  }, { channelKey: '@c', spec, card: { ...makeCard(), crosspost: false }, sourceRef: null, mediaKey: 's1', slotId: 's1' },
  { rendered: { messages: stored.messages, primary: stored.primary, preview: rendered.preview }, prepared: {} });
  assert.deepEqual(sent, rendered.messages, 'what the owner approved is what the publisher gets');
  assert.deepEqual(calls[0].body.rich_message.blocks, (rendered.messages[0] as TgRichMessage).blocks);
  assert.equal(calls[1].body.text, ((rendered.messages[0] as TgRichMessage).fallback as any).text, 'the fallback is the stored one');
  assert.equal(res.fallback, 'html');
  assert.deepEqual(res.mirrorWarnings, ['rich_fallback: html (400: Bad Request: rich messages are not supported)']);
  assert.equal(res.messageId, 9);
});
