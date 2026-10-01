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
import { EDITOR_PROVIDERS, EDITOR_RUNNER, EditorCron } from './editor.module';
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
    ],
  })
  class TestEditorModule {}

  const app = await NestFactory.createApplicationContext(TestEditorModule, { logger: false });
  try {
    assert.ok(app.get(EDITOR_RUNNER) instanceof EditorRunnerService);
    const cron = app.get(EditorCron);
    await cron.tick(); // disabled → no-op, must not throw
  } finally {
    await app.close();
  }
});
