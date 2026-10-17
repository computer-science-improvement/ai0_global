import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStyleOverlay, ownerStyleOverlay, plannerStyleLine, rowOwnerRules } from './owner-style-overlay';
import { configConflicts } from './config-conflicts';
import { ConfigConflictsService } from './config-conflicts.service';
import { effectiveStyle, styleOfRow } from '../post/style/resource-style';
import { rowToCard } from '../repo/editor-channels.repository';
import { lintPost } from '../post/lint-post';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { plannerUserPrompt } from '../roles/prompts';

/** Spec 041 FR-003 (T3): one effective style — owner rule > profile > card > defaults. */

const TG = 'telegram:@loko';
const rule = (id: number, text: string) => ({ id, text });

test('overlay: «без хештегів», «без сленгу», «простіше» become style; other rules are not style', () => {
  const o = ownerStyleOverlay([rule(3, 'Без хештегів у постах'), rule(4, 'Не використовуй сленг'), rule(5, 'Пиши простіше, для новачків'), rule(6, 'Публікуй о 9:00')]);
  assert.deepEqual(o, { hashtags: 'off', slang: false, level: 'beginner', rule_ids: { hashtags: 3, slang: 4, level: 5 } });
  assert.deepEqual(ownerStyleOverlay([rule(1, 'Більше хештегів про ШІ'), rule(2, 'Пиши для фахівців')]), { rule_ids: {} });
  assert.deepEqual(ownerStyleOverlay([rule(7, 'Пояснюй простими словами')]).level, 'beginner');
  const st = applyStyleOverlay({ hashtags: 'vocabulary', audience: { level: 'expert' }, address: 'vy' }, o);
  assert.deepEqual(st, { hashtags: 'off', audience: { level: 'beginner' }, address: 'vy' });
  assert.deepEqual(rowOwnerRules([{ id: '3', text: 'Без хештегів' }, { id: 'x' }, null]), [{ id: 3, text: 'Без хештегів' }]);
});

test('no vocabulary, no hashtags: an empty card vocabulary turns the default off; a vocabulary keeps it', () => {
  assert.equal(effectiveStyle({}, { vocabulary: [] }).hashtags, 'off');
  assert.equal(effectiveStyle({}, { vocabulary: ['#ai'] }).hashtags, 'vocabulary');
  assert.equal(effectiveStyle({}, { vocabulary: null }).hashtags, 'vocabulary', 'a platform ref (no card) is not judged');
  assert.equal(effectiveStyle({ hashtags: 'vocabulary' }, { vocabulary: [] }).hashtags, 'vocabulary', 'the stored style wins over the default');
  // lint: no minimum without a vocabulary.
  const spec = makeSpec({ hashtags: [] });
  const noVocab = lintPost(spec, makeCard({ hashtags: [], hashtagMin: 2, hashtagMax: 4, style: { hashtags: 'vocabulary' } }));
  assert.ok(!noVocab.errors.some((e) => e.code === 'hashtag_count'), JSON.stringify(noVocab.errors));
  const vocab = lintPost(spec, makeCard({ hashtags: ['#ai', '#ml'], hashtagMin: 2, hashtagMax: 4, style: { hashtags: 'vocabulary' } }));
  assert.ok(vocab.errors.some((e) => e.code === 'hashtag_count'));
});

test('card read: the owner rules joined into the row beat format_prefs (style and slang)', () => {
  const row = {
    channel_key: '@loko', hashtags: ['#ai'], hashtag_min: 1, hashtag_max: 3, slang_pref: 'true',
    format_prefs_json: { style: { hashtags: 'vocabulary', audience: { level: 'expert' } }, slang: true }, profile_topic: 'ШІ',
    owner_rules: [{ id: 3, text: 'Без хештегів' }, { id: 4, text: 'Без сленгу' }, { id: 5, text: 'Простіше, для новачків' }],
  };
  const card = rowToCard(row);
  assert.equal(card.style?.hashtags, 'off');
  assert.deepEqual(card.style?.audience, { level: 'beginner' });
  assert.equal(card.slang, false);
  const plain = rowToCard({ ...row, owner_rules: [] });
  assert.equal(plain.style?.hashtags, 'vocabulary');
  assert.equal(plain.slang, true);
  // A row read without the join stays as it was (no style, slang from the pref).
  assert.deepEqual(styleOfRow({ channel_key: '@x' }), {});
});

