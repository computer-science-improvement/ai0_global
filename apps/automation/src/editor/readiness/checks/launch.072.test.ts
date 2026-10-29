import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchPath } from '../../launch/launch-cards';
import type { LaunchBotState } from '../../launch/launch.types';
import { makeFacts } from '../testing/facts-fixture';
import { BOT_BLOCKING_STATES, launchArtifactPath, launchCheck } from './launch';

/** Spec 072 FR-003.5: bot_not_admin. */

const LID = '5b8c1d0e-3f6a-4c52-9d7e-1a2b3c4d5e6f';
const withBot = (botState: LaunchBotState | null, status: 'ready' | 'running' = 'ready') =>
  launchCheck.run(makeFacts({ launch: { id: LID, status, botState, graduation: null } }));
const bot = (state: LaunchBotState['state'], over: Partial<LaunchBotState> = {}): LaunchBotState => ({ state, detail: 'Bot API said so', bot: '@fx_bot', ...over });

test('no_access is an error without a fix, linked to the launch artifact', () => {
  const [x, ...rest] = withBot(bot('no_access'));
  assert.equal(rest.length, 0);
  assert.equal(x.check, 'bot_not_admin');
  assert.equal(x.severity, 'error');
  assert.equal(x.area, 'channel');
  assert.deepEqual(x.subject, { type: 'channel', id: LID, label: 'Launch', agent: 'fx072', channel: '@fx072' });
  assert.equal(x.fix, undefined);
  assert.equal(x.link, launchPath(LID));
  assert.match(x.detail, /The bot @fx_bot is not an administrator of @fx072/);
  assert.deepEqual(x.evidence, { launch_id: LID, launch_status: 'ready', state: 'no_access', detail: 'Bot API said so', bot: '@fx_bot' });
});

test('token_invalid says the token, not the rights', () => {
  const [x] = withBot(bot('token_invalid'), 'running');
  assert.equal(x.severity, 'error');
  assert.match(x.detail, /token is no longer accepted by Telegram/);
  assert.equal((x.evidence as any).launch_status, 'running');
});

test('a bot with no name is "The bot"', () => {
  const [x] = withBot(bot('no_access', { bot: null }));
  assert.match(x.detail, /^The bot is not an administrator/);
});

test('ok, unknown, no state and no launch say nothing', () => {
  assert.deepEqual(withBot(bot('ok')), []);
  assert.deepEqual(withBot(bot('unknown')), []);
  assert.deepEqual(withBot(null), []);
  assert.deepEqual(launchCheck.run(makeFacts()), []);
});

test('the blocking states are exactly the two the contract names, and the path is the launch cards\'', () => {
  assert.deepEqual([...BOT_BLOCKING_STATES], ['no_access', 'token_invalid']);
  assert.equal(launchArtifactPath(LID), launchPath(LID));
});
