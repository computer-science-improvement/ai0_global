import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DB_POOL } from '../../database/database.module';
import { ChannelConfigService } from '../../config/channel-config.service';
import { TelegramNotifier } from '../../publishers/telegram-notifier.service';
import { PostingThrottleService } from '../../publishers/posting-throttle.service';
import { TelegraphService } from '../../publishers/telegraph.service';
import { SlideHostingService } from '../../publishers/hosting/slide-hosting.service';
import { RecipeCarouselRendererService } from '../../common/carousel/recipe-carousel-renderer.service';
import { CrossPostService } from '../../publishers/cross-post.service';
import { GroupFanOutService } from '../../common/content-strategy/group-fanout.service';
import { EDITOR_PROVIDERS, EDITOR_REGISTRY } from '../editor.module';
import type { ToolRegistry } from '../harness/tool-registry';
import type { EditorTool } from '../harness/tool';
import { EXECUTOR_DENY } from '../roles/editor-runner.service';
import {
  CORE_TOOLS, coreOf, creationLoadout, hardExcluded, LOADOUT_ROLES, needsOf, roleDefaultOf, toolTokens, universeOf,
} from './loadout-profiles';

let tools: EditorTool[] = [];
let close: () => Promise<void> = async () => {};

// The real registry, built the way the module test builds it (stubbed external deps, nothing is called).
before(async () => {
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
      { provide: CrossPostService, useValue: { afterPublish: async () => [] } },
      { provide: GroupFanOutService, useValue: { fanOut: async () => [] } },
    ],
  })
  class TestModule {}
  const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  tools = app.get<ToolRegistry>(EDITOR_REGISTRY).all();
  close = () => app.close();
});
after(async () => { await close(); });

const names = (ts: Array<{ name: string }>) => ts.map((t) => t.name);

test('every core tool of every role is a tool of that role in the registry', () => {
  assert.ok(tools.length > 50);
  for (const role of LOADOUT_ROLES) {
    const have = new Set(universeOf(role, tools).map((t) => t.name));
    for (const n of CORE_TOOLS[role] ?? []) assert.ok(have.has(n), `${role}: core tool ${n} is not a ${role} tool in the registry`);
    assert.ok((CORE_TOOLS[role] ?? []).length > 0, `${role} has a profile`);
  }
});

test('core tools of a role include its terminal tools, never a chat-only one', () => {
  const executor = coreOf('executor', universeOf('executor', tools));
  for (const t of ['publish_post', 'publish_platform_post', 'skip_slot', 'request_story_repost']) assert.ok(executor.has(t), t);
  for (const role of LOADOUT_ROLES) assert.ok(universeOf(role, tools).every((t) => !t.chatOnly));
});

test('the writer\'s denied tools are not core and cannot be switched on; the idea reviewer\'s list is short', () => {
  const executor = universeOf('executor', tools);
  const core = coreOf('executor', executor);
  for (const n of EXECUTOR_DENY) assert.ok(!core.has(n), `${n} is not core`);
  assert.deepEqual([...hardExcluded('executor', executor)].sort(), [...EXECUTOR_DENY].sort());
  const reviewer = roleDefaultOf('idea_reviewer', universeOf('idea_reviewer', tools)).map((t) => t.name).sort();
  assert.deepEqual(reviewer, ['finish_idea_review', 'get_playbook', 'list_ideas', 'load_skill', 'review_ideas', 'review_playbook', 'web_fetch']);
});

test('a new executor of a Telegram resource gets the Telegram-only tools, not the platform ones', () => {
  const set = creationLoadout('executor', tools, needsOf(['telegram']), []);
  for (const t of ['publish_post', 'fetch_feed', 'skip_slot']) assert.ok(set.includes(t), t);
  // Spec 064 FR-006: publish_post lints itself, so the writer starts without the two check tools.
  assert.ok(!set.includes('lint_post') && !set.includes('preview_post'), 'lint_post / preview_post are off by default');
  assert.ok(!set.includes('lint_platform_post'), 'lint_platform_post is not for a Telegram-only resource');
  assert.ok(set.includes('publish_platform_post'), 'a terminal tool is core whatever the resource: the harness offers it anyway');
  assert.ok(!set.includes('sql_readonly') && !set.includes('get_channel_card'), 'the writer\'s denied tools stay out');
  assert.ok(!set.includes('get_top_posts'), 'optional tools are not added');
});

test('a resource with other platforms gets the platform tools; one without Telegram loses the Telegram-only', () => {
  const both = creationLoadout('executor', tools, needsOf(['telegram', 'instagram']), []);
  for (const t of ['publish_post', 'lint_platform_post', 'publish_platform_post']) assert.ok(both.includes(t), t);
  assert.ok(!both.includes('lint_post'));
  const ig = creationLoadout('executor', tools, needsOf(['instagram']), []);
  assert.ok(ig.includes('lint_platform_post') && !ig.includes('lint_post'));
});

test('peers\' tools are added when they are the role\'s runnable tools; the order is the registry\'s', () => {
  const set = creationLoadout('executor', tools, needsOf(['telegram']), ['get_top_posts', 'sql_readonly', 'tool_that_does_not_exist', 'submit_plan']);
  assert.ok(set.includes('get_top_posts'));
  assert.ok(!set.includes('sql_readonly'), 'denied for the writer');
  assert.ok(!set.includes('tool_that_does_not_exist') && !set.includes('submit_plan'), 'not a writer tool');
  const order = names(universeOf('executor', tools));
  assert.deepEqual(set, order.filter((n) => set.includes(n)));
});

test('a planner and a reviewer start with their core tools only', () => {
  const planner = creationLoadout('planner', tools, needsOf(['telegram']), []);
  assert.ok(planner.includes('submit_plan') && planner.includes('get_channel_stats') && !planner.includes('get_channel_card'));
  const reviewer = creationLoadout('reviewer', tools, needsOf(['telegram']), []);
  assert.ok(reviewer.includes('finish_review') && reviewer.includes('add_memory'));
});

test('the new loadout is smaller than the role default for every resource role', () => {
  for (const role of ['planner', 'executor', 'reviewer', 'orchestrator'] as const) {
    const universe = universeOf(role, tools);
    const size = (set: string[]) => universe.filter((t) => set.includes(t.name)).reduce((n, t) => n + toolTokens(t), 0);
    const loadout = creationLoadout(role, tools, needsOf(['telegram', 'instagram']), []);
    const def = roleDefaultOf(role, universe).map((t) => t.name);
    assert.ok(size(loadout) <= size(def), `${role}: ${size(loadout)} vs ${size(def)}`);
  }
});

test('toolTokens is the schema size over four', () => {
  const t = tools.find((x) => x.name === 'fetch_feed')!;
  assert.ok(toolTokens(t) > 20 && toolTokens(t) < 2000);
});

test('spec 064 FR-006: the role defaults drop lint_post / preview_post (executor) and propose_skill_edit (orchestrator); the manager keeps it', () => {
  const def = (role: any) => names(roleDefaultOf(role, universeOf(role, tools)));
  const executor = def('executor');
  assert.ok(!executor.includes('lint_post') && !executor.includes('preview_post'));
  assert.ok(executor.includes('publish_post') && executor.includes('lint_platform_post'));
  assert.ok(!def('orchestrator').includes('propose_skill_edit'));
  assert.ok(universeOf('manager', tools).some((t) => t.name === 'propose_skill_edit'), 'the manager owns it');
  assert.ok(hardExcluded('orchestrator', universeOf('orchestrator', tools)).has('propose_skill_edit'));
  assert.ok(!coreOf('executor', universeOf('executor', tools)).has('lint_post'));
});
