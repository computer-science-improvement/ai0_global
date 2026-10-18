// Spec 048 FR-003: the `/` menu of the chat composer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { filterCommands, isSlashCommand, SLASH_COMMANDS, slashToken } from './SlashMenu';

test('the menu opens only for `/word` at the very start, before a space', () => {
  assert.equal(slashToken('/', 1), '');
  assert.equal(slashToken('/st', 3), 'st');
  assert.equal(slashToken('/steer @x', 9), null);
  assert.equal(slashToken('hi /st', 6), null);
  assert.deepEqual(filterCommands('s').map((c) => c.name), ['setup', 'steer', 'skills']);
  assert.deepEqual(filterCommands('x'), []);
});

test('a command goes without the Channel line; a path does not count', () => {
  assert.ok(isSlashCommand('/rules'));
  assert.ok(isSlashCommand(' /steer @a @b'));
  assert.ok(!isSlashCommand('/app/setup is empty'));
  assert.ok(!isSlashCommand('write a post /rules'));
});

test('the list mirrors the server commands', () => {
  const server = readFileSync(fileURLToPath(new URL('../../../../automation/src/editor/chat/slash-commands.ts', import.meta.url)), 'utf8');
  for (const c of SLASH_COMMANDS) assert.ok(server.includes(`name: '${c.name}',`) && server.includes(`args: '${c.args}',`), c.name);
  assert.equal((server.match(/\{ name: '/g) ?? []).length, SLASH_COMMANDS.length);
});
