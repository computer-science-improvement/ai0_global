import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DB_POOL } from '../database/database.module';
import { ChannelConfigService } from '../config/channel-config.service';
import { TelegramNotifier } from '../publishers/telegram-notifier.service';
import { PostingThrottleService } from '../publishers/posting-throttle.service';
import { TelegraphService } from '../publishers/telegraph.service';
import { SlideHostingService } from '../publishers/hosting/slide-hosting.service';
import { RecipeCarouselRendererService } from '../common/carousel/recipe-carousel-renderer.service';
import { EDITOR_OPS, EDITOR_PROVIDERS, EDITOR_RUNNER, EditorCron } from './editor.module';
import { EditorOpsService } from './api/editor-ops.service';
import { EditorRunnerService } from './roles/editor-runner.service';

test('EditorModule providers resolve with stubbed external deps', async () => {
  @Module({
    providers: [
      ...EDITOR_PROVIDERS,
      { provide: DB_POOL, useValue: { query: async () => ({ rows: [] }), connect: async () => ({}) } },
      { provide: ConfigService, useValue: { get: (k: string) => ({ EDITOR_ENABLED: 'false' } as any)[k] } },
      { provide: ChannelConfigService, useValue: { resolveChannel: () => ({}), isPublishPausedFor: () => false } },
      { provide: TelegramNotifier, useValue: { notifyAlert: async () => {} } },
      { provide: PostingThrottleService, useValue: { recordPublish: () => {} } },
      { provide: RecipeCarouselRendererService, useValue: { renderSlides: async () => [] } },
      { provide: SlideHostingService, useValue: { available: async () => false, upload: async () => [], delete: async () => {} } },
      { provide: TelegraphService, useValue: { createPage: async () => ({ url: '', path: '' }) } },
    ],
  })
  class TestEditorModule {}

  const app = await NestFactory.createApplicationContext(TestEditorModule, { logger: false });
  try {
    assert.ok(app.get(EDITOR_RUNNER) instanceof EditorRunnerService);
    const ops = app.get<EditorOpsService>(EDITOR_OPS);
    assert.ok(ops instanceof EditorOpsService);
    const exposed = ops.listTools().map((t) => t.name);
    assert.ok(exposed.includes('lint_post') && exposed.includes('preview_post') && exposed.includes('sql_readonly'));
    for (const forbidden of ['publish_post', 'submit_plan', 'skip_slot', 'add_memory', 'set_format_weights']) {
      assert.ok(!exposed.includes(forbidden), `${forbidden} must not be exposed`);
    }
    const cron = app.get(EditorCron);
    await cron.tick(); // disabled → no-op, must not throw
  } finally {
    await app.close();
  }
});
