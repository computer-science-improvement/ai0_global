import type { Pool } from 'pg';
import { AgentLoop } from '../../editor/harness/agent-loop';
import { ToolRegistry } from '../../editor/harness/tool-registry';
import { PgRunRecorder } from '../../editor/harness/run-recorder';
import { BudgetService } from '../../editor/harness/budget.service';
import { ReadonlyQueryService } from '../../editor/db/readonly-query.service';
import { SkillLibrary } from '../../editor/skills/skill-library';
import { buildReadTools } from '../../editor/tools/read-tools';
import { buildComposeTools } from '../../editor/tools/compose-tools';
import { buildRoleTools } from '../../editor/tools/role-tools';
import { EditorChannelsRepository } from '../../editor/repo/editor-channels.repository';
import { EditorPlansRepository } from '../../editor/repo/editor-plans.repository';
import { EditorMemoryRepository } from '../../editor/repo/editor-memory.repository';
import { EditorRunnerService } from '../../editor/roles/editor-runner.service';
import { ApprovalsRepository } from '../../editor/approval/approvals.repository';
import { ApprovalPublisher } from '../../editor/approval/approval-publisher';
import type { TgMessage } from '../../editor/post/render-telegram';
import type { PublishPlatformDeps } from '../../editor/platform/publish-platform';
import { PlatformPostsRepository } from '../../editor/platform/platform-posts.repository';
import type { LlmClient } from '../../editor/llm/llm.types';
import { ConnectorPostsRepository } from '../posts/connector-posts.repository';
import { ConnectorPostsService } from '../posts/connector-posts.service';

/**
 * Wiring for the spec 103 WP-C PG tests: the real repositories, planner/executor and approval publisher over a
 * throwaway database, with a fake Telegram and a scripted LLM (zero network).
 */

export const SPEC = {
  format: 'text', title: 'Connector test post', origin: 'original',
  body: [
    { type: 'lead', text: 'Webb showed the Ring Nebula in infrared light' },
    { type: 'p', text: 'The shells of gas around the white dwarf are what is left of a star like the Sun.' },
  ],
  hashtags: [],
};

export async function seedChannel(pool: Pool, key: string, mode: 'live' | 'approve' | 'shadow'): Promise<void> {
  await pool.query(
    `INSERT INTO tracked_channels (channel_key, username, title, is_mine, kind) VALUES ($1, $2, 'Connector test', true, 'public')
     ON CONFLICT DO NOTHING`, [key, key.slice(1)]);
  await pool.query(
    `INSERT INTO editor_channels (channel_key, mode, title, brief, formats, hashtags, posts_per_day_min, posts_per_day_max, plan_hour, timezone, language)
     VALUES ($1, $2, 'Connector test', 'Short explainers of space images', '{"text":1}', '{}', 1, 3, 0, 'Europe/Kyiv', 'en')`, [key, mode]);
}

export function harness(pool: Pool, clock: { now: Date }, llm: LlmClient) {
  const now = () => clock.now;
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const memory = new EditorMemoryRepository(pool);
  const sent: Array<{ channelKey: string; messages: TgMessage[] }> = [];
  const publisher = {
    send: async (channelKey: string, messages: TgMessage[]) => { sent.push({ channelKey, messages }); return { messageIds: messages.map((_, i) => 7000 + sent.length * 10 + i) }; },
  };
  const skills = new SkillLibrary();
  const registry = new ToolRegistry([
    ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills }),
    ...buildComposeTools(),
    ...buildRoleTools({ pool, plans, memory, channels, publisher, recordPublish: () => {}, now }),
  ]);
  const loop = new AgentLoop({ llm, recorder: new PgRunRecorder(pool), enabled: () => true, budget: new BudgetService(pool, { globalDailyUsd: 100, channelDailyUsd: 100 }) });
  const runner = new EditorRunnerService({ loop, registry, skills, plans, memory, env: () => undefined, notify: async () => {}, now });
  const mode = async (c: { mode: any }) => c.mode;
  const platform: PublishPlatformDeps = {
    posts: new PlatformPostsRepository(pool), publisher: { publish: async () => ({ externalId: 'x', url: null, warnings: [] }) } as any, health: async () => null, pool, now,
  };
  const approvalPublisher = new ApprovalPublisher({
    repo: new ApprovalsRepository(pool), plans, card: (k) => channels.get(k), mode, telegram: { plans, publisher, recordPublish: () => {} }, platform,
  });
  const approvals = { approved: [] as string[] };
  const posts = new ConnectorPostsService({
    store: new ConnectorPostsRepository(pool), now, card: (k) => channels.get(k), modeOf: mode,
    // Plain text needs no media preparation: render exactly like prepareAndRender does for it.
    render: async (card, spec, mediaKey) => (await import('../../editor/publish/publish-spec')).prepareAndRender({ media: {} as any }, { channelKey: card.channelKey, spec, card, mediaKey }),
    approvals: {
      approve: async (id) => { approvals.approved.push(id); await pool.query(`UPDATE editor_slots SET status='approved', approved_at=now(), approved_by='owner' WHERE id=$1`, [id]); return { movedTo: null }; },
      reject: async () => ({ replacementId: null }),
    },
  });
  return { channels, plans, memory, runner, approvalPublisher, posts, sent, approvals, registry, loop, skills, now, publisher };
}

export async function cleanChannel(pool: Pool, key: string): Promise<void> {
  await pool.query(`DELETE FROM editor_runs WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM editor_drafts WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [key]);
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref = $1`, [`telegram:${key}`]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [key]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [key]);
}
