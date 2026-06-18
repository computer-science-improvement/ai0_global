import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelConfigService } from './channel-config.service';

function svc(opts: {
  channel: any;
  bots?: Record<string, any>;
  defaultBot?: any;
}) {
  const cache = {
    getChannelByKey: (k: string) => (opts.channel?.channel_key === k ? opts.channel : null),
    getChannelById:  (id: string) => (opts.channel?.id === id ? opts.channel : null),
    getBotById:      (id: string) => opts.bots?.[id] ?? null,
    getDefaultBot:   () => opts.defaultBot ?? null,
  };
  const env = { get: (_k: string) => undefined };
  const secrets = { resolveToken: (_t: any, _r: any) => 'resolved-token' };
  return new ChannelConfigService(env as any, cache as any, undefined as any, secrets as any);
}

test('resolveChannel uses the bound bot when bot_id is set', () => {
  const s = svc({
    channel: { id: 'c1', channel_key: '@ch', kind: 'public', bot_id: 'bound', tg_chat_id: null },
    bots: { bound: { id: 'bound', bot_id: 'bound_bot', token_enc: null, token_env: 'X' } },
    defaultBot: { id: 'def', bot_id: 'default_bot', token_enc: null, token_env: 'Y' },
  });
  const r = s.resolveChannel('@ch');
  assert.equal(r.botId, 'bound_bot');
});

test('resolveChannel falls back to the default bot when bot_id is null', () => {
  const s = svc({
    channel: { id: 'c1', channel_key: '@ch', kind: 'public', bot_id: null, tg_chat_id: null },
    defaultBot: { id: 'def', bot_id: 'default_bot', token_enc: null, token_env: 'Y' },
  });
  const r = s.resolveChannel('@ch');
  assert.equal(r.botId, 'default_bot');
});

test('resolveChannel throws the new message when no bot bound and no default', () => {
  const s = svc({
    channel: { id: 'c1', channel_key: '@ch', kind: 'public', bot_id: null, tg_chat_id: null },
    defaultBot: null,
  });
  assert.throws(() => s.resolveChannel('@ch'), /has no bot bound and no default bot is set/);
});
