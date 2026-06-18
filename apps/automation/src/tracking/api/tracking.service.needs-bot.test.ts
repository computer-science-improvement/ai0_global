import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingService } from './tracking.service';

function make(opts: { channelBotId: string | null; defaultBot: any; boundBot?: any }) {
  const channel = {
    id: 'c1', username: 'u', title: 't', about: null, subsCount: 0, isMine: true,
    isClosed: false, trackingStatus: 'ok', pollTier: 'warm', addedAt: new Date(),
    lastPolledAt: null, channelKey: '@u', tgChatId: null, kind: 'public',
    botId: opts.channelBotId, themes: [], publishPaused: false,
  };
  const channels = { getById: async (_id: string) => channel };
  const configCache = {
    getBotById: (_id: string) => opts.boundBot ?? null,
    getDefaultBot: () => opts.defaultBot,
    getBindings: () => [],
    getForwardRoutes: () => [],
  };
  const svc = new TrackingService(
    {} as any, channels as any, {} as any, {} as any, {} as any, {} as any,
    configCache as any, {} as any, {} as any,
  );
  return svc;
}

test('needsBot true: no bot bound and no default bot', async () => {
  const dto = await make({ channelBotId: null, defaultBot: null }).getChannel('c1');
  assert.equal(dto.needsBot, true);
});

test('needsBot false: a default bot exists', async () => {
  const dto = await make({ channelBotId: null, defaultBot: { id: 'd', is_default: true } }).getChannel('c1');
  assert.equal(dto.needsBot, false);
});

test('needsBot false: channel has a bot bound', async () => {
  const dto = await make({
    channelBotId: 'bound', defaultBot: null,
    boundBot: { id: 'bound', bot_id: 'b', username: 'b', active: true },
  }).getChannel('c1');
  assert.equal(dto.needsBot, false);
});
