import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isPrivateAddress } from './ssrf-guard';

const resolvesTo = (...ips: string[]) => async () => ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

test('isPrivateAddress', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('accepts public https URL', async () => {
  const u = await assertPublicUrl('https://example.com/a?b=1', resolvesTo('93.184.216.34'));
  assert.equal(u.hostname, 'example.com');
});

test('rejects bad schemes, ports, creds, internal hosts', async () => {
  await assert.rejects(assertPublicUrl('file:///etc/passwd', resolvesTo('1.1.1.1')), /scheme/);
  await assert.rejects(assertPublicUrl('http://example.com:6379/', resolvesTo('1.1.1.1')), /port/);
  await assert.rejects(assertPublicUrl('http://u:p@example.com/', resolvesTo('1.1.1.1')), /credentials/);
  await assert.rejects(assertPublicUrl('http://localhost/', resolvesTo('127.0.0.1')), /not allowed/);
  await assert.rejects(assertPublicUrl('http://redis/', resolvesTo('172.18.0.3')), /not allowed/);
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest', resolvesTo()), /private/);
  await assert.rejects(assertPublicUrl('http://[::1]/', resolvesTo()), /private/);
});

test('rejects DNS that resolves to a private address (rebinding-style)', async () => {
  await assert.rejects(assertPublicUrl('https://evil.example/', resolvesTo('93.184.216.34', '10.0.0.5')), /private/);
});