test('planner: a one-line style summary from the effective style', () => {
  assert.equal(plannerStyleLine({ hashtags: 'off', audience: { level: 'beginner' }, content_kind: 'news' }, false),
    'Стиль ресурсу: тип ресурсу news; аудиторія початківці (прості теми, без жаргону); без хештегів; без сленгу.');
  assert.equal(plannerStyleLine({ hashtags: 'vocabulary' }, true), null);
  const p = plannerUserPrompt(makeCard({ style: { hashtags: 'off' } }), new Date('2026-10-17T07:00:00Z'), []);
  assert.match(p, /Стиль ресурсу: .*без хештегів/);
});

test('conflicts: hashtag_min_without_vocabulary and rule_not_in_profile, each with its fix', () => {
  const out = configConflicts({
    rules: [rule(3, 'Без хештегів'), rule(4, 'Без сленгу'), rule(5, 'Пиши простіше')],
    playbook: null,
    resources: [{
      ref: TG, style: { hashtags: 'off' }, slang: false, vocabulary: [], hashtagMin: 2,
      profile: { format_prefs: { slang: true, style: { hashtags: 'vocabulary', audience: { level: 'expert' }, address: 'ty' } } },
    }],
  });
  const min = out.find((c) => c.code === 'hashtag_min_without_vocabulary');
  assert.deepEqual(min?.fix, { target: 'card', op: 'hashtag_min_zero', channelKey: '@loko' });
  const nip = out.find((c) => c.code === 'rule_not_in_profile');
  assert.equal(nip?.rule_id, 3);
  assert.match(nip!.detail, /#3, #4, #5/);
  assert.deepEqual(nip?.fix, { target: 'profile', op: 'style', ref: TG, style: { hashtags: 'off', audience: { level: 'beginner' }, address: 'ty' }, slang: false });
  // In agreement: nothing.
  assert.deepEqual(configConflicts({
    rules: [rule(3, 'Без хештегів')], playbook: null,
    resources: [{ ref: TG, style: { hashtags: 'off' }, vocabulary: ['#ai'], hashtagMin: 1, profile: { format_prefs: { style: { hashtags: 'off' } } } }],
  }).map((c) => c.code), []);
});

test('conflicts service: the card and style fixes are applied', async () => {
  const calls: unknown[] = [];
  const svc = new ConfigConflictsService({
    memory: { listActive: async () => [{ id: 5, kind: 'rule', text: 'Простіше, для новачків', evidence: null, createdBy: 'owner', createdAt: new Date() }] } as any,
    network: { groupOfChannel: async () => null, groupResources: async () => [], activePlaybook: async () => null, applyOwnerPatch: async () => ({ noop: true }) } as any,
    channels: {
      get: async () => ({ style: { hashtags: 'off' }, slang: false, pollsPerWeek: null, hashtags: [], hashtagMin: calls.length ? 0 : 2 }),
      setHashtagMin: async (key: string, n: number) => { calls.push(['min', key, n]); return true; },
    } as any,
    profiles: {
      get: async () => ({ profile: { format_prefs: { style: calls.length ? { audience: { level: 'beginner' } } : { audience: { level: 'general' } } } } }),
      patchFormat: async (ref: string, patch: any) => { calls.push(['format', ref, patch]); return { ok: true }; },
      setProfile: async () => undefined,
    } as any,
  });
  const r = await svc.apply({ id: 'o1', handle: 'loko', scope: 'resource', scopeId: TG, kind: 'orchestrator' } as any);
  assert.deepEqual(r.applied.sort(), ['hashtag_min_without_vocabulary', 'rule_not_in_profile']);
  assert.deepEqual(calls, [['min', '@loko', 0], ['format', TG, { style: { audience: { level: 'beginner' } } }]]);
  assert.deepEqual(r.remaining, []);
});
