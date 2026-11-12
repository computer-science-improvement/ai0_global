import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { DB_POOL } from '../database/database.module';
import { ChannelConfigService } from '../config/channel-config.service';
import { TelegramNotifier } from '../publishers/telegram-notifier.service';
import { PostingThrottleService } from '../publishers/posting-throttle.service';
import { TelegraphService } from '../publishers/telegraph.service';
import { SlideHostingService } from '../publishers/hosting/slide-hosting.service';
import { RecipeCarouselRendererService } from '../common/carousel/recipe-carousel-renderer.service';
import { CrossPostService } from '../publishers/cross-post.service';
import { GroupFanOutService } from '../common/content-strategy/group-fanout.service';
import { EDITOR_PROVIDERS, EditorModule } from '../editor/editor.module';
import { CONNECTOR_PROVIDERS } from './connector.module';
import { MCP_ENDPOINT } from './http/mcp.controller';
import { McpEndpoint } from './http/mcp-endpoint';
import { CONNECTOR_TOOLS, type ConnectorPrincipal, type ConnectorToolsFactory } from './types';

/**
 * Spec 103: the connector's providers resolve against the real editor providers (stubbed external deps, no DB), and
 * every editor token the connector injects is one EditorModule exports — otherwise Nest fails only at boot on stage.
 */
test('ConnectorModule providers resolve with the editor providers, and the tools factory serves every tool', async () => {
  @Module({
    providers: [
      ...EDITOR_PROVIDERS,
      ...CONNECTOR_PROVIDERS,
      { provide: DB_POOL, useValue: { query: async () => ({ rows: [] }), connect: async () => ({}) } },
      { provide: ConfigService, useValue: { get: (k: string) => ({ EDITOR_ENABLED: 'false' } as any)[k] } },
      { provide: ChannelConfigService, useValue: { resolveChannel: () => ({}), isPublishPausedFor: () => false } },
      { provide: TelegramNotifier, useValue: { notifyAlert: async () => {} } },
      { provide: PostingThrottleService, useValue: { recordPublish: () => {} } },
      { provide: RecipeCarouselRendererService, useValue: { renderSlides: async () => [] } },
      { provide: SlideHostingService, useValue: { available: async () => false, upload: async () => [], delete: async () => {} } },
      { provide: TelegraphService, useValue: { createPage: async () => ({ url: '', path: '' }) } },
      { provide: CrossPostService, useValue: { afterPublish: async () => [] } },
      { provide: GroupFanOutService, useValue: { fanOut: async () => [] } },
    ],
  })
  class TestConnectorModule {}

  const app = await NestFactory.createApplicationContext(TestConnectorModule, { logger: false });
  try {
    assert.ok(app.get(MCP_ENDPOINT) instanceof McpEndpoint);
    const factory = app.get<ConnectorToolsFactory>(CONNECTOR_TOOLS);
    const all: ConnectorPrincipal = { grantId: 'g', clientId: 'c', clientName: 'Claude', scopes: new Set(['mcp:read', 'mcp:write']) };
    const tools = await factory.tools(all);
    const names = tools.map((t) => t.name);
    for (const n of ['list_channels', 'get_channel', 'list_schedule', 'get_post', 'get_problems', 'get_logs', 'get_run', 'list_agents',
      'read_agent_chat', 'get_draft', 'list_recent_posts', 'check_post', 'prepare_post', 'plan_post', 'update_post', 'cancel_post', 'reject_post',
      'approve_post', 'replan_channel', 'talk_to_agent', 'apply_card', 'discard_card']) {
      assert.ok(names.includes(n), `missing tool ${n}`);
    }
    assert.ok(!names.some((n) => /publish/.test(n)), 'no publish-now tool in v1');
    // Spec 104: the one MCP Apps view, named by the tools that draw a preview; every tool is model-only.
    const [view] = await factory.resources!(all);
    assert.equal(view.mimeType, 'text/html;profile=mcp-app');
    assert.equal((tools.find((t) => t.name === 'get_draft')!._meta as any).ui.resourceUri, view.uri);
    for (const t of tools) assert.deepEqual((t._meta as any)?.ui?.visibility, ['model'], `${t.name} cannot be called from a view`);
    for (const t of tools) {
      assert.ok(t.title, `${t.name} has a title`);
      if (t.scope === 'mcp:read') assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is read-only`);
      else assert.equal(t.annotations?.destructiveHint, true, `${t.name} is destructive`);
    }
  } finally {
    await app.close();
  }
});

test('every editor token the connector injects is exported by EditorModule (or is the global DB_POOL)', () => {
  const exported = new Set<unknown>(Reflect.getMetadata(MODULE_METADATA.EXPORTS, EditorModule) ?? []);
  const own = new Set<unknown>(CONNECTOR_PROVIDERS.map((p) => (p as { provide: unknown }).provide));
  for (const p of CONNECTOR_PROVIDERS) {
    for (const dep of ((p as { inject?: unknown[] }).inject ?? [])) {
      if (dep === DB_POOL || own.has(dep)) continue;
      assert.ok(exported.has(dep), `EditorModule must export ${String(dep)}`);
    }
  }
});
