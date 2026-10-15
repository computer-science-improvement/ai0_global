import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditHasFindings, findingLinks, findingsBySection, groupCountLabel, shortUrl, type ApprovalFinding } from './audit-view';
import { FLAG_LABEL, QUALITY_FLAGS } from './quality-view';

test('finding links: URLs anywhere in extra (labelled by a sibling title or date), ids from *_id / *Id keys, deduplicated', () => {
  const r = findingLinks({
    matches: [
      { url: 'https://t.me/ai_news/1105', date: '2026-10-07', slot_id: 'a1' },
      { url: 'https://t.me/ai_news/1110', title: 'Apple hub again', slotId: 'a2' },
      { url: 'https://t.me/ai_news/1105' },
    ],
    previousPostIds: ['p1', 'p2'],
    source: 'https://www.techcrunch.com/2026/10/06/apple-is-reportedly-partnering-with-lg-to-launch-a-smart-lock/?utm=x',
    score: 0.8,
  });
  assert.deepEqual(r.links.map((l) => l.label), ['2026-10-07', 'Apple hub again', 'techcrunch.com/2026/10/06/apple-is-reportedly-p…']);
  assert.deepEqual(r.ids, ['a1', 'a2', 'p1', 'p2']);
  assert.deepEqual(findingLinks(null), { links: [], ids: [] });
  assert.equal(shortUrl('https://www.x.com/a/'), 'x.com/a');
});

test('approval findings by section: stories, numbers and sources, dates, lint; empty sections left out', () => {
  const f = (code: string, section: ApprovalFinding['section']): ApprovalFinding => ({
    code, section, level: 'warning', message: '', excerpt: null, title: code, explain: '', fix: '', group: null, extra: null,
  });
  const s = findingsBySection([f('slop_em_dash', 'lint'), f('stale_source', 'dates'), f('story_repeat', 'stories')]);
  assert.deepEqual(s.map((x) => [x.label, x.items.length]), [['Story matches', 1], ['Date checks', 1], ['Lint warnings', 1]]);
  assert.deepEqual(findingsBySection(undefined), []);
});

test('counts and the new digest flags have English labels', () => {
  assert.equal(groupCountLabel({ count: 1, posts: 1 }), '1 finding');
  assert.equal(groupCountLabel({ count: 5, posts: 3 }), '5 findings on 3 posts');
  assert.equal(auditHasFindings(null), false);
  for (const f of ['story_repeat', 'fact_conflict', 'date_issue', 'text_hygiene', 'style_violation', 'dark_day'] as const) {
    assert.ok((QUALITY_FLAGS as readonly string[]).includes(f), f);
    assert.ok(FLAG_LABEL[f] && !/_/.test(FLAG_LABEL[f]), f);
  }
});
