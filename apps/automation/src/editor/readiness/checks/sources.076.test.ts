import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelDoctor } from '../doctor';
import { toReadinessFinding, isFixAllTarget } from '../view';
import { makeFacts, mkDataset, NOW } from '../testing/facts-fixture';
import { sourcesCheck } from './sources';

/** Lead, 076 merge (S8, S9, S10): 076's `sourceFindings` as a doctor check over the facts the loader fills. */

const FEED = 'https://zakon.rada.gov.ua/laws/main/rss';
const card = { sources: [{ id: 'pdr_feed', kind: 'rss' as const, ref: FEED }] };
const probe = (over: Record<string, unknown> = {}) => ({ ok: false, failure_class: 'timeout', items: null, newest_at: null, checked_at: new Date(NOW.getTime() - 3_600_000).toISOString(), detail: 'timed out after 15 s', ...over });

/** The facts with the card's feed carrying a stored probe (what the loader reads from `source_probes`). */
const withProbe = (p: ReturnType<typeof probe> | null, o: { proxy?: boolean; required?: boolean; hosts?: string[] } = {}) => {
  const f = makeFacts({ card });
  return { ...f, proxyConfigured: o.proxy ?? false, ...(o.hosts ? { proxyHosts: o.hosts } : {}), sources: f.sources.map((s) => ({ ...s, probe: p, ...(o.required !== undefined ? { required: o.required } : {}) })) };
};

test('a failed stored probe of the only card source is a blocker; with a proxy the fix routes the host, else it drops the source', () => {
  const proxied = sourcesCheck.run(withProbe(probe(), { proxy: true, required: true }));
  assert.deepEqual(proxied.map((x) => [x.check, x.severity]), [['source_probe_failed', 'error']]);
  assert.deepEqual(proxied[0].fix, { kind: 'host_proxy_add', host: 'zakon.rada.gov.ua', url: FEED, sourceKind: 'rss' });
  assert.equal(proxied[0].detail, 'timed out after 15 s', 'the probe\'s own line');
  assert.equal(proxied[0].link, '/app/agents/fx072?tab=settings');
  const plain = sourcesCheck.run(withProbe(probe(), { required: true }));
  assert.deepEqual(plain[0].fix, { kind: 'source_drop', channel: '@fx072', sourceId: 'pdr_feed' }, 'the card source is named by its id');
});

test('source_drop is never in Fix all (lead S9); host_proxy_add is, and neither is applied by code', () => {
  const [drop] = sourcesCheck.run(withProbe(probe(), { required: true }));
  const [route] = sourcesCheck.run(withProbe(probe(), { proxy: true, required: true }));
  assert.equal(isFixAllTarget(drop), false);
  assert.equal(isFixAllTarget(route), true);
  assert.deepEqual(toReadinessFinding(drop).fix, { label: 'Remove the source from the card', auto: false, inFixAll: false });
  assert.deepEqual(toReadinessFinding(route).fix, { label: 'Read zakon.rada.gov.ua through the proxy', auto: false, inFixAll: true });
});

test('a good probe says nothing; no probe on a channel older than 14 days says nothing; a fresh channel is untested', () => {
  assert.deepEqual(sourcesCheck.run(withProbe(probe({ ok: true, failure_class: null, items: 12, newest_at: NOW.toISOString() }))), []);
  assert.deepEqual(sourcesCheck.run(withProbe(null)), [], 'the fixture card was created in September');
  const fresh = withProbe(null);
  const young = { ...fresh, card: { ...fresh.card, createdAt: new Date(NOW.getTime() - 86_400_000) } };
  assert.deepEqual(sourcesCheck.run(young).map((x) => x.check), ['source_untested']);
});

test('a dataset whose list import was an upload is dataset_resync_manual; the doctor runs the check with the others', () => {
  const f = makeFacts({ card, datasets: [{ ...mkDataset({ key: 'pdr_rules' }), uploaded: true }, mkDataset({ key: 'tips' })] });
  const out = sourcesCheck.run({ ...f, sources: f.sources.map((s) => ({ ...s, probe: probe({ ok: true, failure_class: null, items: 3, newest_at: NOW.toISOString() }) })) });
  assert.deepEqual(out.map((x) => [x.check, x.subject.label]), [['dataset_resync_manual', 'pdr_rules']]);
  const all = channelDoctor(withProbe(probe(), { required: true }));
  assert.ok(all.some((x) => x.check === 'source_probe_failed' && x.severity === 'error'));
});

test('W1 integration review: a host on the proxy list since the stored read is not offered the proxy again (no Fix all loop)', () => {
  const [waiting] = sourcesCheck.run(withProbe(probe(), { proxy: true, required: true, hosts: ['zakon.rada.gov.ua'] }));
  assert.equal(waiting.severity, 'error');
  assert.equal(waiting.fix, undefined);
  assert.equal(isFixAllTarget(waiting), false);
  const [through] = sourcesCheck.run(withProbe(probe({ via_proxy: true }), { proxy: true, required: true }));
  assert.deepEqual(through.fix, { kind: 'source_drop', channel: '@fx072', sourceId: 'pdr_feed' }, 'the read went through the proxy: only removing is left');
  assert.equal(isFixAllTarget(through), false);
});
