/**
 * HTTP-level test of NavController (spec 027 FR-005) on an in-process Nest app
 * bound to 127.0.0.1: the real TrackingAuthGuard, GET/PUT/DELETE /api/nav/config,
 * the revision-based 409 and the 400 shape errors. The app_settings table is an
 * in-memory fake that understands the four statements NavConfigService sends.
 */
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../../auth/auth.service';
import { TrackingAuthGuard } from '../../tracking/api/tracking-auth.guard';
import { makeAuth } from '../../auth/testing/fakes';
import { NavConfigService } from './nav-config.service';
import { NAV_CONFIG, NavController } from './nav.controller';

const TOKEN = 'test-token';

/** In-memory app_settings: key → {value, updated_at text}. Revisions tick by 1 ms. */
export class FakeSettingsTable {
  rows = new Map<string, { value: string; updatedAt: string }>();
  private t = Date.parse('2026-10-06T09:00:00.000Z');
  private tick(): string { this.t += 1; return new Date(this.t).toISOString().replace('T', ' ').replace('Z', '+00'); }
  async query(sql: string, params: any[] = []) {
    const [key] = params;
    if (/^SELECT value, updated_at::text/.test(sql.trim())) {
      const r = this.rows.get(key);
      return { rows: r ? [{ value: r.value, revision: r.updatedAt }] : [] };
    }
    if (/^INSERT INTO app_settings/.test(sql.trim())) {
      if (this.rows.has(key)) return { rows: [] };
      const updatedAt = this.tick();
      this.rows.set(key, { value: params[1], updatedAt });
      return { rows: [{ revision: updatedAt }] };
    }
    if (/^UPDATE app_settings/.test(sql.trim())) {
      const r = this.rows.get(key);
      if (!r || r.updatedAt !== params[2]) return { rows: [] };
      r.value = params[1];
      r.updatedAt = this.tick();
      return { rows: [{ revision: r.updatedAt }] };
    }
    if (/^DELETE FROM app_settings/.test(sql.trim())) { this.rows.delete(key); return { rows: [] }; }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

const table = new FakeSettingsTable();
let app: INestApplication;
let port: number;

before(async () => {
  Reflect.defineMetadata('design:paramtypes', [AuthService], TrackingAuthGuard);
  Reflect.defineMetadata('design:paramtypes', [Object], NavController.prototype, 'putConfig');
  @Module({
    controllers: [NavController],
    providers: [
      { provide: ConfigService, useValue: { get: (k: string) => ({ TRACKING_TOKEN: TOKEN } as any)[k] } },
      { provide: AuthService, useValue: makeAuth({ TRACKING_TOKEN: TOKEN }).auth },
      { provide: NAV_CONFIG, useValue: new NavConfigService(table as any) },
    ],
  })
  class TestModule {}
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
  await app.listen(0, '127.0.0.1');
  port = (app.getHttpServer().address() as AddressInfo).port;
});
after(async () => { await app?.close(); });

function call(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1', port, method, path,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(buf); } catch { /* empty */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const menu = (label = 'Team') => ({
  schemaVersion: 1,
  groups: [{ id: 'g_home', items: ['overview', 'approvals'] }],
  pinned: [], hidden: ['strategies'], custom: [],
  overrides: { agents: { label } },
});

test('every nav endpoint requires the tracking token', async () => {
  for (const m of ['GET', 'PUT', 'DELETE']) {
    assert.equal((await call(m, '/api/nav/config', m === 'PUT' ? { config: menu(), baseRevision: null } : undefined, null)).status, 401, m);
  }
});

test('save, read back, stale revision → 409 (draft kept by the client), reset', async () => {
  table.rows.clear();
  const empty = await call('GET', '/api/nav/config');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { config: null, revision: null });

  const first = await call('PUT', '/api/nav/config', { config: menu(), baseRevision: null });
  assert.equal(first.status, 200);
  assert.equal(typeof first.json.revision, 'string');

  const got = await call('GET', '/api/nav/config');
  assert.deepEqual(got.json.config, menu());
  assert.equal(got.json.revision, first.json.revision);

  // Tab B saves on top of the current revision…
  const second = await call('PUT', '/api/nav/config', { config: menu('Crew'), baseRevision: first.json.revision });
  assert.equal(second.status, 200);
  assert.notEqual(second.json.revision, first.json.revision);
  // …so tab A, still on the first revision, gets a 409 and nothing is overwritten.
  const stale = await call('PUT', '/api/nav/config', { config: menu('Lost'), baseRevision: first.json.revision });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'nav_conflict');
  // "Nothing saved yet" is stale too once a row exists, and so is a revision we never issued.
  assert.equal((await call('PUT', '/api/nav/config', { config: menu('Lost'), baseRevision: null })).status, 409);
  assert.equal((await call('PUT', '/api/nav/config', { config: menu('Lost'), baseRevision: 'garbage' })).status, 409);
  assert.equal((await call('GET', '/api/nav/config')).json.config.overrides.agents.label, 'Crew');

  const reset = await call('DELETE', '/api/nav/config');
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.json, { revision: null });
  assert.deepEqual((await call('GET', '/api/nav/config')).json, { config: null, revision: null });
  // After a reset in another tab, a save based on the old revision is a conflict.
  assert.equal((await call('PUT', '/api/nav/config', { config: menu(), baseRevision: second.json.revision })).status, 409);
});

test('invalid shapes are 400 with issues; a missing baseRevision is refused', async () => {
  table.rows.clear();
  const bad = await call('PUT', '/api/nav/config', { config: { ...menu(), schemaVersion: 2 }, baseRevision: null });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid_nav_config');
  assert.equal(bad.json.issues[0].path, 'schemaVersion');
  const noBase = await call('PUT', '/api/nav/config', { config: menu() });
  assert.equal(noBase.status, 400);
  assert.equal(noBase.json.issues[0].path, 'baseRevision');
  const custom = { ...menu(), custom: [{ id: 'c_1', label: 'Out', icon: 'globe', to: 'https://example.com' }] };
  assert.equal((await call('PUT', '/api/nav/config', { config: custom, baseRevision: null })).status, 400);
  assert.equal(table.rows.size, 0, 'nothing was written');
});

test('a corrupt row reads as config:null with a warning, and can be overwritten', async () => {
  table.rows.clear();
  table.rows.set('ui.nav', { value: '{not json', updatedAt: '2026-10-06 08:00:00.000+00' });
  const got = await call('GET', '/api/nav/config');
  assert.deepEqual(got.json, { config: null, revision: '2026-10-06 08:00:00.000+00', warning: 'unparseable' });
  const fix = await call('PUT', '/api/nav/config', { config: menu(), baseRevision: got.json.revision });
  assert.equal(fix.status, 200);
  // A newer schema is returned as stored: the dashboard shows the default menu and blocks saving.
  table.rows.set('ui.nav', { value: JSON.stringify({ ...menu(), schemaVersion: 7 }), updatedAt: '2026-10-06 08:00:01.000+00' });
  assert.equal((await call('GET', '/api/nav/config')).json.config.schemaVersion, 7);
});
