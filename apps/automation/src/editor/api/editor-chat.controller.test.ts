/**
 * HTTP-level test of EditorChatController on an in-process Nest app bound to
 * 127.0.0.1 with stub services: the real TrackingAuthGuard, NDJSON streaming of
 * a chat message, plain HTTP errors before the stream starts, and the mapping of
 * refused draft actions to 4xx. No DB, no LLM, no external network.
 */
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { BadRequestException, Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../../auth/auth.service';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { EDITOR_CHAT, EDITOR_DRAFTS, EditorChatController } from './editor-chat.controller';

const TOKEN = 'test-token';
const CHAT = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const DRAFT = '2b4e28ba-2fa1-11d2-883f-0016d3cca427';
const calls: unknown[][] = [];

const chat = {
  listChats: async () => [], listChannels: async () => [{ channelKey: '@space', title: 'Космос', hasCard: false, mode: null }], createChat: async () => ({ id: CHAT }), getChat: async (id: string) => ({ chat: { id } }), deleteChat: async () => ({ ok: true }),
  validateSend: async (_id: string, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) throw new BadRequestException({ error: 'invalid_text' });
    return text.trim();
  },
  sendMessage: async (id: string, text: string, o: any) => {
    calls.push(['send', id, text, o.channel]);
    o.onEvent({ type: 'tool_call', name: 'fetch_feed', args: { url: 'https://x.example/rss' } });
    o.onEvent({ type: 'tool_result', name: 'fetch_feed', ok: true, summary: '{"items":[]}' });
    o.onEvent({ type: 'draft', draft: { id: DRAFT, status: 'draft' } });
    o.onEvent({ type: 'message', message: { id: 2, role: 'assistant', content: 'Готово' } });
    return { message: {}, drafts: [] };
  },
};
const drafts = {
  withRender: async (d: any) => ({ ...d, render: null }),
  list: async (f: unknown) => { calls.push(['list', f]); return []; },
  publish: async (id: string) => (id === DRAFT ? { ok: true, draft: { id }, messageId: 7, warnings: [] } : { error: 'draft_not_found' }),
  schedule: async (id: string, at: Date) => { calls.push(['schedule', id, at.toISOString()]); return { error: 'too_soon', details: 'x' }; },
  cancel: async () => ({ error: 'already_published' }),
};

let app: INestApplication;
let port: number;

before(async () => {
  Reflect.defineMetadata('design:paramtypes', [ConfigService, AuthService], TrackingAuthGuard);
  Reflect.defineMetadata('design:paramtypes', [String, Object, Object], EditorChatController.prototype, 'send');
  Reflect.defineMetadata('design:paramtypes', [String, Object], EditorChatController.prototype, 'schedule');
  @Module({
    controllers: [EditorChatController],
    providers: [
      { provide: ConfigService, useValue: { get: (k: string) => ({ TRACKING_TOKEN: TOKEN } as any)[k] } },
      { provide: AuthService, useValue: { verifyToken: async () => null } },
      { provide: EDITOR_CHAT, useValue: chat },
      { provide: EDITOR_DRAFTS, useValue: drafts },
    ],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as AddressInfo).port;
});
after(async () => { await app?.close(); });

function call(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; type: string; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, method, path,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('chat routes require the tracking token', async () => {
  assert.equal((await call('GET', '/api/editor/chats', undefined, null)).status, 401);
  assert.equal((await call('POST', `/api/editor/chats/${CHAT}/messages`, { text: 'hi' }, null)).status, 401);
  assert.equal((await call('GET', '/api/editor/chats')).status, 200);
  const ch = await call('GET', '/api/editor/chat-channels');
  assert.equal(JSON.parse(ch.text)[0].channelKey, '@space');
});

test('a chat message streams NDJSON events and ends with done', async () => {
  calls.length = 0;
  const r = await call('POST', `/api/editor/chats/${CHAT}/messages`, { text: ' Зроби пост ', channel: '@space' });
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/x-ndjson/);
  const events = r.text.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ['tool_call', 'tool_result', 'draft', 'message', 'done']);
  assert.deepEqual(calls, [['send', CHAT, 'Зроби пост', '@space']]);
});

test('validation fails as a plain HTTP error before any streaming; malformed ids are 400', async () => {
  const r = await call('POST', `/api/editor/chats/${CHAT}/messages`, { text: '  ' });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.text).error, 'invalid_text');
  assert.equal((await call('GET', '/api/editor/chats/not-a-uuid')).status, 400);
  assert.equal((await call('POST', '/api/editor/drafts/not-a-uuid/publish')).status, 400);
});

test('draft buttons: refused actions map to 4xx with the same {error, details} body', async () => {
  calls.length = 0;
  const ok = await call('POST', `/api/editor/drafts/${DRAFT}/publish`);
  assert.equal(ok.status, 201);
  assert.equal(JSON.parse(ok.text).messageId, 7);
  const missing = await call('POST', `/api/editor/drafts/${CHAT}/publish`);
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.text).error, 'draft_not_found');
  assert.equal((await call('POST', `/api/editor/drafts/${DRAFT}/cancel`)).status, 409);

  const badTime = await call('POST', `/api/editor/drafts/${DRAFT}/schedule`, { at: 'завтра' });
  assert.equal(badTime.status, 400);
  assert.equal(JSON.parse(badTime.text).error, 'invalid_time');
  const soon = await call('POST', `/api/editor/drafts/${DRAFT}/schedule`, { at: '2026-10-02 19:00' });
  assert.equal(soon.status, 400);
  assert.deepEqual(JSON.parse(soon.text), { error: 'too_soon', details: 'x' });
  assert.deepEqual(calls, [['schedule', DRAFT, '2026-10-02T16:00:00.000Z']]);

  assert.equal((await call('GET', '/api/editor/drafts?status=bogus')).status, 400);
  assert.equal((await call('GET', '/api/editor/drafts?status=scheduled')).status, 200);
});
