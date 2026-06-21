import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentScheduleExecutor } from './agent-schedule.executor';

test('schedule builds a text ComposedPost and calls the repo', async () => {
  const created: any[] = [];
  const repo = { create: async (p: any) => { created.push(p); return { id: 'sp1' }; } } as any;
  const exec = new AgentScheduleExecutor(repo);
  const id = await exec.schedule({ channelId: 'c1', text: 'Sponsored', scheduledAt: '2030-01-01T00:00:00Z' });
  assert.equal(id, 'sp1');
  const p = created[0];
  assert.equal(p.channelId, 'c1');
  assert.equal(p.text, 'Sponsored');
  assert.equal(p.sender, 'bot');
  assert.equal(p.mediaType, 'none');
  assert.deepEqual(p.buttons, []);
  assert.equal(p.scheduledAt, '2030-01-01T00:00:00Z');
});
