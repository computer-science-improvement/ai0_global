// Spec 073 T5 (FR-006): the `first_posts` step links to the Approvals tab that exists (`/app/agents/inbox?tab=approvals`),
// not to `/app/approvals` (no route). Nothing pinned the link before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChecklist, FIRST_POSTS, type ChecklistFacts } from './launch-checklist';
import { MemoryLaunchRepo } from './testing/launch-fixtures';
import type { ChannelLaunch } from './launch.types';

const facts = (published: number): ChecklistFacts => ({ tracked: { isMine: true }, published, platforms: [] });

async function launch(status: ChannelLaunch['status']): Promise<ChannelLaunch> {
  const repo = new MemoryLaunchRepo();
  const row = await repo.insert({ channelKey: '@coffee_home', title: null, brief: 'b', refs: [], createdBy: 'owner' });
  return { ...row!, status, startedAt: status === 'running' ? new Date('2026-10-20T10:00:00Z') : null };
}

test('first_posts: after Start the step links to the Approvals tab of the agents inbox', async () => {
  const step = buildChecklist(await launch('running'), facts(1)).find((x) => x.key === 'first_posts')!;
  assert.equal(step.link, '/app/agents/inbox?tab=approvals');
  assert.equal(step.state, 'waiting');
  assert.match(step.detail ?? '', /Approve the waiting posts/);
});

test('first_posts: no link before Start; once the first posts are out the step is done and keeps the Approvals link', async () => {
  assert.equal(buildChecklist(await launch('ready'), facts(0)).find((x) => x.key === 'first_posts')!.link, null);
  const done = buildChecklist(await launch('running'), facts(FIRST_POSTS)).find((x) => x.key === 'first_posts')!;
  assert.equal(done.state, 'done');
  assert.equal(done.link, '/app/agents/inbox?tab=approvals');
});
