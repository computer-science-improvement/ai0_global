import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isParserFile } from './run-parsers.js';

test('isParserFile: runs real parsers only', () => {
  assert.equal(isParserFile('recipes-epicure.js'), true);
  assert.equal(isParserFile('academy.openai.js'), true);
  // node:test files would register (and run) their tests inside the sync.
  assert.equal(isParserFile('recipes-epicure.test.js'), false);
  assert.equal(isParserFile('prompts-github.test.js'), false);
  assert.equal(isParserFile('_parser-template.js'), false);
  assert.equal(isParserFile('example-parser.js'), false);
  assert.equal(isParserFile('README.md'), false);
});
