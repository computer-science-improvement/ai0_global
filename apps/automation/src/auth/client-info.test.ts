import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, ipPrefix, normalizeIp, uaFamily, userAgentOf } from './client-info';

test('normalizeIp unwraps IPv4-mapped IPv6 and rejects non-IPs', () => {
  assert.equal(normalizeIp('::ffff:172.18.0.5'), '172.18.0.5');
  assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeIp('not-an-ip'), null);
  assert.equal(normalizeIp(undefined), null);
  assert.equal(clientIp({ ip: '::ffff:1.2.3.4' }), '1.2.3.4');
  assert.equal(clientIp({ socket: { remoteAddress: '5.6.7.8' } }), '5.6.7.8');
});

test('ipPrefix: IPv4 /24, IPv6 /48', () => {
  assert.equal(ipPrefix('91.1.2.3'), '91.1.2.0/24');
  assert.equal(ipPrefix('::ffff:91.1.2.200'), '91.1.2.0/24');
  assert.equal(ipPrefix('2001:db8:abcd:12::1'), '2001:db8:abcd::/48');
  assert.equal(ipPrefix('2001:0db8:abcd:0012:0000:0000:0000:0001'), '2001:db8:abcd::/48');
  assert.equal(ipPrefix('2001:db8::1'), '2001:db8:0::/48');
  assert.equal(ipPrefix(null), null);
});

test('uaFamily: browser · OS', () => {
  assert.equal(uaFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/128.0 Safari/537.36'), 'Chrome · macOS');
  assert.equal(uaFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0'), 'Edge · Windows');
  assert.equal(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1'), 'Safari · iOS');
  assert.equal(uaFamily('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36'), 'Chrome · Android');
  assert.equal(uaFamily('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox · Linux');
  assert.equal(uaFamily('curl/8.4.0'), 'curl');
  assert.equal(uaFamily(''), 'Unknown device');
  assert.equal(uaFamily(null), 'Unknown device');
});

test('userAgentOf caps the header length', () => {
  assert.equal(userAgentOf({ headers: { 'user-agent': 'x'.repeat(1000) } })?.length, 400);
  assert.equal(userAgentOf({ headers: {} }), null);
});
