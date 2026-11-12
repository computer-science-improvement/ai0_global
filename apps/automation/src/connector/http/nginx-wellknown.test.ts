import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NGINX = join(__dirname, '../../../../dashboard/nginx.conf');
const VITE = join(__dirname, '../../../../dashboard/vite.config.ts');

test('AUTH-6/P4: nginx answers 404 for /.well-known/* other than oauth-*, and the dev proxy mirrors it', { skip: !existsSync(NGINX) }, () => {
  const conf = readFileSync(NGINX, 'utf8');
  const oauth = conf.indexOf('location ^~ /.well-known/oauth- {');
  const other = conf.indexOf('location ^~ /.well-known/ {');
  assert.ok(oauth >= 0, 'the oauth- block is still there');
  assert.ok(other > oauth, 'the catch-all comes after the oauth- block');
  assert.match(conf.slice(other, conf.indexOf('}', other)), /return 404;/);
  assert.match(readFileSync(VITE, 'utf8'), /'\/\.well-known\/'\]/);
});
